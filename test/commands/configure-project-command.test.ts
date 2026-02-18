/**
 * Tests for configure-project-command.ts
 * Project configuration command
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

describe("configure-project-command", () => {
	let mockService: TerminalLauncherService;
	let mockOutputChannel: MockOutputChannel;
	let mockSecurityService: MockSecurityService;

	beforeEach(() => {
		// Create properly typed mocks
		mockOutputChannel = createMockOutputChannel();
		mockSecurityService = createMockSecurityService(mockOutputChannel);
		mockService = createMockTerminalLauncherService(mockSecurityService);
	});

	test("success path - configures project and logs success", async () => {
		const { execute } = await import(
			"../../src/commands/configure-project-command.js"
		);

		await execute(mockService);

		// Verify logging
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Executing commandCentral.terminal.configure command",
		);
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Project configuration completed",
		);

		// Verify service was called
		expect(mockService.configureProject).toHaveBeenCalledTimes(1);
	});

	test("exception path - catches and wraps service errors", async () => {
		const { execute } = await import(
			"../../src/commands/configure-project-command.js"
		);

		// Mock service to throw
		mockService.configureProject = mock(() => {
			throw new Error("Invalid icon selection");
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to configure project: Invalid icon selection",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in configureProject command: Invalid icon selection",
		);
	});

	test("exception path - handles non-Error objects", async () => {
		const { execute } = await import(
			"../../src/commands/configure-project-command.js"
		);

		// Mock service to throw string
		mockService.configureProject = mock(() => {
			throw "Configuration cancelled";
		});

		// Expect the command to throw wrapped error
		await expect(execute(mockService)).rejects.toThrow(
			"Failed to configure project: Configuration cancelled",
		);

		// Verify error was logged
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
			"Error in configureProject command: Configuration cancelled",
		);
	});

	test("uses output channel from security service", async () => {
		const { execute } = await import(
			"../../src/commands/configure-project-command.js"
		);

		await execute(mockService);

		// Verify security service was called to get output channel
		expect(mockService.getSecurityService).toHaveBeenCalledTimes(1);
		expect(mockSecurityService.getOutputChannel).toHaveBeenCalledTimes(1);
	});
});
