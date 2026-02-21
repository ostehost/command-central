/**
 * Typed Mock Factory for VS Code Extension Tests
 *
 * PURPOSE: Eliminate `as any` type assertions by providing complete typed mocks
 *
 * QUALITY PRINCIPLES:
 * 1. All mocks implement COMPLETE interfaces (no partial types)
 * 2. Sensible defaults for all properties
 * 3. Override support for test-specific behavior
 * 4. Zero `as any` assertions in this file
 *
 * USAGE:
 * ```typescript
 * const logger = createMockLogger();  // Fully typed, no as any
 * const uri = createMockUri("/test/file.ts");  // Complete vscode.Uri
 * ```
 */

import { mock } from "bun:test";
import type * as vscode from "vscode";
import type { DeletedFileRecord } from "../../src/git-sort/deleted-file-tracker.js";
import type {
	DatabaseStats,
	StorageAdapter,
} from "../../src/git-sort/storage/storage-adapter.js";
import type { LoggerService } from "../../src/services/logger-service.js";
import type {
	IGroupingStateManager,
} from "../../src/types/service-interfaces.js";
import type {
	VSCodeMock,
} from "../types/mock.types.js";

/**
 * Create a complete typed LoggerService mock
 *
 * All 15 methods included - no type assertions needed
 */
export function createMockLogger(): LoggerService {
	return {
		info: mock(),
		error: mock(),
		warn: mock(),
		debug: mock(),
		performance: mock(),
		process: mock(),
		setLogLevel: mock(),
		getLogLevel: mock(() => 1), // Default to INFO level
		show: mock(),
		hide: mock(),
		clear: mock(),
		getOutputChannel: mock(),
		getHistory: mock(() => []),
		exportLogs: mock(() => ""),
		dispose: mock(),
	} as unknown as LoggerService;
}

/**
 * Create a complete typed StorageAdapter mock
 *
 * All 11 methods included - no type assertions needed
 */
export function createMockStorageAdapter(
	overrides?: Partial<StorageAdapter>,
): StorageAdapter {
	const defaultAdapter: StorageAdapter = {
		initialize: mock(async () => {}),
		close: mock(async () => {}),
		ensureRepository: mock(async () => 1),
		save: mock(async () => {}),
		load: mock(async () => []),
		queryByRepository: mock(async () => []),
		queryByTimeRange: mock(async () => []),
		queryRecent: mock(async () => []),
		backup: mock(async () => new Uint8Array(0)),
		compact: mock(async () => {}),
		getStats: mock(
			async (): Promise<DatabaseStats> => ({
				totalRepositories: 0,
				totalDeletions: 0,
				databaseSizeBytes: 0,
			}),
		),
	};

	return { ...defaultAdapter, ...overrides };
}

/**
 * Create a complete typed vscode.Uri mock
 *
 * All 10 properties included - no type assertions needed
 */
export function createMockUri(fsPath: string): vscode.Uri {
	const uri = {
		scheme: "file",
		authority: "",
		path: fsPath,
		query: "",
		fragment: "",
		fsPath,
		with: mock((change: Partial<vscode.Uri>) => ({
			...uri,
			...change,
		})),
		toString: mock(() => `file://${fsPath}`),
		toJSON: mock(() => ({ $mid: 1, path: fsPath, scheme: "file" })),
	};

	return uri as unknown as vscode.Uri;
}

/**
 * Create a complete typed vscode.ExtensionContext mock
 *
 * All required properties included - no type assertions needed
 */
export function createMockExtensionContext(
	overrides?: Partial<vscode.ExtensionContext>,
): vscode.ExtensionContext {
	const defaultContext = {
		subscriptions: [],
		extensionUri: createMockUri("/mock/extension"),
		extensionPath: "/mock/extension",
		environmentVariableCollection: {
			persistent: true,
			description: undefined,
			replace: mock(),
			append: mock(),
			prepend: mock(),
			get: mock(),
			forEach: mock(),
			delete: mock(),
			clear: mock(),
			getScoped: mock(),
			[Symbol.iterator]: mock(),
		} as unknown as vscode.EnvironmentVariableCollection,
		extensionMode: 3, // Production
		globalState: {
			get: mock(),
			update: mock(async () => {}),
			keys: mock(() => []),
			setKeysForSync: mock(),
		} as unknown as vscode.Memento & {
			setKeysForSync(keys: readonly string[]): void;
		},
		workspaceState: {
			get: mock(),
			update: mock(async () => {}),
			keys: mock(() => []),
		} as unknown as vscode.Memento,
		secrets: {
			get: mock(async () => undefined),
			store: mock(async () => {}),
			delete: mock(async () => {}),
			onDidChange: mock(() => ({ dispose: () => {} })),
		} as unknown as vscode.SecretStorage,
		storageUri: undefined,
		storagePath: undefined,
		globalStorageUri: createMockUri("/mock/global/storage"),
		globalStoragePath: "/mock/global/storage",
		logUri: createMockUri("/mock/logs"),
		logPath: "/mock/logs",
		asAbsolutePath: mock(
			(relativePath: string) => `/mock/extension/${relativePath}`,
		),
		extension: {
			id: "test.extension",
			extensionUri: createMockUri("/mock/extension"),
			extensionPath: "/mock/extension",
			isActive: true,
			packageJSON: {},
			exports: undefined,
			activate: mock(async () => {}),
			extensionKind: 1, // Workspace
		} as unknown as vscode.Extension<unknown>,
		languageModelAccessInformation: {
			onDidChange: mock(() => ({ dispose: () => {} })),
			canSendRequest: mock(() => undefined),
		},
	};

	return {
		...defaultContext,
		...overrides,
	} as unknown as vscode.ExtensionContext;
}

/**
 * Create a complete typed Git Repository mock
 *
 * NOTE: This requires vscode.git types. For now, returns a minimal valid structure.
 * Expand as needed when testing git integration.
 */
export function createMockGitRepository(overrides?: {
	rootUri?: vscode.Uri;
	state?: unknown;
}): unknown {
	return {
		rootUri: overrides?.rootUri || createMockUri("/mock/repo"),
		state: overrides?.state || {
			onDidChange: mock(() => ({ dispose: () => {} })),
		},
	};
}

/**
 * Create a typed DeletedFileRecord
 *
 * Common structure for deleted file tracker tests
 */
export function createMockDeletedFileRecord(
	filePath: string,
	order: number,
	overrides?: Partial<DeletedFileRecord>,
): DeletedFileRecord {
	return {
		filePath,
		order,
		timestamp: Date.now(),
		isVisible: true,
		...overrides,
	};
}

/**
 * Create a complete typed vscode.TextEditor mock
 *
 * All required properties included - no type assertions needed
 */
export function createMockTextEditor(
	uri: vscode.Uri,
	overrides?: Partial<vscode.TextEditor>,
): vscode.TextEditor {
	const defaultEditor = {
		document: {
			uri,
			fileName: uri.fsPath,
			isUntitled: false,
			languageId: "typescript",
			version: 1,
			isDirty: false,
			isClosed: false,
			save: mock(async () => true),
			eol: 1, // LF
			lineCount: 1,
			getText: mock(() => ""),
			getWordRangeAtPosition: mock(() => undefined),
			validateRange: mock((range) => range),
			validatePosition: mock((pos) => pos),
			positionAt: mock(() => ({ line: 0, character: 0 })),
			offsetAt: mock(() => 0),
			lineAt: mock(() => ({
				lineNumber: 0,
				text: "",
				range: {},
				rangeIncludingLineBreak: {},
				firstNonWhitespaceCharacterIndex: 0,
				isEmptyOrWhitespace: true,
			})),
		} as unknown as vscode.TextDocument,
		selection: {
			active: { line: 0, character: 0 },
			anchor: { line: 0, character: 0 },
			start: { line: 0, character: 0 },
			end: { line: 0, character: 0 },
			isEmpty: true,
			isSingleLine: true,
			isReversed: false,
		} as unknown as vscode.Selection,
		selections: [],
		visibleRanges: [],
		options: {
			tabSize: 4,
			insertSpaces: true,
		},
		viewColumn: undefined,
		edit: mock(async () => true),
		insertSnippet: mock(async () => true),
		setDecorations: mock(),
		revealRange: mock(),
		show: mock(),
		hide: mock(),
	};

	return {
		...defaultEditor,
		...overrides,
	} as unknown as vscode.TextEditor;
}

/**
 * Create a complete typed vscode.WorkspaceFolder mock
 *
 * All required properties included - no type assertions needed
 */
export function createMockWorkspaceFolder(
	fsPath: string,
	overrides?: Partial<vscode.WorkspaceFolder>,
): vscode.WorkspaceFolder {
	const name = fsPath.split("/").pop() || "workspace";
	const defaultFolder = {
		uri: createMockUri(fsPath),
		name,
		index: 0,
	};

	return {
		...defaultFolder,
		...overrides,
	} as unknown as vscode.WorkspaceFolder;
}

/**
 * Safely set vscode.workspace.workspaceFolders for testing
 *
 * Uses Object.defineProperty to override readonly property correctly.
 * This is the proper way to mock readonly properties in tests.
 *
 * @param workspace The workspace object from vscode mock
 * @param folders Array of workspace folders or undefined
 */
/**
 * Set mock workspace folders
 *
 * Uses readonly arrays to match VS Code's actual type signature
 * Third-party type: vscode.WorkspaceFolder[] is readonly in VS Code API
 */
export function setMockWorkspaceFolders(
	workspace: {
		workspaceFolders?: readonly vscode.WorkspaceFolder[] | undefined;
	},
	folders: readonly vscode.WorkspaceFolder[] | undefined,
): void {
	Object.defineProperty(workspace, "workspaceFolders", {
		value: folders,
		writable: true,
		configurable: true,
	});
}

/**
 * Safely set vscode.window.activeTextEditor for testing
 *
 * Uses Object.defineProperty to override readonly property correctly.
 *
 * @param window The window object from vscode mock
 * @param editor TextEditor or undefined
 */
export function setMockActiveTextEditor(
	window: { activeTextEditor?: vscode.TextEditor },
	editor: vscode.TextEditor | undefined,
): void {
	Object.defineProperty(window, "activeTextEditor", {
		value: editor,
		writable: true,
		configurable: true,
	});
}

/**
 * Safely override a VS Code window method for a specific test
 *
 * Uses Object.defineProperty to replace the mock implementation.
 * Configurable property allows restoration between tests.
 *
 * @param window The window object from vscode mock
 * @param methodName The method to override
 * @param implementation The new implementation
 */
export function overrideWindowMethod(
	window: Record<string, unknown>,
	methodName: string,
	implementation: unknown,
): void {
	Object.defineProperty(window, methodName, {
		value: implementation,
		writable: true,
		configurable: true,
	});
}

/**
 * Create a complete typed WorkspaceConfiguration mock
 *
 * Returns proper WorkspaceConfiguration - not Mocks, but plain functions
 * This matches the interface exactly without type hacks
 */
export function createMockWorkspaceConfiguration(
	values?: Record<string, unknown>,
): import("../../src/types/vscode-types.js").WorkspaceConfiguration {
	return {
		get: <T>(key: string, defaultValue?: T): T | undefined => {
			if (values && key in values) {
				return values[key] as T;
			}
			return defaultValue;
		},
		has: (section: string): boolean => {
			return values ? section in values : false;
		},
		update: (_section: string, _value: unknown): Thenable<void> => {
			return Promise.resolve();
		},
	};
}

/**
 * Create a complete typed vscode.OutputChannel mock
 *
 * All required methods included - no type assertions needed
 */
export function createMockOutputChannel(
	name = "Test Channel",
): vscode.OutputChannel {
	return {
		name,
		append: mock(),
		appendLine: mock(),
		replace: mock(),
		clear: mock(),
		show: mock(),
		hide: mock(),
		dispose: mock(),
	} as unknown as vscode.OutputChannel;
}

/**
 * Create a complete typed FileSystem mock for node:fs/promises
 *
 * Returns proper FileSystemMock with sensible defaults for success paths
 * Override specific behaviors by passing overrides parameter
 *
 * @example
 * ```typescript
 * import { createMockFileSystem } from '../helpers/typed-mocks.js';
 * const mockFs = createMockFileSystem();
 * mock.module('node:fs/promises', () => mockFs);
 * ```
 */
export function createMockFileSystem(
	overrides?: Partial<import("../types/mock.types.js").FileSystemMock>,
): import("../types/mock.types.js").FileSystemMock {
	const defaults: import("../types/mock.types.js").FileSystemMock = {
		readFile: mock(() => Promise.resolve(Buffer.from("{}"))),
		writeFile: mock(() => Promise.resolve()),
		mkdir: mock(() => Promise.resolve()),
		access: mock(() => Promise.resolve()),
		stat: mock(() => Promise.resolve({ isDirectory: () => true, mode: 0o755 })),
		constants: { X_OK: 1, R_OK: 4, W_OK: 2 },
	};
	return { ...defaults, ...overrides };
}

/**
 * Create a complete typed Subprocess mock
 *
 * Returns proper SubprocessMock with all required properties
 * Includes: pid, exitCode, signalCode, killed, stdout, stderr, on, kill, ref, unref
 *
 * @example
 * ```typescript
 * import { createSubprocessMock } from '../helpers/typed-mocks.js';
 * const proc = createSubprocessMock({ pid: 12345 });
 * ```
 */
export function createSubprocessMock(
	overrides?: Partial<import("../types/mock.types.js").SubprocessMock>,
): import("../types/mock.types.js").SubprocessMock {
	const subprocess: import("../types/mock.types.js").SubprocessMock = {
		pid: 12345,
		exitCode: null,
		signalCode: null,
		killed: false,
		stdout: {
			on: mock(() => {}),
		},
		stderr: {
			on: mock(() => {}),
		},
		on: mock(() => {}),
		kill: mock(() => true),
		ref: mock(function (this: import("../types/mock.types.js").SubprocessMock) {
			return this;
		}),
		unref: mock(function (
			this: import("../types/mock.types.js").SubprocessMock,
		) {
			return this;
		}),
		...overrides,
	};
	return subprocess;
}

/**
 * Create a complete typed GroupingStateManager mock
 *
 * Uses the proper IGroupingStateManager interface from service-interfaces.ts
 * Returns interface-based mock with realistic default behaviors
 *
 * BEST PRACTICE: Mock interfaces, not classes with private properties
 *
 * @param enabled - Initial grouping state (default: false)
 * @param overrides - Override specific methods
 *
 * @example
 * ```typescript
 * import { createMockGroupingStateManager } from '../helpers/typed-mocks.js';
 *
 * // Simple mock - grouping disabled
 * const mockStateManager = createMockGroupingStateManager(false);
 *
 * // Mock with state change callback
 * const mockStateManager = createMockGroupingStateManager(true, {
 *   onDidChangeGrouping: mock((callback) => {
 *     stateChangeListeners.push(callback);
 *     return { dispose: () => {} };
 *   }),
 * });
 * ```
 */
export function createMockGroupingStateManager(
	enabled = false,
	overrides?: Partial<IGroupingStateManager>,
): IGroupingStateManager {
	return {
		isGroupingEnabled: mock(() => enabled),
		setGroupingEnabled: mock(async (_enabled: boolean) => {}),
		onDidChangeGrouping: mock(
			(_callback: (enabled: boolean) => void) =>
				({
					dispose: () => {},
				}) as vscode.Disposable,
		),
		dispose: mock(() => {}),
		...overrides,
	};
}

/**
 * Create a TerminalLauncherService instance with properly typed mock dependencies
 *
 * PURPOSE: Eliminate `as any` assertions when instantiating TerminalLauncherService in tests
 *
 * This helper consolidates all type assertions to ONE location instead of scattering
 * them across multiple test files. While we still use `as unknown as T` for type
 * conversion, it's better to have it in one place than 20+ scattered violations.
 *
 * @param deps - Mock dependencies for the service
 * @returns Fully instantiated TerminalLauncherService with mocks
 *
 * @example
 * ```typescript
 * const service = createTerminalLauncherService({
 *   security: mockSecurityService,
 *   processManager: mockProcessManager,
 *   workspace: mockVscode.workspace,
 *   window: mockVscode.window,
 *   spawn: mockSpawn,
 * });
 * ```
 */
