/**
 * Tests for remove-launcher-command.ts
 * Launcher removal command
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import {
	createMockWorkspaceFolder,
	overrideWindowMethod,
	setMockWorkspaceFolders,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	createMockOutputChannel,
	createMockSecurityService,
	createMockTerminalLauncherService,
	type MockOutputChannel,
	type MockSecurityService,
} from "../types/command-test-mocks.js";

describe("remove-launcher-command", () => {
	let mockService: TerminalLauncherService;
	let mockOutputChannel: MockOutputChannel;
	let mockSecurityService: MockSecurityService;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock();

		// Create properly typed mocks
		mockOutputChannel = createMockOutputChannel();
		mockSecurityService = createMockSecurityService(mockOutputChannel);
		mockService = createMockTerminalLauncherService(mockSecurityService);
	});

	test("no workspace folder - shows error and returns early", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock no workspace folders using helper
		setMockWorkspaceFolders(vscode.workspace, undefined);

		await execute(mockService);

		// Verify error message was shown
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			"No workspace folder is open",
		);

		// Verify service was NOT called
		expect(mockService.removeLauncher).not.toHaveBeenCalled();
	});

	test("success path with project name from settings - shows confirmation and removes", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to return project name from settings
		mock.module("node:fs/promises", () => ({
			readFile: mock(() =>
				Promise.resolve(
					JSON.stringify({
						"commandCentral.project.name": "MyProject",
					}),
				),
			),
		}));

		// Mock user confirming removal
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove")),
		);

		await execute(mockService);

		// Verify confirmation was shown with project name from settings
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			'Remove launcher for "MyProject"?',
			"Remove",
			"Cancel",
		);

		// Verify service was called with project name
		expect(mockService.removeLauncher).toHaveBeenCalledWith("MyProject");

		// Verify success was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Successfully removed launcher: MyProject",
		);
	});

	test("success path without settings - uses folder name as fallback", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/my-project-folder");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user confirming removal
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove")),
		);

		await execute(mockService);

		// Verify confirmation was shown with folder name
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			'Remove launcher for "my-project-folder"?',
			"Remove",
			"Cancel",
		);

		// Verify service was called with folder name
		expect(mockService.removeLauncher).toHaveBeenCalledWith(
			"my-project-folder",
		);
	});

	test("user cancels confirmation - service not called", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user canceling
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Cancel")),
		);

		await execute(mockService);

		// Verify service was NOT called
		expect(mockService.removeLauncher).not.toHaveBeenCalled();
	});

	test("user dismisses confirmation - service not called", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user dismissing
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve(undefined)),
		);

		await execute(mockService);

		// Verify service was NOT called
		expect(mockService.removeLauncher).not.toHaveBeenCalled();
	});

	test("service returns false - logs failure", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user confirming
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove")),
		);

		// Mock service to return false
		mockService.removeLauncher = mock(() => Promise.resolve(false));

		await execute(mockService);

		// Verify failure was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Failed to remove launcher: project",
		);
	});

	test("exception path - catches and wraps service errors", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user confirming
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove")),
		);

		// Mock service to throw
		mockService.removeLauncher = mock(() => {
			throw new Error("File system error");
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to remove launcher: File system error",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in removeCurrentLauncher command: File system error",
		);
	});

	test("exception path - handles non-Error objects", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user confirming
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove")),
		);

		// Mock service to throw string
		mockService.removeLauncher = mock(() => {
			throw "Unexpected failure";
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to remove launcher: Unexpected failure",
		);
	});

	test("uses output channel from security service", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-launcher-command.js"
		);

		// Mock workspace folder using helper
		const folder = createMockWorkspaceFolder("/test/project");
		setMockWorkspaceFolders(vscode.workspace, [folder]);

		// Mock fs to throw (no settings file)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.reject(new Error("ENOENT"))),
		}));

		// Mock user canceling (quick exit)
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Cancel")),
		);

		await execute(mockService);

		// Verify security service was called to get output channel
		expect(mockService.getSecurityService).toHaveBeenCalledTimes(1);
		expect(mockSecurityService.getOutputChannel).toHaveBeenCalledTimes(1);
	});
});
