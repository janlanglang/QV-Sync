import * as assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { runInNewContext } from 'vm';
import { XMLParser } from 'fast-xml-parser';

class TestUri {
	readonly scheme = 'file';
	readonly authority = '';
	constructor(readonly fsPath: string) {}
	static joinPath(base: TestUri, ...parts: string[]): TestUri {
		return new TestUri(path.join(base.fsPath, ...parts));
	}
	toString(): string {
		return this.fsPath;
	}
}

class TestFileSystemError extends Error {
	readonly code = 'FileNotFound';
}

class TestRelativePattern {
	constructor(readonly base: { uri: TestUri }, readonly pattern: string) {}
}

class Disposable {
	constructor(private readonly cleanup = () => {}) {}
	dispose(): void {
		this.cleanup();
	}
}

class TestEvent<T> {
	private listener: ((value: T) => void) | undefined;
	readonly register = (listener: (value: T) => void): Disposable => {
		this.listener = listener;
		return new Disposable();
	};
	fire(value: T): void {
		assert.ok(this.listener, 'Extension must register the event');
		this.listener(value);
	}
}

interface TestEntry {
	relativePath: string;
	field: string;
	version: string;
	contentHash?: string;
	table?: string;
	guid?: string;
	type?: string;
	versionField?: string;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hash = (content: string) => createHash('sha256').update(content).digest('hex');

function readUpdate(body: string): { table: string; sWhere: string; fields: Record<string, string> } {
	const parser = new XMLParser({ trimValues: false, parseTagValue: false, htmlEntities: true });
	const soap: { 'soap12:Envelope': { 'soap12:Body': {
		xmlUpdateOffline: { table: string; sWhere: string; updateData: string };
	} } } = parser.parse(body);
	const call = soap['soap12:Envelope']['soap12:Body'].xmlUpdateOffline;
	const data: { row: Record<string, string> } = parser.parse(call.updateData);
	return { table: call.table, sWhere: call.sWhere, fields: data.row };
}

interface TestPickItem {
	label: string;
	description?: string;
}

function createHarness(options: {
	layout?: 'single' | 'nested' | 'multi-root' | 'overlapping';
	startup?: boolean;
} = {}) {
	const parent = new TestUri(path.resolve('sync-test-workspace'));
	const root = options.layout && options.layout !== 'single' ? TestUri.joinPath(parent, 'dashboard-a') : parent;
	const files = new Map<string, Uint8Array>();
	const logs: string[] = [];
	const errors: string[] = [];
	const requests: string[] = [];
	const subscriptions: Disposable[] = [];
	const save = new TestEvent<{ uri: TestUri; languageId: string }>();
	const change = new TestEvent<TestUri>();
	const create = new TestEvent<TestUri>();
	const commands = new Map<string, () => Promise<void>>();
	const folders = options.layout === 'multi-root' ? [root] : [parent];
	const folderSettings = new Map<string, Record<string, unknown>>();
	const secrets = new Map<string, string>();
	const secretReads: string[] = [];
	const picks: ((items: TestPickItem[]) => TestPickItem | undefined)[] = [];
	const inputs: (string | undefined)[] = [];
	const inputPrompts: string[] = [];
	const informationAnswers: (string | undefined)[] = [];
	const information: string[] = [];
	const fetchUrls: string[] = [];
	let confirmation: string | undefined;
	let selectedFolder: TestUri | undefined;
	const settings: Record<string, unknown> = {
		authMode: 'none', reloadOnStartup: options.startup ?? false, reloadOnStartupPrompt: false, tlsAllowInsecure: false,
		dbFetchJsonUrl: 'http://localhost/dbFetchJSON',
		xmlUpdateOfflineSoapUrl: 'http://localhost/utils.asmx/xmlUpdateOffline'
	};
	let post: (body: string) => Promise<void> = async () => {};
	let fetchRows = async (_sql: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> => rows;
	let failingWrite: string | undefined;
	const write = (uri: TestUri, text: string) => files.set(uri.fsPath, new TextEncoder().encode(text));
	const json = (uri: TestUri) => JSON.parse(new TextDecoder().decode(files.get(uri.fsPath)));
	const addContext = (directory: TestUri, id: string, guid: string, contextType = 'quickview') => {
		const configUri = TestUri.joinPath(directory, '.erp-dashboard-sync.json');
		const indexUri = TestUri.joinPath(directory, '.erp-dashboard-sync-index.json');
		const generated = contextType === 'flow'
			? TestUri.joinPath(directory, 'erp-dashboard', id, guid, guid)
			: TestUri.joinPath(directory, 'erp-dashboard', id, 'query', `${id}__${guid}`);
		const js = new TestUri(`${generated.fsPath}.js`);
		const css = new TestUri(`${generated.fsPath}.css`);
		write(configUri, JSON.stringify({ contextType, dashboardId: id }));
		const entries = [
			{ relativePath: path.relative(directory.fsPath, js.fsPath).replace(/\\/g, '/'), field: contextType === 'flow' ? 'JAVASCRIPT' : 'JSPAGESCRIPT' },
			...(contextType === 'quickview'
				? [{ relativePath: path.relative(directory.fsPath, css.fsPath).replace(/\\/g, '/'), field: 'CSSSTYLE' }] : [])
		].map((entry) => ({
			...entry, table: contextType === 'flow' ? 'FLOWBOARD' : 'QVQUERY', guid, recordName: id,
			type: contextType === 'flow' ? 'DASHBOARD' : 'QUERY',
			version: contextType === 'flow' ? '2026.11.17' : '20261117', contextType, contentHash: hash('old')
		}));
		write(indexUri, JSON.stringify({ contextType, dashboardId: id, entries }));
		write(js, 'old');
		write(css, 'old');
		return {
			root: directory, id, guid, contextType, configUri, indexUri, js, css,
			index: (): { entries: TestEntry[] } => json(indexUri),
			writeIndex: (index: unknown) => write(indexUri, JSON.stringify(index))
		};
	};
	const first = addContext(root, 'test', 'guid');
	const second = options.layout && options.layout !== 'single'
		? addContext(TestUri.joinPath(parent, 'dashboard-b'), 'second', 'second-guid', 'flow') : undefined;
	const contexts = second ? [first, second] : [first];
	if (second && options.layout === 'multi-root') { folders.push(second.root); }
	if (second && options.layout === 'overlapping') { folders.push(first.root, second.root); }
	const contains = (base: TestUri, uri: TestUri) => {
		const relative = path.relative(base.fsPath, uri.fsPath);
		return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	};
	const getWorkspaceFolder = (uri: TestUri) => {
		const owner = folders.filter((folder) => contains(folder, uri)).sort((a, b) => b.fsPath.length - a.fsPath.length)[0];
		return owner ? { uri: owner, name: path.basename(owner.fsPath), index: folders.indexOf(owner) } : undefined;
	};
	const getConfiguration = (_section: string, uri: TestUri) => {
		const owner = getWorkspaceFolder(uri);
		const overrides = owner ? folderSettings.get(owner.uri.fsPath) : undefined;
		return {
			get: (key: string, fallback: unknown) => overrides?.[key] ?? settings[key] ?? fallback,
			inspect: (key: string) => ({ workspaceValue: settings[key], workspaceFolderValue: overrides?.[key] }),
			update: async (key: string, value: unknown) => {
				assert.ok(owner);
				const values = folderSettings.get(owner.uri.fsPath) ?? {};
				values[key] = value;
				folderSettings.set(owner.uri.fsPath, values);
			}
		};
	};
	const vscode = {
		Uri: TestUri, Disposable, RelativePattern: TestRelativePattern, FileSystemError: TestFileSystemError,
		FileType: { File: 1 }, ConfigurationTarget: {}, ProgressLocation: {},
		workspace: {
			get workspaceFolders() {
				return folders.map((uri, index) => ({ uri, name: path.basename(uri.fsPath), index }));
			},
			getWorkspaceFolder,
			getConfiguration,
			findFiles: async (pattern: TestRelativePattern) => [...files.keys()]
				.filter((file) => contains(pattern.base.uri, new TestUri(file))
					&& file.endsWith(pattern.pattern.replace('**/', '').replace(/\//g, path.sep))
					&& !/[\\/](node_modules|\.git)[\\/]/.test(file))
				.map((file) => new TestUri(file)),
			onDidSaveTextDocument: save.register,
			createFileSystemWatcher: (pattern: string) => {
				assert.strictEqual(pattern, '**/*.{js,css,sql,xml,txt}');
				return { dispose() {}, onDidChange: change.register, onDidCreate: create.register };
			},
			fs: {
				stat: async (uri: TestUri) => {
					if (!files.has(uri.fsPath)) { throw new TestFileSystemError('Missing file'); }
					return { type: 1 };
				},
				readFile: async (uri: TestUri) => {
					const bytes = files.get(uri.fsPath);
					if (!bytes) { throw new TestFileSystemError(`Missing file: ${uri.fsPath}`); }
					return bytes;
				},
				writeFile: async (uri: TestUri, bytes: Uint8Array) => {
					if (uri.fsPath === failingWrite) { throw new Error('Write failed'); }
					files.set(uri.fsPath, bytes);
					if (/\.(js|css|sql|xml|txt)$/.test(uri.fsPath)) { change.fire(uri); }
				},
				createDirectory: async () => {}
			}
		},
		commands: {
			registerCommand: (id: string, action: () => Promise<void>) => {
				commands.set(id, action);
				return new Disposable();
			}
		},
		window: {
			createOutputChannel: () => ({ appendLine: (line: string) => logs.push(line), dispose() {} }),
			showErrorMessage: (message: string) => errors.push(message),
			showWarningMessage: async (message: string, ...args: unknown[]) => {
				if (args.length === 0) { errors.push(message); }
				return confirmation;
			},
			showInformationMessage: async (message: string) => {
				information.push(message);
				return informationAnswers.shift();
			},
			showQuickPick: async (items: TestPickItem[]) => {
				const pick = picks.shift();
				assert.ok(pick, `Unexpected dashboard/credential prompt: ${items.map((item) => item.label).join(', ')}`);
				return pick(items);
			},
			showInputBox: async (options: { prompt?: string }) => {
				inputPrompts.push(options.prompt ?? '');
				return inputs.shift();
			},
			showOpenDialog: async () => selectedFolder ? [selectedFolder] : undefined,
			setStatusBarMessage: () => {},
			withProgress: async (_options: unknown, action: (progress: unknown) => Promise<void>) =>
				action({ report() {} })
		}
	};
	const filename = path.resolve(__dirname, '..', 'extension.js');
	const nativeRequire = createRequire(filename);
	const exports: { activate?: (context: unknown) => void } = {};
	runInNewContext(readFileSync(filename, 'utf8'), {
		exports, require: (id: string) => id === 'vscode' ? vscode : nativeRequire(id),
		setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, process, console,
		fetch: async (url: string, request: { method: string; body: string }) => {
			fetchUrls.push(url);
			if (request.method === 'POST') {
				requests.push(request.body);
				await post(request.body);
			}
			const sql = new URL(url).searchParams.get('sql') ?? '';
			const context = contexts.find((candidate) => sql.includes(`'${candidate.id}'`)) ?? first;
			const rows = request.method === 'POST' ? [] : await fetchRows(sql, [{
				type: 'QUERY', qvquery: context.id, guid: context.guid, version: '20261117',
				jspagescript: 'from ERP', cssstyle: 'from ERP', statement: 'select 1',
				xmldefinition: 'from ERP', javascript: 'from ERP', sqlstatement: 'select 1',
				majorversion: '2026', minorversion: '11', patchversion: '17'
			}, ...(context.contextType === 'quickview' ? [{
				type: 'DASHBOARD', qvdashboard: context.id, guid: `${context.guid}-dashboard`, version: '20261117',
				jspagescript: 'dashboard script', cssstyle: 'dashboard css'
			}] : [])]);
			const xmlContent = JSON.stringify(rows).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			return {
				ok: true,
				text: async () => request.method === 'POST' ? '{}' : `<string>${xmlContent}</string>`
			};
		}
	}, { filename });
	assert.ok(exports.activate);
	exports.activate({ subscriptions, secrets: {
		get: async (key: string) => { secretReads.push(key); return secrets.get(key); },
		store: async (key: string, value: string) => { secrets.set(key, value); },
		delete: async (key: string) => { secrets.delete(key); }
	} });

	return {
		...first, parent, second, contexts, folders, folderSettings, secrets, secretReads,
		save, change, create, logs, errors, requests, settings, write, json, files, addContext,
		inputs, inputPrompts, informationAnswers, information, fetchUrls,
		pick: (choose: (items: TestPickItem[]) => TestPickItem | undefined) => picks.push(choose),
		chooseFolder: (uri: TestUri) => { selectedFolder = uri; },
		confirm: (answer: string) => { confirmation = answer; },
		setPost: (action: typeof post) => { post = action; },
		setRows: (action: typeof fetchRows) => { fetchRows = action; },
		failWrite: (uri: TestUri) => { failingWrite = uri.fsPath; },
		run: async (name: string) => {
			const command = commands.get(`erp-dashboard-sync.${name}`);
			assert.ok(command);
			await command();
		},
		reload: async () => {
			const command = commands.get('erp-dashboard-sync.refreshFromErp');
			assert.ok(command);
			await command();
		},
		dispose: () => subscriptions.forEach((item) => item.dispose())
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (condition()) { return; }
		await delay(10);
	}
	assert.fail('Timed out waiting for synchronization');
}

suite('File synchronization events', () => {
	let h: ReturnType<typeof createHarness>;
	setup(() => { h = createHarness(); });
	teardown(() => { h.dispose(); });

	test('uploads external changes and deduplicates save/change/create events regardless of language mode', async () => {
		h.write(h.js, 'external edit');
		h.create.fire(h.js);
		h.change.fire(h.js);
		h.save.fire({ uri: h.js, languageId: 'plaintext' });
		await waitFor(() => h.index().entries[0].contentHash === hash('external edit'));
		h.change.fire(h.js);
		await delay(400);
		assert.strictEqual(h.requests.length, 1);
		assert.ok(h.requests[0].includes('external edit'));
		h.write(h.js, 'old');
		h.change.fire(h.js);
		await waitFor(() => h.index().entries[0].contentHash === hash('old'));
		assert.strictEqual(h.requests.length, 2, 'Reverting to an earlier value must upload again');
		assert.deepStrictEqual(h.errors, []);
	});

	suite('Multiple dashboard contexts', () => {
		let h: ReturnType<typeof createHarness>;
		teardown(() => { h?.dispose(); });

		for (const layout of ['nested', 'multi-root'] as const) {
			test(`reuses existing independent indexes and credentials in a ${layout} workspace without initialization`, async () => {
				h = createHarness({ layout });
				const second = h.second;
				assert.ok(second);
				const originalConfig = h.files.get(h.configUri.fsPath);
				const originalSecondConfig = h.files.get(second.configUri.fsPath);
				const originalFirstIndex = h.index();
				const originalSecondIndex = second.index();
				const firstKey = `erp-dashboard-sync:credentials:${h.root}`;
				const secondKey = `erp-dashboard-sync:credentials:${second.root}`;
				h.secrets.set(firstKey, JSON.stringify({ username: 'first', password: 'test', domain: '' }));
				h.secrets.set(secondKey, JSON.stringify({ username: 'second', password: 'test', domain: '' }));
				h.write(h.js, 'first dashboard edit');
				h.write(second.js, 'second dashboard edit');
				h.change.fire(h.js);
				h.change.fire(second.js);
				await waitFor(() => h.index().entries[0].contentHash === hash('first dashboard edit')
					&& second.index().entries[0].contentHash === hash('second dashboard edit'));
				assert.strictEqual(h.requests.length, 2);
				assert.ok(h.requests.some((body) => body.includes('first dashboard edit') && !body.includes('second-guid')));
				assert.ok(h.requests.some((body) => body.includes('second dashboard edit') && body.includes('second-guid')));
				assert.strictEqual(h.index().entries[0].relativePath, originalFirstIndex.entries[0].relativePath);
				assert.strictEqual(second.index().entries[0].relativePath, originalSecondIndex.entries[0].relativePath);
				assert.strictEqual(h.files.get(h.configUri.fsPath), originalConfig);
				assert.strictEqual(h.files.get(second.configUri.fsPath), originalSecondConfig);
				assert.ok(h.secretReads.includes(firstKey));
				assert.ok(h.secretReads.includes(secondKey));
				assert.ok(!h.files.has(TestUri.joinPath(h.parent, '.erp-dashboard-sync-index.json').fsPath));
				assert.deepStrictEqual(h.errors, []);
			});

			test(`reload selection and reload-all operate on existing ${layout} dashboard roots`, async () => {
				h = createHarness({ layout });
				const second = h.second;
				assert.ok(second);
				h.pick((items) => items.find((item) => item.description === second.root.fsPath));
				await h.reload();
				assert.strictEqual(h.index().entries[0].contentHash, hash('old'));
				assert.strictEqual(second.index().entries[0].contentHash, hash('from ERP'));
				h.pick((items) => items.find((item) => item.label === 'Alle Dashboards neu laden'));
				await h.reload();
				await delay(400);
				assert.strictEqual(h.index().entries[0].contentHash, hash('from ERP'));
				assert.strictEqual(second.index().entries[0].contentHash, hash('from ERP'));
				assert.strictEqual(h.requests.length, 0, 'Reload writes must never be uploaded');
				assert.deepStrictEqual(h.errors, []);
			});
		}

		test('uses the nearest context and never falls back to a parent index for an unindexed child file', async () => {
			h = createHarness();
			const child = h.addContext(TestUri.joinPath(h.root, 'nested'), 'child', 'child-guid');
			const parentIndex = h.index();
			parentIndex.entries.push({
				relativePath: path.relative(h.root.fsPath, child.js.fsPath).replace(/\\/g, '/'),
				field: 'JSPAGESCRIPT', version: '20261117', contentHash: hash('old')
			});
			h.writeIndex(parentIndex);
			h.write(child.js, 'nearest context');
			h.change.fire(child.js);
			await waitFor(() => child.index().entries[0].contentHash === hash('nearest context'));
			assert.ok(h.requests[0].includes('child-guid'));
			assert.strictEqual(h.index().entries[2].contentHash, hash('old'));
			const emptyChild = child.index();
			emptyChild.entries = [];
			child.writeIndex(emptyChild);
			h.write(child.js, 'not indexed in child');
			h.change.fire(child.js);
			await waitFor(() => h.logs.some((line) => line.includes('Datei nicht im Index')));
			assert.strictEqual(h.requests.length, 1);
			h.files.delete(child.indexUri.fsPath);
			h.write(child.js, 'missing child index');
			h.change.fire(child.js);
			await waitFor(() => h.logs.some((line) => line.includes('Indexdatei nicht gefunden')));
			assert.strictEqual(h.requests.length, 1);
		});

		test('does not fall back to a parent context when a nearer configuration is invalid', async () => {
			h = createHarness();
			const child = h.addContext(TestUri.joinPath(h.root, 'nested'), 'child', 'child-guid');
			h.write(child.configUri, '{invalid JSON');
			h.write(child.js, 'must not upload');
			h.change.fire(child.js);
			await waitFor(() => h.logs.some((line) => line.includes('Keine gueltige lokale Konfiguration')));
			assert.strictEqual(h.requests.length, 0);
		});

		test('discovers overlapping workspace roots once and reloads all contexts on startup', async () => {
			h = createHarness({ layout: 'overlapping', startup: true });
			const second = h.second;
			assert.ok(second);
			await waitFor(() => h.index().entries[0].contentHash === hash('from ERP')
				&& second.index().entries[0].contentHash === hash('from ERP'));
			await delay(400);
			assert.strictEqual(h.fetchUrls.length, 2, 'Each context is fetched only once');
			assert.strictEqual(h.requests.length, 0);
			assert.deepStrictEqual(h.errors, []);
		});

		test('respects per-root auto-sync and startup settings', async () => {
			h = createHarness({ layout: 'multi-root', startup: true });
			const second = h.second;
			assert.ok(second);
			h.folderSettings.set(second.root.fsPath, { autoSyncOnSave: false, reloadOnStartup: false });
			await waitFor(() => h.index().entries[0].contentHash === hash('from ERP'));
			await delay(400);
			assert.strictEqual(second.index().entries[0].contentHash, hash('old'));
			h.write(second.js, 'disabled root');
			h.change.fire(second.js);
			await waitFor(() => h.logs.some((line) => line.includes('autoSyncOnSave ist deaktiviert')));
			assert.strictEqual(h.requests.length, 0);
		});

		test('supports choosing a new nested initialization folder without touching existing dashboards', async () => {
			h = createHarness({ layout: 'nested' });
			const second = h.second;
			assert.ok(second);
			const firstIndex = h.files.get(h.indexUri.fsPath);
			const secondIndex = h.files.get(second.indexUri.fsPath);
			const directory = TestUri.joinPath(h.parent, 'new-dashboard');
			h.pick((items) => items.find((item) => item.label === 'Anderen Dashboard-Ordner waehlen...'));
			h.pick((items) => items.find((item) => item.label === 'Quickview'));
			h.inputs.push('new-dashboard');
			h.chooseFolder(directory);
			await h.run('initializeWorkspace');
			const config = h.json(TestUri.joinPath(directory, '.erp-dashboard-sync.json'));
			assert.strictEqual(config.dashboardId, 'new-dashboard');
			assert.ok(h.files.has(TestUri.joinPath(directory, '.erp-dashboard-sync-index.json').fsPath));
			assert.strictEqual(h.files.get(h.indexUri.fsPath), firstIndex);
			assert.strictEqual(h.files.get(second.indexUri.fsPath), secondIndex);
			assert.deepStrictEqual(h.errors, []);
		});

		test('resets version decisions and manages credentials only for the selected dashboard', async () => {
			h = createHarness({ layout: 'nested' });
			const second = h.second;
			assert.ok(second);
			for (const context of h.contexts) {
				const config = h.json(context.configUri);
				config.quickviewVersionState = { lastPromptDate: '2026-11-18', pendingVersion: 'custom' };
				h.write(context.configUri, JSON.stringify(config));
			}
			const chooseSecond = (items: TestPickItem[]) => items.find((item) => item.description === second.root.fsPath);
			h.pick(chooseSecond);
			h.confirm('Zuruecksetzen');
			await h.run('resetVersionPromptState');
			assert.ok(h.json(h.configUri).quickviewVersionState);
			assert.strictEqual(h.json(second.configUri).quickviewVersionState, undefined);
			h.pick(chooseSecond);
			h.pick((items) => items.find((item) => item.label === 'Nur fuer diesen Dashboard-Ordner speichern'));
			h.inputs.push('user', 'test-password', 'domain');
			await h.run('setCredentials');
			const key = `erp-dashboard-sync:credentials:${second.root}`;
			assert.ok(h.secrets.has(key));
			assert.ok(!h.secrets.has(`erp-dashboard-sync:credentials:${h.root}`));
			h.pick(chooseSecond);
			h.pick((items) => items.find((item) => item.label === 'Credentials fuer diesen Dashboard-Ordner loeschen'));
			h.confirm('Loeschen');
			await h.run('clearCredentials');
			assert.ok(!h.secrets.has(key));
		});

		test('cancelling context selection never changes or reloads a dashboard', async () => {
			h = createHarness({ layout: 'nested' });
			h.pick(() => undefined);
			await h.reload();
			assert.strictEqual(h.fetchUrls.length, 0);
			assert.strictEqual(h.requests.length, 0);
			assert.deepStrictEqual(h.errors, []);
		});

		test('continues reloading other dashboards after one reload fails', async () => {
			h = createHarness({ layout: 'nested' });
			const second = h.second;
			assert.ok(second);
			h.failWrite(h.css);
			h.pick((items) => items.find((item) => item.label === 'Alle Dashboards neu laden'));
			await assert.rejects(h.reload(), /Write failed/);
			await delay(400);
			assert.strictEqual(h.index().entries[0].contentHash, hash('old'));
			assert.strictEqual(second.index().entries[0].contentHash, hash('from ERP'));
			assert.strictEqual(h.requests.length, 0);
			assert.strictEqual(h.errors.length, 1);
		});

		test('declining one startup prompt still offers and reloads the next dashboard', async () => {
			h = createHarness({ layout: 'nested', startup: true });
			h.settings.reloadOnStartupPrompt = true;
			h.informationAnswers.push('Nicht jetzt', 'Laden');
			const second = h.second;
			assert.ok(second);
			await waitFor(() => second.index().entries[0].contentHash === hash('from ERP'));
			assert.strictEqual(h.index().entries[0].contentHash, hash('old'));
			assert.strictEqual(h.fetchUrls.length, 1);
			assert.deepStrictEqual(h.errors, []);
		});

		test('uses existing custom configuration and index filenames from each workspace root', async () => {
			h = createHarness({ layout: 'overlapping' });
			const second = h.second;
			assert.ok(second);
			const config = h.files.get(second.configUri.fsPath);
			const index = h.files.get(second.indexUri.fsPath);
			assert.ok(config);
			assert.ok(index);
			const configUri = TestUri.joinPath(second.root, '.custom-sync.json');
			const indexUri = TestUri.joinPath(second.root, '.custom-index.json');
			h.files.set(configUri.fsPath, config);
			h.files.set(indexUri.fsPath, index);
			h.files.delete(second.configUri.fsPath);
			h.files.delete(second.indexUri.fsPath);
			h.folderSettings.set(second.root.fsPath, { configFileName: '.custom-sync.json', indexFileName: '.custom-index.json' });
			h.write(second.js, 'custom index edit');
			h.change.fire(second.js);
			await waitFor(() => h.json(indexUri).entries[0].contentHash === hash('custom index edit'));
			h.pick((items) => {
				assert.strictEqual(items.filter((item) => item.description === second.root.fsPath).length, 1);
				return items.find((item) => item.description === second.root.fsPath);
			});
			await h.reload();
			assert.strictEqual(h.json(indexUri).entries[0].contentHash, hash('from ERP'));
			assert.ok(!h.files.has(second.indexUri.fsPath));
			assert.strictEqual(h.index().entries[0].contentHash, hash('old'));
			assert.deepStrictEqual(h.errors, []);
		});
	});

	test('serializes multiple files and preserves changes made during a running upload', async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		h.setPost(async () => { if (h.requests.length === 1) { await blocked; } });
		h.write(h.js, 'first edit');
		h.change.fire(h.js);
		await waitFor(() => h.requests.length === 1);
		h.write(h.js, 'second edit');
		h.change.fire(h.js);
		h.write(h.css, 'css edit');
		h.change.fire(h.css);
		await delay(400);
		assert.strictEqual(h.requests.length, 1, 'No concurrent ERP writes');
		release();
		await waitFor(() => h.index().entries.every((entry) =>
			entry.contentHash === hash(entry.field === 'CSSSTYLE' ? 'css edit' : 'second edit')));
		assert.strictEqual(h.requests.length, 3);
		assert.ok(h.requests[0].includes('first edit'));
		assert.ok(h.requests[1].includes('second edit'));
		assert.deepStrictEqual(h.errors, []);
	});

	test('supports legacy indexes and retries failed content on the next save', async () => {
		const index = h.index();
		delete index.entries[0].contentHash;
		h.writeIndex(index);
		h.setPost(async () => { throw new Error('ERP unavailable'); });
		h.write(h.js, 'retry edit');
		h.change.fire(h.js);
		await waitFor(() => h.errors.length > 0);
		assert.strictEqual(h.index().entries[0].contentHash, undefined);
		h.setPost(async () => {});
		h.save.fire({ uri: h.js, languageId: 'javascript' });
		await waitFor(() => h.index().entries[0].contentHash === hash('retry edit'));
		assert.ok(h.requests[h.requests.length - 1].includes('retry edit'));
	});

	test('does not upload ERP reload writes, but does upload a subsequent external edit', async () => {
		await h.reload();
		await delay(400);
		assert.strictEqual(h.requests.length, 0);
		assert.deepStrictEqual(h.errors, []);
		assert.strictEqual(h.index().entries[0].contentHash, hash('from ERP'));
		h.write(h.js, 'after reload');
		h.change.fire(h.js);
		await waitFor(() => h.index().entries[0].contentHash === hash('after reload'));
		assert.ok(h.requests[0].includes('after reload'));
	});

	test('does not upload its own files after a partially failed reload', async () => {
		h.failWrite(h.css);
		await assert.rejects(h.reload(), /Write failed/);
		await delay(400);
		assert.strictEqual(h.requests.length, 0);
		assert.strictEqual(h.errors.length, 1);
	});

	test('respects disabled auto-sync and ignores unindexed files', async () => {
		h.settings.autoSyncOnSave = false;
		h.write(h.js, 'disabled');
		h.change.fire(h.js);
		await waitFor(() => h.logs.some((line) => line.includes('autoSyncOnSave ist deaktiviert')));
		h.settings.autoSyncOnSave = true;
		const unmanaged = TestUri.joinPath(h.js, '..', 'unmanaged.js');
		h.write(unmanaged, 'unmanaged');
		h.create.fire(unmanaged);
		await waitFor(() => h.logs.some((line) => line.includes('Datei nicht im Index')));
		assert.strictEqual(h.requests.length, 0);
	});
});

suite('Dashboard-query fields', () => {
	let h: ReturnType<typeof createHarness>;
	setup(() => { h = createHarness(); });
	teardown(() => { h.dispose(); });

	test('uploads raw assignment fields and separately updates only their parent dashboard version', async () => {
		const values: Record<string, string> = {
			PARAMSTRING: '  a=1&b=<value>\r\n',
			JSCHARTSCRIPT: 'function render() {\n  return "<chart>";\n}\n',
			CHARTOPTIONS: '({ callback: function (x) { return x < 5; } })\n'
		};
		h.setRows(async (sql, rows) => {
			assert.ok(sql.includes('QVQUERY') && sql.includes('CAST(QVDASHBOARDQUERY.GUID as varchar(50)) as DASHBOARDQUERY_GUID'));
			for (const field of Object.keys(values)) { assert.ok(sql.includes(`QVDASHBOARDQUERY.${field}`)); }
			return rows.map((row) => row.type === 'QUERY'
				? { ...row, version: 'legacy-version', DASHBOARDQUERY_GUID: 'assignment-guid', ...values } : row);
		});
		await h.reload();
		await delay(400);
		assert.strictEqual(h.requests.length, 0, 'Generated files must not be uploaded');
		const entries = h.index().entries.filter((entry) => entry.table === 'QVDASHBOARDQUERY');
		assert.strictEqual(entries.length, 3);
		const suffixes: Record<string, string> = {
			PARAMSTRING: '.paramstring.txt', JSCHARTSCRIPT: '.jschartscript.js', CHARTOPTIONS: '.chartoptions.js'
		};
		for (const entry of entries) {
			assert.ok(entry.relativePath.startsWith('erp-dashboard/test/dashboard-query/'));
			assert.ok(entry.relativePath.endsWith(suffixes[entry.field]));
			assert.strictEqual(entry.guid, 'assignment-guid');
			assert.strictEqual(entry.versionField, undefined);
			const uri = TestUri.joinPath(h.root, ...entry.relativePath.split('/'));
			assert.strictEqual(new TextDecoder().decode(h.files.get(uri.fsPath)), values[entry.field]);
			h.write(uri, `${values[entry.field]}changed`);
			h.change.fire(uri);
		}
		await waitFor(() => h.index().entries.filter((entry) => entry.table === 'QVDASHBOARDQUERY')
			.every((entry) => entry.contentHash === hash(`${values[entry.field]}changed`)));
		assert.strictEqual(h.requests.length, 6);
		const updates = h.requests.map(readUpdate);
		for (const call of updates.filter((update) => update.table === 'QVDASHBOARDQUERY')) {
			assert.strictEqual(call.table, 'QVDASHBOARDQUERY');
			assert.strictEqual(call.sWhere, "GUID='assignment-guid'");
			const fields = Object.keys(call.fields);
			assert.strictEqual(fields.length, 1, 'Only the changed content field, no invented version column');
			const field = fields[0];
			assert.ok(field && field in values);
			assert.strictEqual(call.fields[field], `${values[field]}changed`);
		}
		const parentUpdates = updates.filter((update) => update.table === 'QVDASHBOARD');
		assert.strictEqual(parentUpdates.length, 3);
		for (const call of parentUpdates) {
			assert.strictEqual(call.sWhere, "GUID='guid-dashboard'");
			assert.deepStrictEqual(Object.keys(call.fields), ['ANP_VERSION']);
			assert.ok(h.index().entries.filter((entry) => entry.table === 'QVDASHBOARD')
				.every((entry) => entry.version === call.fields.ANP_VERSION));
		}
		assert.ok(h.index().entries.filter((entry) => entry.table === 'QVQUERY')
			.every((entry) => entry.version === 'legacy-version'));
		assert.deepStrictEqual(h.errors, []);
	});

	test('keeps repeated queries separate and materializes NULL/empty or omitted values as empty files', async () => {
		h.setRows(async (_sql, rows) => [
			{ ...rows[0], DASHBOARDQUERY_GUID: 'assignment-a', PARAMSTRING: null, JSCHARTSCRIPT: '', CHARTOPTIONS: null },
			{ ...rows[0], DASHBOARDQUERY_GUID: 'assignment-b', PARAMSTRING: 'second', CHARTOPTIONS: '({})' }
		]);
		await h.reload();
		const entries = h.index().entries.filter((entry) => entry.table === 'QVDASHBOARDQUERY');
		assert.strictEqual(entries.length, 6);
		assert.strictEqual(new Set(entries.map((entry) => entry.relativePath)).size, 6);
		assert.strictEqual(entries.filter((entry) => entry.guid === 'assignment-a').length, 3);
		assert.strictEqual(entries.filter((entry) => entry.guid === 'assignment-b').length, 3);
		for (const entry of entries.filter((candidate) => candidate.guid === 'assignment-a')) {
			const uri = TestUri.joinPath(h.root, ...entry.relativePath.split('/'));
			assert.strictEqual(new TextDecoder().decode(h.files.get(uri.fsPath)), '');
		}
		assert.ok(entries.some((entry) => entry.guid === 'assignment-b' && entry.field === 'JSCHARTSCRIPT'
			&& entry.contentHash === hash('')));
		assert.deepStrictEqual(h.errors, []);
	});

	test('supports legacy indexes before reload and missing new files without blocking existing uploads', async () => {
		assert.ok(!h.index().entries.some((entry) => entry.table === 'QVDASHBOARDQUERY'));
		h.write(h.js, 'legacy project save');
		h.change.fire(h.js);
		await waitFor(() => h.index().entries[0].contentHash === hash('legacy project save'));
		assert.strictEqual(h.index().entries.length, 2, 'No mandatory new entries before an ERP reload');
		assert.strictEqual(h.requests.length, 1);
		assert.ok(h.requests[0].includes('<table>QVQUERY</table>'));

		h.setRows(async (_sql, rows) => rows.map((row) => ({
			...row, DASHBOARDQUERY_GUID: 'assignment-guid', PARAMSTRING: 'p=1', JSCHARTSCRIPT: '', CHARTOPTIONS: '({})'
		})));
		await h.reload();
		const param = h.index().entries.find((entry) => entry.field === 'PARAMSTRING');
		assert.ok(param);
		const uri = TestUri.joinPath(h.root, ...param.relativePath.split('/'));
		h.files.delete(uri.fsPath);
		h.change.fire(uri);
		h.write(h.css, 'existing css edit');
		h.change.fire(h.css);
		await waitFor(() => h.index().entries.find((entry) => entry.field === 'CSSSTYLE')?.contentHash === hash('existing css edit'));
		assert.strictEqual(h.requests.length, 2);
		assert.ok(!h.files.has(uri.fsPath));
		assert.ok(h.logs.some((line) => line.includes('Datei inzwischen geloescht')));
		assert.deepStrictEqual(h.errors, []);
		await h.reload();
		assert.strictEqual(new TextDecoder().decode(h.files.get(uri.fsPath)), 'p=1');
	});

	test('retains the existing ANP_VERSION fallback without dropping the new fields', async () => {
		h.setRows(async (sql, rows) => {
			if (/\.anp_version/i.test(sql)) { throw new Error("Invalid column name 'ANP_VERSION'."); }
			assert.ok(sql.includes('QVDASHBOARDQUERY.PARAMSTRING'));
			return rows.map((row) => ({ ...row, DASHBOARDQUERY_GUID: 'assignment-guid', PARAMSTRING: 'p=1' }));
		});
		await h.reload();
		assert.strictEqual(h.fetchUrls.length, 2);
		assert.strictEqual(h.index().entries.filter((entry) => entry.table === 'QVDASHBOARDQUERY').length, 3);
		assert.deepStrictEqual(h.errors, []);
	});

	test('never treats unrelated ERP failures as a compatibility fallback', async () => {
		const index = h.files.get(h.indexUri.fsPath);
		h.setRows(async () => { throw new Error('HTTP 503 ERP unavailable'); });
		await assert.rejects(h.reload(), /HTTP 503 ERP unavailable/);
		assert.strictEqual(h.fetchUrls.length, 1);
		assert.strictEqual(h.files.get(h.indexUri.fsPath), index);
		assert.strictEqual(h.errors.length, 1);
	});

	test('rejects new fields without an assignment GUID instead of writing to the query GUID', async () => {
		const index = h.files.get(h.indexUri.fsPath);
		h.setRows(async (_sql, rows) => rows.map((row) => ({ ...row, PARAMSTRING: 'cannot map safely' })));
		await assert.rejects(h.reload(), /QVDASHBOARDQUERY-GUID fehlt/);
		assert.strictEqual(h.files.get(h.indexUri.fsPath), index);
		assert.strictEqual(h.requests.length, 0);
	});

	async function prepareAssignment(dashboardVersion = '20261117') {
		h.setRows(async (_sql, rows) => rows.map((row) => row.type === 'QUERY'
			? { ...row, DASHBOARDQUERY_GUID: 'assignment-guid', PARAMSTRING: 'p=1', JSCHARTSCRIPT: '', CHARTOPTIONS: '({})' }
			: { ...row, version: dashboardVersion }));
		await h.reload();
		const entry = h.index().entries.find((candidate) => candidate.field === 'PARAMSTRING');
		assert.ok(entry);
		return { entry, uri: TestUri.joinPath(h.root, ...entry.relativePath.split('/')) };
	}

	test('checks the parent version before upload and reuses its daily decision', async () => {
		const { uri } = await prepareAssignment('17');
		h.inputs.push('18');
		h.write(uri, 'first change');
		h.change.fire(uri);
		await waitFor(() => h.index().entries.find((entry) => entry.field === 'PARAMSTRING')?.contentHash === hash('first change'));
		assert.strictEqual(h.inputPrompts.length, 1);
		assert.ok(h.index().entries.filter((entry) => entry.table === 'QVDASHBOARD').every((entry) => entry.version === '18'));
		h.write(uri, 'second change');
		h.save.fire({ uri, languageId: 'plaintext' });
		await waitFor(() => h.index().entries.find((entry) => entry.field === 'PARAMSTRING')?.contentHash === hash('second change'));
		assert.strictEqual(h.inputPrompts.length, 1, 'No repeated version prompt on the same day');
		const parentUpdates = h.requests.map(readUpdate).filter((update) => update.table === 'QVDASHBOARD');
		assert.strictEqual(parentUpdates.length, 2);
		assert.ok(parentUpdates.every((update) => update.fields.ANP_VERSION === '18'));
		assert.deepStrictEqual(h.errors, []);
	});

	test('cancelling the dashboard version prompt prevents both remote writes', async () => {
		const { entry, uri } = await prepareAssignment('17');
		h.inputs.push(undefined);
		h.write(uri, 'cancelled change');
		h.change.fire(uri);
		await waitFor(() => h.logs.some((line) => line.includes('Decision=cancelled-by-user')));
		assert.strictEqual(h.requests.length, 0);
		assert.strictEqual(h.index().entries.find((candidate) => candidate.field === 'PARAMSTRING')?.contentHash, entry.contentHash);
		assert.ok(h.index().entries.filter((candidate) => candidate.table === 'QVDASHBOARD').every((candidate) => candidate.version === '17'));
		assert.deepStrictEqual(h.errors, []);
	});

	test('keeps content pending after a failed dashboard version write and retries on the next save', async () => {
		const { entry, uri } = await prepareAssignment();
		h.setPost(async (body) => {
			if (readUpdate(body).table === 'QVDASHBOARD') { throw new Error('Parent version unavailable'); }
		});
		h.write(uri, 'pending change');
		h.change.fire(uri);
		await waitFor(() => h.errors.length === 1);
		assert.ok(h.errors[0].includes('Zuordnungsinhalt wurde gespeichert'));
		assert.strictEqual(h.index().entries.find((candidate) => candidate.field === 'PARAMSTRING')?.contentHash, entry.contentHash);
		assert.ok(h.index().entries.filter((candidate) => candidate.table === 'QVDASHBOARD').every((candidate) => candidate.version === '20261117'));
		h.setPost(async () => {});
		h.save.fire({ uri, languageId: 'plaintext' });
		await waitFor(() => h.index().entries.find((candidate) => candidate.field === 'PARAMSTRING')?.contentHash === hash('pending change'));
		const updates = h.requests.map(readUpdate);
		assert.strictEqual(updates.filter((update) => update.table === 'QVDASHBOARDQUERY').length, 2);
		const last = updates[updates.length - 1];
		assert.ok(last);
		assert.strictEqual(last.table, 'QVDASHBOARD');
		assert.ok(h.index().entries.filter((candidate) => candidate.table === 'QVDASHBOARD').every((candidate) => candidate.version === last.fields.ANP_VERSION));
	});

	test('never advances the dashboard version when its assignment content update fails', async () => {
		const { entry, uri } = await prepareAssignment();
		h.setPost(async () => { throw new Error('Content update failed'); });
		h.write(uri, 'failed change');
		h.change.fire(uri);
		await waitFor(() => h.errors.length === 1);
		assert.ok(h.requests.map(readUpdate).every((update) => update.table === 'QVDASHBOARDQUERY'));
		assert.strictEqual(h.index().entries.find((candidate) => candidate.field === 'PARAMSTRING')?.contentHash, entry.contentHash);
		assert.ok(h.index().entries.filter((candidate) => candidate.table === 'QVDASHBOARD').every((candidate) => candidate.version === '20261117'));
	});

	test('reuploads a reverted file after a partial failure even when it matches the previous index hash', async () => {
		const { uri } = await prepareAssignment();
		h.setPost(async (body) => {
			if (readUpdate(body).table === 'QVDASHBOARD') { throw new Error('Parent version unavailable'); }
		});
		h.write(uri, 'temporary remote change');
		h.change.fire(uri);
		await waitFor(() => h.errors.length === 1);
		h.setPost(async () => {});
		h.write(uri, 'p=1');
		h.save.fire({ uri, languageId: 'plaintext' });
		await waitFor(() => h.logs.filter((line) => line.includes('Request erfolgreich abgeschlossen.')).length === 3);
		const updates = h.requests.map(readUpdate).filter((update) => update.table === 'QVDASHBOARDQUERY');
		assert.strictEqual(updates.length, 2);
		assert.strictEqual(updates[1].fields.PARAMSTRING, 'p=1');
		assert.strictEqual(h.index().entries.find((candidate) => candidate.field === 'PARAMSTRING')?.contentHash, hash('p=1'));
	});

	test('requires an unambiguous parent dashboard in legacy assignment indexes', async () => {
		const { uri } = await prepareAssignment();
		const index = h.index();
		index.entries = index.entries.filter((entry) => entry.table !== 'QVDASHBOARD');
		h.writeIndex(index);
		h.write(uri, 'cannot version safely');
		h.change.fire(uri);
		await waitFor(() => h.errors.length === 1);
		assert.ok(h.logs.some((line) => line.includes('Dashboard-Version kann nicht eindeutig zugeordnet werden')));
		assert.strictEqual(h.requests.length, 0);
	});
});

suite('Query OPTIONS XML', () => {
	let h: ReturnType<typeof createHarness>;
	setup(() => { h = createHarness(); });
	teardown(() => { h.dispose(); });

	test('preserves raw XML and synchronizes OPTIONS with query VERSION, not the dashboard version', async () => {
		const xml = '<?xml version="1.0"?>\r\n<options label="A &amp; B"><![CDATA[x < 5 && y > 0]]></options>\r\n';
		h.setRows(async (sql, rows) => {
			assert.ok(sql.includes('QVQUERY.OPTIONS'));
			assert.ok(sql.includes("'' as OPTIONS"));
			return rows.map((row) => ({ ...row, OPTIONS: row.type === 'QUERY' ? xml : 'not a query option' }));
		});
		await h.reload();
		await delay(400);
		const entries = h.index().entries.filter((entry) => entry.field === 'OPTIONS');
		assert.strictEqual(entries.length, 1);
		const entry = entries[0];
		assert.ok(entry);
		assert.ok(entry.relativePath.startsWith('erp-dashboard/test/query/'));
		assert.ok(entry.relativePath.endsWith('.options.xml'));
		assert.strictEqual(entry.table, 'QVQUERY');
		assert.strictEqual(entry.guid, 'guid');
		assert.strictEqual(entry.versionField, 'VERSION');
		const uri = TestUri.joinPath(h.root, ...entry.relativePath.split('/'));
		assert.strictEqual(new TextDecoder().decode(h.files.get(uri.fsPath)), xml);
		assert.strictEqual(h.requests.length, 0);
		const changed = xml.replace('A &amp; B', 'C &amp; D');
		h.write(uri, changed);
		h.change.fire(uri);
		await waitFor(() => h.index().entries.find((candidate) => candidate.field === 'OPTIONS')?.contentHash === hash(changed));
		assert.strictEqual(h.requests.length, 1);
		const update = readUpdate(h.requests[0]);
		assert.strictEqual(update.table, 'QVQUERY');
		assert.strictEqual(update.sWhere, "GUID='guid'");
		assert.deepStrictEqual(Object.keys(update.fields).sort(), ['OPTIONS', 'VERSION']);
		assert.strictEqual(update.fields.OPTIONS, changed);
		assert.ok(h.index().entries.filter((candidate) => candidate.table === 'QVQUERY').every((candidate) => candidate.version === update.fields.VERSION));
		assert.ok(h.index().entries.filter((candidate) => candidate.table === 'QVDASHBOARD').every((candidate) => candidate.version === '20261117'));
		assert.deepStrictEqual(h.errors, []);
	});

	test('supports old indexes and missing OPTIONS files, and materializes NULL as empty XML content', async () => {
		assert.ok(!h.index().entries.some((entry) => entry.field === 'OPTIONS'));
		h.write(h.js, 'before reload');
		h.change.fire(h.js);
		await waitFor(() => h.index().entries[0].contentHash === hash('before reload'));
		assert.strictEqual(h.index().entries.length, 2);
		h.setRows(async (_sql, rows) => rows.map((row) => ({ ...row, OPTIONS: null })));
		await h.reload();
		const entry = h.index().entries.find((candidate) => candidate.field === 'OPTIONS');
		assert.ok(entry);
		const uri = TestUri.joinPath(h.root, ...entry.relativePath.split('/'));
		assert.strictEqual(new TextDecoder().decode(h.files.get(uri.fsPath)), '');
		h.files.delete(uri.fsPath);
		h.change.fire(uri);
		h.write(h.css, 'after reload');
		h.change.fire(h.css);
		await waitFor(() => h.index().entries.find((candidate) => candidate.field === 'CSSSTYLE')?.contentHash === hash('after reload'));
		assert.strictEqual(h.requests.length, 2);
		assert.ok(!h.files.has(uri.fsPath));
		assert.deepStrictEqual(h.errors, []);
	});
});
