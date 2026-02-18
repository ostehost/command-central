/**
 * Tests for launch-workspace-command.ts
 * Launch terminal at workspace root
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

describe("launch-workspace-command", () => {
	let mockService: TerminalLauncherService;
	let mockOutputChannel: MockOutputChannel;
	let mockSecurityService: MockSecurityService;

	beforeEach(() => {
		// Create properly typed mocks
		mockOutputChannel = createMockOutputChannel();
		mockSecurityService = createMockSecurityService(mockOutputChannel);
		mockService = createMockTerminalLauncherService(mockSecurityService);
	});

	test("success path - launches terminal at workspace root and logs success", async () => {
		const { execute } = await import(
			"../../src/commands/launch-workspace-command.js"
		);

		await execute(mockService);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.launchWorkspace command",
		);
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Terminal launched successfully at workspace root with PID: 12345",
		);

		// Verify service was called
		expect(mockService.launchWorkspace).toHaveBeenCalledTimes(1);
	});

	test("success path without PID - logs success without PID", async () => {
		const { execute } = await import(
			"../../src/commands/launch-workspace-command.js"
		);

		// Mock service to return success without PID
		mockService.launchWorkspace = mock(() =>
			Promise.resolve({ success: true, pid: undefined, error: undefined }),
		);

		await execute(mockService);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Terminal launched successfully at workspace root",
		);
	});

	test("failure path - logs error and throws when service returns failure", async () => {
		const { execute } = await import(
			"../../src/commands/launch-workspace-command.js"
		);

		// Mock service to return failure
		mockService.launchWorkspace = mock(() =>
			Promise.resolve({
				success: false,
				pid: undefined,
				error: "No workspace folder found",
			}),
		);

		// Expect the command to throw
		await expect(execute(mockService)).rejects.toThrow(
			"No workspace folder found",
		);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Failed to launch terminal at workspace: No workspace folder found",
		);
	});

	test("exception path - re-throws terminal-related errors without wrapping", async () => {
		const { execute } = await import(
			"../../src/commands/launch-workspace-command.js"
		);

		// Mock service to throw terminal-related error
		mockService.launchWorkspace = mock(() => {
			throw new Error("terminal binary not found");
		});

		// Expect the command to throw the original error (not wrapped)
		await expect(execute(mockService)).rejects.toThrow(
			"terminal binary not found",
		);
	});

	// REMOVED: Redundant boilerplate test
});
