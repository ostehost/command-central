/**
 * Shared VS Code mock for consistent testing across all test files
 * Addresses Bun's shared mock issue by providing a complete mock
 */

import { mock } from "bun:test";

interface UriChange {
	scheme?: string;
	authority?: string;
	path?: string;
	query?: string;
	fragment?: string;
}

interface MockUri {
	fsPath: string;
	path: string;
	scheme: string;
	query: string;
	fragment: string;
	authority: string;
	toString: () => string;
	with: (change: UriChange) => MockUri;
}

function createMockUri(base: {
	fsPath: string;
	scheme?: string;
	query?: string;
	fragment?: string;
	authority?: string;
}): MockUri {
	const scheme = base.scheme ?? "file";
	const query = base.query ?? "";
	const fragment = base.fragment ?? "";
	const authority = base.authority ?? "";
	const fsPath = base.fsPath;

	return {
		fsPath,
		path: fsPath,
		scheme,
		query,
		fragment,
		authority,
		toString: () => {
			const q = query ? `?${query}` : "";
			return `${scheme}://${fsPath}${q}`;
		},
		with: (change: UriChange): MockUri =>
			createMockUri({
				fsPath: change.path ?? fsPath,
				scheme: change.scheme ?? scheme,
				query: change.query ?? query,
				fragment: change.fragment ?? fragment,
				authority: change.authority ?? authority,
			}),
	};
}

export function createVSCodeMock() {
	return {
		RelativePattern: class {
			constructor(
				public base: string | { uri: { fsPath: string } },
				public pattern: string,
			) {}
		},
		version: "1.85.0",
		env: {
			isTelemetryEnabled: true,
			machineId: "mock-machine-id",
			appName: "Visual Studio Code",
			language: "en",
			openExternal: mock(() => Promise.resolve(true)),
		},
		workspace: {
			isTrusted: true,
			workspaceFolders: [
				{ uri: { fsPath: "/mock/workspace" }, name: "workspace", index: 0 },
			] as Array<{ uri: { fsPath: string }; name: string; index: number }>,
			createFileSystemWatcher: mock(() => ({
				onDidChange: mock(() => ({ dispose: mock() })),
				onDidCreate: mock(() => ({ dispose: mock() })),
				onDidDelete: mock(() => ({ dispose: mock() })),
				dispose: mock(),
			})),
			getConfiguration: mock((_section?: string) => ({
				get: mock((_key: string, defaultValue?: unknown) => defaultValue),
				update: mock((_section: string, _value: unknown, _target?: unknown) =>
					Promise.resolve(),
				),
			})),
			onDidChangeConfiguration: mock(() => ({ dispose: mock() })),
			onDidChangeWorkspaceFolders: mock(() => ({ dispose: mock() })),
			showWorkspaceFolderPick: mock((_options?: unknown) =>
				Promise.resolve(undefined as unknown),
			),
			asRelativePath: mock((uri: string | { fsPath: string }) => {
				if (typeof uri === "string") return uri;
				const path = uri?.fsPath || "";
				// Simple relative path logic
				const parts = path.split("/");
				if (parts.length > 2) {
					// Return last two parts for nested paths
					return parts.slice(-2).join("/");
				}
				// Return just filename for root files
				return parts[parts.length - 1] || path;
			}),
			registerTextDocumentContentProvider: mock(
				(_scheme: string, _provider: unknown) => ({
					dispose: mock(),
				}),
			),
		},
		TreeItem: class {
			public description?: string;
			public tooltip?: string;
			public contextValue?: string;
			public resourceUri?: {
				fsPath: string;
				path: string;
				scheme: string;
				toString: () => string;
			};
			public command?: {
				command: string;
				title: string;
				arguments?: unknown[];
			};
			public iconPath?:
				| string
				| { light: string; dark: string }
				| { id: string };

			constructor(
				public label: string,
				public collapsibleState?: number,
			) {}
		},
		TreeItemCollapsibleState: {
			None: 0,
			Collapsed: 1,
			Expanded: 2,
		},
		ConfigurationTarget: {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3,
		},
		ViewColumn: {
			One: 1,
			Two: 2,
			Three: 3,
			Active: -1,
			Beside: -2,
		},
		QuickPickItemKind: {
			Separator: -1,
			Default: 0,
		},
		ExtensionKind: {
			UI: 1,
			Workspace: 2,
		},
		ThemeIcon: class {
			constructor(
				public id: string,
				public color?: { id: string },
			) {}
			static File = { id: "file" };
		},
		ThemeColor: class {
			constructor(public id: string) {}
		},
		FileDecoration: class {
			constructor(
				public badge?: string,
				public tooltip?: string,
				public color?: { id: string },
			) {}
		},
		MarkdownString: class {
			constructor(public value: string) {}
		},
		Uri: {
			file: (path: string): MockUri => createMockUri({ fsPath: path }),
			parse: (str: string): MockUri => createMockUri({ fsPath: str }),
			joinPath: (base: { fsPath: string }, ...segments: string[]): MockUri =>
				createMockUri({ fsPath: `${base.fsPath}/${segments.join("/")}` }),
		},
		extensions: {
			getExtension: mock(() => undefined),
		},
		commands: {
			executeCommand: mock((..._args: unknown[]) => Promise.resolve()),
			registerCommand: mock(
				(_id: string, _handler: (...args: unknown[]) => unknown) => ({
					dispose: mock(() => {}),
				}),
			),
		},
		StatusBarAlignment: {
			Left: 1,
			Right: 2,
		},
		window: {
			badge: undefined as { value: number; tooltip: string } | undefined,
			showInformationMessage: mock(),
			showWarningMessage: mock(),
			showErrorMessage: mock(),
			requestAttention: mock(),
			setStatusBarMessage: mock((_message?: string, _timeoutMs?: number) => ({
				dispose: mock(),
			})),
			createStatusBarItem: mock((_alignment?: number, _priority?: number) => ({
				text: "",
				tooltip: "",
				command: "",
				show: mock(),
				hide: mock(),
				dispose: mock(),
			})),
			createOutputChannel: mock((_name: string, _languageId?: string) => ({
				append: mock(),
				appendLine: mock(),
				clear: mock(),
				show: mock(),
				hide: mock(),
				dispose: mock(),
			})),
			createTreeView: mock((_viewId: string, _options: unknown) => ({
				title: "",
				description: "",
				visible: true,
				onDidChangeVisibility: mock(() => ({ dispose: mock() })),
				onDidChangeSelection: mock(() => ({ dispose: mock() })),
				dispose: mock(),
			})),
			onDidChangeActiveTextEditor: mock((_callback: unknown) => ({
				dispose: mock(),
			})),
			onDidChangeVisibleTextEditors: mock((_callback: unknown) => ({
				dispose: mock(),
			})),
			showQuickPick: mock(() => Promise.resolve(undefined)),
			showInputBox: mock((_options?: unknown) =>
				Promise.resolve(undefined as unknown),
			),
			createWebviewPanel: mock(
				(
					_viewType: string,
					_title: string,
					_showOptions: unknown,
					_options?: unknown,
				) => ({
					webview: {
						html: "",
						onDidReceiveMessage: mock(() => ({ dispose: mock() })),
						postMessage: mock(() => Promise.resolve(true)),
						asWebviewUri: mock((uri: { fsPath: string }) => uri),
						cspSource: "mock-csp",
					},
					onDidDispose: mock(() => ({ dispose: mock() })),
					onDidChangeViewState: mock(() => ({ dispose: mock() })),
					reveal: mock(),
					dispose: mock(),
					visible: true,
					viewColumn: 1,
				}),
			),
			createTerminal: mock((_options?: unknown) => ({
				show: mock(),
				hide: mock(),
				dispose: mock(),
				sendText: mock(),
			})),
			registerFileDecorationProvider: mock((_provider: unknown) => ({
				dispose: mock(),
			})),
		},
		EventEmitter: class<T = unknown> {
			private listeners: Array<(e: T) => void> = [];
			private disposed = false;

			fire(data: T): void {
				if (this.disposed) return;
				for (const listener of this.listeners) {
					listener(data);
				}
			}

			get event() {
				return (listener: (e: T) => void) => {
					if (this.disposed) {
						return { dispose: () => {} };
					}
					this.listeners.push(listener);
					return {
						dispose: () => {
							const index = this.listeners.indexOf(listener);
							if (index > -1) {
								this.listeners.splice(index, 1);
							}
						},
					};
				};
			}

			dispose(): void {
				this.disposed = true;
				this.listeners = [];
			}
		},
	};
}

export function setupVSCodeMock() {
	const vscodeMock = createVSCodeMock();
	mock.module("vscode", () => vscodeMock);
	try {
		const runtimeVscode = require("vscode") as Record<string, unknown>;
		Object.assign(runtimeVscode, vscodeMock);
	} catch {
		// Ignore if the module has not been loaded yet.
	}
	return vscodeMock;
}
