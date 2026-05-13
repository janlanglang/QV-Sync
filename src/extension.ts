import * as vscode from 'vscode';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import * as httpntlm from 'httpntlm';

type AuthMode = 'none' | 'ntlm';
type UpdateTransport = 'soap12' | 'httpPost';
type RecordType = 'QUERY' | 'DASHBOARD';

interface LocalConfig {
	dashboardId: string;
}

interface RuntimeConfig {
	workspaceFolder: vscode.WorkspaceFolder;
	localConfig: LocalConfig;
	dbFetchJsonUrl: string;
	xmlUpdateOfflineSoapUrl: string;
	xmlUpdateOfflineHttpUrl: string;
	updateTransport: UpdateTransport;
	authMode: AuthMode;
	authUsername: string;
	authPassword: string;
	authDomain: string;
	authWorkstation: string;
	autoSyncOnSave: boolean;
	configFileName: string;
	indexFileName: string;
	generatedRootDir: string;
}

interface DbRow {
	name: string;
	guid: string;
	jsPageScript: string;
	cssStyle: string;
	version: string;
	type: RecordType;
}

interface FileIndexEntry {
	relativePath: string;
	table: 'QVQUERY' | 'QVDASHBOARD';
	field: 'JSPAGESCRIPT' | 'CSSSTYLE';
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

export function activate(context: vscode.ExtensionContext): void {
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
	if (document.languageId !== 'javascript' && document.languageId !== 'css') {
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
	const configFileName = settings.get<string>('configFileName', '.erp-dashboard-sync.json');
	const localConfigUri = vscode.Uri.joinPath(workspaceFolder.uri, configFileName);
	let localConfig = await readJsonFile<LocalConfig>(localConfigUri);

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

	return {
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
		xmlUpdateOfflineHttpUrl: settings.get<string>(
			'xmlUpdateOfflineHttpUrl',
			'https://applusdeploy.systec-lab.local/APplusdeploy/flexmobility/utils.asmx/xmlUpdateOffline'
		),
		updateTransport: settings.get<UpdateTransport>('updateTransport', 'soap12'),
		authMode: settings.get<AuthMode>('authMode', 'ntlm'),
		authUsername: settings.get<string>('authUsername', ''),
		authPassword: settings.get<string>('authPassword', ''),
		authDomain: settings.get<string>('authDomain', ''),
		authWorkstation: settings.get<string>('authWorkstation', ''),
		autoSyncOnSave: settings.get<boolean>('autoSyncOnSave', true),
		configFileName,
		indexFileName: settings.get<string>('indexFileName', '.erp-dashboard-sync-index.json'),
		generatedRootDir: settings.get<string>('generatedRootDir', 'erp-dashboard')
	};
}

async function fetchDashboardRows(config: RuntimeConfig): Promise<DbRow[]> {
	const sql = buildDashboardSql(config.localConfig.dashboardId);
	const fetchUrl = new URL(config.dbFetchJsonUrl);
	fetchUrl.searchParams.set('sql', sql);

	const responseText = await requestText({
		method: 'GET',
		url: fetchUrl.toString(),
		config
	});

	const rawJson = extractXmlStringValue(responseText);
	const parsed = JSON.parse(rawJson);
	const list = Array.isArray(parsed) ? parsed : [parsed];

	return list
		.map((item) => normalizeDbRow(item))
		.filter((item): item is DbRow => item !== undefined);
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

		const fileBaseName = `${sanitizePathPart(row.name)}__${sanitizePathPart(row.guid)}`;
		const jsRelativePath = toPosixPath(
			path.join(config.generatedRootDir, dashboardFolderName, row.type.toLowerCase(), `${fileBaseName}.js`)
		);
		const cssRelativePath = toPosixPath(
			path.join(config.generatedRootDir, dashboardFolderName, row.type.toLowerCase(), `${fileBaseName}.css`)
		);

		await writeTextFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.js`), row.jsPageScript ?? '');
		await writeTextFile(vscode.Uri.joinPath(recordDir, `${fileBaseName}.css`), row.cssStyle ?? '');

		entries.push({
			relativePath: jsRelativePath,
			table: row.type === 'QUERY' ? 'QVQUERY' : 'QVDASHBOARD',
			field: 'JSPAGESCRIPT',
			guid: row.guid,
			recordName: row.name,
			type: row.type,
			version: row.version
		});

		entries.push({
			relativePath: cssRelativePath,
			table: row.type === 'QUERY' ? 'QVQUERY' : 'QVDASHBOARD',
			field: 'CSSSTYLE',
			guid: row.guid,
			recordName: row.name,
			type: row.type,
			version: row.version
		});
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
	const updateData = `${entry.field}=${toSqlNString(content)}`;
	const whereClause = `GUID='${escapeSqlString(entry.guid)}'`;

	if (config.updateTransport === 'httpPost') {
		const body = new URLSearchParams({
			table: entry.table,
			updateData,
			sWhere: whereClause
		}).toString();

		await requestText({
			method: 'POST',
			url: config.xmlUpdateOfflineHttpUrl,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body,
			config
		});
		return;
	}

	const soapBody = buildSoapEnvelope(entry.table, updateData, whereClause);
	await requestText({
		method: 'POST',
		url: config.xmlUpdateOfflineSoapUrl,
		headers: {
			'Content-Type': 'application/soap+xml; charset=utf-8'
		},
		body: soapBody,
		config
	});
}

function buildSoapEnvelope(table: string, updateData: string, sWhere: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <xmlUpdateOffline xmlns="http://tempuri.org/">
      <table>${escapeXml(table)}</table>
      <updateData>${escapeXml(updateData)}</updateData>
      <sWhere>${escapeXml(sWhere)}</sWhere>
    </xmlUpdateOffline>
  </soap12:Body>
</soap12:Envelope>`;
}

async function requestText(options: RequestOptions): Promise<string> {
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
}

async function requestWithNtlm(options: RequestOptions): Promise<string> {
	if (!options.config.authUsername || !options.config.authPassword) {
		throw new Error('NTLM ist aktiviert, aber authUsername oder authPassword fehlt.');
	}

	return new Promise<string>((resolve, reject) => {
		const requestOptions = {
			url: options.url,
			username: options.config.authUsername,
			password: options.config.authPassword,
			domain: options.config.authDomain,
			workstation: options.config.authWorkstation,
			headers: options.headers,
			body: options.body
		};

		const callback = (error: unknown, response: { statusCode?: number }, body: string) => {
			if (error) {
				reject(error);
				return;
			}

			if (!response || !response.statusCode || response.statusCode >= 400) {
				reject(new Error(`NTLM Request fehlgeschlagen (${response?.statusCode ?? 'unknown'}): ${body ?? ''}`));
				return;
			}

			resolve(body ?? '');
		};

		if (options.method === 'GET') {
			httpntlm.get(requestOptions, callback);
		} else {
			httpntlm.post(requestOptions, callback);
		}
	});
}

function buildDashboardSql(dashboardId: string): string {
	const sanitizedId = escapeSqlString(dashboardId);
	return `select qvquery.qvquery,qvquery.GUID, QVQUERY.JSPAGESCRIPT,QVQUERY.CSSSTYLE, QVQUERY.VERSION, type='QUERY' from QVQUERY
join QVDASHBOARDQUERY on QVQUERY.QVQUERY = QVDASHBOARDQUERY.QVQUERY
join QVDASHBOARD on QVDASHBOARDQUERY.QVDASHBOARD = QVDASHBOARD.QVDASHBOARD
where QVDASHBOARD.QVDASHBOARD = '${sanitizedId}'

UNION ALL

select QVDASHBOARD.QVDASHBOARD,QVDASHBOARD.GUID, QVDASHBOARD.JSPAGESCRIPT,QVDASHBOARD.CSSSTYLE, VERSION=QVDASHBOARD.INFO, type='DASHBOARD'
from QVDASHBOARD
where QVDASHBOARD.QVDASHBOARD = '${sanitizedId}'`;
}

function extractXmlStringValue(xmlText: string): string {
	const parsed = XML_PARSER.parse(xmlText) as { string?: string | { '#text'?: string } };
	const value = parsed.string;

	if (typeof value === 'string') {
		return decodeXmlEntities(value);
	}

	if (value && typeof value === 'object' && typeof value['#text'] === 'string') {
		return decodeXmlEntities(value['#text']);
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
		guid: String(pick(obj, ['guid', 'GUID']) ?? ''),
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

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
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
