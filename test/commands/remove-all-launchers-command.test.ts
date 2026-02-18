/**
 * Tests for remove-all-launchers-command.ts
 * Bulk launcher removal command
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import { overrideWindowMethod } from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	createMockOutputChannel,
	createMockSecurityService,
	createMockTerminalLauncherService,
	type MockOutputChannel,
	type MockSecurityService,
} from "../types/command-test-mocks.js";

describe("remove-all-launchers-command", () => {
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

	test("success path - shows confirmation and removes all launchers", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-all-launchers-command.js"
		);

		// Mock user confirming removal
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove All")),
		);

		await execute(mockService);

		// Verify confirmation was shown
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"Remove ALL project launchers? This cannot be undone.",
			"Remove All",
			"Cancel",
		);

		// Verify service was called
		expect(mockService.removeAllLaunchers).toHaveBeenCalledTimes(1);

		// Verify success was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Successfully removed all launchers",
		);
	});

	test("user cancels confirmation - service not called", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-all-launchers-command.js"
		);

		// Mock user canceling
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Cancel")),
		);

		await execute(mockService);

		// Verify service was NOT called
		expect(mockService.removeAllLaunchers).not.toHaveBeenCalled();

		// Verify only command execution was logged (no success/failure)
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.removeAllLaunchers command",
		);
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith(
			expect.stringContaining("removed"),
		);
	});

	// REMOVED: Redundant boilerplate test

	test("service returns false - logs failure", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-all-launchers-command.js"
		);

		// Mock user confirming
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Remove All")),
		);

		// Mock service to return false
		mockService.removeAllLaunchers = mock(() => Promise.resolve(false));

		await execute(mockService);

		// Verify failure was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Failed to remove all launchers",
		);
	});

	// REMOVED: Redundant boilerplate test

	// REMOVED: Redundant boilerplate test

	// REMOVED: Redundant boilerplate test

	test("logging - logs command execution", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/remove-all-launchers-command.js"
		);

		// Mock user canceling (quick exit)
		overrideWindowMethod(
			vscode.window,
			"showWarningMessage",
			mock(() => Promise.resolve("Cancel")),
		);

		await execute(mockService);

		// Verify command execution was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.removeAllLaunchers command",
		);
	});
});
