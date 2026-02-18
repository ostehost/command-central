/**
 * TerminalLauncherService - Terminal launcher integration service
 * Uses configured launcher scripts to create project-specific terminals with custom icons
 *
 * Strategy Pattern Integration:
 * - UserLauncherStrategy: Uses user-configured launcher path
 * - BundledLauncherStrategy: Uses bundled binary (macOS only)
 *
 * @see src/services/launcher/launcher-strategy.interface.ts for interface definition
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { ISecurityService } from "../types/service-interfaces.js";
import type { ProcessManager } from "../utils/process-manager.js";
import {
	BundledLauncherStrategy,
	type ILauncherStrategy,
	type LauncherStrategyContext,
	UserLauncherStrategy,
} from "./launcher/index.js";
import { getLogger } from "./logger-service.js";

interface LaunchResult {
	success: boolean;
	pid?: number;
	error?: string;
}

// Type for spawn function - compatible with both Node.js spawn and test mocks
interface SpawnResult {
	pid?: number;
	unref: () => void;
	kill: (signal?: string | number) => boolean;
	stdout?: NodeJS.ReadableStream | null;
	stderr?: NodeJS.ReadableStream | null;
	on: (event: string, callback: (...args: unknown[]) => void) => SpawnResult;
}

interface SpawnOptions {
	detached?: boolean;
	stdio?: string;
	stdout?: "pipe" | null;
	stderr?: "pipe" | null;
	env?: NodeJS.ProcessEnv;
}

type SpawnFunction = (
	command: string,
	args?: readonly string[],
	options?: SpawnOptions,
) => SpawnResult;

export class TerminalLauncherService {
	private spawn: SpawnFunction;
	private currentStrategy: ILauncherStrategy | null = null;
	private configChangeDisposable: { dispose(): void } | null = null;

	constructor(
		private securityService: ISecurityService,
		private processManager: ProcessManager,
		private workspace: typeof vscode.workspace,
		private window: typeof vscode.window,
		private extensionPath: string = "", // Path to extension for bundled resources
		spawnFunction?: SpawnFunction, // Optional for testing
	) {
		this.spawn =
			spawnFunction ||
			((cmd: string, args?: readonly string[], options?: SpawnOptions) => {
				// Use Node.js spawn
				const subprocess = nodeSpawn(cmd, args || [], {
					detached: options?.detached,
					stdio: options?.stdio || "pipe",
					env: options?.env,
				} as Parameters<typeof nodeSpawn>[2]);
				// Return a compatible interface
				return subprocess as SpawnResult;
			});

		// Invalidate strategy cache on config change (pattern from grouping-state-manager.ts)
		this.configChangeDisposable = this.workspace.onDidChangeConfiguration(
			(e) => {
				if (e.affectsConfiguration("commandCentral.terminal")) {
					this.currentStrategy = null;
				}
			},
		);
	}

	/**
	 * Get the configured launcher script path
	 */
	private getLauncherPath(): string {
		const config = this.workspace.getConfiguration(
			"commandCentral.terminal",
			null,
		);
		return config.get("launcherPath", "");
	}

	/**
	 * Check if auto-configure is enabled
	 */
	private shouldAutoConfigureProject(): boolean {
		const config = this.workspace.getConfiguration(
			"commandCentral.terminal",
			null,
		);
		return config.get("autoConfigureProject", true);
	}

	/**
	 * Get the configured terminal app path
	 */
	private getTerminalApp(): string | undefined {
		const config = this.workspace.getConfiguration(
			"commandCentral.terminal",
			null,
		);
		return config.get<string>("app");
	}

	/**
	 * Get the best available launcher strategy
	 *
	 * Priority order:
	 * 1. User-configured path (if available)
	 * 2. Bundled launcher (macOS only)
	 * 3. null (no launcher available)
	 */
	async getStrategy(): Promise<ILauncherStrategy | null> {
		// Return cached strategy if available
		if (this.currentStrategy) {
			return this.currentStrategy;
		}

		const launcherPath = this.getLauncherPath();

		// 1. User override takes priority
		if (launcherPath) {
			const strategy = new UserLauncherStrategy(
				launcherPath,
				this.createStrategyContext(),
			);
			if (await strategy.isAvailable()) {
				this.currentStrategy = strategy;
				return strategy;
			}
		}

		// 2. Bundled launcher (macOS only)
		if (process.platform === "darwin" && this.extensionPath) {
			const strategy = new BundledLauncherStrategy(
				this.extensionPath,
				this.createStrategyContext(),
			);
			if (await strategy.isAvailable()) {
				this.currentStrategy = strategy;
				return strategy;
			}
		}

		return null;
	}

	/**
	 * Create context object for launcher strategies
	 */
	private createStrategyContext(): LauncherStrategyContext {
		return {
			extensionPath: this.extensionPath,
			processManager: this.processManager,
			logger: getLogger(),
			securityService: this.securityService,
			spawn: this.spawn,
		};
	}

	/**
	 * Validate that the launcher script is accessible
	 * Platform-aware: Windows checks file existence, Unix checks executable bit
	 */
	async validateLauncherInstallation(): Promise<{
		isValid: boolean;
		message?: string;
	}> {
		const launcherPath = this.getLauncherPath();

		try {
			// Windows doesn't support X_OK flag - just check file exists
			if (process.platform === "win32") {
				await fs.access(launcherPath);
			} else {
				// Unix-like systems check for executable permission
				await fs.access(launcherPath, fs.constants.X_OK);
			}
			return { isValid: true };
		} catch {
			return {
				isValid: false,
				message: `Terminal launcher script not found or not executable at ${launcherPath}. Please check the commandCentral.terminal.launcherPath setting.`,
			};
		}
	}

	/**
	 * Launch terminal with default settings (workspace root)
	 */
	async launch(): Promise<LaunchResult> {
		const workspaceFolder = this.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return {
				success: false,
				error:
					"No workspace folder is currently open. Please open a folder in VS Code first.",
			};
		}

		// Ensure project settings exist if auto-configure is enabled
		if (this.shouldAutoConfigureProject()) {
			await this.ensureProjectSettings(workspaceFolder.uri.fsPath);
		}

		// Validate and sanitize the workspace path
		let sanitizedPath: string;
		try {
			sanitizedPath = this.securityService.sanitizePath(
				workspaceFolder.uri.fsPath,
			);
		} catch (error) {
			return {
				success: false,
				error: `Security validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}

		return this.executeLauncher([sanitizedPath]);
	}

	/**
	 * Launch terminal at a specific path
	 */
	async launchHere(uri: vscode.Uri | undefined): Promise<LaunchResult> {
		if (!uri || !uri.fsPath) {
			return {
				success: false,
				error:
					"No path provided. Right-click on a file or folder in the Explorer to launch terminal at that location.",
			};
		}

		// Validate and sanitize the path
		let targetPath: string;
		try {
			targetPath = this.securityService.sanitizePath(uri.fsPath);
		} catch (error) {
			return {
				success: false,
				error: `Security validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}

		// Check if it's a file and get the directory
		try {
			const stat = await fs.stat(targetPath);
			if (!stat.isDirectory()) {
				targetPath = path.dirname(targetPath);
			}
		} catch (error) {
			return {
				success: false,
				error: `Cannot access the specified path: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}

		return this.executeLauncher([targetPath]);
	}

	/**
	 * Launch terminal at workspace root
	 */
	async launchWorkspace(): Promise<LaunchResult> {
		return this.launch(); // Same as default launch
	}

	/**
	 * Execute the launcher using the strategy system
	 *
	 * Strategy selection priority:
	 * 1. User-configured launcherPath (UserLauncherStrategy)
	 * 2. Bundled launcher on macOS (BundledLauncherStrategy)
	 * 3. No launcher available - show helpful error
	 */
	private async executeLauncher(args: string[]): Promise<LaunchResult> {
		try {
			// Validate working directory argument
			const workingDir = args[0];
			if (!workingDir) {
				return { success: false, error: "No working directory specified" };
			}

			// Use strategy-based launch
			const strategy = await this.getStrategy();

			if (strategy) {
				const terminalApp = this.getTerminalApp();
				const env = terminalApp ? { TERMINAL_APP: terminalApp } : undefined;
				const result = await strategy.launch(workingDir, env);

				if (result.success) {
					const logLevel = this.workspace
						.getConfiguration("commandCentral.terminal", null)
						.get<string>("logLevel", "info");
					if (logLevel === "debug") {
						this.window.showInformationMessage(
							"Terminal launcher executed successfully",
						);
					}
				} else {
					this.window.showErrorMessage(
						`Failed to launch terminal: ${result.error}`,
					);
				}

				return {
					success: result.success,
					pid: result.pid,
					error: result.error,
				};
			}

			// No strategy available - show helpful error
			const errorMsg =
				"No launcher available. Configure commandCentral.terminal.launcherPath or use macOS with bundled launcher.";
			this.window.showErrorMessage(errorMsg);
			return { success: false, error: errorMsg };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			this.window.showErrorMessage(
				`Failed to launch terminal: ${errorMessage}`,
			);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Execute an operation with retry logic
	 */
	private async withRetry<T>(
		operation: () => Promise<T>,
		maxAttempts = 3,
		delays = [100, 300, 900],
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error as Error;

				// Don't retry on permanent errors
				if (this.isPermanentError(error)) {
					throw error;
				}

				if (attempt < maxAttempts - 1) {
					const delay = delays[attempt] || 1000;
					await new Promise((resolve) => setTimeout(resolve, delay));
					this.securityService
						.getOutputChannel()
						.appendLine(
							`Retry attempt ${attempt + 2}/${maxAttempts} after ${delay}ms`,
						);
				}
			}
		}

		throw new Error(
			`Failed after ${maxAttempts} attempts: ${lastError?.message}`,
		);
	}

	/**
	 * Check if an error is permanent (should not retry)
	 */
	private isPermanentError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		const errorCode = (error as NodeJS.ErrnoException)?.code;

		// File not found, permission denied, etc. are permanent
		return (
			errorCode === "ENOENT" ||
			errorCode === "EACCES" ||
			message.includes("not found") ||
			message.includes("Permission denied")
		);
	}

	/**
	 * Execute an operation with timeout using AbortController
	 */
	private async executeWithTimeout<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		timeoutMs = 5000,
	): Promise<T> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			controller.abort();
		}, timeoutMs);

		try {
			const result = await operation(controller.signal);
			clearTimeout(timeoutId);
			return result;
		} catch (error) {
			clearTimeout(timeoutId);
			if (controller.signal.aborted) {
				throw new Error(`Operation timed out after ${timeoutMs}ms`);
			}
			throw error;
		}
	}

	/**
	 * List all project launchers
	 */
	async listLaunchers(): Promise<string[]> {
		return this.withRetry(async () => {
			try {
				const launcherPath = this.getLauncherPath();

				// Execute with timeout
				const output = await this.executeWithTimeout(async (signal) => {
					return new Promise<string>((resolve, reject) => {
						const proc = this.spawn(launcherPath, ["list"], {});

						let stdout = "";
						let stderr = "";
						let processKilled = false;

						// Handle abort signal
						signal.addEventListener("abort", () => {
							processKilled = true;
							if (proc.kill) {
								proc.kill("SIGTERM");
							}
							reject(new Error("Process killed due to timeout"));
						});

						// Handle Node.js streams
						proc.stdout?.on("data", (data: Buffer) => {
							stdout += data.toString();
						});

						proc.stderr?.on("data", (data: Buffer) => {
							stderr += data.toString();
						});

						proc.on("error", (...args: unknown[]) => {
							const error = args[0] as Error;
							if (!processKilled) {
								reject(error);
							}
						});

						proc.on("close", (...args: unknown[]) => {
							const code = args[0] as number | null;
							if (processKilled) return;

							if (code !== 0) {
								reject(
									new Error(
										`Launcher list failed with code ${code}: ${stderr}`,
									),
								);
							} else {
								resolve(stdout);
							}
						});
					});
				});

				// Parse the output to extract launcher names
				const lines = output.split("\n").filter((line) => line.trim());
				const launchers: string[] = [];

				for (const line of lines) {
					// More flexible regex: look for bullet points followed by project name
					// Matches: • ProjectName [emoji] → /path or just • ProjectName
					const match = line.match(/^\s*[•·-]\s+(.+?)(?:\s*→|$)/);
					if (match?.[1]) {
						// Clean up the name by removing trailing emojis/icons and whitespace
						// First trim whitespace, then remove emojis from the end
						let name = match[1].trim();
						// Remove common emoji patterns (but not digits which can be part of names)
						// This targets actual emoji characters and common folder/file icons
						// Using individual emoji strings to avoid character class issues with combining characters
						const emojiPattern =
							/\s*(?:📁|🚀|📂|📄|📝|💻|🖥️|⚡|🔥|✨|🎯|🎨|🔧|🔨|⚙️|🛠️)+\s*$/u;
						name = name.replace(emojiPattern, "").trim();
						if (name) {
							launchers.push(name);
						}
					}
				}

				return launchers;
			} catch (error) {
				// Improve error messages for common cases
				let errorMessage: string;
				const errorCode = (error as NodeJS.ErrnoException)?.code;

				if (errorCode === "ENOENT") {
					errorMessage =
						"Terminal launcher not found at configured path. Please check your settings.";
				} else if (errorCode === "EACCES") {
					errorMessage =
						"Permission denied when accessing terminal launcher. Please check file permissions.";
				} else if (
					error instanceof Error &&
					error.message.includes("timed out")
				) {
					errorMessage =
						"Terminal launcher timed out. The launcher may be unresponsive.";
				} else {
					errorMessage = `Failed to list launchers: ${error instanceof Error ? error.message : "Unknown error"}`;
				}

				this.window.showErrorMessage(errorMessage);
				throw new Error(errorMessage);
			}
		});
	}

	/**
	 * Remove a specific launcher
	 */
	async removeLauncher(name: string): Promise<boolean> {
		try {
			const launcherPath = this.getLauncherPath();

			// Use async spawn
			const { success, stderr } = await new Promise<{
				success: boolean;
				stderr: string;
			}>((resolve, reject) => {
				const proc = this.spawn(launcherPath, ["remove", name], {});

				let stderr = "";

				// Handle Node.js streams
				proc.stderr?.on("data", (data: Buffer) => {
					stderr += data.toString();
				});

				proc.on("error", reject);

				proc.on("close", (...args: unknown[]) => {
					const code = args[0] as number | null;
					resolve({ success: code === 0, stderr });
				});
			});

			if (success) {
				this.window.showInformationMessage(`Removed launcher: ${name}`);
			} else {
				this.window.showErrorMessage(
					`Failed to remove launcher '${name}': ${stderr || "Check if the launcher exists"}`,
				);
			}

			return success;
		} catch (error) {
			this.window.showErrorMessage(
				`Failed to remove launcher: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return false;
		}
	}

	/**
	 * Remove all launchers
	 */
	async removeAllLaunchers(): Promise<boolean> {
		try {
			const launcherPath = this.getLauncherPath();

			// Use async spawn
			const { success, stderr } = await new Promise<{
				success: boolean;
				stderr: string;
			}>((resolve, reject) => {
				const proc = this.spawn(launcherPath, ["remove-all"], {});

				let stderr = "";

				// Handle Node.js streams
				proc.stderr?.on("data", (data: Buffer) => {
					stderr += data.toString();
				});

				proc.on("error", reject);

				proc.on("close", (...args: unknown[]) => {
					const code = args[0] as number | null;
					resolve({ success: code === 0, stderr });
				});
			});

			if (success) {
				this.window.showInformationMessage("Removed all launchers");
			} else {
				this.window.showErrorMessage(
					`Failed to remove all launchers: ${stderr || "Operation failed"}`,
				);
			}

			return success;
		} catch (error) {
			this.window.showErrorMessage(
				`Failed to remove launchers: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return false;
		}
	}

	/**
	 * Ensure project settings exist in .vscode/settings.json
	 */
	private async ensureProjectSettings(workspaceFolder: string): Promise<void> {
		const settingsPath = path.join(workspaceFolder, ".vscode", "settings.json");

		try {
			// Check if settings already exist
			const settingsContent = await fs.readFile(settingsPath, "utf-8");
			const settings = JSON.parse(settingsContent);

			// Check if project settings are already configured (new or old format)
			if (
				// New format
				settings["commandCentral.project.icon"] ||
				settings["commandCentral.project.name"] ||
				// Legacy format
				settings.projectIcon ||
				settings.projectName ||
				settings.terminalTheme
			) {
				return; // Already configured
			}
		} catch {
			// Settings don't exist or are invalid, we'll create/update them
		}

		// Prompt for project configuration
		const projectName = await this.window.showInputBox({
			prompt: "Enter project name",
			value: path.basename(workspaceFolder),
			placeHolder: "My Project",
		});

		if (!projectName) {
			return; // User cancelled
		}

		// Emoji picker
		const emojis = [
			{ label: "🚀", description: "Rocket - Launch/Deploy" },
			{ label: "🔧", description: "Wrench - Tools/Config" },
			{ label: "📦", description: "Package - Libraries" },
			{ label: "🎨", description: "Palette - Design/UI" },
			{ label: "🔍", description: "Magnifying Glass - Search/Analysis" },
			{ label: "⚡", description: "Lightning - Performance" },
			{ label: "🌟", description: "Star - Featured" },
			{ label: "💼", description: "Briefcase - Business" },
			{ label: "🎯", description: "Target - Goals" },
			{ label: "🔥", description: "Fire - Hot/Active" },
			{ label: "🦀", description: "Crab - Rust" },
			{ label: "🐍", description: "Snake - Python" },
			{ label: "☕", description: "Coffee - Java" },
			{ label: "🌐", description: "Globe - Web" },
			{ label: "📱", description: "Mobile - Apps" },
			{ label: "🗄️", description: "Cabinet - Database" },
			{ label: "🔒", description: "Lock - Security" },
			{ label: "📊", description: "Chart - Analytics" },
			{ label: "🤖", description: "Robot - AI/Automation" },
			{ label: "📝", description: "Memo - Documentation" },
		];

		const selectedEmoji = await this.window.showQuickPick(emojis, {
			placeHolder: "Select project icon",
		});

		if (!selectedEmoji) {
			return; // User cancelled
		}

		// Theme selection (optional)
		const themes = [
			{ label: "None", value: "" },
			{ label: "Nord", value: "nord" },
			{ label: "Dracula", value: "dracula" },
			{ label: "Tokyo Night", value: "tokyonight" },
			{ label: "Catppuccin", value: "catppuccin" },
			{ label: "Gruvbox", value: "gruvbox" },
			{ label: "One Dark", value: "onedark" },
			{ label: "Solarized", value: "solarized" },
		];

		const selectedTheme = await this.window.showQuickPick(themes, {
			placeHolder: "Select terminal theme (optional)",
		});

		// Create or update settings using new configuration format
		const projectSettings: Record<string, string> = {
			"commandCentral.project.icon": selectedEmoji.label,
			"commandCentral.project.name": projectName,
		};

		// Only add theme if selected
		if (selectedTheme?.value) {
			projectSettings["commandCentral.terminal.theme"] = selectedTheme.value;
		}

		// Ensure .vscode directory exists
		const vscodeDir = path.join(workspaceFolder, ".vscode");
		await fs.mkdir(vscodeDir, { recursive: true });

		// Read existing settings or create new
		let existingSettings = {};
		try {
			const content = await fs.readFile(settingsPath, "utf-8");
			existingSettings = JSON.parse(content);
		} catch {
			// File doesn't exist or is invalid
		}

		// Merge settings
		const updatedSettings = {
			...existingSettings,
			...projectSettings,
		};

		// Write settings
		await fs.writeFile(
			settingsPath,
			JSON.stringify(updatedSettings, null, 2),
			"utf-8",
		);

		this.window.showInformationMessage(
			`Project configured: ${projectName} ${selectedEmoji.label}`,
		);
	}

	/**
	 * Configure project settings
	 */
	async configureProject(): Promise<void> {
		const workspaceFolder = this.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			this.window.showErrorMessage("No workspace folder is open");
			return;
		}

		await this.ensureProjectSettings(workspaceFolder.uri.fsPath);
	}

	/**
	 * Get the security service (for command handlers)
	 */
	getSecurityService(): ISecurityService {
		return this.securityService;
	}

	/**
	 * Dispose of resources
	 */
	dispose(): void {
		// Clean up config change listener
		if (this.configChangeDisposable) {
			this.configChangeDisposable.dispose();
			this.configChangeDisposable = null;
		}
		// Clear cached strategy
		this.currentStrategy = null;
	}
}
