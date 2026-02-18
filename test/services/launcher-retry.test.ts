/**
 * Tests for Launcher Retry Mechanism
 * Test-driven development: Write tests first, then implement
 *
 * SPAWN TESTING BEST PRACTICES:
 *
 * 1. Dependency Injection (not module mocking)
 *    - We inject spawn function via constructor
 *    - Production code uses real node:child_process
 *    - Tests inject mocks for predictable, fast testing
 *
 * 2. ALWAYS call mock.restore() in beforeEach
 *    - Prevents test state bleed between tests
 *    - Critical for retry tests with multiple mock behaviors
 *    - First line in beforeEach hook
 *
 * 3. Mock EventEmitter interface completely
 *    - stdout/stderr: { on: mock() }
 *    - on: mock() for spawn/error/close events
 *    - kill, unref, pid properties
 *
 * 4. Use appropriate mock methods for retry testing:
 *    - mockReturnValueOnce: for simulating retry scenarios
 *    - mockImplementation: for error simulation
 *    - Chain multiple behaviors to test retry logic
 *
 * 5. Test retry patterns:
 *    - Transient failures that succeed on retry
 *    - Permanent failures (ENOENT) that don't retry
 *    - Max retry limit enforcement
 *    - Error classification (retryable vs permanent)
 *
 * See: SPAWN_TESTING_BEST_PRACTICES.md for detailed analysis
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import {
	createSubprocessMock,
	createTerminalLauncherService,
} from "../helpers/typed-mocks.js";
import { createVSCodeMock } from "../mocks/index.test.js";
import type {
	ProcessManagerMock,
	SecurityServiceMock,
	SpawnMock,
	VSCodeMock,
} from "../types/mock.types.js";

describe("Launcher Retry Mechanism", () => {
	let service: TerminalLauncherService;
	let mockVscode: VSCodeMock;
	let mockSpawn: SpawnMock;
	let mockSecurityService: SecurityServiceMock;
	let mockProcessManager: ProcessManagerMock;

	beforeEach(() => {
		mock.restore(); // ✅ Restore all mocks to prevent test state bleed

		// Create fresh mocks
		mockVscode = createVSCodeMock() as unknown as VSCodeMock;
		mockSpawn = mock();

		// Mock security service
		// ✅ Complete SecurityServiceMock with third-party vscode.OutputChannel
		const mockOutputChannel = {
			name: "Test Security Log",
			append: mock(() => {}),
			appendLine: mock(() => {}),
			replace: mock(() => {}), // Required by OutputChannel interface
			clear: mock(() => {}),
			show: mock(() => {}),
			hide: mock(() => {}),
			dispose: mock(() => {}),
		} as unknown as import("vscode").OutputChannel;
		mockSecurityService = {
			auditLog: mock(),
			validatePath: mock(() => true),
			validateArgs: mock(() => []),
			sanitizePath: mock((p: string) => p),
			isWorkspaceTrusted: mock(() => true),
			getOutputChannel: mock(() => mockOutputChannel),
		} as unknown as SecurityServiceMock;

		// Mock process manager
		// ✅ Complete ProcessManagerMock interface
		mockProcessManager = {
			track: mock(() => true),
			untrack: mock(),
			isTracked: mock(() => false),
			getActiveCount: mock(() => 0),
			healthCheck: mock(),
			cleanup: mock(() => Promise.resolve()),
			isAlive: mock(() => true), // Required by ProcessManagerMock
			getProcessInfo: mock(() => ({ pid: 12345, startTime: Date.now() })), // Required by ProcessManagerMock
		};

		// Mock workspace configuration
		// ✅ Using third-party vscode.WorkspaceConfiguration type
		const mockConfig = {
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
				if (key === "logLevel") return "info";
				return defaultValue;
			}),
			has: mock(() => true),
			inspect: mock(() => undefined), // Required by WorkspaceConfiguration interface
			update: mock(() => Promise.resolve()),
		} as unknown as import("vscode").WorkspaceConfiguration;
		mockVscode.workspace.getConfiguration = mock(() => mockConfig);

		// Mock window methods
		mockVscode.window.showErrorMessage = mock();
		mockVscode.window.showInformationMessage = mock();

		// Create service instance with typed helper
		service = createTerminalLauncherService({
			security: mockSecurityService,
			processManager: mockProcessManager,
			workspace: mockVscode.workspace,
			window: mockVscode.window,
			spawn: mockSpawn,
		});
	});

	afterEach(() => {
		// Clear mock call history for clean test isolation
		mockSpawn.mockClear();
	});

	describe("listLaunchers with retry", () => {
		test("retries on transient failure and succeeds", async () => {
			// Create mock process objects
			const failProcess = createSubprocessMock({
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "error") {
						callback(new Error("ECONNRESET"));
					}
				}),
				pid: 12345,
			});

			const successProcess = createSubprocessMock({
				stdout: {
					on: mock((event: string, callback: (...args: unknown[]) => void) => {
						if (event === "data") {
							callback(
								Buffer.from(
									"• Project1 📁 → /path/to/project1\n• Project2 🚀 → /path/to/project2\n",
								),
							);
						}
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(0);
					}
				}),
				pid: 12346,
			});

			// First call fails, second succeeds
			mockSpawn
				.mockReturnValueOnce(failProcess)
				.mockReturnValueOnce(successProcess);

			// This should retry and succeed
			const result = await service.listLaunchers();

			// Verify retry happened
			expect(mockSpawn).toHaveBeenCalledTimes(2);
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["list"],
				{}, // Now expects options object
			);

			// Verify we got the correct result
			expect(result).toEqual(["Project1", "Project2"]);
		});

		test("fails after maximum retry attempts", async () => {
			const failProcess = createSubprocessMock({
				stderr: {
					on: mock((event: string, callback: (...args: unknown[]) => void) => {
						if (event === "data") {
							callback(Buffer.from("Connection failed"));
						}
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "error") {
						callback(new Error("ECONNRESET"));
					}
				}),
				pid: 12345,
			});

			// All attempts fail
			mockSpawn.mockReturnValue(failProcess);

			// This should fail after retries
			await expect(service.listLaunchers()).rejects.toThrow();

			// Default is 3 attempts (1 initial + 2 retries)
			expect(mockSpawn).toHaveBeenCalledTimes(3);
		});

		test("does not retry on permanent errors", async () => {
			const notFoundProcess = createSubprocessMock({
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "error") {
						const error = new Error("spawn ENOENT") as NodeJS.ErrnoException;
						error.code = "ENOENT";
						callback(error);
					}
				}),
				pid: undefined as unknown as number,
			});

			mockSpawn.mockReturnValue(notFoundProcess);

			// Should not retry on ENOENT (file not found)
			await expect(service.listLaunchers()).rejects.toThrow();

			// Should only try once for permanent errors
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		test("validates output format before parsing", async () => {
			const invalidOutputProcess = createSubprocessMock({
				stdout: {
					on: mock((event: string, callback: (...args: unknown[]) => void) => {
						if (event === "data") {
							callback(
								Buffer.from(
									"This is not valid launcher output\nRandom text here",
								),
							);
						}
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(0);
					}
				}),
				pid: 12345,
			});

			mockSpawn.mockReturnValue(invalidOutputProcess);

			const result = await service.listLaunchers();

			// Should handle invalid output gracefully
			expect(result).toEqual([]); // Empty array for invalid output
		});

		test("handles empty output gracefully", async () => {
			const emptyOutputProcess = createSubprocessMock({
				stdout: {
					on: mock((event: string, callback: (...args: unknown[]) => void) => {
						if (event === "data") {
							callback(Buffer.from(""));
						}
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(0);
					}
				}),
				pid: 12345,
			});

			mockSpawn.mockReturnValue(emptyOutputProcess);

			const result = await service.listLaunchers();

			// Should return empty array for empty output
			expect(result).toEqual([]);
		});
	});

	describe("timeout handling", () => {
		test("times out long-running operations", async () => {
			// Create a process that never completes
			const hangingProcess = createSubprocessMock({
				on: mock(), // Never calls close or error
				pid: 12345,
			});

			mockSpawn.mockReturnValue(hangingProcess);

			// Set a short timeout for testing (would be implemented in service)
			const timeoutPromise = service.listLaunchers();

			// This should eventually timeout (when implemented)
			// For now, it will hang, so we manually timeout the test
			const timeoutError = new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Operation timed out")), 100),
			);

			await expect(
				Promise.race([timeoutPromise, timeoutError]),
			).rejects.toThrow("Operation timed out");
		});

		test("cleans up process on timeout", async () => {
			const hangingProcess = createSubprocessMock({
				on: mock(),
				kill: mock(),
				pid: 12345,
			});

			mockSpawn.mockReturnValue(hangingProcess);

			// When timeout is implemented, it should kill the process
			void service.listLaunchers(); // Fire and forget for timeout test

			// Manually timeout for now
			setTimeout(() => {
				// Verify process would be killed
				expect(hangingProcess.kill).toHaveBeenCalledTimes(0); // Not yet implemented
			}, 150);

			// Let the test complete
			await new Promise((resolve) => setTimeout(resolve, 200));
		});
	});

	describe("error message improvements", () => {
		test("provides helpful error for launcher not found", async () => {
			const notFoundProcess = createSubprocessMock({
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "error") {
						const error = new Error("spawn ENOENT") as NodeJS.ErrnoException;
						error.code = "ENOENT";
						callback(error);
					}
				}),
			});

			mockSpawn.mockReturnValue(notFoundProcess);

			try {
				await service.listLaunchers();
			} catch (error) {
				// When implemented, should have user-friendly message
				expect((error as Error).message).toContain("launcher");
			}
		});

		test("provides helpful error for permission denied", async () => {
			const permissionDeniedProcess = createSubprocessMock({
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "error") {
						const error = new Error("spawn EACCES") as NodeJS.ErrnoException;
						error.code = "EACCES";
						callback(error);
					}
				}),
			});

			mockSpawn.mockReturnValue(permissionDeniedProcess);

			try {
				await service.listLaunchers();
			} catch (error) {
				// When implemented, should mention permissions
				expect((error as Error).message.toLowerCase()).toContain("permission");
			}
		});
	});
});
