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
});
