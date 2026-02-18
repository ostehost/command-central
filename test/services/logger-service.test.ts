/**
 * Tests for LoggerService
 * Following CLAUDE.md test patterns with Bun's native test runner
 */

import { beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { setupVSCodeMock } from "../helpers/vscode-mock.js";

/**
 * Properly typed MockOutputChannel with Bun mock methods
 * This allows accessing .mock.calls and other mock properties
 */
interface MockOutputChannel {
	appendLine: Mock<(value: string) => void>;
	append: Mock<(value: string) => void>;
	replace: Mock<(value: string) => void>;
	clear: Mock<() => void>;
	show: Mock<() => void>;
	hide: Mock<() => void>;
	dispose: Mock<() => void>;
	name: string;
}

describe("LoggerService", () => {
	let mockOutputChannel: MockOutputChannel;

	beforeEach(() => {
		mock.restore();
		setupVSCodeMock(); // Mock vscode before dynamic import

		// Create mock output channel with proper Mock types
		mockOutputChannel = {
			name: "Test Logger",
			appendLine: mock(() => {}),
			append: mock(() => {}),
			replace: mock(() => {}),
			clear: mock(() => {}),
			show: mock(() => {}),
			hide: mock(() => {}),
			dispose: mock(() => {}),
		};
	});

	describe("Initialization", () => {
		test("initializes with correct log level", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			expect(logger.getLogLevel()).toBe(LogLevel.DEBUG);
		});
	});

	describe("Logging Methods", () => {
		test("debug() logs when level is DEBUG", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.DEBUG);
			logger.debug("Debug message", "TestContext");

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("DEBUG");
			expect(lastCall?.[0]).toContain("Debug message");
			expect(lastCall?.[0]).toContain("[TestContext]");
		});

		test("error() logs error with stack trace", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.ERROR,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.ERROR);
			const error = new Error("Test error");
			logger.error("Error occurred", error);

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThanOrEqual(2);
			const errorCall = calls[calls.length - 2];
			const stackCall = calls[calls.length - 1];
			expect(errorCall).toBeDefined();
			expect(stackCall).toBeDefined();

			expect(errorCall?.[0]).toContain("ERROR");
			expect(errorCall?.[0]).toContain("Error occurred");
			expect(stackCall?.[0]).toContain("Stack:");
		});
	});

	describe("History Management", () => {
		test("maintains log history", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.info("Message 1");
			logger.info("Message 2");
			logger.info("Message 3");

			const history = logger.getHistory();
			expect(history.length).toBe(3);
			expect(history[0]?.message).toBe("Message 1");
			expect(history[1]?.message).toBe("Message 2");
			expect(history[2]?.message).toBe("Message 3");
		});

		test("limits history size to maxHistorySize", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			// Create logger with small history size for testing
			const testLogger = new LoggerService(
				"Test",
				LogLevel.INFO,
				mockOutputChannel,
			);

			// Log more than 1000 messages (default max)
			for (let i = 0; i < 1100; i++) {
				testLogger.info(`Message ${i}`);
			}

			const history = testLogger.getHistory();
			expect(history.length).toBe(1000);
			expect(history[0]?.message).toBe("Message 100"); // First 100 should be trimmed
		});
	});
});
