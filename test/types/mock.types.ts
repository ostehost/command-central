/**
 * Mock type definitions for tests
 * Using Bun's native Mock type and VS Code types
 */

import type { Mock } from "bun:test";
import type * as vscode from "vscode";

/**
 * Typed VS Code mock structure
 */
export interface VSCodeMock {
	window: {
		showInformationMessage: Mock<
			(message: string, ...items: string[]) => Thenable<string | undefined>
		>;
		showErrorMessage: Mock<
			(message: string, ...items: string[]) => Thenable<string | undefined>
		>;
		showWarningMessage: Mock<
			(message: string, ...items: string[]) => Thenable<string | undefined>
		>;
		showInputBox: Mock<
			(options?: vscode.InputBoxOptions) => Thenable<string | undefined>
		>;
		showQuickPick: Mock<
			(
				items: string[] | Thenable<string[]>,
				options?: vscode.QuickPickOptions,
			) => Thenable<string | undefined>
		>;
		createOutputChannel: Mock<(name: string) => vscode.OutputChannel>;
		createTerminal: Mock<(options: vscode.TerminalOptions) => vscode.Terminal>;
		activeTextEditor: vscode.TextEditor | undefined;
		visibleTextEditors: vscode.TextEditor[];
		terminals: vscode.Terminal[];
	};
	workspace: {
		getConfiguration: Mock<
			(section?: string, scope?: vscode.Uri) => vscode.WorkspaceConfiguration
		>;
		workspaceFolders: vscode.WorkspaceFolder[] | undefined;
		getWorkspaceFolder: Mock<
			(uri: vscode.Uri) => vscode.WorkspaceFolder | undefined
		>;
		fs: {
			readFile: Mock<(uri: vscode.Uri) => Thenable<Uint8Array>>;
			writeFile: Mock<(uri: vscode.Uri, content: Uint8Array) => Thenable<void>>;
			delete: Mock<
				(uri: vscode.Uri, options?: { recursive?: boolean }) => Thenable<void>
			>;
			createDirectory: Mock<(uri: vscode.Uri) => Thenable<void>>;
			readDirectory: Mock<
				(uri: vscode.Uri) => Thenable<[string, vscode.FileType][]>
			>;
			stat: Mock<(uri: vscode.Uri) => Thenable<vscode.FileStat>>;
		};
	};
	commands: {
		registerCommand: Mock<
			(
				command: string,
				callback: (...args: unknown[]) => unknown,
			) => vscode.Disposable
		>;
		executeCommand: Mock<
			(command: string, ...rest: unknown[]) => Thenable<unknown>
		>;
		getCommands: Mock<(filterInternal?: boolean) => Thenable<string[]>>;
	};
	extensions: {
		getExtension: Mock<
			(extensionId: string) => vscode.Extension<unknown> | undefined
		>;
		all: vscode.Extension<unknown>[];
	};
	Uri: typeof vscode.Uri;
	RelativePattern: typeof vscode.RelativePattern;
	Disposable: typeof vscode.Disposable;
	TreeItem: typeof vscode.TreeItem;
	TreeItemCollapsibleState: typeof vscode.TreeItemCollapsibleState;
}

/**
 * Security service mock interface
 * Matches ISecurityService from src/types/service-interfaces.ts
 */
export interface SecurityServiceMock {
	checkWorkspaceTrust: Mock<() => Promise<boolean>>;
	isCommandAllowed: Mock<(command: unknown) => boolean>;
	validateCommand: Mock<
		(
			command: string,
			args: string[],
		) => Promise<{ command: string; args: string[]; isValid: boolean }>
	>;
	getExecutionLimits: Mock<
		() => {
			timeout: number;
			maxBuffer: number;
			killSignal: "SIGTERM" | "SIGKILL";
			shell: boolean;
		}
	>;
	auditLog: Mock<
		(
			command: string,
			args: string[],
			result: { success: boolean; error?: string },
		) => void
	>;
	sanitizePath: Mock<(path: string) => string>;
	getOutputChannel: Mock<() => vscode.OutputChannel>;
	dispose: Mock<() => void>;
}

/**
 * Process manager mock interface
 */
export interface ProcessManagerMock {
	track: Mock<(pid: number) => boolean>;
	untrack: Mock<(pid: number) => void>;
	isTracked: Mock<(pid: number) => boolean>;
	getActiveCount: Mock<() => number>;
	healthCheck: Mock<() => void>;
	cleanup: Mock<() => Promise<void>>;
	isAlive: Mock<(pid: number) => boolean>;
	getProcessInfo: Mock<
		(pid: number) => { pid: number; startTime: number } | undefined
	>;
}

/**
 * Spawn mock for subprocess testing
 * Matches Node.js spawn signature: (command, args?, options?) => SpawnResult
 */
export type SpawnMock = Mock<
	(
		command: string,
		args?: readonly string[],
		options?: {
			detached?: boolean;
			stdio?: string;
			env?: NodeJS.ProcessEnv;
		},
	) => SubprocessMock
>;

/**
 * Mock subprocess interface
 */
export interface SubprocessMock {
	pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	killed: boolean;
	stdout: {
		on: Mock<(event: string, listener: (data: unknown) => void) => void>;
	};
	stderr: {
		on: Mock<(event: string, listener: (data: unknown) => void) => void>;
	};
	on: Mock<(event: string, listener: (data: unknown) => void) => void>;
	kill: Mock<(signal?: string | number) => boolean>;
	ref: Mock<() => void>;
	unref: Mock<() => void>;
}

/**
 * File system mock interface for node:fs/promises
 *
 * Provides typed mock for Node.js file system operations
 */
export interface FileSystemMock {
	readFile: Mock<(path: string) => Promise<Buffer>>;
	writeFile: Mock<(path: string, data: string | Buffer) => Promise<void>>;
	mkdir: Mock<
		(path: string, options?: { recursive?: boolean }) => Promise<void>
	>;
	access: Mock<(path: string, mode?: number) => Promise<void>>;
	stat: Mock<
		(path: string) => Promise<{ isDirectory: () => boolean; mode?: number }>
	>;
	constants: { X_OK: number; R_OK: number; W_OK: number };
}

/**
 * TreeView mock interface for vscode.TreeView<T>
 *
 * Generic tree view mock for testing tree providers
 */
export interface TreeViewMock<T = unknown> {
	reveal: Mock<
		(
			element: T,
			options?: { select?: boolean; focus?: boolean },
		) => Thenable<void>
	>;
	onDidChangeVisibility: Mock<
		(
			listener: (e: vscode.TreeViewVisibilityChangeEvent) => void,
		) => vscode.Disposable
	>;
	onDidChangeSelection: Mock<
		(
			listener: (e: vscode.TreeViewSelectionChangeEvent<T>) => void,
		) => vscode.Disposable
	>;
	visible: boolean;
	selection: readonly T[];
	dispose: Mock<() => void>;
}

/**
 * Process result mock interface
 *
 * Represents the result of a spawned process (from Bun.spawn or child_process)
 */
export interface ProcessResultMock {
	pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	stdout: {
		text: Mock<() => Promise<string>>;
	};
	stderr: {
		text: Mock<() => Promise<string>>;
	};
	killed: boolean;
}
