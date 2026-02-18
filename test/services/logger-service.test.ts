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

		test("initializes with default log level if not provided", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const defaultLogger = new LoggerService(
				"Default",
				LogLevel.INFO,
				mockOutputChannel,
			);
			expect(defaultLogger.getLogLevel()).toBe(LogLevel.INFO);
		});
	});

	describe("Log Level Management", () => {
		test("sets log level correctly", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.ERROR);
			expect(logger.getLogLevel()).toBe(LogLevel.ERROR);
		});

		test("logs level change when setting new level", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.WARN);
			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("Log level set to WARN");
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

		test("debug() does not log when level is INFO", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.INFO,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.INFO);
			const callCount = mockOutputChannel.appendLine.mock.calls.length;
			logger.debug("Debug message");

			// Should not have added any new calls
			expect(mockOutputChannel.appendLine.mock.calls.length).toBe(callCount);
		});

		test("info() logs when level is INFO or lower", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.INFO,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.INFO);
			logger.info("Info message");

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("INFO");
			expect(lastCall?.[0]).toContain("Info message");
		});

		test("warn() logs when level is WARN or lower", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.WARN,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.WARN);
			logger.warn("Warning message");

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("WARN");
			expect(lastCall?.[0]).toContain("Warning message");
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

		test("error() handles non-Error objects", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.error("Error occurred", "string error");

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("ERROR");
			expect(lastCall?.[0]).toContain("Error occurred");
		});
	});

	describe("Performance Logging", () => {
		test("logs performance metrics with correct format", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.performance("Database query", 125.5, "DataService");

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("⏱️");
			expect(lastCall?.[0]).toContain("Database query: 125.50ms");
			expect(lastCall?.[0]).toContain("[DataService]");
		});
	});

	describe("Process Logging", () => {
		test("logs process events with PID", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.process("Started", 12345, "with arguments");

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("Process 12345: Started");
			expect(lastCall?.[0]).toContain("with arguments");
			expect(lastCall?.[0]).toContain("[ProcessManager]");
		});

		test("logs process events without PID", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.process("General event", undefined);

			expect(mockOutputChannel.appendLine).toHaveBeenCalled();
			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			expect(lastCall?.[0]).toContain("Process: General event");
			expect(lastCall?.[0]).not.toContain("undefined");
		});
	});

	describe("Output Channel Management", () => {
		test("show() calls output channel show", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.show();
			expect(mockOutputChannel.show).toHaveBeenCalled();
		});

		test("hide() calls output channel hide", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.hide();
			expect(mockOutputChannel.hide).toHaveBeenCalled();
		});

		test("clear() clears output channel and history", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.info("Test message");
			expect(logger.getHistory().length).toBeGreaterThan(0);

			logger.clear();
			expect(mockOutputChannel.clear).toHaveBeenCalled();
			expect(logger.getHistory().length).toBe(0);
		});

		test("getOutputChannel() returns the output channel", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			const channel = logger.getOutputChannel();
			expect(channel).toBe(mockOutputChannel);
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

		test("getHistory() with limit returns limited entries", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			for (let i = 0; i < 10; i++) {
				logger.info(`Message ${i}`);
			}

			const limited = logger.getHistory(3);
			expect(limited.length).toBe(3);
			expect(limited[0]?.message).toBe("Message 7");
			expect(limited[1]?.message).toBe("Message 8");
			expect(limited[2]?.message).toBe("Message 9");
		});
	});

	describe("Log Export", () => {
		test("exports logs as formatted string", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.info("First message");
			logger.warn("Warning message");
			logger.error("Error message");

			const exported = logger.exportLogs();
			expect(exported).toContain("First message");
			expect(exported).toContain("Warning message");
			expect(exported).toContain("Error message");
			expect(exported).toContain("INFO");
			expect(exported).toContain("WARN");
			expect(exported).toContain("ERROR");
		});
	});

	describe("Log Formatting", () => {
		test("includes correct icons for log levels", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.DEBUG);

			logger.debug("Debug");
			logger.info("Info");
			logger.warn("Warning");
			logger.error("Error");

			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.some((c: [string]) => c[0].includes("🔍"))).toBe(true); // DEBUG
			expect(calls.some((c: [string]) => c[0].includes("ℹ️"))).toBe(true); // INFO
			expect(calls.some((c: [string]) => c[0].includes("⚠️"))).toBe(true); // WARN
			expect(calls.some((c: [string]) => c[0].includes("❌"))).toBe(true); // ERROR
		});

		test("formats timestamp correctly", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			const before = new Date().toISOString();
			logger.info("Test message");
			const after = new Date().toISOString();

			const calls = mockOutputChannel.appendLine.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const lastCall = calls[calls.length - 1];
			expect(lastCall).toBeDefined();
			const logLine = lastCall?.[0];
			expect(logLine).toBeDefined();

			// TypeScript knows logLine is defined after toBeDefined check
			if (!logLine) throw new Error("logLine should be defined");

			// Extract timestamp from log line (should be at the beginning)
			const timestampMatch = logLine.match(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
			);
			expect(timestampMatch).toBeTruthy();
			expect(timestampMatch).not.toBeNull();

			const logTimestamp = timestampMatch?.[0];
			expect(logTimestamp).toBeDefined();

			// TypeScript knows logTimestamp is defined after toBeDefined check
			if (!logTimestamp) throw new Error("logTimestamp should be defined");

			expect(logTimestamp >= before).toBe(true);
			expect(logTimestamp <= after).toBe(true);
		});
	});

	describe("Singleton Management", () => {
		test("getLogger() returns singleton instance", async () => {
			const { getLogger, resetLogger } = await import(
				"../../src/services/logger-service.js"
			);
			resetLogger(); // Clear any existing instance
			const instance1 = getLogger();
			const instance2 = getLogger();
			expect(instance1).toBe(instance2);
		});

		test("setLogger() sets custom logger instance", async () => {
			const { LoggerService, setLogger, getLogger } = await import(
				"../../src/services/logger-service.js"
			);
			const customLogger = new LoggerService("Custom");
			setLogger(customLogger);
			const retrieved = getLogger();
			expect(retrieved).toBe(customLogger);
		});

		test("resetLogger() disposes and clears instance", async () => {
			const { getLogger, resetLogger } = await import(
				"../../src/services/logger-service.js"
			);
			const instance = getLogger();
			const disposeSpy = mock();
			instance.dispose = disposeSpy;

			resetLogger();
			expect(disposeSpy).toHaveBeenCalled();

			// New instance should be created
			const newInstance = getLogger();
			expect(newInstance).not.toBe(instance);
		});
	});

	describe("Disposal", () => {
		test("dispose() cleans up output channel", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.dispose();
			expect(mockOutputChannel.dispose).toHaveBeenCalled();
		});
	});

	describe("Debug Data Logging", () => {
		test("logs additional data in debug mode", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.DEBUG,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.DEBUG);
			const data = { userId: 123, action: "login" };

			logger.debug("User action", "AuthService", data);

			const calls = mockOutputChannel.appendLine.mock.calls;
			const dataCall = calls.find((c: [string]) => c[0].includes("Data:"));
			expect(dataCall).toBeTruthy();
			expect(dataCall).toBeDefined();
			expect(dataCall?.[0]).toContain("userId");
			expect(dataCall?.[0]).toContain("123");
			expect(dataCall?.[0]).toContain("action");
			expect(dataCall?.[0]).toContain("login");
		});

		test("does not log data in non-debug mode", async () => {
			const { LoggerService, LogLevel } = await import(
				"../../src/services/logger-service.js"
			);
			const logger = new LoggerService(
				"Test Logger",
				LogLevel.INFO,
				mockOutputChannel,
			);

			logger.setLogLevel(LogLevel.INFO);
			const data = { userId: 123, action: "login" };

			logger.info("User action", "AuthService", data);

			const calls = mockOutputChannel.appendLine.mock.calls;
			const dataCall = calls.find((c: [string]) => c[0].includes("Data:"));
			expect(dataCall).toBeFalsy();
		});
	});
});
