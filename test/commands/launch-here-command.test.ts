/**
 * Tests for launch-here-command.ts
 * Launch terminal at specific file/folder location
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import {
	createMockTextEditor,
	createMockUri,
	setMockActiveTextEditor,
} from "../helpers/typed-mocks.js";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";
import {
	createMockOutputChannel,
	createMockSecurityService,
	createMockTerminalLauncherService,
	type MockOutputChannel,
	type MockSecurityService,
} from "../types/command-test-mocks.js";

describe("launch-here-command", () => {
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

	test("success path with URI - launches terminal at specified location", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/launch-here-command.js"
		);

		const testUri = vscode.Uri.file("/test/path");

		await execute(mockService, testUri);

		// Verify service was called with URI
		expect(mockService.launchHere).toHaveBeenCalledWith(testUri);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.launchHere command at /test/path",
		);
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Terminal launched successfully at /test/path with PID: 12345",
		);
	});

	test("success path without URI - uses active editor location", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/launch-here-command.js"
		);

		const editorUri = createMockUri("/editor/file.txt");
		const mockEditor = createMockTextEditor(editorUri);

		// Set active editor using proper helper (no type assertions)
		setMockActiveTextEditor(vscode.window, mockEditor);

		await execute(mockService);

		// Verify service was called with editor URI
		expect(mockService.launchHere).toHaveBeenCalledWith(editorUri);
	});

	test("no URI and no active editor - shows warning and returns early", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/launch-here-command.js"
		);

		// Set no active editor using proper helper (no type assertions)
		setMockActiveTextEditor(vscode.window, undefined);

		await execute(mockService);

		// Verify warning was shown
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"No file or folder selected. Right-click on a file or folder in the Explorer, or open a file in the editor first.",
		);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Warning: No path available for launchHere command",
		);

		// Verify service was NOT called
		expect(mockService.launchHere).not.toHaveBeenCalled();
	});

	test("failure path - logs error and throws when service returns failure", async () => {
		const vscode = await import("vscode");
		const { execute } = await import(
			"../../src/commands/launch-here-command.js"
		);

		const testUri = vscode.Uri.file("/test/path");

		// Mock service to return failure
		mockService.launchHere = mock(() =>
			Promise.resolve({
				success: false,
				pid: undefined,
				error: "Invalid path",
			}),
		);

		// Expect the command to throw
		await expect(execute(mockService, testUri)).rejects.toThrow("Invalid path");

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Failed to launch terminal here: Invalid path",
		);
	});

});
