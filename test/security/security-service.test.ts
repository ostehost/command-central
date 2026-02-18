/**
 * Tests for SecurityService - ESM module with Bun test runner
 */

import { beforeEach, describe, expect, type Mock, test } from "bun:test";
import { SecurityService } from "../../src/security/security-service.js";
import type {
	VSCodeWindow,
	VSCodeWorkspace,
} from "../../src/types/vscode-types.js";
import {
	assertThrows,
	createMockWindow,
	createMockWorkspace,
	mock,
} from "../mocks/index.test.js";

describe("SecurityService", () => {
	let service: SecurityService;
	let mockWorkspace: VSCodeWorkspace;
	let mockWindow: VSCodeWindow;
	let mockShowWarning: Mock<
		(...args: unknown[]) => Promise<string | undefined>
	>;
	let mockGetConfig: Mock<(...args: unknown[]) => unknown>;
	let mockCreateChannel: Mock<(...args: unknown[]) => unknown>;

	beforeEach(() => {
		// Create typed mock VS Code APIs using factory functions
		mockWorkspace = createMockWorkspace();
		mockWindow = createMockWindow();

		// Create mockable wrappers for vscode functions that need .mockResolvedValue() / .mockReturnValue()
		mockShowWarning = mock();
		mockGetConfig = mock(() => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}));
		mockCreateChannel = mock();

		// Replace with mockable versions
		mockWindow.showWarningMessage =
			mockShowWarning as typeof mockWindow.showWarningMessage;
		mockWorkspace.getConfiguration =
			mockGetConfig as typeof mockWorkspace.getConfiguration;
		mockWindow.createOutputChannel =
			mockCreateChannel as typeof mockWindow.createOutputChannel;

		service = new SecurityService(mockWorkspace, mockWindow);
	});

	describe("checkWorkspaceTrust", () => {
		test("allows execution in trusted workspace", async () => {
			mockWorkspace.isTrusted = true;
			const result = await service.checkWorkspaceTrust();
			expect(result).toBe(true);
		});

		test("prompts user in untrusted workspace", async () => {
			mockWorkspace.isTrusted = false;
			mockShowWarning.mockResolvedValue("Trust Workspace");

			const result = await service.checkWorkspaceTrust();

			expect(result).toBe(true);
			expect(mockShowWarning).toHaveBeenCalledWith(
				expect.stringContaining("trusted workspace"),
				expect.objectContaining({ modal: true }),
				"Trust Workspace",
			);
		});

		test("blocks execution when user declines trust", async () => {
			mockWorkspace.isTrusted = false;
			mockShowWarning.mockResolvedValue(undefined);

			const result = await service.checkWorkspaceTrust();

			expect(result).toBe(false);
		});
	});

	describe("isCommandAllowed", () => {
		test("allows configured commands", () => {
			expect(service.isCommandAllowed("ls")).toBe(true);
			expect(service.isCommandAllowed("pwd")).toBe(true);
			expect(service.isCommandAllowed("echo")).toBe(true);
		});

		test("blocks unconfigured commands", () => {
			expect(service.isCommandAllowed("rm")).toBe(false);
			expect(service.isCommandAllowed("curl")).toBe(false);
			expect(service.isCommandAllowed("eval")).toBe(false);
		});

		test("is case sensitive", () => {
			expect(service.isCommandAllowed("LS")).toBe(false);
			expect(service.isCommandAllowed("Echo")).toBe(false);
		});

		test("rejects empty or invalid commands", () => {
			expect(service.isCommandAllowed("")).toBe(false);
			expect(service.isCommandAllowed("  ")).toBe(false);
			// Testing runtime null/undefined handling - signature now accepts unknown
			// Security layer validates defensive programming against malformed inputs
			expect(service.isCommandAllowed(null)).toBe(false);
			expect(service.isCommandAllowed(undefined)).toBe(false);
		});
	});

	describe("validateCommand", () => {
		test("validates allowed commands with sanitized args", async () => {
			const result = await service.validateCommand("echo", ["hello", "world"]);

			expect(result).toEqual({
				command: "echo",
				args: ["hello", "world"],
				isValid: true,
			});
		});

		test("rejects disallowed commands", async () => {
			await assertThrows(
				() => service.validateCommand("rm", ["-rf", "/"]),
				/not allowed/i,
			);
		});

		test("sanitizes command arguments", async () => {
			const result = await service.validateCommand("echo", [
				"test;evil",
				"$(whoami)",
			]);

			expect(result.args).toEqual(["testevil", "whoami"]);
			expect(result.isValid).toBe(true);
		});

		test("validates executable paths", async () => {
			const result = await service.validateCommand("/usr/bin/ls", []);

			expect(result.command).toBe("/usr/bin/ls");
			expect(result.isValid).toBe(true);
		});

		test("rejects invalid executable paths", async () => {
			await assertThrows(
				() => service.validateCommand("/usr/bin/ls;evil", []),
				/invalid executable/i,
			);
		});
	});

	describe("getExecutionLimits", () => {
		test("returns configured limits", () => {
			const limits = service.getExecutionLimits();

			expect(limits.timeout).toBe(30000);
			expect(limits.maxBuffer).toBe(10 * 1024 * 1024);
			expect(limits.killSignal).toBe("SIGTERM");
			expect(limits.shell).toBe(false);
		});

		test("enforces minimum timeout", () => {
			mockGetConfig.mockReturnValue({
				get: mock((key: string) =>
					key === "executionTimeout" ? 100 : undefined,
				),
			});

			const newService = new SecurityService(mockWorkspace, mockWindow);
			const limits = newService.getExecutionLimits();

			expect(limits.timeout).toBeGreaterThanOrEqual(1000);
		});

		test("enforces maximum timeout", () => {
			mockGetConfig.mockReturnValue({
				get: mock((key: string) =>
					key === "executionTimeout" ? 1000000 : undefined,
				),
			});

			const newService = new SecurityService(mockWorkspace, mockWindow);
			const limits = newService.getExecutionLimits();

			expect(limits.timeout).toBeLessThanOrEqual(300000);
		});
	});

	describe("auditLog", () => {
		test("logs command execution", () => {
			const outputChannel = {
				appendLine: mock(),
				append: mock(),
				show: mock(),
				dispose: mock(),
			};

			mockCreateChannel.mockReturnValue(outputChannel);
			const newService = new SecurityService(mockWorkspace, mockWindow);

			newService.auditLog("echo", ["hello"], { success: true });

			expect(outputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("echo"),
			);
		});

		test("includes timestamp in log", () => {
			const outputChannel = {
				appendLine: mock(),
				append: mock(),
				show: mock(),
				dispose: mock(),
			};

			mockCreateChannel.mockReturnValue(outputChannel);
			const newService = new SecurityService(mockWorkspace, mockWindow);

			newService.auditLog("ls", [], { success: true });

			const logCall = outputChannel.appendLine.mock.calls?.[0]?.[0];
			expect(logCall).toMatch(/\d{4}-\d{2}-\d{2}/); // Date pattern
		});

		test("logs failed executions", () => {
			const outputChannel = {
				appendLine: mock(),
				append: mock(),
				show: mock(),
				dispose: mock(),
			};

			mockCreateChannel.mockReturnValue(outputChannel);
			const newService = new SecurityService(mockWorkspace, mockWindow);

			newService.auditLog("cat", ["/etc/passwd"], {
				success: false,
				error: "Permission denied",
			});

			const logCall = outputChannel.appendLine.mock.calls?.[0]?.[0];
			expect(logCall).toContain("FAILED");
			expect(logCall).toContain("Permission denied");
		});
	});

	describe("sanitizePath", () => {
		test("sanitizes and validates paths", () => {
			const result = service.sanitizePath("/home/user/file.txt");
			expect(result).toBe("/home/user/file.txt");
		});

		test("rejects path traversal attempts", () => {
			expect(() => service.sanitizePath("../../../etc/passwd")).toThrow(
				/traversal/i,
			);
			expect(() => service.sanitizePath("/home/../../../etc")).toThrow(
				/traversal/i,
			);
		});

		test("handles Windows paths", () => {
			const result = service.sanitizePath("C:\\Users\\Documents\\file.txt");
			expect(result).toContain("Users");
			expect(result).toContain("Documents");
		});
	});

	describe("dispose", () => {
		test("cleans up resources", () => {
			const outputChannel = {
				appendLine: mock(),
				append: mock(),
				show: mock(),
				dispose: mock(),
			};

			mockCreateChannel.mockReturnValue(outputChannel);
			const newService = new SecurityService(mockWorkspace, mockWindow);

			// Trigger output channel creation
			newService.auditLog("test", [], { success: true });

			// Dispose
			newService.dispose();

			expect(outputChannel.dispose).toHaveBeenCalled();
		});
	});
});
