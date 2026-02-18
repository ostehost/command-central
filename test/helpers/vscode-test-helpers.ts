/**
 * VS Code Test Helpers for Bun
 * Utilities for testing VS Code extensions with Bun's test runner
 */

import { existsSync } from "node:fs";
// SKIP: VS Code module not available outside Extension Host - see KNOWN_LIMITATIONS.md
// import * as vscode from "vscode";
import path from "node:path";

// Mock vscode for tests - use type import for TypeScript
import type * as vscodeTypes from "vscode";

// Access global vscode in test environment or use empty object as fallback
const vscode =
	(global as { vscode?: typeof vscodeTypes }).vscode ||
	({} as typeof vscodeTypes);

/**
 * Wait for an extension to be available
 */
export async function waitForExtension(
	extensionId: string,
	timeout: number = 10000,
): Promise<vscodeTypes.Extension<unknown>> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		const extension =
			vscode.extensions.getExtension(extensionId) ||
			vscode.extensions.getExtension(`mike.${extensionId}`);

		if (extension) {
			return extension;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	// Extension not found within timeout
	const available = vscode.extensions.all.map(
		(e: vscodeTypes.Extension<unknown>) => e.id,
	);
	throw new Error(
		`Extension ${extensionId} not found after ${timeout}ms. ` +
			`Available extensions: ${available.join(", ")}`,
	);
}

/**
 * Wait for extension activation
 */
export async function waitForActivation(
	extension: vscodeTypes.Extension<unknown>,
	timeout: number = 5000,
): Promise<void> {
	if (extension.isActive) {
		return;
	}

	const startTime = Date.now();
	await extension.activate();
	const duration = Date.now() - startTime;

	if (duration > timeout) {
		throw new Error(
			`Extension activation took ${duration}ms (max: ${timeout}ms)`,
		);
	}
}

/**
 * Create a test workspace
 */
export async function createTestWorkspace(
	name: string = "test-workspace",
): Promise<vscodeTypes.WorkspaceFolder> {
	const workspacePath = path.join(process.cwd(), "test-workspaces", name);

	// Ensure directory exists
	await Bun.$`mkdir -p ${workspacePath}`;

	// Create a test file
	await Bun.write(
		path.join(workspacePath, "test.txt"),
		"Test workspace content",
	);

	// Open the workspace
	const uri = vscode.Uri.file(workspacePath);
	await vscode.commands.executeCommand("vscode.openFolder", uri);

	// Wait for workspace to be ready
	await new Promise((resolve) => setTimeout(resolve, 1000));

	const workspace = vscode.workspace.workspaceFolders?.[0];
	if (!workspace) {
		throw new Error("Failed to create test workspace");
	}

	return workspace;
}

/**
 * Execute a command and capture the result
 */
export async function executeCommand<T = unknown>(
	command: string,
	...args: unknown[]
): Promise<T> {
	try {
		const result = (await vscode.commands.executeCommand(
			command,
			...args,
		)) as T;
		return result;
	} catch (error) {
		throw new Error(
			`Command '${command}' failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Wait for a condition to be true
 */
export async function waitForCondition(
	condition: () => boolean | Promise<boolean>,
	options: {
		timeout?: number;
		interval?: number;
		message?: string;
	} = {},
): Promise<void> {
	const timeout = options.timeout || 5000;
	const interval = options.interval || 100;
	const message = options.message || "Condition not met";

	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		const result = await condition();
		if (result) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	throw new Error(`${message} (timeout: ${timeout}ms)`);
}

/**
 * Create a temporary file in the workspace
 */
export async function createTempFile(
	filename: string,
	content: string = "",
): Promise<vscodeTypes.Uri> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		throw new Error("No workspace folder available");
	}

	const filePath = path.join(workspaceFolder.uri.fsPath, filename);
	const uri = vscode.Uri.file(filePath);

	await Bun.write(filePath, content);

	return uri;
}

/**
 * Open a file in the editor
 */
export async function openFile(
	uri: vscodeTypes.Uri,
): Promise<vscodeTypes.TextEditor> {
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document);
	return editor;
}

/**
 * Close all editors
 */
export async function closeAllEditors(): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.closeAllEditors");
	await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Get output channel content
 */
export function getOutputChannelContent(
	_channelName: string,
): string | undefined {
	// Note: VS Code doesn't provide a direct API to read output channel content
	// This is a placeholder for when/if such API becomes available
	console.warn("Reading output channel content is not directly supported");
	return undefined;
}

/**
 * Mock VS Code window methods for testing
 */
export function mockWindowMethods() {
	interface MockCall {
		message: string;
		args: unknown[];
	}

	const mocks = {
		showInformationMessage: [] as MockCall[],
		showWarningMessage: [] as MockCall[],
		showErrorMessage: [] as MockCall[],
		showQuickPick: [] as MockCall[],
		showInputBox: [] as MockCall[],
	};

	// Store original methods
	const originals = {
		showInformationMessage: vscode.window.showInformationMessage,
		showWarningMessage: vscode.window.showWarningMessage,
		showErrorMessage: vscode.window.showErrorMessage,
		showQuickPick: vscode.window.showQuickPick,
		showInputBox: vscode.window.showInputBox,
	};

	// Replace with mocks that capture calls using Object.defineProperty
	Object.defineProperty(vscode.window, "showInformationMessage", {
		value: (message: string, ...args: unknown[]) => {
			mocks.showInformationMessage.push({ message, args });
			return Promise.resolve(undefined);
		},
		writable: true,
		configurable: true,
	});

	Object.defineProperty(vscode.window, "showWarningMessage", {
		value: (message: string, ...args: unknown[]) => {
			mocks.showWarningMessage.push({ message, args });
			return Promise.resolve(undefined);
		},
		writable: true,
		configurable: true,
	});

	Object.defineProperty(vscode.window, "showErrorMessage", {
		value: (message: string, ...args: unknown[]) => {
			mocks.showErrorMessage.push({ message, args });
			return Promise.resolve(undefined);
		},
		writable: true,
		configurable: true,
	});

	return {
		mocks,
		restore: () => {
			Object.assign(vscode.window, originals);
		},
	};
}

/**
 * Assert that a command is registered
 */
// DISABLED: Requires expect from test context
// export async function assertCommandRegistered(command: string): Promise<void> {
// 	const commands = await vscode.commands.getCommands(true);
// 	expect(commands).toContain(command);
// }

/**
 * Assert extension has specific contribution
 */
// DISABLED: Requires expect from test context
// export function assertContribution(
// 	extension: vscodeTypes.Extension<any>,
// 	type: string,
// 	validator?: (contribution: any) => boolean,
// ): void {
// 	const contributions = extension.packageJSON.contributes;
// 	expect(contributions).toBeTruthy();
// 	expect(contributions[type]).toBeTruthy();
//
// 	if (validator) {
// 		expect(validator(contributions[type])).toBe(true);
// 	}
// }

/**
 * Measure command execution time
 */
export async function measureCommandTime(
	command: string,
	...args: unknown[]
): Promise<number> {
	const start = performance.now();
	await vscode.commands.executeCommand(command, ...args);
	return performance.now() - start;
}

/**
 * Clean up test workspace
 */
export async function cleanupTestWorkspace(): Promise<void> {
	const testWorkspacesPath = path.join(process.cwd(), "test-workspaces");
	if (existsSync(testWorkspacesPath)) {
		await Bun.$`rm -rf ${testWorkspacesPath}`;
	}
}

// Re-export for convenience - DISABLED: causes import issues
// export { expect } from "bun:test";
