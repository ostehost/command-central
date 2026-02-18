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
