/**
 * Tests for TerminalLauncherService configuration and management features
 * Covers: Configuration getters, validation, project settings, launcher management
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type * as vscode from "vscode";
import type { TerminalLauncherService } from "../../src/services/terminal-launcher-service.js";
import {
	createMockFileSystem,
	createMockProcessManager,
	createMockSecurityService,
	createTerminalLauncherService,
} from "../helpers/typed-mocks.js";
import { createMockUri, createVSCodeMock } from "../mocks/index.test.js";
import type {
	FileSystemMock,
	ProcessManagerMock,
	SecurityServiceMock,
	VSCodeMock,
} from "../types/mock.types.js";

describe("TerminalLauncherService Configuration & Management", () => {
	let service: TerminalLauncherService;
	let mockVscode: VSCodeMock;
	let mockSpawn: ReturnType<typeof mock>;
	let mockSecurityService: SecurityServiceMock;
	let mockProcessManager: ProcessManagerMock;
	let mockFs: FileSystemMock;

	beforeEach(() => {
		mock.restore();

		// Mock fs/promises with typed helper
		mockFs = createMockFileSystem();
		mock.module("node:fs/promises", () => mockFs);

		// Create fresh mocks
		mockVscode = createVSCodeMock() as unknown as VSCodeMock;
		mockSpawn = mock();

		// Use typed factory functions from test/helpers/typed-mocks.ts
		mockSecurityService = createMockSecurityService();
		mockProcessManager = createMockProcessManager();

		// Mock workspace configuration
		// ✅ Using third-party vscode.WorkspaceConfiguration type
		const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
			get: mock((key: string, defaultValue?: unknown) => {
				if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
				if (key === "app") return undefined;
				if (key === "logLevel") return "info";
				if (key === "autoConfigureProject") return true;
				return defaultValue;
			}),
			has: mock(() => true),
			inspect: mock(() => undefined), // Required by WorkspaceConfiguration interface
			update: mock(() => Promise.resolve()),
		};
		mockVscode.workspace.getConfiguration = mock(
			(_section?: string, _scope?: vscode.Uri) =>
				mockConfig as vscode.WorkspaceConfiguration,
		);

		// Mock window methods
		mockVscode.window.showErrorMessage = mock();
		mockVscode.window.showInformationMessage = mock();
		mockVscode.window.showInputBox = mock(() => Promise.resolve("TestProject"));
		mockVscode.window.showQuickPick = mock(
			(
				_items: string[] | Thenable<string[]>,
				_options?: vscode.QuickPickOptions,
			) => Promise.resolve("🚀"),
		);

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
		mockSpawn.mockClear();
	});

	describe("Platform-Specific Validation", () => {
		test("Windows: validates launcher exists (no executable bit check)", async () => {
			// Save original platform
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});

			mockFs.access.mockClear();
			mockFs.access.mockImplementation(() => Promise.resolve());

			const result = await service.validateLauncherInstallation();

			// Verify access was called without X_OK flag
			expect(mockFs.access).toHaveBeenCalledTimes(1);
			expect(mockFs.access).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
			);
			expect(result.isValid).toBe(true);

			// Restore platform
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
			});
		});

		test("Unix: validates launcher is executable", async () => {
			// Save original platform
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", {
				value: "darwin",
				configurable: true,
			});

			mockFs.access.mockClear();
			mockFs.access.mockImplementation(() => Promise.resolve());

			const result = await service.validateLauncherInstallation();

			// Verify access was called WITH X_OK flag
			expect(mockFs.access).toHaveBeenCalledTimes(1);
			expect(mockFs.access).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				1, // X_OK constant
			);
			expect(result.isValid).toBe(true);

			// Restore platform
			Object.defineProperty(process, "platform", {
				value: originalPlatform,
				configurable: true,
			});
		});

		test("returns error when launcher not found", async () => {
			mockFs.access.mockImplementation(() =>
				Promise.reject(new Error("ENOENT")),
			);

			const result = await service.validateLauncherInstallation();

			expect(result.isValid).toBe(false);
			expect(result.message).toContain("not found");
			expect(result.message).toContain("launcherPath");
		});
	});

	describe("Configuration Getters", () => {
		test("getLauncherPath returns configured path", async () => {
			// We test this indirectly through validation
			await service.validateLauncherInstallation();

			expect(mockFs.access).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				expect.anything(),
			);
		});

		test("getTerminalApp returns undefined when not configured", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Verify spawn was called - strategy spreads process.env so env is never undefined
			// When no terminal app is configured, TERMINAL_APP should NOT be in the env
			expect(mockSpawn).toHaveBeenCalled();
			const spawnCall = mockSpawn.mock.calls[0];
			expect(spawnCall).toBeDefined();
			const spawnOptions = spawnCall?.[2] as
				| { env?: Record<string, string> }
				| undefined;
			// The env should NOT have TERMINAL_APP set (or it should be undefined in the env object)
			expect(spawnOptions?.env?.["TERMINAL_APP"]).toBeUndefined();
		});

		test("getTerminalApp returns configured app", async () => {
			// Reconfigure to return terminal app
			// ✅ Complete WorkspaceConfiguration mock with third-party type
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: mock((key: string, defaultValue?: unknown) => {
					if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
					if (key === "app") return "/usr/bin/kitty";
					if (key === "logLevel") return "info";
					if (key === "autoConfigureProject") return false;
					return defaultValue;
				}),
				has: mock(() => true),
				inspect: mock(() => undefined),
				update: mock(() => Promise.resolve()),
			};
			mockVscode.workspace.getConfiguration = mock(
				(_section?: string, _scope?: vscode.Uri) =>
					mockConfig as vscode.WorkspaceConfiguration,
			);

			// Recreate service with new config
			service = createTerminalLauncherService({
				security: mockSecurityService,

				processManager: mockProcessManager,

				workspace: mockVscode.workspace,

				window: mockVscode.window,
				spawn: mockSpawn,
			});

			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Verify spawn was called WITH TERMINAL_APP env var
			expect(mockSpawn).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({
					env: expect.objectContaining({
						TERMINAL_APP: "/usr/bin/kitty",
					}),
				}),
			);
		});
	});

	describe("Launcher Removal", () => {
		test("removeLauncher - success", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: {
					on: mock((_event: string, _callback: (data: Buffer) => void) => {
						// No stderr on success
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(0); // Exit code 0 = success
					}
				}),
			};

			mockSpawn.mockReturnValue(mockProcess);

			const result = await service.removeLauncher("TestLauncher");

			expect(result).toBe(true);
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["remove", "TestLauncher"],
				{},
			);
			expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("Removed launcher: TestLauncher"),
			);
		});

		test("removeLauncher - failure with stderr", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: {
					on: mock((event: string, callback: (data: Buffer) => void) => {
						if (event === "data") {
							callback(Buffer.from("Launcher not found"));
						}
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(1); // Exit code 1 = failure
					}
				}),
			};

			mockSpawn.mockReturnValue(mockProcess);

			const result = await service.removeLauncher("NonExistent");

			expect(result).toBe(false);
			expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Failed to remove launcher"),
			);
		});

		test("removeLauncher - spawn error", async () => {
			mockSpawn.mockImplementation(() => {
				const mockProcess = {
					stdout: { on: mock() },
					stderr: { on: mock() },
					on: mock((event: string, callback: (...args: unknown[]) => void) => {
						if (event === "error") {
							callback(new Error("spawn ENOENT"));
						}
					}),
				};
				// Trigger error after returning
				setTimeout(() => mockProcess.on("error", () => {}), 0);
				return mockProcess;
			});

			const result = await service.removeLauncher("TestLauncher");

			expect(result).toBe(false);
			expect(mockVscode.window.showErrorMessage).toHaveBeenCalled();
		});

		test("removeAllLaunchers - success", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: {
					on: mock((_event: string, _callback: (data: Buffer) => void) => {
						// No stderr on success
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(0); // Exit code 0 = success
					}
				}),
			};

			mockSpawn.mockReturnValue(mockProcess);

			const result = await service.removeAllLaunchers();

			expect(result).toBe(true);
			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/local/bin/ghostty-launcher",
				["remove-all"],
				{},
			);
			expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
				"Removed all launchers",
			);
		});

		test("removeAllLaunchers - failure", async () => {
			const mockProcess = {
				stdout: { on: mock() },
				stderr: {
					on: mock((event: string, callback: (data: Buffer) => void) => {
						if (event === "data") {
							callback(Buffer.from("Operation failed"));
						}
					}),
				},
				on: mock((event: string, callback: (...args: unknown[]) => void) => {
					if (event === "close") {
						callback(1); // Exit code 1 = failure
					}
				}),
			};

			mockSpawn.mockReturnValue(mockProcess);

			const result = await service.removeAllLaunchers();

			expect(result).toBe(false);
			expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Failed to remove all launchers"),
			);
		});
	});

	describe("Project Configuration", () => {
		test("configureProject - no workspace", async () => {
			mockVscode.workspace.workspaceFolders = undefined;

			await service.configureProject();

			expect(mockVscode.window.showErrorMessage).toHaveBeenCalledWith(
				"No workspace folder is open",
			);
		});

		test("ensureProjectSettings - already configured (new format)", async () => {
			mockFs.readFile.mockImplementation(() =>
				Promise.resolve(
					Buffer.from(
						JSON.stringify({
							"commandCentral.project.icon": "🚀",
							"commandCentral.project.name": "ExistingProject",
						}),
					),
				),
			);

			// Enable auto-configure
			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: mock((key: string, defaultValue?: unknown) => {
					if (key === "autoConfigureProject") return true;
					if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
					return defaultValue;
				}),
				has: mock(() => true),
				inspect: mock(() => undefined),
				update: mock(() => Promise.resolve()),
			};
			mockVscode.workspace.getConfiguration = mock(
				(_section?: string, _scope?: vscode.Uri) =>
					mockConfig as vscode.WorkspaceConfiguration,
			);

			service = createTerminalLauncherService({
				security: mockSecurityService,

				processManager: mockProcessManager,

				workspace: mockVscode.workspace,

				window: mockVscode.window,
				spawn: mockSpawn,
			});

			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Should NOT prompt for configuration
			expect(mockVscode.window.showInputBox).not.toHaveBeenCalled();
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});

		test("ensureProjectSettings - already configured (legacy format)", async () => {
			mockFs.readFile.mockImplementation(() =>
				Promise.resolve(
					Buffer.from(
						JSON.stringify({
							projectIcon: "🚀",
							projectName: "LegacyProject",
						}),
					),
				),
			);

			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: mock((key: string, defaultValue?: unknown) => {
					if (key === "autoConfigureProject") return true;
					if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
					return defaultValue;
				}),
				has: mock(() => true),
				inspect: mock(() => undefined),
				update: mock(() => Promise.resolve()),
			};
			mockVscode.workspace.getConfiguration = mock(
				(_section?: string, _scope?: vscode.Uri) =>
					mockConfig as vscode.WorkspaceConfiguration,
			);

			service = createTerminalLauncherService({
				security: mockSecurityService,

				processManager: mockProcessManager,

				workspace: mockVscode.workspace,

				window: mockVscode.window,
				spawn: mockSpawn,
			});

			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Should NOT prompt for configuration
			expect(mockVscode.window.showInputBox).not.toHaveBeenCalled();
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});

		test("ensureProjectSettings - user cancels name input", async () => {
			mockFs.readFile.mockImplementation(() =>
				Promise.reject(new Error("ENOENT")),
			);

			mockVscode.window.showInputBox = mock(() => Promise.resolve(undefined)); // User cancelled

			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: mock((key: string, defaultValue?: unknown) => {
					if (key === "autoConfigureProject") return true;
					if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
					return defaultValue;
				}),
				has: mock(() => true),
				inspect: mock(() => undefined),
				update: mock(() => Promise.resolve()),
			};
			mockVscode.workspace.getConfiguration = mock(
				(_section?: string, _scope?: vscode.Uri) =>
					mockConfig as vscode.WorkspaceConfiguration,
			);

			service = createTerminalLauncherService({
				security: mockSecurityService,

				processManager: mockProcessManager,

				workspace: mockVscode.workspace,

				window: mockVscode.window,
				spawn: mockSpawn,
			});

			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Should NOT write settings
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});

		test("ensureProjectSettings - user cancels emoji picker", async () => {
			mockFs.readFile.mockImplementation(() =>
				Promise.reject(new Error("ENOENT")),
			);

			mockVscode.window.showInputBox = mock(() =>
				Promise.resolve("TestProject"),
			);
			mockVscode.window.showQuickPick = mock(() => Promise.resolve(undefined)); // User cancelled

			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: mock((key: string, defaultValue?: unknown) => {
					if (key === "autoConfigureProject") return true;
					if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
					return defaultValue;
				}),
				has: mock(() => true),
				inspect: mock(() => undefined),
				update: mock(() => Promise.resolve()),
			};
			mockVscode.workspace.getConfiguration = mock(
				(_section?: string, _scope?: vscode.Uri) =>
					mockConfig as vscode.WorkspaceConfiguration,
			);

			service = createTerminalLauncherService({
				security: mockSecurityService,

				processManager: mockProcessManager,

				workspace: mockVscode.workspace,

				window: mockVscode.window,
				spawn: mockSpawn,
			});

			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Should NOT write settings
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});

		test("ensureProjectSettings - creates new configuration", async () => {
			mockFs.readFile.mockImplementation(() =>
				Promise.reject(new Error("ENOENT")),
			);

			mockVscode.window.showInputBox = mock(() =>
				Promise.resolve("NewProject"),
			);
			mockVscode.window.showQuickPick = mock()
				.mockResolvedValueOnce({ label: "🚀", description: "Rocket" }) // Emoji
				.mockResolvedValueOnce({ label: "Nord", value: "nord" }); // Theme

			const mockConfig: Partial<vscode.WorkspaceConfiguration> = {
				get: mock((key: string, defaultValue?: unknown) => {
					if (key === "autoConfigureProject") return true;
					if (key === "launcherPath") return "/usr/local/bin/ghostty-launcher";
					return defaultValue;
				}),
				has: mock(() => true),
				inspect: mock(() => undefined),
				update: mock(() => Promise.resolve()),
			};
			mockVscode.workspace.getConfiguration = mock(
				(_section?: string, _scope?: vscode.Uri) =>
					mockConfig as vscode.WorkspaceConfiguration,
			);

			service = createTerminalLauncherService({
				security: mockSecurityService,

				processManager: mockProcessManager,

				workspace: mockVscode.workspace,

				window: mockVscode.window,
				spawn: mockSpawn,
			});

			const mockProcess = {
				stdout: { on: mock() },
				stderr: { on: mock() },
				on: mock(),
				kill: mock(),
				unref: mock(),
				pid: 12345,
			};

			mockSpawn.mockReturnValue(mockProcess);

			await service.launch();

			// Should create .vscode directory
			expect(mockFs.mkdir).toHaveBeenCalledWith("/workspace/project/.vscode", {
				recursive: true,
			});

			// Should write settings
			expect(mockFs.writeFile).toHaveBeenCalled();
			const writeCall = mockFs.writeFile.mock.calls[0];
			expect(writeCall).toBeDefined();
			expect(writeCall?.[0]).toBe("/workspace/project/.vscode/settings.json");
			expect(writeCall?.[1]).toBeDefined();

			// TypeScript knows writeCall is defined after checks
			if (!writeCall?.[1]) throw new Error("writeCall[1] should be defined");

			const writtenSettings = JSON.parse(writeCall[1].toString());
			expect(writtenSettings["commandCentral.project.icon"]).toBe("🚀");
			expect(writtenSettings["commandCentral.project.name"]).toBe("NewProject");
			expect(writtenSettings["commandCentral.terminal.theme"]).toBe("nord");

			// Should show success message
			expect(mockVscode.window.showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("NewProject"),
			);
		});
	});
});
