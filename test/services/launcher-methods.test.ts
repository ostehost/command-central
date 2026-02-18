/**
 * Tests for TerminalLauncherService launch methods
 * Covers: launch, launchHere, launchWorkspace
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
 *    - Critical for tests with multiple mock behaviors
 *    - First line in beforeEach hook
 *
 * 3. Mock EventEmitter interface completely
 *    - stdout/stderr: { on: mock() }
 *    - on: mock() for spawn/error/close events
 *    - kill, unref, pid properties
 *
 * 4. Use appropriate mock methods:
 *    - mockReturnValue: for static process returns
 *    - mockImplementation: for conditional/dynamic behavior
 *
 * 5. Test process lifecycle:
 *    - Successful spawn (spawn event fires)
 *    - Spawn errors (ENOENT - file not found)
 *    - Runtime errors (ECONNRESET)
 *    - Process cleanup (kill, unref)
 *
 * See: SPAWN_TESTING_BEST_PRACTICES.md for detailed analysis
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import {
	createMockProcessManager,
	createMockSecurityService,
	createTerminalLauncherService,
} from "../helpers/typed-mocks.js";
import { createMockUri, createVSCodeMock } from "../mocks/index.test.js";
import type {
	ProcessManagerMock,
	SecurityServiceMock,
	VSCodeMock,
} from "../types/mock.types.js";

describe("TerminalLauncherService Launch Methods", () => {
	let service: TerminalLauncherService;
	let mockVscode: VSCodeMock;
	let mockSpawn: ReturnType<typeof mock>;
	let mockSecurityService: SecurityServiceMock;
	let mockProcessManager: ProcessManagerMock;
	let mockFsAccess: ReturnType<typeof mock>;

	beforeEach(() => {
		mock.restore(); // ✅ Restore all mocks to prevent test state bleed

		// Create fs.access mock reference for per-test overrides
		mockFsAccess = mock(() => Promise.resolve());

		// Mock fs/promises for launcher validation
		// NOTE: This will pollute git-timestamps when running `bun test` (all tests together)
		// but is required for launcher tests to pass. Solution: use `just test` (partitioned)
		mock.module("node:fs/promises", () => ({
			readFile: mock(() => Promise.resolve(JSON.stringify({}))),
			writeFile: mock(() => Promise.resolve()),
			mkdir: mock(() => Promise.resolve()),
			access: mockFsAccess,
			stat: mock(() => Promise.resolve({ isDirectory: () => true })),
			constants: { X_OK: 1 },
		}));

		// Create fresh mocks
		mockVscode = createVSCodeMock() as unknown as VSCodeMock;
		mockSpawn = mock();

		// Use typed factory functions from test/helpers/typed-mocks.ts
		mockSecurityService = createMockSecurityService();
		mockProcessManager = createMockProcessManager();

		// Mock workspace configuration
		// ✅ Using third-party vscode.WorkspaceConfiguration type
		const mockConfig: Partial<import("vscode").WorkspaceConfiguration> = {
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
				if (key === "path") return "/Applications/Terminal.app";
				if (key === "logLevel") return "info";
				if (key === "autoConfigureProject") return false; // Disable auto-configure for simpler testing
				return defaultValue;
			}),
			has: mock(() => true),
			inspect: mock(() => undefined), // Required by WorkspaceConfiguration interface
			update: mock(() => Promise.resolve()),
		};
		mockVscode.workspace.getConfiguration = mock(
			(_section?: string, _scope?: import("vscode").Uri) =>
				mockConfig as import("vscode").WorkspaceConfiguration,
		);

		// Mock window methods
		mockVscode.window.showErrorMessage = mock();
		mockVscode.window.showInformationMessage = mock();
		mockVscode.window.showInputBox = mock(() => Promise.resolve("TestProject"));
		mockVscode.window.showQuickPick = mock(() => Promise.resolve("folder"));

		// Mock workspace folders
		// ✅ Using third-party vscode.Uri type from mock factory
		mockVscode.workspace.workspaceFolders = [
			{
				uri: createMockUri("/workspace/project"),
				name: "project",
				index: 0,
			},
		];

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

	describe("launch method", () => {
		test("launches terminal successfully", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "spawn") {
						callback();
					}
				}),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Verify spawn was called with correct arguments
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["/workspace/project"],
				expect.objectContaining({
					detached: true,
					stdio: "ignore",
				}),
			);
		});

		test("handles launch errors gracefully", async () => {
			// Mock spawn to throw synchronously (like real spawn with ENOENT)
			const spawnError = new Error("spawn ENOENT") as NodeJS.ErrnoException;
			spawnError.code = "ENOENT";
			mockSpawn.mockImplementation(() => {
				throw spawnError;
			});

			const result = await service.launch();

			// Verify result indicates failure
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error?.length).toBeGreaterThan(0);

			// Verify error was shown to user
			expect(mockVscode.window.showErrorMessage).toHaveBeenCalled();
		});

		test("validates launcher installation before launching", async () => {
			// Mock fs.access to throw error (file doesn't exist)
			mockFsAccess.mockImplementation(() =>
				Promise.reject(new Error("ENOENT")),
			);

			const result = await service.launch();

			// Verify result indicates failure
			expect(result.success).toBe(false);
			// With strategy pattern, error is "no launcher available" when no strategy can be found
			expect(result.error?.toLowerCase()).toContain("no launcher available");

			// Verify spawn was not called
			expect(mockSpawn).not.toHaveBeenCalled();

			// Restore fs.access mock
			mockFsAccess.mockImplementation(() => Promise.resolve());
		});
	});

	describe("launchHere method", () => {
		test("launches terminal in current directory", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "spawn") {
						callback();
					}
				}),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			const currentPath = "/Users/test/project";
			await service.launchHere(createMockUri(currentPath));

			// Verify spawn was called with correct directory argument
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				[currentPath],
				expect.objectContaining({
					detached: true,
					stdio: "ignore",
				}),
			);
		});

		test("sanitizes directory path", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "spawn") {
						callback();
					}
				}),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);
			mockSecurityService.sanitizePath = mock(() => "/safe/path");

			await service.launchHere(createMockUri("/dangerous/../path"));

			// Verify sanitization was called
			expect(mockSecurityService.sanitizePath).toHaveBeenCalledWith(
				"/dangerous/../path",
			);

			// Verify spawn was called with sanitized path
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["/safe/path"],
				expect.anything(),
			);
		});

		test("handles missing directory gracefully", async () => {
			// launchHere expects a URI object with fsPath
			const result = await service.launchHere(undefined);
			expect(result.success).toBe(false);
			expect(result.error).toContain("No path provided");

			// Verify spawn was not called
			expect(mockSpawn).not.toHaveBeenCalled();
		});
	});

	describe("launchWorkspace method", () => {
		test("launches terminal for workspace folder", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "spawn") {
						callback();
					}
				}),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launchWorkspace();

			// Verify spawn was called with workspace directory
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["/workspace/project"],
				expect.objectContaining({
					detached: true,
					stdio: "ignore",
				}),
			);
		});

		test("handles missing workspace gracefully", async () => {
			mockVscode.workspace.workspaceFolders = undefined;

			const result = await service.launchWorkspace();
			expect(result.success).toBe(false);
			expect(result.error).toContain("No workspace folder");

			// Verify spawn was not called
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		test("handles empty workspace folders array", async () => {
			mockVscode.workspace.workspaceFolders = [];

			const result = await service.launchWorkspace();
			expect(result.success).toBe(false);
			expect(result.error).toContain("No workspace folder");

			// Verify spawn was not called
			expect(mockSpawn).not.toHaveBeenCalled();
		});
	});

	describe("edge cases", () => {
		test("handles spawn process without pid", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "spawn") {
						callback();
					}
				}),
				kill: mock(),
				// No pid property
			};

			mockSpawn.mockReturnValue(mockProcess);

			// Should not throw even without pid
			await service.launch();

			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		test("uses launcher script consistently across platforms", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "spawn") {
						callback();
					}
				}),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Should use the launcher path regardless of platform
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["/workspace/project"],
				expect.objectContaining({
					detached: true,
					stdio: "ignore",
				}),
			);

			// The launcher script handles platform differences internally
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});
	});
});
