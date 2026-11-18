import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import * as httpntlm from 'httpntlm';

type AuthMode = 'none' | 'ntlm';
type RecordType = 'QUERY' | 'DASHBOARD';
type DashboardContextType = 'quickview' | 'flow';
type FlowVersionBump = 'majorversion' | 'minorversion' | 'patchversion';

interface LocalConfig {
	contextType: DashboardContextType;
	dashboardId: string;
	displayName?: string;
	quickviewVersionState?: QuickviewVersionState;
	flowVersionState?: FlowVersionState;
}

interface QuickviewVersionState {
	lastPromptDate?: string;
	pendingVersion?: string;
}

interface FlowVersionState {
	lastPromptDate?: string;
	pendingBump?: FlowVersionBump;
}

interface DashboardContext {
	uri: vscode.Uri;
	workspaceFolder: vscode.WorkspaceFolder;
}

interface RuntimeConfig {
	workspaceFolder: vscode.WorkspaceFolder;
	contextRoot: vscode.Uri;
	localConfigUri: vscode.Uri;
	localConfig: LocalConfig;
	dbFetchJsonUrl: string;
	xmlUpdateOfflineSoapUrl: string;
	xmlUpdateOfflineRequestUrls: string[];
	verboseLogging: boolean;
	tlsAllowInsecure: boolean;
	authMode: AuthMode;
	authUsername: string;
	authPassword: string;
	authDomain: string;
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
}

interface DbRow {
	name: string;
	title: string;
	guid: string;
	xmlDefinition?: string;
	javascript?: string;
	sqlStatement?: string;
	statement: string;
	jsPageScript: string;
	cssStyle: string;
	options?: string;
	dashboardQueryGuid?: string;
	paramString?: string;
	jsChartScript?: string;
	chartOptions?: string;
	version: string;
	type: RecordType;
}

interface FileIndexEntry {
	relativePath: string;
	contentHash?: string;
	table: 'QVQUERY' | 'QVDASHBOARD' | 'QVDASHBOARDQUERY' | 'FLOWBOARD';
	field: 'JSPAGESCRIPT' | 'CSSSTYLE' | 'STATEMENT' | 'XMLDEFINITION' | 'JAVASCRIPT' | 'SQLSTATEMENT'
		| 'PARAMSTRING' | 'JSCHARTSCRIPT' | 'CHARTOPTIONS' | 'OPTIONS';
	versionField?: 'VERSION' | 'ANP_VERSION';
	guid: string;
	recordName: string;
	type: RecordType | 'DASHBOARDQUERY';
	version: string;
	contextType: DashboardContextType;
}

interface FileIndex {
	generatedAt: string;
	contextType: DashboardContextType;
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

class PartialSyncError extends Error {}

const OUTPUT_CHANNEL = vscode.window.createOutputChannel('ERP Dashboard Sync');
const XML_PARSER = new XMLParser({ ignoreAttributes: false, trimValues: false });
const DEPRECATED_SETTING_KEYS = ['xmlUpdateOfflineHttpUrl', 'updateTransport'] as const;
const SECRET_STORAGE_PREFIX = 'erp-dashboard-sync';
type CredentialScope = 'workspace' | 'global';
const ONBOARDING_DEFAULTS = {
	dbFetchJsonUrl: 'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/customutils.asmx/dbFetchJSON',
	xmlUpdateOfflineSoapUrl: 'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/utils.asmx',
	authMode: 'ntlm' as AuthMode,
	tlsAllowInsecure: true
};
const migratedWorkspaceFolders = new Set<string>();
let extensionContext: vscode.ExtensionContext | undefined;
let syncQueue: Promise<void> = Promise.resolve();
const pendingFileChanges = new Map<string, ReturnType<typeof setTimeout>>();
const synchronizedContentHashes = new Map<string, string>();
const pendingDashboardVersionUpdates = new Set<string>();

function enqueueSyncOperation(operation: () => Promise<void>): Promise<void> {
	const result = syncQueue.then(operation);
	syncQueue = result.catch((error: unknown) => {
		logOutput(`[Sync] Fehlgeschlagen: ${formatError(error)}`);
		vscode.window.showErrorMessage('ERP Dashboard Sync: Synchronisierung fehlgeschlagen. Details im Output-Channel.');
	});
	return result;
}

function scheduleFileSync(uri: vscode.Uri, source: 'save' | 'filesystem'): void {
	const key = uri.toString();
	const pending = pendingFileChanges.get(key);
	if (pending) {
		clearTimeout(pending);
	}
	pendingFileChanges.set(key, setTimeout(() => {
		pendingFileChanges.delete(key);
		void enqueueSyncOperation(() => syncFile(uri, source)).catch(() => {
			// enqueueSyncOperation reports errors and keeps subsequent uploads running.
		});
	}, 300));
}

function hashContent(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

function logOutput(message: string): void {
	OUTPUT_CHANNEL.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function logVerbose(config: RuntimeConfig, message: string): void {
	if (!config.verboseLogging) {
		return;
	}

	logOutput(message);
}

export function activate(context: vscode.ExtensionContext): void {
	extensionContext = context;
	context.subscriptions.push(OUTPUT_CHANNEL);

	context.subscriptions.push(
		vscode.commands.registerCommand('erp-dashboard-sync.initializeWorkspace', async () => {
			const contexts = await selectDashboardContexts('initialize');
			const context = contexts?.[0];
			if (context) {
				await enqueueSyncOperation(() => initializeWorkspace(true, context));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('erp-dashboard-sync.refreshFromErp', async () => {
			const contexts = await selectDashboardContexts('reload');
			if (contexts) {
				await reloadContexts(contexts);
			}
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
		vscode.commands.registerCommand('erp-dashboard-sync.resetVersionPromptState', async () => {
			await resetVersionPromptState();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document) => {
			scheduleFileSync(document.uri, 'save');
		})
	);

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{js,css,sql,xml,txt}');
	context.subscriptions.push(
		watcher,
		watcher.onDidChange((uri) => scheduleFileSync(uri, 'filesystem')),
		watcher.onDidCreate((uri) => scheduleFileSync(uri, 'filesystem')),
		new vscode.Disposable(() => {
			for (const timer of pendingFileChanges.values()) {
				clearTimeout(timer);
			}
			pendingFileChanges.clear();
		})
	);

	void triggerStartupReloadIfConfigured().catch((error: unknown) => {
		logOutput(`[StartupReload] Fehlgeschlagen: ${formatError(error)}`);
		vscode.window.showErrorMessage('ERP Dashboard Sync: Startup-Reload fehlgeschlagen. Details im Output-Channel.');
	});
}

export function deactivate(): void {
	OUTPUT_CHANNEL.dispose();
}

async function initializeWorkspace(promptForDashboard: boolean, context: DashboardContext): Promise<void> {
	await ensureWorkspaceBootstrapSettings(context.workspaceFolder);
	const canContinue = await ensureCredentialsForInitialization(context);
	if (!canContinue) {
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `ERP Dashboard Sync: Lade Dashboard-Dateien (${context.uri.fsPath})`,
			cancellable: false
		},
		async (progress) => {
			progress.report({ message: 'Konfiguration laden...' });
			const config = await loadRuntimeConfig(context, promptForDashboard);
			if (!config) {
				if (!promptForDashboard) {
					vscode.window.showInformationMessage(
						'ERP Dashboard Sync: Keine lokale Konfiguration gefunden. Bitte zuerst "Initialize Workspace" ausfuehren oder eine .erp-dashboard-sync.json bereitstellen.'
					);
				}
				return;
			}

			progress.report({ message: 'Daten via dbFetchJSON abrufen...' });
			const rows = await fetchWorkspaceRows(config);
			if (config.localConfig.contextType === 'flow') {
				await persistFlowDisplayName(config, rows[0]?.title);
			}

			progress.report({ message: 'Arbeitsdateien erzeugen...' });
			const index = await materializeFiles(config, rows);

			progress.report({ message: 'Index schreiben...' });
			await writeIndex(config, index);

			vscode.window.showInformationMessage(
				`ERP Dashboard Sync: ${rows.length} Elemente fuer ${getContextLabel(config.localConfig.contextType)} '${getWorkspaceLabel(config.localConfig)}' geladen.`
			);
		}
	);
}

async function ensureWorkspaceBootstrapSettings(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const settings = vscode.workspace.getConfiguration('erpDashboardSync', workspaceFolder.uri);
	let updatedCount = 0;

	updatedCount += await applySettingIfMissing(
		settings,
		'dbFetchJsonUrl',
		ONBOARDING_DEFAULTS.dbFetchJsonUrl,
		workspaceFolder
	);
	updatedCount += await applySettingIfMissing(
		settings,
		'xmlUpdateOfflineSoapUrl',
		ONBOARDING_DEFAULTS.xmlUpdateOfflineSoapUrl,
		workspaceFolder
	);
	updatedCount += await applySettingIfMissing(settings, 'authMode', ONBOARDING_DEFAULTS.authMode, workspaceFolder);
	updatedCount += await applySettingIfMissing(
		settings,
		'tlsAllowInsecure',
		ONBOARDING_DEFAULTS.tlsAllowInsecure,
		workspaceFolder
	);

	if (updatedCount > 0) {
		logOutput(
			`[Onboarding] ${updatedCount} fehlende Workspace-Settings wurden mit Startwerten gesetzt (dbFetchJsonUrl/xmlUpdateOfflineSoapUrl/authMode/tlsAllowInsecure).`
		);
	}
}

async function applySettingIfMissing<T>(
	settings: vscode.WorkspaceConfiguration,
	key: string,
	value: T,
	workspaceFolder: vscode.WorkspaceFolder
): Promise<number> {
	const inspect = settings.inspect<T>(key);
	const hasWorkspaceValue = inspect?.workspaceValue !== undefined || inspect?.workspaceFolderValue !== undefined;
	if (hasWorkspaceValue) {
		return 0;
	}

	await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
	logOutput(
		`[Onboarding] Workspace-Setting gesetzt: erpDashboardSync.${key}=${typeof value === 'string' ? `'${value}'` : String(value)} (${workspaceFolder.uri.fsPath})`
	);
	return 1;
}

async function ensureCredentialsForInitialization(context: DashboardContext): Promise<boolean> {
	const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
	const authMode = settings.get<AuthMode>('authMode', 'ntlm');
	if (authMode !== 'ntlm') {
		return true;
	}

	const authSettings = await resolveAuthSettings(context, settings);
	const hasUsername = authSettings.username.trim().length > 0;
	const hasPassword = authSettings.password.length > 0;
	if (hasUsername && hasPassword) {
		return true;
	}

	const answer = await vscode.window.showWarningMessage(
		'ERP Dashboard Sync: Fuer NTLM fehlen Username/Passwort. Soll ich die Credentials jetzt abfragen und im Secret Storage speichern?',
		{ modal: true },
		'Credentials setzen',
		'Abbrechen'
	);

	if (answer !== 'Credentials setzen') {
		vscode.window.showInformationMessage('ERP Dashboard Sync: Initialisierung abgebrochen (fehlende Credentials).');
		return false;
	}

	await setCredentialsInSecretStorage(context);
	const refreshedAuthSettings = await resolveAuthSettings(context, settings);
	const hasCredentialsAfterPrompt =
		refreshedAuthSettings.username.trim().length > 0 && refreshedAuthSettings.password.length > 0;
	if (!hasCredentialsAfterPrompt) {
		vscode.window.showWarningMessage(
			'ERP Dashboard Sync: Initialisierung abgebrochen, weil weiterhin keine vollstaendigen NTLM-Credentials vorhanden sind.'
		);
		return false;
	}

	return true;
}

async function triggerStartupReloadIfConfigured(): Promise<void> {
	for (const context of await discoverDashboardContexts()) {
		const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
		if (!settings.get<boolean>('reloadOnStartup', true)) {
			continue;
		}

		const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
		const localConfig = normalizeLocalConfig(await readJsonFile<LocalConfig>(vscode.Uri.joinPath(context.uri, configFileName)));
		if (!localConfig?.dashboardId?.trim()) {
			logOutput(`[StartupReload] Skip: Ungueltige Konfiguration (${context.uri.fsPath}).`);
			continue;
		}

		const workspaceLabel = getWorkspaceLabel(localConfig);
		if (settings.get<boolean>('reloadOnStartupPrompt', true)) {
			const answer = await vscode.window.showInformationMessage(
				`ERP Dashboard Sync: ${getContextLabel(localConfig.contextType)} '${workspaceLabel}' (${context.uri.fsPath}) ist verknuepft. Aktuellen Stand aus ERP laden?`,
				'Laden',
				'Nicht jetzt'
			);
			if (answer !== 'Laden') {
				continue;
			}
		}

		logOutput(`[StartupReload] Starte Reload fuer '${workspaceLabel}' (${context.uri.fsPath}).`);
		try {
			await enqueueSyncOperation(() => initializeWorkspace(false, context));
		} catch (error) {
			logOutput(`[StartupReload] Kontext fehlgeschlagen, fahre mit weiteren Kontexten fort: ${formatError(error)}`);
		}
	}
}

async function syncFile(uri: vscode.Uri, source: 'save' | 'filesystem'): Promise<void> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		logOutput(`[SaveSync] Skip: Datei ausserhalb Workspace geaendert: ${uri.fsPath}`);
		return;
	}

	const context = await findDashboardContext(uri);
	if (!context) {
		logOutput(`[SaveSync] Skip: Kein Dashboard-Kontext gefunden (${uri.fsPath}).`);
		return;
	}
	const config = await loadRuntimeConfig(context, false);
	if (!config) {
		logOutput('[SaveSync] Skip: Keine gueltige lokale Konfiguration gefunden.');
		return;
	}

	if (!config.autoSyncOnSave) {
		logOutput('[SaveSync] Skip: autoSyncOnSave ist deaktiviert.');
		return;
	}

	const index = await readIndex(config);
	if (!index) {
		logOutput(`[SaveSync] Skip: Indexdatei nicht gefunden oder ungueltig (${config.indexFileName}).`);
		return;
	}

	const relativePath = toPosixPath(path.relative(config.contextRoot.fsPath, uri.fsPath));
	const pathMatch = findIndexEntryByRelativePath(
		index,
		relativePath,
		config.localConfig.contextType,
		config.generatedRootDir
	);
	let entry = pathMatch.entry;
	if (entry && pathMatch.matchKind === 'case-insensitive') {
		logOutput(
			`[SaveSync] Hinweis: Datei ueber case-insensitive Pfadabgleich gefunden (${relativePath} vs ${entry.relativePath}).`
		);
	}
	if (entry && pathMatch.matchKind === 'legacy-layout') {
		logOutput(
			`[SaveSync] Hinweis: Datei ueber Legacy-Pfadabgleich gefunden (${relativePath} vs ${entry.relativePath}).`
		);
		entry.relativePath = relativePath;
	}
	if (!entry) {
		logOutput(`[SaveSync] Skip: Datei nicht im Index enthalten (${relativePath}).`);
		return;
	}

	let content: string;
	try {
		content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			logOutput(`[SaveSync] Skip: Datei inzwischen geloescht (${relativePath}).`);
			return;
		}
		throw error;
	}
	const contentHash = hashContent(content);
	if (!pendingDashboardVersionUpdates.has(uri.toString())
		&& (synchronizedContentHashes.get(uri.toString()) ?? entry.contentHash) === contentHash) {
		logOutput(`[SaveSync] Skip: Inhalt unveraendert (${relativePath}, Quelle=${source}).`);
		return;
	}

	logOutput(`[SaveSync] Trigger (${source}): ${relativePath} -> ${entry.table}.${entry.field}`);

	entry.contextType ??= config.localConfig.contextType;

	if (entry.contextType === 'quickview') {
		entry.versionField ??= getVersionFieldForRecordType(entry.type);
		alignQuickviewVersionFromSiblingEntries(index, entry);
	}

	try {
		const pushed = entry.table === 'QVDASHBOARDQUERY'
			? await pushDashboardQueryUpdate(config, index, entry, content)
			: await pushUpdate(config, entry, content);
		if (!pushed) {
			vscode.window.setStatusBarMessage('ERP Sync: Update abgebrochen', 2500);
			return;
		}
		synchronizedContentHashes.set(uri.toString(), contentHash);
		pendingDashboardVersionUpdates.delete(uri.toString());

		try {
			entry.contentHash = contentHash;
			propagateVersionToSiblingEntries(index, entry);
			await writeIndex(config, index);
		} catch (writeError) {
			logOutput(`[SaveSync] Hinweis: Index konnte nach erfolgreichem Update nicht geschrieben werden: ${formatError(writeError)}`);
			vscode.window.showWarningMessage(
				'ERP Dashboard Sync: Update wurde gespeichert, aber der lokale Index konnte nicht aktualisiert werden. Bitte Output-Channel pruefen.'
			);
		}

		vscode.window.setStatusBarMessage(`ERP Sync: ${entry.recordName} (${entry.field}) aktualisiert`, 2500);
	} catch (error) {
		if (error instanceof PartialSyncError) {
			pendingDashboardVersionUpdates.add(uri.toString());
			synchronizedContentHashes.delete(uri.toString());
		}
		logOutput(`Save-Sync fehlgeschlagen fuer ${relativePath}: ${formatError(error)}`);
		vscode.window.showErrorMessage(
			error instanceof PartialSyncError
				? error.message
				: `ERP Dashboard Sync: Update fehlgeschlagen fuer ${entry.recordName} (${entry.field}). Details im Output-Channel.`
		);
	}
}

function alignQuickviewVersionFromSiblingEntries(index: FileIndex, entry: FileIndexEntry): void {
	const currentVersion = entry.version.trim();
	if (isDateVersionFormat(currentVersion)) {
		return;
	}

	const sibling = index.entries.find((candidate) => {
		if (candidate === entry) {
			return false;
		}

		if (candidate.contextType !== 'quickview' || candidate.guid !== entry.guid) {
			return false;
		}

		const candidateVersionField = candidate.versionField ?? getVersionFieldForRecordType(candidate.type);
		const entryVersionField = entry.versionField ?? getVersionFieldForRecordType(entry.type);
		if (candidateVersionField !== entryVersionField) {
			return false;
		}

		return isDateVersionFormat(candidate.version.trim());
	});

	if (!sibling) {
		return;
	}

	entry.version = sibling.version.trim();
}

function propagateVersionToSiblingEntries(index: FileIndex, entry: FileIndexEntry): void {
	const normalizedVersion = entry.version.trim();
	if (!normalizedVersion) {
		return;
	}

	for (const candidate of index.entries) {
		if (candidate.contextType !== entry.contextType || candidate.guid !== entry.guid) {
			continue;
		}

		if (entry.contextType === 'quickview') {
			const candidateVersionField = candidate.versionField ?? getVersionFieldForRecordType(candidate.type);
			const entryVersionField = entry.versionField ?? getVersionFieldForRecordType(entry.type);
			if (candidateVersionField !== entryVersionField) {
				continue;
			}
		}

		candidate.version = normalizedVersion;
	}
}

async function loadRuntimeConfig(
	context: DashboardContext,
	promptForDashboard: boolean
): Promise<RuntimeConfig | undefined> {
	const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
	const workspaceKey = context.workspaceFolder.uri.toString();
	if (!migratedWorkspaceFolders.has(workspaceKey)) {
		await migrateDeprecatedSettings(settings);
		migratedWorkspaceFolders.add(workspaceKey);
	}

	const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
	const localConfigUri = vscode.Uri.joinPath(context.uri, configFileName);
	let localConfig = normalizeLocalConfig(await readJsonFile<LocalConfig>(localConfigUri));
	const authSettings = await resolveAuthSettings(context, settings);
	const authUsernameRaw = authSettings.username;
	const authPassword = authSettings.password;
	const authDomainRaw = authSettings.domain;
	const authUsername = authUsernameRaw.trim();
	const authDomain = authDomainRaw.trim();

	if (!localConfig && !promptForDashboard) {
		return undefined;
	}

	if (!localConfig || !localConfig.dashboardId || promptForDashboard) {
		localConfig = await promptForWorkspaceConfig(localConfig);
		if (!localConfig) {
			return undefined;
		}

		await writeJsonFile(localConfigUri, localConfig);
	}

	const runtimeConfig: RuntimeConfig = {
		workspaceFolder: context.workspaceFolder,
		contextRoot: context.uri,
		localConfigUri,
		localConfig,
		dbFetchJsonUrl: settings.get<string>(
			'dbFetchJsonUrl',
			'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/customutils.asmx/dbFetchJSON'
		),
		xmlUpdateOfflineSoapUrl: settings.get<string>(
			'xmlUpdateOfflineSoapUrl',
			'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/utils.asmx/xmlUpdateOffline'
		),
		xmlUpdateOfflineRequestUrls: [],
		verboseLogging: settings.get<boolean>('verboseLogging', false),
		tlsAllowInsecure: settings.get<boolean>('tlsAllowInsecure', false),
		authMode: settings.get<AuthMode>('authMode', 'ntlm'),
		authUsername,
		authPassword,
		authDomain,
		authSource: authSettings.source,
		autoSyncOnSave: settings.get<boolean>('autoSyncOnSave', true),
		configFileName,
		indexFileName: settings.get<string>('indexFileName', '.erp-dashboard-sync-index.json'),
		generatedRootDir: settings.get<string>('generatedRootDir', 'erp-dashboard')
	};
	runtimeConfig.xmlUpdateOfflineRequestUrls = buildXmlUpdateOfflineRequestUrls(runtimeConfig.xmlUpdateOfflineSoapUrl);

	if (authUsernameRaw !== authUsername || authDomainRaw !== authDomain) {
		logOutput(
			'[Config] Hinweis: authUsername/authDomain wurden getrimmt (fuehrende/nachgestellte Leerzeichen entfernt).'
		);
	}

	logAuthConfigurationDiagnostics(settings, runtimeConfig);

	return runtimeConfig;
}

async function promptForWorkspaceConfig(existingConfig: LocalConfig | undefined): Promise<LocalConfig | undefined> {
	const contextType = await vscode.window.showQuickPick(
		[
			{ label: 'Quickview', value: 'quickview' as const, description: 'Eindeutiger Dashboard-Name' },
			{ label: 'Flow', value: 'flow' as const, description: 'GUID als technische Identitaet' }
		],
		{
			title: 'ERP Dashboard Sync',
			placeHolder: 'Welcher Typ soll synchronisiert werden?'
		}
	);

	if (!contextType) {
		return undefined;
	}

	const existingId = existingConfig?.contextType === contextType.value ? existingConfig.dashboardId : undefined;
	const existingTitle = existingConfig?.contextType === 'flow' ? existingConfig.displayName : undefined;
	const defaultId = existingId ?? (contextType.value === 'quickview' ? 'wss_001' : '');
	const identifierPrompt = contextType.value === 'quickview' ? 'QVDASHBOARD Name (z. B. wss_001)' : 'Flow GUID';
	const identifierTitle = contextType.value === 'quickview' ? 'ERP Dashboard Sync' : 'ERP Flow Sync';
	const identifierValue = await vscode.window.showInputBox({
		title: identifierTitle,
		prompt: identifierPrompt,
		value: defaultId,
		ignoreFocusOut: true,
		validateInput: (value) =>
			value.trim().length === 0
				? contextType.value === 'quickview'
					? 'Dashboard-Name ist erforderlich.'
					: 'GUID ist erforderlich.'
				: undefined
	});

	if (!identifierValue) {
		return undefined;
	}

	return {
		contextType: contextType.value,
		dashboardId: identifierValue.trim(),
		displayName: existingTitle,
		quickviewVersionState: existingConfig?.quickviewVersionState,
		flowVersionState: existingConfig?.flowVersionState
	};
}

function getContextLabel(contextType: DashboardContextType | undefined): string {
	return contextType === 'flow' ? 'Flow' : 'Quickview';
}

function getWorkspaceLabel(localConfig: LocalConfig): string {
	if (localConfig.contextType === 'flow' && localConfig.displayName?.trim()) {
		return `${localConfig.dashboardId} (${localConfig.displayName.trim()})`;
	}

	return localConfig.dashboardId;
}

async function persistFlowDisplayName(config: RuntimeConfig, fetchedTitle: string | undefined): Promise<void> {
	if (config.localConfig.contextType !== 'flow') {
		return;
	}

	const normalizedTitle = fetchedTitle?.trim();
	if (!normalizedTitle) {
		return;
	}

	if (config.localConfig.displayName === normalizedTitle) {
		return;
	}

	config.localConfig.displayName = normalizedTitle;
	await writeJsonFile(config.localConfigUri, config.localConfig);
}

function normalizeLocalConfig(localConfig: LocalConfig | undefined): LocalConfig | undefined {
	if (!localConfig) {
		return undefined;
	}

	return {
		contextType: localConfig.contextType ?? 'quickview',
		dashboardId: localConfig.dashboardId?.trim() ?? '',
		displayName: localConfig.displayName?.trim() ? localConfig.displayName.trim() : undefined,
		quickviewVersionState: localConfig.quickviewVersionState
			? {
				lastPromptDate: localConfig.quickviewVersionState.lastPromptDate?.trim() || undefined,
				pendingVersion: localConfig.quickviewVersionState.pendingVersion?.trim() || undefined
			}
			: undefined,
		flowVersionState: localConfig.flowVersionState
			? {
				lastPromptDate: localConfig.flowVersionState.lastPromptDate?.trim() || undefined,
				pendingBump: localConfig.flowVersionState.pendingBump
			}
			: undefined
	};
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
		logOutput(
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
		logOutput(
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

	logOutput('[Config] ERP Dashboard Sync runtime configuration loaded.');
	logOutput(`[Config] Workspace folder: ${config.workspaceFolder.uri.fsPath}`);
	logOutput(`[Config] Dashboard folder: ${config.contextRoot.fsPath}`);
	logOutput(`[Config] authMode=${config.authMode}`);
	logOutput(`[Config] authSource=${config.authSource}`);
	logOutput(`[Config] verboseLogging=${config.verboseLogging ? 'yes' : 'no'}`);
	logOutput(`[Config] tlsAllowInsecure=${config.tlsAllowInsecure ? 'yes' : 'no'}`);
	logOutput(
		`[Config] authUsername set=${config.authUsername.trim().length > 0 ? 'yes' : 'no'} (length=${config.authUsername.length})`
	);
	logOutput(
		`[Config] authPassword set=${config.authPassword.length > 0 ? 'yes' : 'no'} (length=${config.authPassword.length})`
	);
	logOutput(
		`[Config] authUsername scopes: global=${usernameInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${usernameInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${usernameInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);
	logOutput(
		`[Config] authPassword scopes: global=${passwordInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${passwordInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${passwordInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);
	logOutput(
		`[Config] authDomain set=${config.authDomain.length > 0 ? 'yes' : 'no'} (length=${config.authDomain.length})`
	);
	logOutput(
		`[Config] authDomain scopes: global=${domainInspect?.globalValue !== undefined ? 'set' : 'empty'}, workspace=${domainInspect?.workspaceValue !== undefined ? 'set' : 'empty'}, workspaceFolder=${domainInspect?.workspaceFolderValue !== undefined ? 'set' : 'empty'}`
	);

	if (config.authUsername.includes('\\') && config.authDomain.length > 0) {
		logOutput(
			"[Config] Warnung: Username enthaelt bereits 'domain\\user' UND authDomain ist gesetzt. Das fuehrt oft zu 401."
		);
	}
}

async function resolveAuthSettings(
	context: DashboardContext,
	settings: vscode.WorkspaceConfiguration
): Promise<StoredCredentials & { source: 'settings' | 'secretStorage' }> {
	const stored = await readCredentialsFromSecretStorage(context, 'workspace')
		?? (context.uri.toString() !== context.workspaceFolder.uri.toString()
			? await readCredentialsFromSecretStorage(context.workspaceFolder, 'workspace')
			: undefined);
	if (stored) {
		return {
			...stored,
			source: 'secretStorage'
		};
	}

	const storedGlobal = await readCredentialsFromSecretStorage(context, 'global');
	if (storedGlobal) {
		return {
			...storedGlobal,
			source: 'secretStorage'
		};
	}

	return {
		username: settings.get<string>('authUsername', ''),
		password: settings.get<string>('authPassword', ''),
		domain: settings.get<string>('authDomain', ''),
		source: 'settings'
	};
}

async function setCredentialsInSecretStorage(selectedContext?: DashboardContext): Promise<void> {
	const context = selectedContext ?? (await selectDashboardContexts('credentials'))?.[0];
	if (!context) {
		return;
	}

	if (!extensionContext) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Secret Storage ist nicht verfuegbar.');
		return;
	}

	const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
	const current = await resolveAuthSettings(context, settings);

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

	const scopeChoice = await vscode.window.showQuickPick(
		[
			{ label: 'Nur fuer diesen Dashboard-Ordner speichern', description: context.uri.fsPath, value: 'workspace' as const },
			{ label: 'Global fuer alle Workspaces speichern', value: 'global' as const }
		],
		{
			title: 'ERP Dashboard Sync Credentials',
			placeHolder: 'Wo sollen die Credentials gespeichert werden?'
		}
	);

	if (!scopeChoice) {
		return;
	}

	await writeCredentialsToSecretStorage(context, {
		username: username.trim(),
		password: passwordInput.length > 0 ? passwordInput : current.password,
		domain: domain.trim()
	}, scopeChoice.value);

	vscode.window.showInformationMessage(
		scopeChoice.value === 'global'
			? 'ERP Dashboard Sync: Credentials global im Secret Storage gespeichert.'
			: `ERP Dashboard Sync: Credentials fuer '${context.uri.fsPath}' im Secret Storage gespeichert.`
	);
}

async function clearCredentialsInSecretStorage(): Promise<void> {
	const context = (await selectDashboardContexts('credentials'))?.[0];
	if (!context) {
		return;
	}

	if (!extensionContext) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Secret Storage ist nicht verfuegbar.');
		return;
	}

	const scopeChoice = await vscode.window.showQuickPick(
		[
			{ label: 'Credentials fuer diesen Dashboard-Ordner loeschen', description: context.uri.fsPath, value: 'workspace' as const },
			{ label: 'Globale Credentials loeschen', value: 'global' as const },
			{ label: 'Beides loeschen', value: 'both' as const }
		],
		{
			title: 'ERP Dashboard Sync Credentials',
			placeHolder: 'Welche gespeicherten Credentials sollen geloescht werden?'
		}
	);

	if (!scopeChoice) {
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

	if (scopeChoice.value === 'workspace' || scopeChoice.value === 'both') {
		await deleteCredentialsFromSecretStorage(context, 'workspace');
	}

	if (scopeChoice.value === 'global' || scopeChoice.value === 'both') {
		await deleteCredentialsFromSecretStorage(context, 'global');
	}

	vscode.window.showInformationMessage('ERP Dashboard Sync: Gewaehlte Credentials wurden aus Secret Storage geloescht.');
}

async function resetVersionPromptState(): Promise<void> {
	const context = (await selectDashboardContexts('reset'))?.[0];
	if (!context) {
		return;
	}
	await enqueueSyncOperation(() => resetContextVersionPromptState(context));
}

async function resetContextVersionPromptState(context: DashboardContext): Promise<void> {
	const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
	const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
	const localConfigUri = vscode.Uri.joinPath(context.uri, configFileName);
	const localConfig = normalizeLocalConfig(await readJsonFile<LocalConfig>(localConfigUri));
	if (!localConfig) {
		vscode.window.showWarningMessage('ERP Dashboard Sync: Keine lokale Konfiguration gefunden.');
		return;
	}

	const hasQuickviewState = Boolean(localConfig.quickviewVersionState?.lastPromptDate || localConfig.quickviewVersionState?.pendingVersion);
	const hasFlowState = Boolean(localConfig.flowVersionState?.lastPromptDate || localConfig.flowVersionState?.pendingBump);
	if (!hasQuickviewState && !hasFlowState) {
		vscode.window.showInformationMessage('ERP Dashboard Sync: Es sind keine gespeicherten Versions-Prompt-States vorhanden.');
		return;
	}

	const answer = await vscode.window.showWarningMessage(
		'ERP Dashboard Sync: Gespeicherte Tagesentscheidung fuer Versionierung zuruecksetzen?',
		{ modal: true },
		'Zuruecksetzen'
	);
	if (answer !== 'Zuruecksetzen') {
		return;
	}

	delete localConfig.quickviewVersionState;
	delete localConfig.flowVersionState;
	await writeJsonFile(localConfigUri, localConfig);
	vscode.window.showInformationMessage('ERP Dashboard Sync: Versions-Prompt-States wurden zurueckgesetzt.');
}

function getSecretStorageKey(context: { uri: vscode.Uri }, scope: CredentialScope): string {
	if (scope === 'global') {
		return `${SECRET_STORAGE_PREFIX}:credentials:global`;
	}

	return `${SECRET_STORAGE_PREFIX}:credentials:${context.uri.toString()}`;
}

async function readCredentialsFromSecretStorage(
	context: { uri: vscode.Uri },
	scope: CredentialScope
): Promise<StoredCredentials | undefined> {
	if (!extensionContext) {
		return undefined;
	}

	const key = getSecretStorageKey(context, scope);
	const raw = await extensionContext.secrets.get(key);
	if (!raw) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
		return {
			username: typeof parsed.username === 'string' ? parsed.username : '',
			password: typeof parsed.password === 'string' ? parsed.password : '',
			domain: typeof parsed.domain === 'string' ? parsed.domain : ''
		};
	} catch (error) {
		logOutput(`[Config] Ungueltiger Secret-Storage Inhalt, verwende Settings-Fallback: ${formatError(error)}`);
		return undefined;
	}
}

async function writeCredentialsToSecretStorage(
	context: { uri: vscode.Uri },
	credentials: StoredCredentials,
	scope: CredentialScope
): Promise<void> {
	if (!extensionContext) {
		throw new Error('Secret Storage ist nicht verfuegbar.');
	}

	const key = getSecretStorageKey(context, scope);
	await extensionContext.secrets.store(key, JSON.stringify(credentials));
}

async function deleteCredentialsFromSecretStorage(
	context: { uri: vscode.Uri },
	scope: CredentialScope
): Promise<void> {
	if (!extensionContext) {
		return;
	}

	const key = getSecretStorageKey(context, scope);
	await extensionContext.secrets.delete(key);
}

async function fetchWorkspaceRows(config: RuntimeConfig): Promise<DbRow[]> {
	if (config.localConfig.contextType === 'flow') {
		return fetchFlowRows(config);
	}

	return fetchQuickviewRows(config);
}

async function fetchQuickviewRows(config: RuntimeConfig): Promise<DbRow[]> {
	const executeFetch = async (includeAnpVersion: boolean): Promise<string> => {
		const sql = buildQuickviewSql(config.localConfig.dashboardId, includeAnpVersion);
		const fetchUrl = new URL(config.dbFetchJsonUrl);
		fetchUrl.searchParams.set('sql', sql);
		logOutput(
			`[DBFetch] Quickview request: dashboard=${config.localConfig.dashboardId}, mode=${includeAnpVersion ? 'with ANP_VERSION' : 'without ANP_VERSION (fallback)'}, endpoint=${config.dbFetchJsonUrl}, sqlLength=${sql.length}`
		);
		logVerbose(config, `[DBFetch] Request URL (encoded): ${fetchUrl.toString()}`);
		logVerbose(config, `[DBFetch] SQL (decoded):\n${sql}`);

		return requestText({
			method: 'GET',
			url: fetchUrl.toString(),
			config
		});
	};

	let responseText: string;
	try {
		responseText = await executeFetch(true);
	} catch (error) {
		if (!shouldFallbackWithoutAnpVersion(error)) {
			throw error;
		}

		logOutput(
			`[DBFetch] Anfrage mit ANP_VERSION fehlgeschlagen, fallback ohne ANP_VERSION wird versucht: ${formatError(error)}`
		);
		responseText = await executeFetch(false);
	}

	return parseWorkspaceRows(responseText, config, 'quickview');
}

async function fetchFlowRows(config: RuntimeConfig): Promise<DbRow[]> {
	const sql = buildFlowSql(config.localConfig.dashboardId);
	const fetchUrl = new URL(config.dbFetchJsonUrl);
	fetchUrl.searchParams.set('sql', sql);
	logOutput(
		`[DBFetch] Flow request: guid=${config.localConfig.dashboardId}, endpoint=${config.dbFetchJsonUrl}, sqlLength=${sql.length}`
	);
	logVerbose(config, `[DBFetch] Request URL (encoded): ${fetchUrl.toString()}`);
	logVerbose(config, `[DBFetch] SQL (decoded):\n${sql}`);

	const responseText = await requestText({
		method: 'GET',
		url: fetchUrl.toString(),
		config
	});

	return parseWorkspaceRows(responseText, config, 'flow');
}

async function parseWorkspaceRows(responseText: string, config: RuntimeConfig, contextType: DashboardContextType): Promise<DbRow[]> {
	if (!responseText || responseText.trim().length === 0) {
		logOutput('[DBFetch] Leere Antwort erhalten (Body length = 0).');
		throw new Error(
			'dbFetchJSON hat eine leere Antwort geliefert. Bitte NTLM-Logs mit HTTP-Status/Header pruefen (moeglicher Redirect oder Endpoint-/Scope-Mismatch).'
		);
	}

	const rawJson = extractXmlStringValue(responseText);
	logOutput(
		`[DBFetch] Response received: xmlLength=${responseText.length}, extractedJsonLength=${rawJson.length}`
	);
	logVerbose(config, `[DBFetch] Raw XML response:\n${responseText}`);
	logVerbose(config, `[DBFetch] Extracted JSON string:\n${rawJson}`);
	const parsed = await parseDbFetchJson(rawJson);
	const list = Array.isArray(parsed) ? parsed : [parsed];
	logOutput(`[DBFetch] Parsed JSON elements: ${list.length}`);

	return list
		.map((item) => normalizeDbRow(item, contextType))
		.filter((item): item is DbRow => item !== undefined);
}

function shouldFallbackWithoutAnpVersion(error: unknown): boolean {
	const message = formatError(error).toLowerCase();
	const mentionsAnpVersion = /anp[_\s-]?version/.test(message);
	if (!mentionsAnpVersion) {
		return false;
	}

	const isColumnError =
		message.includes('invalid column') ||
		message.includes('unknown column') ||
		message.includes('ungueltiger spaltenname') ||
		message.includes('ung\u00fcltiger spaltenname') ||
		message.includes('spaltenname');

	return isColumnError;
}

async function parseDbFetchJson(rawJson: string): Promise<unknown> {
	try {
		return JSON.parse(rawJson);
	} catch (initialError) {
		logOutput(`[DBFetch] JSON.parse fehlgeschlagen: ${formatError(initialError)}`);
		logJsonErrorContext(rawJson, initialError, 'initial');

		const sanitized = rawJson.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
		if (sanitized !== rawJson) {
			logOutput('[DBFetch] Hinweis: Ungueltige Steuerzeichen wurden entfernt, erneuter Parse-Versuch.');
			try {
				return JSON.parse(sanitized);
			} catch (sanitizedError) {
				logOutput(`[DBFetch] Parse nach Steuerzeichen-Bereinigung fehlgeschlagen: ${formatError(sanitizedError)}`);
				logJsonErrorContext(sanitized, sanitizedError, 'sanitized');
			}
		}

		try {
			const { jsonrepair } = await import('jsonrepair');
			const repaired = jsonrepair(sanitized);
			logOutput('[DBFetch] Hinweis: JSON wurde mit jsonrepair repariert.');
			return JSON.parse(repaired);
		} catch (repairError) {
			logOutput(`[DBFetch] JSON-Reparatur fehlgeschlagen: ${formatError(repairError)}`);
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
	logOutput(`[DBFetch] JSON-Fehlerkontext (${stage}) @${position}: ${context}`);

	const segment = input.slice(0, position);
	const qvMatches = [...segment.matchAll(/"qvquery"\s*:\s*"([^"]*)"/g)];
	const guidMatches = [...segment.matchAll(/"GUID"\s*:\s*"([^"]*)"/g)];
	const qvquery = qvMatches.length > 0 ? qvMatches[qvMatches.length - 1][1] : 'unknown';
	const guid = guidMatches.length > 0 ? guidMatches[guidMatches.length - 1][1] : 'unknown';
	logOutput(`[DBFetch] Vermutlich betroffener Datensatz: qvquery='${qvquery}', guid='${guid}'`);
}

async function materializeFiles(config: RuntimeConfig, rows: DbRow[]): Promise<FileIndex> {
	const entries: FileIndexEntry[] = [];
	const rootName = sanitizePathPart(config.localConfig.dashboardId);
	const rootDir = vscode.Uri.joinPath(config.contextRoot, config.generatedRootDir, rootName);
	await vscode.workspace.fs.createDirectory(rootDir);

	for (const row of rows) {
		if (config.localConfig.contextType === 'flow') {
			await materializeFlowRow(config, rootDir, rootName, row, entries);
		} else {
			await materializeQuickviewRow(config, rootDir, rootName, row, entries);
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		contextType: config.localConfig.contextType,
		dashboardId: config.localConfig.dashboardId,
		entries
	};
}

async function materializeQuickviewRow(
	config: RuntimeConfig,
	rootDir: vscode.Uri,
	rootName: string,
	row: DbRow,
	entries: FileIndexEntry[]
): Promise<void> {
	const recordDir = vscode.Uri.joinPath(rootDir, row.type.toLowerCase());
	await vscode.workspace.fs.createDirectory(recordDir);

	const fileNameParts = [sanitizePathPart(row.name)];
	if (row.title.trim().length > 0) {
		fileNameParts.push(sanitizePathPart(row.title));
	}
	fileNameParts.push(sanitizePathPart(row.guid));
	const fileBaseName = fileNameParts.join('__');
	const jsRelativePath = toPosixPath(path.join(config.generatedRootDir, rootName, row.type.toLowerCase(), `${fileBaseName}.js`));
	const cssRelativePath = toPosixPath(path.join(config.generatedRootDir, rootName, row.type.toLowerCase(), `${fileBaseName}.css`));

	await writeGeneratedFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.js`), row.jsPageScript ?? '');
	await writeGeneratedFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.css`), row.cssStyle ?? '');
	if (row.type === 'QUERY') {
		await writeGeneratedFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.sql`), row.statement ?? '');
		await writeGeneratedFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.options.xml`), row.options ?? '');
	}

	entries.push({
		relativePath: jsRelativePath,
		contentHash: hashContent(row.jsPageScript ?? ''),
		table: row.type === 'QUERY' ? 'QVQUERY' : 'QVDASHBOARD',
		field: 'JSPAGESCRIPT',
		versionField: row.type === 'QUERY' ? 'VERSION' : 'ANP_VERSION',
		guid: row.guid,
		recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
		type: row.type,
		version: row.version,
		contextType: 'quickview'
	});

	entries.push({
		relativePath: cssRelativePath,
		contentHash: hashContent(row.cssStyle ?? ''),
		table: row.type === 'QUERY' ? 'QVQUERY' : 'QVDASHBOARD',
		field: 'CSSSTYLE',
		versionField: row.type === 'QUERY' ? 'VERSION' : 'ANP_VERSION',
		guid: row.guid,
		recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
		type: row.type,
		version: row.version,
		contextType: 'quickview'
	});

	if (row.type === 'QUERY') {
		const sqlRelativePath = toPosixPath(path.join(config.generatedRootDir, rootName, row.type.toLowerCase(), `${fileBaseName}.sql`));
		entries.push({
			relativePath: sqlRelativePath,
			contentHash: hashContent(row.statement ?? ''),
			table: 'QVQUERY',
			field: 'STATEMENT',
			versionField: 'VERSION',
			guid: row.guid,
			recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
			type: row.type,
			version: row.version,
			contextType: 'quickview'
		});
		entries.push({
			relativePath: toPosixPath(path.join(config.generatedRootDir, rootName, 'query', `${fileBaseName}.options.xml`)),
			contentHash: hashContent(row.options ?? ''),
			table: 'QVQUERY',
			field: 'OPTIONS',
			versionField: 'VERSION',
			guid: row.guid,
			recordName: row.title.trim().length > 0 ? `${row.name} - ${row.title}` : row.name,
			type: 'QUERY',
			version: row.version,
			contextType: 'quickview'
		});
		await materializeDashboardQueryFiles(config, rootDir, rootName, row, entries);
	}
}

async function materializeDashboardQueryFiles(
	config: RuntimeConfig,
	rootDir: vscode.Uri,
	rootName: string,
	row: DbRow,
	entries: FileIndexEntry[]
): Promise<void> {
	if (!row.dashboardQueryGuid) {
		return;
	}
	const recordDir = vscode.Uri.joinPath(rootDir, 'dashboard-query');
	await vscode.workspace.fs.createDirectory(recordDir);
	const fileBaseName = [row.name, row.title, row.dashboardQueryGuid]
		.filter((part) => part.trim().length > 0).map(sanitizePathPart).join('__');
	const fields = [
		{ field: 'PARAMSTRING', suffix: 'paramstring.txt', content: row.paramString ?? '' },
		{ field: 'JSCHARTSCRIPT', suffix: 'jschartscript.js', content: row.jsChartScript ?? '' },
		{ field: 'CHARTOPTIONS', suffix: 'chartoptions.js', content: row.chartOptions ?? '' }
	] as const;
	for (const { field, suffix, content } of fields) {
		const fileName = `${fileBaseName}.${suffix}`;
		await writeGeneratedFile(vscode.Uri.joinPath(recordDir, fileName), content);
		entries.push({
			relativePath: toPosixPath(path.join(config.generatedRootDir, rootName, 'dashboard-query', fileName)),
			contentHash: hashContent(content),
			table: 'QVDASHBOARDQUERY',
			field,
			guid: row.dashboardQueryGuid,
			recordName: `${row.name}${row.title.trim() ? ` - ${row.title}` : ''} (Dashboard-Zuordnung)`,
			type: 'DASHBOARDQUERY',
			version: '',
			contextType: 'quickview'
		});
	}
}

async function materializeFlowRow(
	config: RuntimeConfig,
	rootDir: vscode.Uri,
	rootName: string,
	row: DbRow,
	entries: FileIndexEntry[]
): Promise<void> {
	const fileBaseName = sanitizePathPart(row.guid);
	const flowRecordDir = vscode.Uri.joinPath(rootDir, fileBaseName);
	await vscode.workspace.fs.createDirectory(flowRecordDir);

	const xmlRelativePath = toPosixPath(path.join(config.generatedRootDir, rootName, fileBaseName, `${fileBaseName}.xml`));
	const jsRelativePath = toPosixPath(path.join(config.generatedRootDir, rootName, fileBaseName, `${fileBaseName}.js`));
	const sqlRelativePath = toPosixPath(path.join(config.generatedRootDir, rootName, fileBaseName, `${fileBaseName}.sql`));

	await writeGeneratedFile(vscode.Uri.joinPath(flowRecordDir, `${fileBaseName}.xml`), row.xmlDefinition ?? '');
	await writeGeneratedFile(vscode.Uri.joinPath(flowRecordDir, `${fileBaseName}.js`), row.javascript ?? '');
	await writeGeneratedFile(vscode.Uri.joinPath(flowRecordDir, `${fileBaseName}.sql`), row.sqlStatement ?? '');

	const recordName = row.title.trim().length > 0 ? `${row.title.trim()} (${row.guid})` : row.guid;
	entries.push({
		relativePath: xmlRelativePath,
		contentHash: hashContent(row.xmlDefinition ?? ''),
		table: 'FLOWBOARD',
		field: 'XMLDEFINITION',
		guid: row.guid,
		recordName,
		type: 'DASHBOARD',
		version: row.version,
		contextType: 'flow'
	});
	entries.push({
		relativePath: jsRelativePath,
		contentHash: hashContent(row.javascript ?? ''),
		table: 'FLOWBOARD',
		field: 'JAVASCRIPT',
		guid: row.guid,
		recordName,
		type: 'DASHBOARD',
		version: row.version,
		contextType: 'flow'
	});
	entries.push({
		relativePath: sqlRelativePath,
		contentHash: hashContent(row.sqlStatement ?? ''),
		table: 'FLOWBOARD',
		field: 'SQLSTATEMENT',
		guid: row.guid,
		recordName,
		type: 'DASHBOARD',
		version: row.version,
		contextType: 'flow'
	});
}

async function writeIndex(config: RuntimeConfig, index: FileIndex): Promise<void> {
	const indexUri = vscode.Uri.joinPath(config.contextRoot, config.indexFileName);
	await writeJsonFile(indexUri, index);
}

async function readIndex(config: RuntimeConfig): Promise<FileIndex | undefined> {
	const indexUri = vscode.Uri.joinPath(config.contextRoot, config.indexFileName);
	return readJsonFile<FileIndex>(indexUri);
}

async function pushDashboardQueryUpdate(
	config: RuntimeConfig,
	index: FileIndex,
	entry: FileIndexEntry,
	content: string
): Promise<boolean> {
	const dashboards = index.entries.filter((candidate) => candidate.table === 'QVDASHBOARD');
	const dashboard = dashboards[0];
	if (!dashboard || new Set(dashboards.map((candidate) => candidate.guid)).size !== 1) {
		throw new Error('Dashboard-Version kann nicht eindeutig zugeordnet werden. Bitte zuerst "Reload From ERP" ausfuehren.');
	}
	dashboard.contextType ??= 'quickview';
	dashboard.versionField = 'ANP_VERSION';
	alignQuickviewVersionFromSiblingEntries(index, dashboard);
	const versionValue = await resolveQuickviewVersionValue(config, dashboard);
	if (versionValue === undefined) {
		return false;
	}

	logOutput(`[SaveSync] Dashboard-Version target: QVDASHBOARD.ANP_VERSION=${versionValue}, GUID=${dashboard.guid}`);
	await sendUpdateFields(config, entry, [{ field: entry.field, value: content }]);
	try {
		await sendUpdateFields(config, dashboard, [{ field: 'ANP_VERSION', value: versionValue }]);
	} catch (error) {
		logOutput(`[SaveSync] Zuordnungsinhalt gespeichert, Dashboard-Version fehlgeschlagen: ${formatError(error)}`);
		throw new PartialSyncError(
			'ERP Dashboard Sync: Der Zuordnungsinhalt wurde gespeichert, aber die Dashboard-Version konnte nicht aktualisiert werden. Bitte erneut speichern. Details im Output-Channel.',
			{ cause: error }
		);
	}
	dashboard.version = versionValue;
	propagateVersionToSiblingEntries(index, dashboard);
	return true;
}

async function pushUpdate(config: RuntimeConfig, entry: FileIndexEntry, content: string): Promise<boolean> {
	const versionField = entry.contextType === 'quickview' ? entry.versionField ?? getVersionFieldForRecordType(entry.type) : entry.versionField;
	let versionValue: string | undefined;
	let flowVersionUpdate: { major: string; minor: string; patch: string } | undefined;
	if (entry.contextType === 'quickview' && versionField) {
		versionValue = await resolveQuickviewVersionValue(config, entry);
		if (versionValue === undefined) {
			return false;
		}
	}

	if (entry.contextType === 'flow') {
		flowVersionUpdate = await resolveFlowVersionUpdate(config, entry);
		if (!flowVersionUpdate) {
			return false;
		}
	}

	const updateFields: Array<{ field: string; value: string }> = [
		{ field: entry.field, value: content }
	];
	if (versionField && versionValue !== undefined) {
		updateFields.push({ field: versionField, value: versionValue });
	}
	if (flowVersionUpdate) {
		updateFields.push({ field: 'MAJORVERSION', value: flowVersionUpdate.major });
		updateFields.push({ field: 'MINORVERSION', value: flowVersionUpdate.minor });
		updateFields.push({ field: 'PATCHVERSION', value: flowVersionUpdate.patch });
	}
	if (versionField && versionValue !== undefined) {
		logOutput(`[SaveSync] Version target: ${entry.table}.${versionField}=${versionValue}`);
	}
	if (flowVersionUpdate) {
		logOutput(
			`[SaveSync] Version target: ${entry.table}.MAJORVERSION=${flowVersionUpdate.major}, ${entry.table}.MINORVERSION=${flowVersionUpdate.minor}, ${entry.table}.PATCHVERSION=${flowVersionUpdate.patch}`
		);
	}
	logOutput(`[SaveSync] Content length: ${content.length}`);
	await sendUpdateFields(config, entry, updateFields);
	if (versionValue !== undefined) {
		entry.version = versionValue;
	}
	if (flowVersionUpdate) {
		entry.version = `${flowVersionUpdate.major}.${flowVersionUpdate.minor}.${flowVersionUpdate.patch}`;
	}
	return true;
}

async function sendUpdateFields(
	config: RuntimeConfig,
	entry: FileIndexEntry,
	updateFields: Array<{ field: string; value: string }>
): Promise<void> {
	const updateData = toCData(buildUpdateDataRow(updateFields));
	const whereClause = `GUID='${escapeSqlString(entry.guid)}'`;
	logOutput('[SaveSync] Transport: soap12');
	logOutput(`[SaveSync] Target: ${entry.table}.${updateFields.map(({ field }) => field).join(',')}`);
	logOutput(`[SaveSync] Record: ${entry.recordName} (${entry.type})`);
	logOutput(`[SaveSync] GUID: ${entry.guid}`);

	const soapBody = buildSoapEnvelope(entry.table, updateData, whereClause);
	logOutput(`[SaveSync] Method: POST`);
	logOutput(`[SaveSync] Configured endpoint: ${config.xmlUpdateOfflineSoapUrl}`);
	logOutput(`[SaveSync] Headers: Content-Type=application/soap+xml; charset=utf-8`);
	logOutput(`[SaveSync] SOAP payload prepared (length=${soapBody.length})`);
	logVerbose(config, `[SaveSync] SOAP body:\n${soapBody}`);

	let lastError: unknown;
	for (let index = 0; index < config.xmlUpdateOfflineRequestUrls.length; index += 1) {
		const endpoint = config.xmlUpdateOfflineRequestUrls[index];
		logOutput(`[SaveSync] Endpoint candidate ${index + 1}/${config.xmlUpdateOfflineRequestUrls.length}: ${endpoint}`);
		try {
			await requestText({
				method: 'POST',
				url: endpoint,
				headers: {
					'Content-Type': 'application/soap+xml; charset=utf-8'
				},
				body: soapBody,
				config
			});
			lastError = undefined;
			break;
		} catch (error) {
			lastError = error;
			logOutput(`[SaveSync] Endpoint candidate fehlgeschlagen: ${formatError(error)}`);
		}
	}

	if (lastError) {
		throw lastError;
	}
	logOutput('[SaveSync] Request erfolgreich abgeschlossen.');
}

function buildXmlUpdateOfflineRequestUrls(configuredUrl: string): string[] {
	const trimmed = configuredUrl.trim();
	if (!trimmed) {
		throw new Error('erpDashboardSync.xmlUpdateOfflineSoapUrl darf nicht leer sein.');
	}

	const candidates: string[] = [];
	const addCandidate = (value: string): void => {
		const normalized = value.replace(/\/+$/, '');
		if (!normalized || candidates.includes(normalized)) {
			return;
		}

		candidates.push(normalized);
	};

	addCandidate(trimmed);
	if (/\/xmlUpdateOffline\/?$/i.test(trimmed)) {
		addCandidate(trimmed.replace(/\/xmlUpdateOffline\/?$/i, ''));
	} else if (/\.asmx\/?$/i.test(trimmed)) {
		addCandidate(`${trimmed.replace(/\/+$/, '')}/xmlUpdateOffline`);
	}

	return candidates;
}

function buildUpdateDataRow(fields: Array<{ field: string; value: string }>): string {
	// XML normalizes literal CR/CRLF; character references preserve the saved content.
	const rowContent = fields
		.map(({ field, value }) => `<${field}>${escapeXml(value).replace(/\r/g, '&#13;')}</${field}>`)
		.join('');
	return `<row>${rowContent}</row>`;
}

function formatVersionStamp(value: Date): string {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, '0');
	const day = String(value.getDate()).padStart(2, '0');
	return `${year}${month}${day}`;
}

async function resolveQuickviewVersionValue(config: RuntimeConfig, entry: FileIndexEntry): Promise<string | undefined> {
	const currentVersion = entry.version.trim();
	logOutput(
		`[Versioning][Quickview] Record='${entry.recordName}', current='${currentVersion || '<leer>'}', type=${entry.type}`
	);
	if (isDateVersionFormat(currentVersion)) {
		const autoVersion = formatVersionStamp(new Date());
		logOutput(
			`[Versioning][Quickview] Decision=auto-date, reason=current format YYYYMMDD, newVersion='${autoVersion}'`
		);
		return autoVersion;
	}

	const todayKey = getTodayKey();
	const quickviewState = config.localConfig.quickviewVersionState;
	if (quickviewState?.lastPromptDate === todayKey && quickviewState.pendingVersion?.trim()) {
		const reusedVersion = quickviewState.pendingVersion.trim();
		logOutput(
			`[Versioning][Quickview] Decision=reuse-daily, date=${todayKey}, reusedVersion='${reusedVersion}'`
		);
		return reusedVersion;
	}

	logOutput(
		`[Versioning][Quickview] Decision=prompt-manual, reason=non-date current version and no stored decision for ${todayKey}`
	);

	const manualVersion = await vscode.window.showInputBox({
		title: 'ERP Dashboard Sync',
		prompt: `Quickview '${entry.recordName}': Welcher neue Versionsstand soll gespeichert werden? Aktueller Stand: '${currentVersion || '<leer>'}'.`,
		value: currentVersion || formatVersionStamp(new Date()),
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim().length === 0 ? 'Versionsstand darf nicht leer sein.' : undefined)
	});

	if (manualVersion === undefined) {
		logOutput('[Versioning][Quickview] Decision=cancelled-by-user');
		return undefined;
	}

	config.localConfig.quickviewVersionState = {
		lastPromptDate: todayKey,
		pendingVersion: manualVersion.trim()
	};
	await writeJsonFile(config.localConfigUri, config.localConfig);
	logOutput(
		`[Versioning][Quickview] Decision=manual-input, storedForDate=${todayKey}, newVersion='${manualVersion.trim()}'`
	);

	return manualVersion.trim();
}

async function resolveFlowVersionUpdate(
	config: RuntimeConfig,
	entry: FileIndexEntry
): Promise<{ major: string; minor: string; patch: string } | undefined> {
	logOutput(
		`[Versioning][Flow] Record='${entry.recordName}', current='${entry.version || '<leer>'}'`
	);
	const currentParts = parseFlowVersion(entry.version);
	if (!currentParts) {
		logOutput('[Versioning][Flow] Decision=prompt-manual-version, reason=current version not parseable as MAJOR.MINOR.PATCH');
		const manualParts = await promptFlowVersionParts(entry);
		if (!manualParts) {
			logOutput('[Versioning][Flow] Decision=cancelled-by-user');
			return undefined;
		}
		logOutput(
			`[Versioning][Flow] Decision=manual-version, newVersion='${manualParts.major}.${manualParts.minor}.${manualParts.patch}'`
		);

		return manualParts;
	}

	if (isFlowDateVersion(currentParts)) {
		const now = new Date();
		const autoVersion = {
			major: String(now.getFullYear()),
			minor: String(now.getMonth() + 1).padStart(2, '0'),
			patch: String(now.getDate()).padStart(2, '0')
		};
		logOutput(
			`[Versioning][Flow] Decision=auto-date, reason=current format YYYY.MM.DD, newVersion='${autoVersion.major}.${autoVersion.minor}.${autoVersion.patch}'`
		);
		return autoVersion;
	}

	const todayKey = getTodayKey();
	let bump = config.localConfig.flowVersionState?.lastPromptDate === todayKey
		? config.localConfig.flowVersionState.pendingBump
		: undefined;
	if (bump) {
		logOutput(`[Versioning][Flow] Decision=reuse-daily-bump, date=${todayKey}, bump=${bump}`);
	}

	if (!bump) {
		logOutput(
			`[Versioning][Flow] Decision=prompt-bump, reason=non-date version and no stored bump for ${todayKey}`
		);
		const decision = await vscode.window.showQuickPick(
			[
				{ label: 'Major +1', value: 'majorversion' as const },
				{ label: 'Minor +1', value: 'minorversion' as const },
				{ label: 'Fix +1', value: 'patchversion' as const }
			],
			{
				title: 'ERP Flow Sync',
				placeHolder: `Flow '${entry.recordName}': Aktuelle Version '${entry.version || '<leer>'}'. Welcher Teil soll um 1 erhoeht werden?`,
				ignoreFocusOut: true
			}
		);

		if (!decision) {
			logOutput('[Versioning][Flow] Decision=cancelled-by-user');
			return undefined;
		}

		bump = decision.value;
		config.localConfig.flowVersionState = {
			lastPromptDate: todayKey,
			pendingBump: bump
		};
		await writeJsonFile(config.localConfigUri, config.localConfig);
		logOutput(`[Versioning][Flow] Decision=manual-bump, storedForDate=${todayKey}, bump=${bump}`);
	}

	const bumped = bumpFlowVersion(currentParts, bump);
	logOutput(
		`[Versioning][Flow] Result after bump: from='${currentParts.major}.${currentParts.minor}.${currentParts.patch}' to='${bumped.major}.${bumped.minor}.${bumped.patch}'`
	);
	return bumped;
}

async function promptFlowVersionParts(
	entry: FileIndexEntry
): Promise<{ major: string; minor: string; patch: string } | undefined> {
	const manualVersion = await vscode.window.showInputBox({
		title: 'ERP Flow Sync',
		prompt: `Flow '${entry.recordName}': Neuer Versionsstand als 'MAJOR.MINOR.PATCH'. Aktueller Stand: '${entry.version || '<leer>'}'.`,
		value: entry.version || '1.0.0',
		ignoreFocusOut: true,
		validateInput: (value) => (parseFlowVersion(value.trim()) ? undefined : "Bitte im Format 'MAJOR.MINOR.PATCH' eingeben.")
	});

	if (manualVersion === undefined) {
		return undefined;
	}

	return parseFlowVersion(manualVersion.trim());
}

function bumpFlowVersion(
	parts: { major: string; minor: string; patch: string },
	bump: FlowVersionBump
): { major: string; minor: string; patch: string } {
	const major = Number.parseInt(parts.major, 10);
	const minor = Number.parseInt(parts.minor, 10);
	const patch = Number.parseInt(parts.patch, 10);

	if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
		return parts;
	}

	if (bump === 'majorversion') {
		return {
			major: String(major + 1),
			minor: String(0),
			patch: String(0)
		};
	}

	if (bump === 'minorversion') {
		return {
			major: String(major),
			minor: String(minor + 1),
			patch: String(0)
		};
	}

	return {
		major: String(major),
		minor: String(minor),
		patch: String(patch + 1)
	};
}

function parseFlowVersion(value: string): { major: string; minor: string; patch: string } | undefined {
	const normalized = value.trim();
	if (!normalized) {
		return undefined;
	}

	const segments = normalized.split('.');
	if (segments.length !== 3) {
		return undefined;
	}

	const [major, minor, patch] = segments.map((segment) => segment.trim());
	if (!major || !minor || !patch) {
		return undefined;
	}

	return { major, minor, patch };
}

function isFlowDateVersion(parts: { major: string; minor: string; patch: string }): boolean {
	if (!/^\d{4}$/.test(parts.major) || !/^\d{1,2}$/.test(parts.minor) || !/^\d{1,2}$/.test(parts.patch)) {
		return false;
	}

	const year = Number(parts.major);
	const month = Number(parts.minor);
	const day = Number(parts.patch);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

function getTodayKey(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isDateVersionFormat(value: string): boolean {
	if (!/^\d{8}$/.test(value)) {
		return false;
	}

	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(4, 6));
	const day = Number(value.slice(6, 8));
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
		return false;
	}

	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

function getVersionFieldForRecordType(type: FileIndexEntry['type']): FileIndexEntry['versionField'] {
	return type === 'QUERY' ? 'VERSION' : type === 'DASHBOARD' ? 'ANP_VERSION' : undefined;
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
		logOutput(
			`[NTLM] Sende ${options.method} ${url.origin}${url.pathname} (Versuch ${index + 1}/${authCandidates.length}) mit ${describeAuthIdentity(candidate.username, candidate.domain)}`
		);

		let response: {
			statusCode?: number;
			statusMessage?: string;
			headers?: Record<string, string | string[] | undefined>;
		};
		let body = '';

		try {
			const result = await executeNtlmRequest(options, candidate.username, candidate.domain);
			response = result.response;
			body = result.body;
		} catch (error) {
			logOutput(
				`[NTLM] Transportfehler bei ${options.method} ${options.url}: ${formatError(error)}`
			);
			throw error;
		}

		if (response?.statusCode && response.statusCode < 400) {
			const contentType = getHeaderValue(response?.headers, 'content-type') ?? '<leer>';
			const contentLength = getHeaderValue(response?.headers, 'content-length') ?? '<leer>';
			const location = getHeaderValue(response?.headers, 'location') ?? '<leer>';
			logOutput(
				`[NTLM] Antwort HTTP ${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}, content-type='${contentType}', content-length='${contentLength}', location='${location}', bodyLength=${(body ?? '').length}`
			);

			if (index > 0) {
				logOutput('[NTLM] Hinweis: Fallback-Identitaetsformat wurde erfolgreich verwendet.');
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
			candidate.domain
		);
		logOutput(`[NTLM] ${diagnostic}`);

		lastError = new Error(`NTLM Request fehlgeschlagen: ${diagnostic}`);

		const hasMoreCandidates = index < authCandidates.length - 1;
		if (statusCode === 401 && hasMoreCandidates) {
			logOutput('[NTLM] HTTP 401 - versuche alternatives Username/Domain-Format.');
			continue;
		}

		throw lastError;
	}

	throw lastError ?? new Error('NTLM Request fehlgeschlagen.');
}

function buildNtlmAuthCandidates(config: RuntimeConfig): Array<{ username: string; domain: string }> {
	const candidates: Array<{ username: string; domain: string }> = [];
	const addCandidate = (username: string, domain: string): void => {
		const key = `${username}|||${domain}`;
		if (candidates.some((item) => `${item.username}|||${item.domain}` === key)) {
			return;
		}

		candidates.push({ username, domain });
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

function executeNtlmRequest(
	options: RequestOptions,
	username: string,
	domain: string
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
	attemptedDomain?: string
): string {
	const bodyPreview = (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
	const challengeHeader = getHeaderValue(headers, 'www-authenticate');
	const configuredIdentityInfo = describeAuthIdentity(config.authUsername, config.authDomain);
	const attemptedIdentityInfo = describeAuthIdentity(
		attemptedUsername ?? config.authUsername,
		attemptedDomain ?? config.authDomain
	);
	const scopeInfo = `authMode=${config.authMode}, passwordSet=${config.authPassword.length > 0 ? 'yes' : 'no'}, tlsAllowInsecure=${config.tlsAllowInsecure ? 'yes' : 'no'}, attemptedIdentity=${attemptedIdentityInfo}, configuredIdentity=${configuredIdentityInfo}`;
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

function buildQuickviewSql(dashboardId: string, includeAnpVersion: boolean): string {
	const sanitizedId = escapeSqlString(dashboardId);
	const anpQueryField = includeAnpVersion
		? "COALESCE(CAST(qvdashboard.anp_version as varchar(50)), '') as ANP_VERSION"
		: "'' as ANP_VERSION";
	const anpDashboardField = includeAnpVersion
		? "COALESCE(CAST(QVDASHBOARD.ANP_VERSION as varchar(50)), '') as ANP_VERSION"
		: "'' as ANP_VERSION";
	const dashboardVersionField = includeAnpVersion
		? "COALESCE(CAST(QVDASHBOARD.ANP_VERSION as varchar(50)), COALESCE(QVDASHBOARD.INFO, ''))"
		: 'QVDASHBOARD.INFO';
	const dashboardQueryFields = ', CAST(QVDASHBOARDQUERY.GUID as varchar(50)) as DASHBOARDQUERY_GUID, QVDASHBOARDQUERY.PARAMSTRING, QVDASHBOARDQUERY.JSCHARTSCRIPT, QVDASHBOARDQUERY.CHARTOPTIONS';
	const emptyDashboardQueryFields = ", '' as DASHBOARDQUERY_GUID, '' as PARAMSTRING, '' as JSCHARTSCRIPT, '' as CHARTOPTIONS";
	return `select qvquery.qvquery,qvquery.title,qvquery.GUID,qvquery.STATEMENT, QVQUERY.JSPAGESCRIPT,QVQUERY.CSSSTYLE, QVQUERY.OPTIONS, QVQUERY.VERSION, ${anpQueryField}${dashboardQueryFields}, type='QUERY' from QVQUERY
join QVDASHBOARDQUERY on QVQUERY.QVQUERY = QVDASHBOARDQUERY.QVQUERY
join QVDASHBOARD on QVDASHBOARDQUERY.QVDASHBOARD = QVDASHBOARD.QVDASHBOARD
where QVDASHBOARD.QVDASHBOARD = '${sanitizedId}'

UNION ALL

select QVDASHBOARD.QVDASHBOARD,QVDASHBOARD.title,QVDASHBOARD.GUID,'' as STATEMENT, QVDASHBOARD.JSPAGESCRIPT,QVDASHBOARD.CSSSTYLE, '' as OPTIONS, VERSION=${dashboardVersionField}, ${anpDashboardField}${emptyDashboardQueryFields}, type='DASHBOARD'
from QVDASHBOARD
where QVDASHBOARD.QVDASHBOARD = '${sanitizedId}'`;
}

function buildFlowSql(flowGuid: string): string {
	const sanitizedGuid = escapeSqlString(flowGuid);
	return `select FLOWBOARD.GUID,FLOWBOARD.TITLE,FLOWBOARD.XMLDEFINITION,FLOWBOARD.JAVASCRIPT,FLOWBOARD.SQLSTATEMENT,FLOWBOARD.MAJORVERSION,FLOWBOARD.MINORVERSION,FLOWBOARD.PATCHVERSION from FLOWBOARD where FLOWBOARD.GUID = '${sanitizedGuid}'`;
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

function normalizeDbRow(raw: unknown, contextType: DashboardContextType): DbRow | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	if (contextType === 'flow') {
		const guid = String(pick(obj, ['guid', 'GUID']) ?? '').trim();
		if (!guid) {
			return undefined;
		}

		const title = String(pick(obj, ['title', 'TITLE']) ?? '').trim();
		const majorVersion = String(pick(obj, ['majorversion', 'MAJORVERSION']) ?? '').trim();
		const minorVersion = String(pick(obj, ['minorversion', 'MINORVERSION']) ?? '').trim();
		const patchVersion = String(pick(obj, ['patchversion', 'PATCHVERSION']) ?? '').trim();
		const version = [majorVersion, minorVersion, patchVersion].filter((part) => part.length > 0).join('.');

		return {
			name: title || guid,
			title,
			guid,
			xmlDefinition: String(pick(obj, ['xmldefinition', 'XMLDEFINITION']) ?? ''),
			javascript: String(pick(obj, ['javascript', 'JAVASCRIPT']) ?? ''),
			sqlStatement: String(pick(obj, ['sqlstatement', 'SQLSTATEMENT']) ?? ''),
			statement: '',
			jsPageScript: '',
			cssStyle: '',
			version,
			type: 'DASHBOARD'
		};
	}

	const typeValue = String(pick(obj, ['type', 'TYPE']) ?? '').toUpperCase();
	if (typeValue !== 'QUERY' && typeValue !== 'DASHBOARD') {
		return undefined;
	}

	const name = String(
		pick(obj, ['qvquery', 'QVQUERY', 'qvdashboard', 'QVDASHBOARD']) ??
			(typeValue === 'QUERY' ? 'query' : 'dashboard')
	);
	const dashboardQueryGuid = String(pick(obj, ['dashboardquery_guid', 'DASHBOARDQUERY_GUID']) ?? '').trim();
	const paramString = pick(obj, ['paramstring', 'PARAMSTRING']);
	const jsChartScript = pick(obj, ['jschartscript', 'JSCHARTSCRIPT']);
	const chartOptions = pick(obj, ['chartoptions', 'CHARTOPTIONS']);
	if (typeValue === 'QUERY' && !dashboardQueryGuid
		&& [paramString, jsChartScript, chartOptions].some((value) => value !== undefined)) {
		throw new Error(`QVDASHBOARDQUERY-GUID fehlt fuer Query '${name}'. Zusaetzliche Felder koennen nicht sicher zugeordnet werden.`);
	}

	return {
		name,
		title: String(pick(obj, ['title', 'TITLE']) ?? ''),
		guid: String(pick(obj, ['guid', 'GUID']) ?? ''),
		statement: String(pick(obj, ['statement', 'STATEMENT']) ?? ''),
		jsPageScript: String(pick(obj, ['jspagescript', 'JSPAGESCRIPT']) ?? ''),
		cssStyle: String(pick(obj, ['cssstyle', 'CSSSTYLE']) ?? ''),
		options: String(pick(obj, ['options', 'OPTIONS']) ?? ''),
		dashboardQueryGuid: typeValue === 'QUERY' ? dashboardQueryGuid || undefined : undefined,
		paramString: String(paramString ?? ''),
		jsChartScript: String(jsChartScript ?? ''),
		chartOptions: String(chartOptions ?? ''),
		version: String(pick(obj, ['version', 'VERSION', 'anp_version', 'ANP_VERSION']) ?? ''),
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

type IndexPathMatchKind = 'exact' | 'case-insensitive' | 'legacy-layout';

function findIndexEntryByRelativePath(
	index: FileIndex,
	relativePath: string,
	contextType: DashboardContextType,
	generatedRootDir: string
): { entry?: FileIndexEntry; matchKind?: IndexPathMatchKind } {
	const exact = index.entries.find((item) => item.relativePath === relativePath);
	if (exact) {
		return { entry: exact, matchKind: 'exact' };
	}

	if (process.platform === 'win32') {
		const relativePathLower = relativePath.toLowerCase();
		const caseInsensitive = index.entries.find((item) => item.relativePath.toLowerCase() === relativePathLower);
		if (caseInsensitive) {
			return { entry: caseInsensitive, matchKind: 'case-insensitive' };
		}
	}

	const normalizedRelativePath = normalizeManagedRelativePath(relativePath, generatedRootDir, contextType);
	for (const candidate of index.entries) {
		const normalizedCandidatePath = normalizeManagedRelativePath(candidate.relativePath, generatedRootDir, contextType);
		const isMatch = process.platform === 'win32'
			? normalizedCandidatePath.toLowerCase() === normalizedRelativePath.toLowerCase()
			: normalizedCandidatePath === normalizedRelativePath;
		if (isMatch) {
			return { entry: candidate, matchKind: 'legacy-layout' };
		}
	}

	return {};
}

function normalizeManagedRelativePath(
	relativePath: string,
	generatedRootDir: string,
	contextType: DashboardContextType
): string {
	const normalizedPath = toPosixPath(relativePath).replace(/^\.\//, '');
	const normalizedRoot = toPosixPath(generatedRootDir).replace(/^\.\//, '').replace(/\/+$/, '');
	if (!normalizedRoot) {
		return normalizedPath;
	}

	const rootPrefix = `${normalizedRoot}/`;
	if (!normalizedPath.startsWith(rootPrefix)) {
		return normalizedPath;
	}

	const rest = normalizedPath.slice(rootPrefix.length);
	const contextPrefix = `${contextType}/`;
	if (rest.startsWith(contextPrefix)) {
		return `${rootPrefix}${rest.slice(contextPrefix.length)}`;
	}

	return normalizedPath;
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

function containsUri(root: vscode.Uri, uri: vscode.Uri): boolean {
	if (root.scheme !== uri.scheme || root.authority !== uri.authority) {
		return false;
	}
	const relativePath = path.relative(root.fsPath, uri.fsPath);
	return relativePath === '' || (relativePath !== '..'
		&& !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function contextKey(uri: vscode.Uri): string {
	const key = uri.toString();
	return process.platform === 'win32' ? key.toLowerCase() : key;
}

async function hasContextConfig(context: DashboardContext): Promise<boolean> {
	const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
	const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
	try {
		const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(context.uri, configFileName));
		return (stat.type & vscode.FileType.File) !== 0;
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			return false;
		}
		throw error;
	}
}

async function findDashboardContext(uri: vscode.Uri): Promise<DashboardContext | undefined> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		return undefined;
	}
	let directory = vscode.Uri.joinPath(uri, '..');
	while (containsUri(workspaceFolder.uri, directory)) {
		const context = { uri: directory, workspaceFolder };
		if (await hasContextConfig(context)) {
			return context;
		}
		if (contextKey(directory) === contextKey(workspaceFolder.uri)) {
			break;
		}
		directory = vscode.Uri.joinPath(directory, '..');
	}
	return undefined;
}

async function discoverDashboardContexts(): Promise<DashboardContext[]> {
	const contexts = new Map<string, DashboardContext>();
	for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
		const settings = vscode.workspace.getConfiguration('erpDashboardSync', workspaceFolder.uri);
		const configFileName = toPosixPath(settings.get<string>('configFileName', '.erp-dashboard-sync.json'));
		const configFiles = await vscode.workspace.findFiles(
			new vscode.RelativePattern(workspaceFolder, `**/${configFileName}`),
			'**/{node_modules,.git}/**'
		);
		for (const configFile of configFiles) {
			let uri = configFile;
			for (const _part of configFileName.split('/').filter(Boolean)) {
				uri = vscode.Uri.joinPath(uri, '..');
			}
			const owner = vscode.workspace.getWorkspaceFolder(uri);
			if (owner) {
				const ownerSettings = vscode.workspace.getConfiguration('erpDashboardSync', uri);
				const ownerFileName = ownerSettings.get<string>('configFileName', '.erp-dashboard-sync.json');
				if (contextKey(vscode.Uri.joinPath(uri, ownerFileName)) === contextKey(configFile)) {
					contexts.set(contextKey(uri), { uri, workspaceFolder: owner });
				}
			}
		}
	}
	return [...contexts.values()].sort((left, right) => left.uri.fsPath.localeCompare(right.uri.fsPath));
}

type ContextCommand = 'initialize' | 'reload' | 'credentials' | 'reset';
interface ContextPickItem extends vscode.QuickPickItem {
	contexts?: DashboardContext[];
	chooseFolder?: boolean;
}

async function selectDashboardContexts(command: ContextCommand): Promise<DashboardContext[] | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Bitte zuerst einen Workspace-Ordner oeffnen.');
		return undefined;
	}

	const discovered = await discoverDashboardContexts();
	const candidates = new Map(discovered.map((context) => [contextKey(context.uri), context]));
	if (command === 'initialize' || command === 'credentials') {
		for (const workspaceFolder of folders) {
			candidates.set(contextKey(workspaceFolder.uri), { uri: workspaceFolder.uri, workspaceFolder });
		}
	}
	const contexts = [...candidates.values()];
	if (!contexts.length) {
		vscode.window.showWarningMessage('ERP Dashboard Sync: Keine lokale Konfiguration gefunden. Bitte zuerst "Initialize Workspace" ausfuehren.');
		return undefined;
	}
	if (contexts.length === 1 && command !== 'initialize') {
		return contexts;
	}

	const items: ContextPickItem[] = await Promise.all(contexts.map(async (context) => {
		const settings = vscode.workspace.getConfiguration('erpDashboardSync', context.uri);
		const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
		const localConfig = normalizeLocalConfig(await readJsonFile<LocalConfig>(vscode.Uri.joinPath(context.uri, configFileName)));
		return {
			label: localConfig?.dashboardId ? `${getContextLabel(localConfig.contextType)}: ${getWorkspaceLabel(localConfig)}` : path.basename(context.uri.fsPath),
			description: context.uri.fsPath,
			contexts: [context]
		};
	}));
	if (command === 'reload' && contexts.length > 1) {
		items.unshift({ label: 'Alle Dashboards neu laden', contexts });
	}
	if (command === 'initialize') {
		items.push({ label: 'Anderen Dashboard-Ordner waehlen...', chooseFolder: true });
	}
	const choice = await vscode.window.showQuickPick(items, {
		title: 'ERP Dashboard Sync: Dashboard-Ordner',
		placeHolder: 'Fuer welchen Dashboard-Ordner soll der Befehl ausgefuehrt werden?'
	});
	if (!choice?.chooseFolder) {
		return choice?.contexts;
	}
	const selected = await vscode.window.showOpenDialog({
		title: 'Dashboard-Ordner im Workspace waehlen',
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		defaultUri: folders[0]?.uri
	});
	const uri = selected?.[0];
	if (!uri) {
		return undefined;
	}
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		vscode.window.showErrorMessage('ERP Dashboard Sync: Der Dashboard-Ordner muss innerhalb eines geoeffneten Workspace-Ordners liegen.');
		return undefined;
	}
	return [{ uri, workspaceFolder }];
}

async function reloadContexts(contexts: DashboardContext[]): Promise<void> {
	const results = await Promise.allSettled(contexts.map((context) =>
		enqueueSyncOperation(() => initializeWorkspace(false, context))));
	const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
	const firstFailure = failures[0];
	if (failures.length === 1 && firstFailure) {
		throw firstFailure.reason;
	}
	if (failures.length > 1) {
		throw new AggregateError(failures.map((failure) => failure.reason), 'ERP Dashboard Sync: Mehrere Reloads fehlgeschlagen.');
	}
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

async function writeGeneratedFile(uri: vscode.Uri, content: string): Promise<void> {
	await writeTextFile(uri, content);
	// Also suppress reload feedback if a later file or the index cannot be written.
	synchronizedContentHashes.set(uri.toString(), hashContent(content));
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
