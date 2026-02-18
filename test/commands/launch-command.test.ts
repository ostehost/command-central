/**
 * Tests for launch-command.ts
 * Basic terminal launch workflow
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import {
	createMockOutputChannel,
	createMockSecurityService,
	createMockTerminalLauncherService,
	type MockOutputChannel,
	type MockSecurityService,
} from "../types/command-test-mocks.js";

describe("launch-command", () => {
	let mockService: TerminalLauncherService;
	let mockOutputChannel: MockOutputChannel;
	let mockSecurityService: MockSecurityService;

	beforeEach(() => {
		// Create properly typed mocks
		mockOutputChannel = createMockOutputChannel();
		mockSecurityService = createMockSecurityService(mockOutputChannel);
		mockService = createMockTerminalLauncherService(mockSecurityService);
	});

	test("success path - launches terminal and logs success", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		await execute(mockService);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.launch command",
		);
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Terminal launched successfully with PID: 12345",
		);

		// Verify service was called
		expect(mockService.launch).toHaveBeenCalledTimes(1);
	});

	test("success path without PID - logs success without PID", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		// Mock service to return success without PID
		mockService.launch = mock(() =>
			Promise.resolve({ success: true, pid: undefined, error: undefined }),
		);

		await execute(mockService);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Terminal launched successfully",
		);
	});

	test("failure path - logs error and throws when service returns failure", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		// Mock service to return failure
		mockService.launch = mock(() =>
			Promise.resolve({
				success: false,
				pid: undefined,
				error: "Permission denied",
			}),
		);

		// Expect the command to throw
		await expect(execute(mockService)).rejects.toThrow("Permission denied");

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Failed to launch terminal: Permission denied",
		);
	});

	test("failure path with no error message - uses default error", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		// Mock service to return failure without error message
		mockService.launch = mock(() =>
			Promise.resolve({ success: false, pid: undefined, error: undefined }),
		);

		// Expect the command to throw with default message
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to launch terminal. Check the Output panel for more details.",
		);
	});

	test("exception path - catches and re-throws service errors", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		// Mock service to throw
		mockService.launch = mock(() => {
			throw new Error("Network timeout");
		});

		// Expect the command to throw
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to launch terminal: Network timeout",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in launch command: Network timeout",
		);
	});

	test("exception path - re-throws terminal-related errors without wrapping", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		// Mock service to throw terminal-related error
		mockService.launch = mock(() => {
			throw new Error("terminal not found");
		});

		// Expect the command to throw the original error (not wrapped)
		await expect(execute(mockService)).rejects.toThrow("terminal not found");
	});

	test("exception path - handles non-Error objects", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		// Mock service to throw string
		mockService.launch = mock(() => {
			throw "Something went wrong";
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to launch terminal: Something went wrong",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in launch command: Something went wrong",
		);
	});

	test("uses output channel from security service", async () => {
		const { execute } = await import("../../src/commands/launch-command.js");

		await execute(mockService);

		// Verify security service was called to get output channel
		expect(mockService.getSecurityService).toHaveBeenCalledTimes(1);
		expect(mockSecurityService.getOutputChannel).toHaveBeenCalledTimes(1);
	});
});
