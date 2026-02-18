/**
 * Tests for list-launchers-command.ts
 * Launcher listing command
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

describe("list-launchers-command", () => {
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

	test("success path with launchers - shows quick pick and logs count", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		await execute(mockService);

		// Verify quick pick was shown
		expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
			["project1", "project2", "project3"],
			{
				placeHolder: "Found 3 project launcher(s)",
				title: "Terminal Project Launchers",
			},
		);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.listLaunchers command",
		);
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Listed 3 launcher(s)",
		);
	});

	test("success path with selection - shows info message", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		// Mock user selecting a launcher
		overrideWindowMethod(
			vscode.window,
			"showQuickPick",
			mock(() => Promise.resolve("project2")),
		);

		await execute(mockService);

		// Verify info message was shown with selection
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Selected: project2",
		);
	});

	test("success path without selection - no info message shown", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		// Mock user dismissing quick pick
		overrideWindowMethod(
			vscode.window,
			"showQuickPick",
			mock(() => Promise.resolve(undefined)),
		);

		await execute(mockService);

		// Verify info message was NOT shown (no selection)
		expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
	});

	test("no launchers found - shows info message and returns early", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		// Mock no launchers
		mockService.listLaunchers = mock(() => Promise.resolve([]));

		await execute(mockService);

		// Verify info message was shown
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"No project launchers found",
		);

		// Verify quick pick was NOT shown
		expect(vscode.window.showQuickPick).not.toHaveBeenCalled();

		// Verify count was NOT logged (early return)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalledWith(
			expect.stringContaining("Listed"),
		);
	});

	test("exception path - catches and wraps service errors", async () => {
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		// Mock service to throw
		mockService.listLaunchers = mock(() => {
			throw new Error("Directory read failed");
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to list launchers: Directory read failed",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in listLaunchers command: Directory read failed",
		);
	});

	test("exception path - handles non-Error objects", async () => {
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		// Mock service to throw string
		mockService.listLaunchers = mock(() => {
			throw "Unexpected error";
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to list launchers: Unexpected error",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in listLaunchers command: Unexpected error",
		);
	});

	test("uses output channel from security service", async () => {
		const { execute } = await import(
			"../../src/commands/list-launchers-command.js"
		);

		await execute(mockService);

		// Verify security service was called to get output channel
		expect(mockService.getSecurityService).toHaveBeenCalledTimes(1);
		expect(mockSecurityService.getOutputChannel).toHaveBeenCalledTimes(1);
	});
});
