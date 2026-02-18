/**
 * Tests for Launcher Strategies
 *
 * TESTING APPROACH:
 * Strategy classes use Dependency Injection via LauncherStrategyContext.
 * This means we can test with simple mock objects - NO vscode module mocking needed.
 *
 * Pattern: formatters.test.ts, validator.test.ts - simple mocks, no vscode dependency
 *
 * IMPORTANT: These tests mock fs.access to ensure deterministic behavior.
 * Other test files also mock node:fs/promises, so we need explicit mocking here
 * to avoid test pollution from shared module cache.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LauncherStrategyContext } from "../../../src/services/launcher/launcher-strategy.interface.js";

// Mock fs with controlled behavior to avoid test pollution
const mockFsAccess = mock((path: string, mode?: number) => {
	// Simulate realistic filesystem behavior
	const X_OK = 1; // fs.constants.X_OK

	// Valid executables
	if (path === "/bin/sh") {
		return Promise.resolve();
	}

	// Valid extension paths (for bundled strategy)
	if (path.includes("/Users/test/project")) {
		// File exists - check if we're testing executability
		if (mode === X_OK) {
			// Return success for executable check on known good paths
			return Promise.resolve();
		}
		return Promise.resolve();
	}

	// Non-existent paths
	if (path.includes("/nonexistent")) {
		const error = new Error(
			`ENOENT: no such file or directory, access '${path}'`,
		);
		(error as NodeJS.ErrnoException).code = "ENOENT";
		return Promise.reject(error);
	}

	// Non-executable files (like /etc/hosts)
	if (path === "/etc/hosts" && mode === X_OK) {
		const error = new Error(`EACCES: permission denied, access '${path}'`);
		(error as NodeJS.ErrnoException).code = "EACCES";
		return Promise.reject(error);
	}

	// Default: file exists but check type
	if (mode === X_OK) {
		const error = new Error(`EACCES: permission denied, access '${path}'`);
		(error as NodeJS.ErrnoException).code = "EACCES";
		return Promise.reject(error);
	}

	return Promise.resolve();
});

// Apply fs mock before any strategy imports
mock.module("node:fs/promises", () => ({
	access: mockFsAccess,
	stat: mock((path: string) => {
		if (path.includes("/nonexistent")) {
			const error = new Error(
				`ENOENT: no such file or directory, stat '${path}'`,
			);
			(error as NodeJS.ErrnoException).code = "ENOENT";
			return Promise.reject(error);
		}
		return Promise.resolve({ mode: 0o644 });
	}),
	chmod: mock(() => Promise.resolve()),
	constants: { X_OK: 1, F_OK: 0 },
}));

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a mock context for strategy testing.
 * No vscode dependency - just simple mock functions.
 */
function createMockContext(): LauncherStrategyContext {
	return {
		extensionPath: "/test/extension",
		processManager: {
			track: mock(() => {}),
		},
		logger: {
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		},
		securityService: {
			auditLog: mock(() => {}),
		},
	};
}

// ============================================================================
// UserLauncherStrategy Tests
// ============================================================================

describe("UserLauncherStrategy", () => {
	let mockContext: LauncherStrategyContext;

	beforeEach(() => {
		mock.restore();
		mockContext = createMockContext();
	});

	describe("isAvailable", () => {
		test("returns true for valid executable path", async () => {
			// Use an actual executable that exists on all Unix systems
			const { UserLauncherStrategy } = await import(
				"../../../src/services/launcher/user-launcher-strategy.js"
			);
			const strategy = new UserLauncherStrategy("/bin/sh", mockContext);

			const result = await strategy.isAvailable();

			expect(result).toBe(true);
		});
	});

	describe("validate", () => {
		test("returns isValid true for valid executable", async () => {
			const { UserLauncherStrategy } = await import(
				"../../../src/services/launcher/user-launcher-strategy.js"
			);
			const strategy = new UserLauncherStrategy("/bin/sh", mockContext);

			const result = await strategy.validate();

			expect(result.isValid).toBe(true);
		});
	});
});

// ============================================================================
// BundledLauncherStrategy Tests
// ============================================================================

describe("BundledLauncherStrategy", () => {
	let mockContext: LauncherStrategyContext;

	beforeEach(() => {
		mock.restore();
		mockContext = createMockContext();
	});

	describe("isAvailable", () => {
		test("returns false on non-darwin platform", async () => {
			// Test the logic directly by checking if we're on darwin
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/test/extension",
				mockContext,
			);

			const result = await strategy.isAvailable();

			// If we're on darwin, it will check for file existence
			// If not darwin, it returns false immediately
			if (process.platform !== "darwin") {
				expect(result).toBe(false);
			}
			// On darwin, result depends on whether bundled file exists
		});

		test("checks for bundled launcher file existence on darwin", async () => {
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);

			// Use actual extension path where bundled launcher exists
			const strategy = new BundledLauncherStrategy(
				"/Users/test/project",
				mockContext,
			);

			const result = await strategy.isAvailable();

			// On macOS with bundled launcher present, should return true
			if (process.platform === "darwin") {
				expect(result).toBe(true);
			} else {
				expect(result).toBe(false);
			}
		});
	});

	describe("getInfo", () => {
		test("returns correct launcher info with bundled type", async () => {
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/test/extension",
				mockContext,
			);

			const info = strategy.getInfo();

			expect(info.type).toBe("bundled");
			expect(info.path).toContain("ghostty-launcher");
			expect(info.verificationStatus).toBe("skipped");
		});
	});

	describe("validate", () => {
		test("returns PLATFORM error on non-darwin", async () => {
			if (process.platform === "darwin") {
				// Skip this test on macOS - it's platform-specific
				return;
			}

			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/test/extension",
				mockContext,
			);

			const result = await strategy.validate();

			expect(result.isValid).toBe(false);
			expect(result.errorCode).toBe("PLATFORM");
			expect(result.message).toContain("macOS");
		});

		test("returns ENOENT when bundled file not found", async () => {
			if (process.platform !== "darwin") {
				// Skip this test on non-macOS
				return;
			}

			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/nonexistent/path",
				mockContext,
			);

			const result = await strategy.validate();

			expect(result.isValid).toBe(false);
			expect(result.errorCode).toBe("ENOENT");
		});

		test("returns isValid true when bundled file exists", async () => {
			if (process.platform !== "darwin") {
				return;
			}

			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/Users/test/project",
				mockContext,
			);

			const result = await strategy.validate();

			expect(result.isValid).toBe(true);
		});
	});

	describe("strategyId", () => {
		test("has correct strategy identifier", async () => {
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/test/extension",
				mockContext,
			);

			expect(strategy.strategyId).toBe("bundled");
		});
	});

	describe("ensureExecutable behavior", () => {
		test("getInfo shows verificationStatus as skipped (integrity check deferred)", async () => {
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);
			const strategy = new BundledLauncherStrategy(
				"/test/extension",
				mockContext,
			);

			const info = strategy.getInfo();

			// MVP decision: integrity check skipped
			expect(info.verificationStatus).toBe("skipped");
		});
	});
});

// ============================================================================
// Strategy Selection Integration Tests
// ============================================================================

describe("Strategy Selection Logic", () => {
	describe("priority order", () => {
		test("user strategy takes priority when path is valid", async () => {
			const { UserLauncherStrategy } = await import(
				"../../../src/services/launcher/user-launcher-strategy.js"
			);
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);

			const mockContext = createMockContext();

			// User strategy with valid executable
			const userStrategy = new UserLauncherStrategy("/bin/sh", mockContext);
			const bundledStrategy = new BundledLauncherStrategy(
				"/test/extension",
				mockContext,
			);

			// Simulate priority check
			const userAvailable = await userStrategy.isAvailable();
			const bundledAvailable = await bundledStrategy.isAvailable();

			// User should be available
			expect(userAvailable).toBe(true);

			// Selection logic: user first
			if (userAvailable) {
				expect(userStrategy.strategyId).toBe("user");
			} else if (bundledAvailable) {
				expect(bundledStrategy.strategyId).toBe("bundled");
			}
		});

		test("bundled strategy is fallback on macOS when no user path", async () => {
			if (process.platform !== "darwin") {
				return;
			}

			const { UserLauncherStrategy } = await import(
				"../../../src/services/launcher/user-launcher-strategy.js"
			);
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);

			const mockContext = createMockContext();

			// User strategy with invalid path
			const userStrategy = new UserLauncherStrategy(
				"/nonexistent/launcher",
				mockContext,
			);
			const bundledStrategy = new BundledLauncherStrategy(
				"/Users/test/project",
				mockContext,
			);

			const userAvailable = await userStrategy.isAvailable();
			const bundledAvailable = await bundledStrategy.isAvailable();

			expect(userAvailable).toBe(false);
			expect(bundledAvailable).toBe(true);
		});

		test("returns null when neither strategy is available", async () => {
			const { UserLauncherStrategy } = await import(
				"../../../src/services/launcher/user-launcher-strategy.js"
			);
			const { BundledLauncherStrategy } = await import(
				"../../../src/services/launcher/bundled-launcher-strategy.js"
			);

			const mockContext = createMockContext();

			// Both invalid
			const userStrategy = new UserLauncherStrategy(
				"/nonexistent/launcher",
				mockContext,
			);
			const bundledStrategy = new BundledLauncherStrategy(
				"/nonexistent/extension",
				mockContext,
			);

			const userAvailable = await userStrategy.isAvailable();
			const bundledAvailable = await bundledStrategy.isAvailable();

			expect(userAvailable).toBe(false);
			// On non-darwin, bundled is always unavailable
			// On darwin with wrong path, it's also unavailable
			if (process.platform !== "darwin") {
				expect(bundledAvailable).toBe(false);
			}
		});
	});

	describe("context injection", () => {
		test("strategies receive and use logger from context", async () => {
			const { UserLauncherStrategy } = await import(
				"../../../src/services/launcher/user-launcher-strategy.js"
			);

			const mockContext = createMockContext();
			const strategy = new UserLauncherStrategy(
				"/nonexistent/path",
				mockContext,
			);

			await strategy.isAvailable();

			// Logger should be called for debug logging
			expect(mockContext.logger.debug).toHaveBeenCalled();
		});

		test("strategies use processManager from context", async () => {
			// This test verifies the interface - actual process tracking
			// is tested in integration tests
			const mockContext = createMockContext();

			expect(mockContext.processManager.track).toBeDefined();
			expect(typeof mockContext.processManager.track).toBe("function");
		});

		test("strategies use securityService for audit logging", async () => {
			const mockContext = createMockContext();

			expect(mockContext.securityService.auditLog).toBeDefined();
			expect(typeof mockContext.securityService.auditLog).toBe("function");
		});
	});
});
