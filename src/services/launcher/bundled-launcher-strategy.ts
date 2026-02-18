/**
 * Bundled Launcher Strategy
 *
 * Implements ILauncherStrategy for the bundled macOS launcher.
 * Handles VSIX extraction edge cases (executable bit loss) with smart chmod.
 *
 * @see launcher-strategy.interface.ts for interface definition
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	LauncherInfo,
	LauncherValidationResult,
	LaunchResult,
} from "../../types/launcher-config.js";
import type {
	ILauncherStrategy,
	LauncherStrategyContext,
} from "./launcher-strategy.interface.js";

export class BundledLauncherStrategy implements ILauncherStrategy {
	readonly strategyId = "bundled" as const;
	private readonly launcherPath: string;
	private readonly terminalAppPath: string;
	private executableVerified = false;

	constructor(
		extensionPath: string,
		private context: LauncherStrategyContext,
	) {
		// Single shell script works on both arm64 and x64
		// (verified: launcher handles architecture detection internally)
		this.launcherPath = path.join(
			extensionPath,
			"resources",
			"bin",
			"ghostty-launcher",
		);
		// Bundled terminal app (synced from ghostty-fork)
		this.terminalAppPath = path.join(
			extensionPath,
			"resources",
			"app",
			"CommandCentral.app",
		);
	}

	/**
	 * Check if bundled launcher is available (macOS only)
	 */
	async isAvailable(): Promise<boolean> {
		// Platform check first (fast path)
		if (process.platform !== "darwin") {
			return false;
		}

		try {
			// Check file exists (don't check executable yet - we'll fix it on launch)
			await fs.access(this.launcherPath, fs.constants.F_OK);
			return true;
		} catch {
			this.context.logger.debug(
				`Bundled launcher not found: ${this.launcherPath}`,
				"BundledLauncherStrategy",
			);
			return false;
		}
	}

	/**
	 * Get launcher info for audit logging
	 */
	getInfo(): LauncherInfo {
		return {
			type: "bundled",
			path: this.launcherPath,
			verificationStatus: "skipped",
		};
	}

	/**
	 * Launch terminal at specified working directory
	 */
	async launch(
		workingDir: string,
		env?: NodeJS.ProcessEnv,
	): Promise<LaunchResult> {
		const launcherInfo = this.getInfo();

		// Fix executable bit on first use (VSIX extraction may lose it)
		if (!this.executableVerified) {
			await this.ensureExecutable();
		}

		// Check for bundled terminal app
		const bundledApp = await this.getBundledTerminalApp();

		try {
			// Use injected spawn for testing, fallback to native for production
			const spawn = this.context.spawn ?? nodeSpawn;

			// Build environment with bundled app if available
			const launchEnv = {
				...process.env,
				// Use bundled app path if available, otherwise fall back to bundle ID
				TERMINAL_APP: bundledApp ?? "com.ghostty",
				...env,
			};

			if (bundledApp) {
				this.context.logger.debug(
					`Using bundled terminal app: ${bundledApp}`,
					"BundledLauncherStrategy",
				);
			}

			// Use array form to avoid shell parsing (handles paths with spaces)
			const child = spawn(this.launcherPath, [workingDir], {
				detached: true,
				stdio: "ignore",
				env: launchEnv,
			});

			// Fully detach from parent process
			child.unref();

			if (child.pid) {
				this.context.processManager.track(child.pid);
				this.context.logger.info(
					`Bundled launcher spawned (pid: ${child.pid})`,
					"BundledLauncherStrategy",
				);
			}

			this.context.securityService.auditLog(this.launcherPath, [workingDir], {
				success: true,
			});

			return { success: true, pid: child.pid, launcherInfo };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.context.securityService.auditLog(this.launcherPath, [workingDir], {
				success: false,
				error: message,
			});
			return { success: false, error: message, launcherInfo };
		}
	}

	/**
	 * Get the bundled terminal app path if available
	 */
	private async getBundledTerminalApp(): Promise<string | undefined> {
		try {
			await fs.access(this.terminalAppPath, fs.constants.F_OK);
			return this.terminalAppPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * Validate launcher with detailed error information
	 */
	async validate(): Promise<LauncherValidationResult> {
		if (process.platform !== "darwin") {
			return {
				isValid: false,
				message: "Bundled launcher only available on macOS",
				errorCode: "PLATFORM",
			};
		}

		try {
			await fs.access(this.launcherPath, fs.constants.F_OK);
			return { isValid: true };
		} catch {
			return {
				isValid: false,
				message: `Bundled launcher not found: ${this.launcherPath}`,
				errorCode: "ENOENT",
			};
		}
	}

	/**
	 * Smart chmod: only fix if executable bits are missing
	 *
	 * VSIX extraction may lose executable permissions. This method:
	 * 1. Checks if any executable bit is set (user, group, or other)
	 * 2. Only runs chmod if bits are missing
	 * 3. Handles read-only extension directories gracefully
	 */
	private async ensureExecutable(): Promise<void> {
		try {
			const stats = await fs.stat(this.launcherPath);

			// Check if ANY executable bit is set (user, group, or other)
			if ((stats.mode & 0o111) === 0) {
				await fs.chmod(this.launcherPath, 0o755);
				this.context.logger.debug(
					`Fixed executable bit: ${this.launcherPath}`,
					"BundledLauncherStrategy",
				);
			}

			this.executableVerified = true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES") {
				// Extension in read-only directory—log but don't fail
				// Try launch anyway; if it fails, the error will be returned then
				this.context.logger.warn(
					`Cannot chmod (read-only): ${this.launcherPath}`,
					"BundledLauncherStrategy",
				);
				this.executableVerified = true; // Don't retry on every launch
			} else {
				throw error;
			}
		}
	}
}
