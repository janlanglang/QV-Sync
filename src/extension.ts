import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { XMLParser } from 'fast-xml-parser';
import * as httpntlm from 'httpntlm';

type AuthMode = 'none' | 'ntlm';
type RecordType = 'QUERY' | 'DASHBOARD';

interface LocalConfig {
	dashboardId: string;
}

interface RuntimeConfig {
	workspaceFolder: vscode.WorkspaceFolder;
	localConfig: LocalConfig;
	dbFetchJsonUrl: string;
	xmlUpdateOfflineSoapUrl: string;
	tlsAllowInsecure: boolean;
	authMode: AuthMode;
	authUsername: string;
	authPassword: string;
	authDomain: string;
	authWorkstation: string;
	authSource: 'settings' | 'secretStorage';
	autoSyncOnSave: boolean;
	configFileName: string;
	indexFileName: string;
	generatedRootDir: string;
}

interface StoredCredentials {
	username: string;
	password: string;
	domain: string;
	workstation: string;
}

interface DbRow {
	name: string;
	title: string;
	guid: string;
	statement: string;
	jsPageScript: string;
	cssStyle: string;
	version: string;
	type: RecordType;
}

interface FileIndexEntry {
	relativePath: string;
	table: 'QVQUERY' | 'QVDASHBOARD';
	field: 'JSPAGESCRIPT' | 'CSSSTYLE' | 'STATEMENT';
	guid: string;
	recordName: string;
	type: RecordType;
	version: string;
}

interface FileIndex {
	generatedAt: string;
	dashboardId: string;
	entries: FileIndexEntry[];
}

interface RequestOptions {
	method: 'GET' | 'POST';
	url: string;
	headers?: Record<string, string>;
	body?: string;
	config: RuntimeConfig;
}

const OUTPUT_CHANNEL = vscode.window.createOutputChannel('ERP Dashboard Sync');
const XML_PARSER = new XMLParser({ ignoreAttributes: false, trimValues: false });
const DEPRECATED_SETTING_KEYS = ['xmlUpdateOfflineHttpUrl', 'updateTransport'] as const;
const SECRET_STORAGE_PREFIX = 'erp-dashboard-sync';
let deprecatedSettingsMigrationCompleted = false;
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	context.subscriptions.push(OUTPUT_CHANNEL);

	context.subscriptions.push(
		vscode.commands.registerCommand('erp-dashboard-sync.initializeWorkspace', async () => {
			await initializeWorkspace(true);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('erp-dashboard-sync.refreshFromErp', async () => {
			await initializeWorkspace(false);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('erp-dashboard-sync.setCredentials', async () => {
			await setCredentialsInSecretStorage();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('erp-dashboard-sync.clearCredentials', async () => {
			await clearCredentialsInSecretStorage();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (document) => {
			await syncDocumentOnSave(document);
		})
	);
}

export function deactivate(): void {
	OUTPUT_CHANNEL.dispose();
}

async function initializeWorkspace(promptForDashboard: boolean): Promise<void> {
	const workspaceFolder = getPrimaryWorkspaceFolder();
	if (!workspaceFolder) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Bitte zuerst einen Workspace-Ordner oeffnen.');
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'ERP Dashboard Sync: Lade Dashboard-Dateien',
			cancellable: false
		},
		async (progress) => {
			progress.report({ message: 'Konfiguration laden...' });
			const config = await loadRuntimeConfig(workspaceFolder, promptForDashboard);
			if (!config) {
				return;
			}

			progress.report({ message: 'Daten via dbFetchJSON abrufen...' });
			const rows = await fetchDashboardRows(config);

			progress.report({ message: 'JS/CSS Dateien erzeugen...' });
			const index = await materializeFiles(config, rows);

			progress.report({ message: 'Index schreiben...' });
			await writeIndex(config, index);

			vscode.window.showInformationMessage(
				`ERP Dashboard Sync: ${rows.length} Elemente fuer Dashboard '${config.localConfig.dashboardId}' geladen.`
			);
		}
	);
}

async function syncDocumentOnSave(document: vscode.TextDocument): Promise<void> {
	if (document.languageId !== 'javascript' && document.languageId !== 'css' && document.languageId !== 'sql') {
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!workspaceFolder) {
		return;
	}

	const config = await loadRuntimeConfig(workspaceFolder, false);
	if (!config || !config.autoSyncOnSave) {
		return;
	}

	const index = await readIndex(config);
	if (!index) {
		return;
	}

	const relativePath = toPosixPath(path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath));
	const entry = index.entries.find((item) => item.relativePath === relativePath);
	if (!entry) {
		return;
	}

	try {
		await pushUpdate(config, entry, document.getText());
		vscode.window.setStatusBarMessage(`ERP Sync: ${entry.recordName} (${entry.field}) aktualisiert`, 2500);
	} catch (error) {
		OUTPUT_CHANNEL.appendLine(`Save-Sync fehlgeschlagen fuer ${relativePath}: ${formatError(error)}`);
		vscode.window.showErrorMessage(
			`ERP Dashboard Sync: Update fehlgeschlagen fuer ${entry.recordName} (${entry.field}). Details im Output-Channel.`
		);
	}
}

async function loadRuntimeConfig(
	workspaceFolder: vscode.WorkspaceFolder,
	promptForDashboard: boolean
): Promise<RuntimeConfig | undefined> {
	const settings = vscode.workspace.getConfiguration('erpDashboardSync', workspaceFolder.uri);
	if (!deprecatedSettingsMigrationCompleted) {
		await migrateDeprecatedSettings(settings);
		deprecatedSettingsMigrationCompleted = true;
	}

	const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
	const localConfigUri = vscode.Uri.joinPath(workspaceFolder.uri, configFileName);
	let localConfig = await readJsonFile<LocalConfig>(localConfigUri);
	const authSettings = await resolveAuthSettings(workspaceFolder, settings);
	const authUsernameRaw = authSettings.username;
	const authPassword = authSettings.password;
	const authDomainRaw = authSettings.domain;
	const authWorkstationRaw = authSettings.workstation;
	const authUsername = authUsernameRaw.trim();
	const authDomain = authDomainRaw.trim();
	const authWorkstation = authWorkstationRaw.trim();

	if (!localConfig || !localConfig.dashboardId || promptForDashboard) {
		const defaultDashboard = localConfig?.dashboardId ?? 'wss_001';
		const dashboardId = await vscode.window.showInputBox({
			title: 'ERP Dashboard Sync',
			prompt: 'QVDASHBOARD Name (z. B. wss_001)',
			value: defaultDashboard,
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim().length === 0 ? 'Dashboard-Name ist erforderlich.' : undefined)
		});

		if (!dashboardId) {
			return undefined;
		}

		localConfig = { dashboardId: dashboardId.trim() };
		await writeJsonFile(localConfigUri, localConfig);
	}

	const runtimeConfig: RuntimeConfig = {
		workspaceFolder,
		localConfig,
		dbFetchJsonUrl: settings.get<string>(
			'dbFetchJsonUrl',
			'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/customutils.asmx/dbFetchJSON'
		),
		xmlUpdateOfflineSoapUrl: settings.get<string>(
			'xmlUpdateOfflineSoapUrl',
			'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/utils.asmx'
		),
		tlsAllowInsecure: settings.get<boolean>('tlsAllowInsecure', false),
		authMode: settings.get<AuthMode>('authMode', 'ntlm'),
		authUsername,
		authPassword,
		authDomain,
		authWorkstation,
		authSource: authSettings.source,
		autoSyncOnSave: settings.get<boolean>('autoSyncOnSave', true),
		configFileName,
		indexFileName: settings.get<string>('indexFileName', '.erp-dashboard-sync-index.json'),
		generatedRootDir: settings.get<string>('generatedRootDir', 'erp-dashboard')
	};

	if (authUsernameRaw !== authUsername || authDomainRaw !== authDomain || authWorkstationRaw !== authWorkstation) {
		OUTPUT_CHANNEL.appendLine(
			'[Config] Hinweis: authUsername/authDomain/authWorkstation wurden getrimmt (fuehrende/nachgestellte Leerzeichen entfernt).'
		);
	}

	logAuthConfigurationDiagnostics(settings, runtimeConfig);

	return runtimeConfig;
}

async function migrateDeprecatedSettings(settings: vscode.WorkspaceConfiguration): Promise<void> {
	let removedCount = 0;

	for (const key of DEPRECATED_SETTING_KEYS) {
		const inspect = settings.inspect<unknown>(key);
		if (!inspect) {
			continue;
		}

		removedCount += await clearDeprecatedSettingInScope(settings, key, inspect.globalValue, vscode.ConfigurationTarget.Global);
		removedCount += await clearDeprecatedSettingInScope(settings, key, inspect.workspaceValue, vscode.ConfigurationTarget.Workspace);
		removedCount += await clearDeprecatedSettingInScope(
			settings,
			key,
			inspect.workspaceFolderValue,
			vscode.ConfigurationTarget.WorkspaceFolder
		);
	}

	if (removedCount > 0) {
		OUTPUT_CHANNEL.appendLine(
			`[Config] Migration: ${removedCount} veraltete Setting-Werte entfernt (xmlUpdateOfflineHttpUrl/updateTransport).`
		);
	}
}

async function clearDeprecatedSettingInScope(
	settings: vscode.WorkspaceConfiguration,
	key: (typeof DEPRECATED_SETTING_KEYS)[number],
	value: unknown,
	target: vscode.ConfigurationTarget
): Promise<number> {
	if (value === undefined) {
		return 0;
	}

	try {
		await settings.update(key, undefined, target);
		return 1;
	} catch (error) {
		OUTPUT_CHANNEL.appendLine(
			`[Config] Migration-Warnung: Konnte '${key}' in Scope ${String(target)} nicht entfernen: ${formatError(error)}`
		);
		return 0;
	}
}

function logAuthConfigurationDiagnostics(
	settings: vscode.WorkspaceConfiguration,
	config: RuntimeConfig
): void {
	const usernameInspect = settings.inspect<string>('authUsername');
	const passwordInspect = settings.inspect<string>('authPassword');
	const domainInspect = settings.inspect<string>('authDomain');
	const workstationInspect = settings.inspect<string>('authWorkstation');

	OUTPUT_CHANNEL.appendLine('[Config] ERP Dashboard Sync runtime configuration loaded.');
	OUTPUT_CHANNEL.appendLine(`[Config] Workspace folder: ${config.workspaceFolder.uri.fsPath}`);
	OUTPUT_CHANNEL.appendLine(`[Config] authMode=${config.authMode}`);
	OUTPUT_CHANNEL.appendLine(`[Config] authSource=${config.authSource}`);
	OUTPUT_CHANNEL.appendLine(`[Config] tlsAllowInsecure=${config.tlsAllowInsecure ? 'yes' : 'no'}`);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authUsername set=${config.authUsername.trim().length > 0 ? 'yes' : 'no'} (length=${config.authUsername.length})`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authPassword set=${config.authPassword.length > 0 ? 'yes' : 'no'} (length=${config.authPassword.length})`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authUsername scopes: global=${usernameInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${usernameInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${usernameInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authPassword scopes: global=${passwordInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${passwordInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${passwordInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authDomain set=${config.authDomain.length > 0 ? 'yes' : 'no'} (length=${config.authDomain.length})`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authWorkstation set=${config.authWorkstation.length > 0 ? 'yes' : 'no'} (length=${config.authWorkstation.length})`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authDomain scopes: global=${domainInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${domainInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${domainInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);
	OUTPUT_CHANNEL.appendLine(
		`[Config] authWorkstation scopes: global=${workstationInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${workstationInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${workstationInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);

	if (config.authUsername.includes('\\') && config.authDomain.length > 0) {
		OUTPUT_CHANNEL.appendLine(
			"[Config] Warnung: Username enthaelt bereits 'domain\\user' UND authDomain ist gesetzt. Das fuehrt oft zu 401."
		);
	}
}

async function resolveAuthSettings(
	workspaceFolder: vscode.WorkspaceFolder,
	settings: vscode.WorkspaceConfiguration
): Promise<StoredCredentials & { source: 'settings' | 'secretStorage' }> {
	const stored = await readCredentialsFromSecretStorage(workspaceFolder);
	if (stored) {
		return {
			...stored,
			source: 'secretStorage'
		};
	}

	return {
		username: settings.get<string>('authUsername', ''),
		password: settings.get<string>('authPassword', ''),
		domain: settings.get<string>('authDomain', ''),
		workstation: settings.get<string>('authWorkstation', ''),
		source: 'settings'
	};
}

async function setCredentialsInSecretStorage(): Promise<void> {
	const workspaceFolder = getPrimaryWorkspaceFolder();
	if (!workspaceFolder) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Bitte zuerst einen Workspace-Ordner oeffnen.');
		return;
	}

	if (!extensionContext) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Secret Storage ist nicht verfuegbar.');
		return;
	}

	const settings = vscode.workspace.getConfiguration('erpDashboardSync', workspaceFolder.uri);
	const current = await resolveAuthSettings(workspaceFolder, settings);

	const username = await vscode.window.showInputBox({
		title: 'ERP Dashboard Sync Credentials',
		prompt: 'NTLM Username',
		value: current.username,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim().length === 0 ? 'Username ist erforderlich.' : undefined)
	});

	if (username === undefined) {
		return;
	}

	const passwordInput = await vscode.window.showInputBox({
		title: 'ERP Dashboard Sync Credentials',
		prompt: 'NTLM Passwort (leer lassen = bestehendes beibehalten)',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (value.length > 0 || current.password.length > 0) {
				return undefined;
			}
			return 'Passwort ist erforderlich.';
		}
	});

	if (passwordInput === undefined) {
		return;
	}

	const domain = await vscode.window.showInputBox({
		title: 'ERP Dashboard Sync Credentials',
		prompt: 'NTLM Domain (optional)',
		value: current.domain,
		ignoreFocusOut: true
	});

	if (domain === undefined) {
		return;
	}

	const workstation = await vscode.window.showInputBox({
		title: 'ERP Dashboard Sync Credentials',
		prompt: 'NTLM Workstation (optional)',
		value: current.workstation,
		ignoreFocusOut: true
	});

	if (workstation === undefined) {
		return;
	}

	await writeCredentialsToSecretStorage(workspaceFolder, {
		username: username.trim(),
		password: passwordInput.length > 0 ? passwordInput : current.password,
		domain: domain.trim(),
		workstation: workstation.trim()
	});

	vscode.window.showInformationMessage('ERP Dashboard Sync: Credentials sicher im Secret Storage gespeichert.');
}

async function clearCredentialsInSecretStorage(): Promise<void> {
	const workspaceFolder = getPrimaryWorkspaceFolder();
	if (!workspaceFolder) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Bitte zuerst einen Workspace-Ordner oeffnen.');
		return;
	}

	if (!extensionContext) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Secret Storage ist nicht verfuegbar.');
		return;
	}

	const answer = await vscode.window.showWarningMessage(
		'ERP Dashboard Sync: Gespeicherte Credentials aus dem Secret Storage loeschen?',
		{ modal: true },
		'Loeschen'
	);

	if (answer !== 'Loeschen') {
		return;
	}

	await deleteCredentialsFromSecretStorage(workspaceFolder);
	vscode.window.showInformationMessage('ERP Dashboard Sync: Credentials aus Secret Storage geloescht.');
}

function getSecretStorageKey(workspaceFolder: vscode.WorkspaceFolder): string {
	return `${SECRET_STORAGE_PREFIX}:credentials:${workspaceFolder.uri.toString()}`;
}

async function readCredentialsFromSecretStorage(
	workspaceFolder: vscode.WorkspaceFolder
): Promise<StoredCredentials | undefined> {
	if (!extensionContext) {
		return undefined;
	}

	const key = getSecretStorageKey(workspaceFolder);
	const raw = await extensionContext.secrets.get(key);
	if (!raw) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
		return {
			username: typeof parsed.username === 'string' ? parsed.username : '',
			password: typeof parsed.password === 'string' ? parsed.password : '',
			domain: typeof parsed.domain === 'string' ? parsed.domain : '',
			workstation: typeof parsed.workstation === 'string' ? parsed.workstation : ''
		};
	} catch (error) {
		OUTPUT_CHANNEL.appendLine(`[Config] Ungueltiger Secret-Storage Inhalt, verwende Settings-Fallback: ${formatError(error)}`);
		return undefined;
	}
}

async function writeCredentialsToSecretStorage(
	workspaceFolder: vscode.WorkspaceFolder,
	credentials: StoredCredentials
): Promise<void> {
	if (!extensionContext) {
		throw new Error('Secret Storage ist nicht verfuegbar.');
	}

	const key = getSecretStorageKey(workspaceFolder);
	await extensionContext.secrets.store(key, JSON.stringify(credentials));
}

async function deleteCredentialsFromSecretStorage(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	if (!extensionContext) {
		return;
	}

	const key = getSecretStorageKey(workspaceFolder);
	await extensionContext.secrets.delete(key);
}

async function fetchDashboardRows(config: RuntimeConfig): Promise<DbRow[]> {
	const sql = buildDashboardSql(config.localConfig.dashboardId);
	const fetchUrl = new URL(config.dbFetchJsonUrl);
	fetchUrl.searchParams.set('sql', sql);
	OUTPUT_CHANNEL.appendLine('[DBFetch] ---- BEGIN REQUEST ----');
	OUTPUT_CHANNEL.appendLine(`[DBFetch] Dashboard: ${config.localConfig.dashboardId}`);
	OUTPUT_CHANNEL.appendLine(`[DBFetch] Endpoint: ${config.dbFetchJsonUrl}`);
	OUTPUT_CHANNEL.appendLine(`[DBFetch] Request URL (encoded): ${fetchUrl.toString()}`);
	OUTPUT_CHANNEL.appendLine('[DBFetch] SQL (decoded):');
	OUTPUT_CHANNEL.appendLine(sql);
	OUTPUT_CHANNEL.appendLine('[DBFetch] ---- END REQUEST ----');

	const responseText = await requestText({
		method: 'GET',
		url: fetchUrl.toString(),
		config
	});

	if (!responseText || responseText.trim().length === 0) {
		OUTPUT_CHANNEL.appendLine('[DBFetch] Leere Antwort erhalten (Body length = 0).');
		throw new Error(
			'dbFetchJSON hat eine leere Antwort geliefert. Bitte NTLM-Logs mit HTTP-Status/Header pruefen (moeglicher Redirect oder Endpoint-/Scope-Mismatch).'
		);
	}

	OUTPUT_CHANNEL.appendLine('[DBFetch] ---- BEGIN RAW RESPONSE ----');
	OUTPUT_CHANNEL.appendLine(responseText);
	OUTPUT_CHANNEL.appendLine('[DBFetch] ---- END RAW RESPONSE ----');

	const rawJson = extractXmlStringValue(responseText);
	OUTPUT_CHANNEL.appendLine('[DBFetch] ---- BEGIN EXTRACTED JSON STRING ----');
	OUTPUT_CHANNEL.appendLine(rawJson);
	OUTPUT_CHANNEL.appendLine('[DBFetch] ---- END EXTRACTED JSON STRING ----');
	const parsed = await parseDbFetchJson(rawJson);
	const list = Array.isArray(parsed) ? parsed : [parsed];
	OUTPUT_CHANNEL.appendLine(`[DBFetch] Parsed JSON elements: ${list.length}`);

	return list
		.map((item) => normalizeDbRow(item))
		.filter((item): item is DbRow => item !== undefined);
}

async function parseDbFetchJson(rawJson: string): Promise<unknown> {
	try {
		return JSON.parse(rawJson);
	} catch (initialError) {
		OUTPUT_CHANNEL.appendLine(`[DBFetch] JSON.parse fehlgeschlagen: ${formatError(initialError)}`);
		logJsonErrorContext(rawJson, initialError, 'initial');

		const sanitized = rawJson.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
		if (sanitized !== rawJson) {
			OUTPUT_CHANNEL.appendLine('[DBFetch] Hinweis: Ungueltige Steuerzeichen wurden entfernt, erneuter Parse-Versuch.');
			try {
				return JSON.parse(sanitized);
			} catch (sanitizedError) {
				OUTPUT_CHANNEL.appendLine(`[DBFetch] Parse nach Steuerzeichen-Bereinigung fehlgeschlagen: ${formatError(sanitizedError)}`);
				logJsonErrorContext(sanitized, sanitizedError, 'sanitized');
			}
		}

		try {
			const { jsonrepair } = await import('jsonrepair');
			const repaired = jsonrepair(sanitized);
			OUTPUT_CHANNEL.appendLine('[DBFetch] Hinweis: JSON wurde mit jsonrepair repariert.');
			return JSON.parse(repaired);
		} catch (repairError) {
			OUTPUT_CHANNEL.appendLine(`[DBFetch] JSON-Reparatur fehlgeschlagen: ${formatError(repairError)}`);
			throw new Error(`dbFetchJSON enthaelt ungueltiges JSON und konnte nicht repariert werden. ${formatError(initialError)}`);
		}
	}
}

function logJsonErrorContext(input: string, error: unknown, stage: string): void {
	const message = formatError(error);
	const match = message.match(/position\s+(\d+)/i);
	if (!match) {
		return;
	}

	const position = Number(match[1]);
	if (!Number.isFinite(position) || position < 0) {
		return;
	}

	const start = Math.max(0, position - 120);
	const end = Math.min(input.length, position + 120);
	const context = input.slice(start, end).replace(/\n/g, '\\n');
	OUTPUT_CHANNEL.appendLine(`[DBFetch] JSON-Fehlerkontext (${stage}) @${position}: ${context}`);

	const segment = input.slice(0, position);
	const qvMatches = [...segment.matchAll(/"qvquery"\s*:\s*"([^"]*)"/g)];
	const guidMatches = [...segment.matchAll(/"GUID"\s*:\s*"([^"]*)"/g)];
	const qvquery = qvMatches.length > 0 ? qvMatches[qvMatches.length - 1][1] : 'unknown';
	const guid = guidMatches.length > 0 ? guidMatches[guidMatches.length - 1][1] : 'unknown';
	OUTPUT_CHANNEL.appendLine(`[DBFetch] Vermutlich betroffener Datensatz: qvquery='${qvquery}', guid='${guid}'`);
}

async function materializeFiles(config: RuntimeConfig, rows: DbRow[]): Promise<FileIndex> {
	const entries: FileIndexEntry[] = [];
	const dashboardFolderName = sanitizePathPart(config.localConfig.dashboardId);
	const dashboardDir = vscode.Uri.joinPath(
		config.workspaceFolder.uri,
		config.generatedRootDir,
		dashboardFolderName
	);
	await vscode.workspace.fs.createDirectory(dashboardDir);

	for (const row of rows) {
		const recordDir = vscode.Uri.joinPath(dashboardDir, row.type.toLowerCase());
		await vscode.workspace.fs.createDirectory(recordDir);

		const fileNameParts = [sanitizePathPart(row.name)];
		if (row.title.trim().length > 0) {
			fileNameParts.push(sanitizePathPart(row.title));
		}
		fileNameParts.push(sanitizePathPart(row.guid));
		const fileBaseName = fileNameParts.join('__');
		const jsRelativePath = toPosixPath(
			path.join(config.generatedRootDir, dashboardFolderName, row.type.toLowerCase(), `${fileBaseName}.js`)
		);
		const cssRelativePath = toPosixPath(
			path.join(config.generatedRootDir, dashboardFolderName, row.type.toLowerCase(), `${fileBaseName}.css`)
		);

		await writeTextFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.js`), row.jsPageScript ?? '');
		await writeTextFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.css`), row.cssStyle ?? '');
		if (row.type === 'QUERY') {
			await writeTextFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.sql`), row.statement ?? '');
		}

		entries.push({
			relativePath: jsRelativePath,
			table: row.type === 'QUERY' ? 'QVQUERY' : 'QVDASHBOARD',
			field: 'JSPAGESCRIPT',
			guid: row.guid,
			recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
			type: row.type,
			version: row.version
		});

		entries.push({
			relativePath: cssRelativePath,
			table: row.type === 'QUERY' ? 'QVQUERY' : 'QVDASHBOARD',
			field: 'CSSSTYLE',
			guid: row.guid,
			recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
			type: row.type,
			version: row.version
		});

		if (row.type === 'QUERY') {
			const sqlRelativePath = toPosixPath(
				path.join(config.generatedRootDir, dashboardFolderName, row.type.toLowerCase(), `${fileBaseName}.sql`)
			);
			entries.push({
				relativePath: sqlRelativePath,
				table: 'QVQUERY',
				field: 'STATEMENT',
				guid: row.guid,
				recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
				type: row.type,
				version: row.version
			});
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		dashboardId: config.localConfig.dashboardId,
		entries
	};
}

async function writeIndex(config: RuntimeConfig, index: FileIndex): Promise<void> {
	const indexUri = vscode.Uri.joinPath(config.workspaceFolder.uri, config.indexFileName);
	await writeJsonFile(indexUri, index);
}

async function readIndex(config: RuntimeConfig): Promise<FileIndex | undefined> {
	const indexUri = vscode.Uri.joinPath(config.workspaceFolder.uri, config.indexFileName);
	return readJsonFile<FileIndex>(indexUri);
}

async function pushUpdate(config: RuntimeConfig, entry: FileIndexEntry, content: string): Promise<void> {
	const updateDataRow = buildUpdateDataRow(entry.field, content);
	const updateData = toCData(updateDataRow);
	const whereClause = `GUID='${escapeSqlString(entry.guid)}'`;
	OUTPUT_CHANNEL.appendLine('[SaveSync] ---- BEGIN REQUEST ----');
	OUTPUT_CHANNEL.appendLine('[SaveSync] Transport: soap12');
	OUTPUT_CHANNEL.appendLine(`[SaveSync] Target: ${entry.table}.${entry.field}`);
	OUTPUT_CHANNEL.appendLine(`[SaveSync] Record: ${entry.recordName} (${entry.type})`);
	OUTPUT_CHANNEL.appendLine(`[SaveSync] GUID: ${entry.guid}`);
	OUTPUT_CHANNEL.appendLine(`[SaveSync] Content length: ${content.length}`);

	const soapBody = buildSoapEnvelope(entry.table, updateData, whereClause);
	OUTPUT_CHANNEL.appendLine(`[SaveSync] Method: POST`);
	OUTPUT_CHANNEL.appendLine(`[SaveSync] Endpoint: ${config.xmlUpdateOfflineSoapUrl}`);
	OUTPUT_CHANNEL.appendLine(`[SaveSync] Headers: Content-Type=application/soap+xml; charset=utf-8`);
	OUTPUT_CHANNEL.appendLine('[SaveSync] Body (SOAP 1.2):');
	OUTPUT_CHANNEL.appendLine(soapBody);
	await requestText({
		method: 'POST',
		url: config.xmlUpdateOfflineSoapUrl,
		headers: {
			'Content-Type': 'application/soap+xml; charset=utf-8'
		},
		body: soapBody,
		config
	});
	OUTPUT_CHANNEL.appendLine('[SaveSync] ---- END REQUEST ----');
}

function buildUpdateDataRow(field: FileIndexEntry['field'], value: string): string {
	return `<row><${field}>${escapeXml(value)}</${field}></row>`;
}

function toCData(value: string): string {
	const safeValue = value.replace(/\]\]>/g, ']]]]><![CDATA[>');
	return `<![CDATA[${safeValue}]]>`;
}

function buildSoapEnvelope(table: string, updateData: string, sWhere: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <xmlUpdateOffline xmlns="http://tempuri.org/">
      <table>${escapeXml(table)}</table>
	      <updateData>${updateData}</updateData>
      <sWhere>${escapeXml(sWhere)}</sWhere>
    </xmlUpdateOffline>
  </soap12:Body>
</soap12:Envelope>`;
}

async function requestText(options: RequestOptions): Promise<string> {
	return withOptionalInsecureTls(options.config.tlsAllowInsecure, async () => {
		if (options.config.authMode === 'ntlm') {
			return requestWithNtlm(options);
		}

		const response = await fetch(options.url, {
			method: options.method,
			headers: options.headers,
			body: options.body
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorBody}`);
		}

		return response.text();
	});
	}

function withOptionalInsecureTls<T>(allowInsecure: boolean, action: () => Promise<T>): Promise<T> {
	if (!allowInsecure) {
		return action();
	}

	const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

	return action().finally(() => {
		if (previous === undefined) {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
			return;
		}

		process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
	});
}

async function requestWithNtlm(options: RequestOptions): Promise<string> {
	if (!options.config.authUsername || !options.config.authPassword) {
		throw new Error('NTLM ist aktiviert, aber authUsername oder authPassword fehlt.');
	}

	const url = new URL(options.url);
	const authCandidates = buildNtlmAuthCandidates(options.config);
	let lastError: Error | undefined;

	for (let index = 0; index < authCandidates.length; index += 1) {
		const candidate = authCandidates[index];
		OUTPUT_CHANNEL.appendLine(
			`[NTLM] Sende ${options.method} ${url.origin}${url.pathname} (Versuch ${index + 1}/${authCandidates.length}) mit ${describeAuthIdentity(candidate.username, candidate.domain)}, workstation='${candidate.workstation || '<leer>'}'`
		);

		let response: {
			statusCode?: number;
			statusMessage?: string;
			headers?: Record<string, string | string[] | undefined>;
		};
		let body = '';

		try {
			const result = await executeNtlmRequest(options, candidate.username, candidate.domain, candidate.workstation);
			response = result.response;
			body = result.body;
		} catch (error) {
			OUTPUT_CHANNEL.appendLine(
				`[NTLM] Transportfehler bei ${options.method} ${options.url}: ${formatError(error)}`
			);
			throw error;
		}

		if (response?.statusCode && response.statusCode < 400) {
			const contentType = getHeaderValue(response?.headers, 'content-type') ?? '<leer>';
			const contentLength = getHeaderValue(response?.headers, 'content-length') ?? '<leer>';
			const location = getHeaderValue(response?.headers, 'location') ?? '<leer>';
			OUTPUT_CHANNEL.appendLine(
				`[NTLM] Antwort HTTP ${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}, content-type='${contentType}', content-length='${contentLength}', location='${location}', bodyLength=${(body ?? '').length}`
			);

			if (index > 0) {
				OUTPUT_CHANNEL.appendLine('[NTLM] Hinweis: Fallback-Identitaetsformat wurde erfolgreich verwendet.');
			}
			return body ?? '';
		}

		const statusCode = response?.statusCode;
		const diagnostic = buildNtlmDiagnostic(
			options.config,
			statusCode,
			response?.statusMessage,
			response?.headers,
			body,
			candidate.username,
			candidate.domain,
			candidate.workstation
		);
		OUTPUT_CHANNEL.appendLine(`[NTLM] ${diagnostic}`);

		lastError = new Error(`NTLM Request fehlgeschlagen: ${diagnostic}`);

		const hasMoreCandidates = index < authCandidates.length - 1;
		if (statusCode === 401 && hasMoreCandidates) {
			OUTPUT_CHANNEL.appendLine('[NTLM] HTTP 401 - versuche alternatives Username/Domain-Format.');
			continue;
		}

		throw lastError;
	}

	throw lastError ?? new Error('NTLM Request fehlgeschlagen.');
}

function buildNtlmAuthCandidates(config: RuntimeConfig): Array<{ username: string; domain: string; workstation: string }> {
	const candidates: Array<{ username: string; domain: string; workstation: string }> = [];
	const workstationCandidates = buildNtlmWorkstationCandidates(config.authWorkstation);
	const addCandidate = (username: string, domain: string): void => {
		for (const workstation of workstationCandidates) {
			const key = `${username}|||${domain}|||${workstation}`;
			if (candidates.some((item) => `${item.username}|||${item.domain}|||${item.workstation}` === key)) {
				continue;
			}
			candidates.push({ username, domain, workstation });
		}
	};

	const username = config.authUsername;
	const domain = config.authDomain;
	addCandidate(username, domain);

	const hasEmbeddedDomain = username.includes('\\');
	const hasUpn = username.includes('@');
	if (hasEmbeddedDomain && domain.length > 0) {
		addCandidate(username, '');
	}

	if (!hasEmbeddedDomain && domain.length > 0) {
		addCandidate(`${domain}\\${username}`, '');
		if (!hasUpn) {
			addCandidate(`${username}@${domain}`, '');
		}
	}

	return candidates;
}

function buildNtlmWorkstationCandidates(configuredWorkstation: string): string[] {
	const values: string[] = [];
	const add = (value: string): void => {
		if (!values.includes(value)) {
			values.push(value);
		}
	};

	add(configuredWorkstation);
	if (configuredWorkstation.length > 0) {
		add('');
	}

	const localHost = os.hostname().trim();
	if (localHost.length > 0) {
		add(localHost);
		add(localHost.toUpperCase());
	}

	return values;
}

function executeNtlmRequest(
	options: RequestOptions,
	username: string,
	domain: string,
	workstation: string
): Promise<{
	response: { statusCode?: number; statusMessage?: string; headers?: Record<string, string | string[] | undefined> };
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const requestOptions = {
			url: options.url,
			username,
			password: options.config.authPassword,
			domain,
			workstation,
			rejectUnauthorized: !options.config.tlsAllowInsecure,
			headers: options.headers,
			body: options.body
		};

		const callback = (
			error: unknown,
			response: {
				statusCode?: number;
				statusMessage?: string;
				headers?: Record<string, string | string[] | undefined>;
				body?: string | Buffer;
			}
		) => {
			if (error) {
				reject(error);
				return;
			}

			const responseBody = response?.body;
			const normalizedBody = Buffer.isBuffer(responseBody)
				? responseBody.toString('utf8')
				: (responseBody ?? '');

			resolve({
				response: response ?? {},
				body: normalizedBody
			});
		};

		if (options.method === 'GET') {
			httpntlm.get(requestOptions, callback);
		} else {
			httpntlm.post(requestOptions, callback);
		}
	});
}

function buildNtlmDiagnostic(
	config: RuntimeConfig,
	statusCode: number | undefined,
	statusMessage: string | undefined,
	headers: Record<string, string | string[] | undefined> | undefined,
	body: string,
	attemptedUsername?: string,
	attemptedDomain?: string,
	attemptedWorkstation?: string
): string {
	const bodyPreview = (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
	const challengeHeader = getHeaderValue(headers, 'www-authenticate');
	const configuredIdentityInfo = describeAuthIdentity(config.authUsername, config.authDomain);
	const attemptedIdentityInfo = describeAuthIdentity(
		attemptedUsername ?? config.authUsername,
		attemptedDomain ?? config.authDomain
	);
	const attemptedWorkstationValue = attemptedWorkstation ?? config.authWorkstation;
	const attemptedWorkstationDisplay = attemptedWorkstationValue.length > 0 ? attemptedWorkstationValue : '<leer>';
	const scopeInfo = `authMode=${config.authMode}, passwordSet=${config.authPassword.length > 0 ? 'yes' : 'no'}, workstation='${config.authWorkstation}', tlsAllowInsecure=${config.tlsAllowInsecure ? 'yes' : 'no'}, attemptedIdentity=${attemptedIdentityInfo}, attemptedWorkstation='${attemptedWorkstationDisplay}', configuredIdentity=${configuredIdentityInfo}`;
	const statusText = statusMessage ? ` ${statusMessage}` : '';
	const challengeText = challengeHeader ? `WWW-Authenticate='${challengeHeader}'` : 'WWW-Authenticate=<leer>';

	if (statusCode === 401) {
		const ntlmOffered = /(^|[,\s])NTLM([,\s]|$)/i.test(challengeHeader ?? '');
		const offerHint = ntlmOffered
			? 'Server bietet NTLM an.'
			: 'Server bietet laut Header kein NTLM an (ggf. nur Negotiate/Kerberos oder Reverse-Proxy-Konfiguration).';
		return `HTTP 401${statusText} (Unauthorized). ${offerHint} ${challengeText}. Pruefe Benutzername/Passwort/Domain. Typische Formate: 'authUsername=benutzer' + 'authDomain=domain' ODER 'authUsername=domain\\benutzer' mit leerem authDomain. ${scopeInfo}. Antwort: ${bodyPreview}`;
	}

	if (statusCode === 403) {
		return `HTTP 403${statusText} (Forbidden). NTLM wurde vermutlich akzeptiert, aber der Benutzer hat keine Berechtigung auf den Endpoint. ${challengeText}. ${scopeInfo}. Antwort: ${bodyPreview}`;
	}

	if (!statusCode) {
		return `Kein HTTP-Status erhalten. Moeglich: TLS/Netzwerk/Proxy-Problem. ${challengeText}. ${scopeInfo}. Antwort: ${bodyPreview}`;
	}

	return `HTTP ${statusCode}${statusText}. ${challengeText}. ${scopeInfo}. Antwort: ${bodyPreview}`;
}

function getHeaderValue(
	headers: Record<string, string | string[] | undefined> | undefined,
	name: string
): string | undefined {
	if (!headers) {
		return undefined;
	}

	const direct = headers[name];
	if (Array.isArray(direct)) {
		return direct.join(', ');
	}

	if (typeof direct === 'string') {
		return direct;
	}

	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== lowerName) {
			continue;
		}

		if (Array.isArray(value)) {
			return value.join(', ');
		}

		return typeof value === 'string' ? value : undefined;
	}

	return undefined;
}

function describeAuthIdentity(username: string, domain: string): string {
	const hasSlashDomain = username.includes('\\');
	const hasUpn = username.includes('@');
	const domainSet = domain.length > 0;
	const usernameHint = hasSlashDomain ? 'domain\\user' : hasUpn ? 'user@domain' : 'user';
	const domainHint = domainSet ? `domain='${domain}'` : 'domain=<leer>';

	if ((hasSlashDomain || hasUpn) && domainSet) {
		return `${usernameHint} + separates domain gesetzt (potenziell doppelt), ${domainHint}`;
	}

	return `${usernameHint}, ${domainHint}`;
}

function buildDashboardSql(dashboardId: string): string {
	const sanitizedId = escapeSqlString(dashboardId);
	return `select qvquery.qvquery,qvquery.title,qvquery.GUID,qvquery.STATEMENT, QVQUERY.JSPAGESCRIPT,QVQUERY.CSSSTYLE, QVQUERY.VERSION, type='QUERY' from QVQUERY
join QVDASHBOARDQUERY on QVQUERY.QVQUERY = QVDASHBOARDQUERY.QVQUERY
join QVDASHBOARD on QVDASHBOARDQUERY.QVDASHBOARD = QVDASHBOARD.QVDASHBOARD
where QVDASHBOARD.QVDASHBOARD = '${sanitizedId}'

UNION ALL

select QVDASHBOARD.QVDASHBOARD,QVDASHBOARD.title,QVDASHBOARD.GUID,'' as STATEMENT, QVDASHBOARD.JSPAGESCRIPT,QVDASHBOARD.CSSSTYLE, VERSION=QVDASHBOARD.INFO, type='DASHBOARD'
from QVDASHBOARD
where QVDASHBOARD.QVDASHBOARD = '${sanitizedId}'`;
}

function extractXmlStringValue(xmlText: string): string {
	const parsed = XML_PARSER.parse(xmlText) as { string?: string | { '#text'?: string } };
	const value = parsed.string;

	if (typeof value === 'string') {
		return value;
	}

	if (value && typeof value === 'object' && typeof value['#text'] === 'string') {
		return value['#text'];
	}

	throw new Error('dbFetchJSON Antwort enthaelt kein <string>-Element.');
}

function normalizeDbRow(raw: unknown): DbRow | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const typeValue = String(pick(obj, ['type', 'TYPE']) ?? '').toUpperCase();
	if (typeValue !== 'QUERY' && typeValue !== 'DASHBOARD') {
		return undefined;
	}

	const name = String(
		pick(obj, ['qvquery', 'QVQUERY', 'qvdashboard', 'QVDASHBOARD']) ??
			(typeValue === 'QUERY' ? 'query' : 'dashboard')
	);

	return {
		name,
		title: String(pick(obj, ['title', 'TITLE']) ?? ''),
		guid: String(pick(obj, ['guid', 'GUID']) ?? ''),
		statement: String(pick(obj, ['statement', 'STATEMENT']) ?? ''),
		jsPageScript: String(pick(obj, ['jspagescript', 'JSPAGESCRIPT']) ?? ''),
		cssStyle: String(pick(obj, ['cssstyle', 'CSSSTYLE']) ?? ''),
		version: String(pick(obj, ['version', 'VERSION']) ?? ''),
		type: typeValue
	};
}

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]): unknown {
	for (const key of keys) {
		if (key in obj) {
			return obj[key];
		}
	}

	return undefined;
}

function sanitizePathPart(value: string): string {
	const normalized = value.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
	return normalized.length > 0 ? normalized : 'unnamed';
}

function toPosixPath(input: string): string {
	return input.split(path.sep).join('/');
}

function escapeSqlString(value: string): string {
	return value.replace(/'/g, "''");
}

function toSqlNString(value: string): string {
	return `N'${escapeSqlString(value)}'`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return undefined;
	}

	return folders[0];
}

async function readJsonFile<T>(uri: vscode.Uri): Promise<T | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = new TextDecoder().decode(bytes);
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

async function writeJsonFile(uri: vscode.Uri, value: unknown): Promise<void> {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	await writeTextFile(uri, content);
}

async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
	const bytes = new TextEncoder().encode(content);
	await vscode.workspace.fs.writeFile(uri, bytes);
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
