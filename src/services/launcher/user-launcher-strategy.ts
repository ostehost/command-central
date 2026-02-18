/**
 * User Launcher Strategy
 *
 * Implements ILauncherStrategy for user-configured launcher paths.
 * Validates executable permissions and spawns detached processes.
 *
 * @see launcher-strategy.interface.ts for interface definition
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import type {
	LauncherInfo,
	LauncherValidationResult,
	LaunchResult,
} from "../../types/launcher-config.js";
import type {
	ILauncherStrategy,
	LauncherStrategyContext,
} from "./launcher-strategy.interface.js";

export class UserLauncherStrategy implements ILauncherStrategy {
	readonly strategyId = "user" as const;

	constructor(
		private launcherPath: string,
		private context: LauncherStrategyContext,
	) {}

	/**
	 * Check if user-configured launcher is available and executable
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Unix: check executable permission (codebase pattern from terminal-launcher-service.ts:117)
			await fs.access(this.launcherPath, fs.constants.X_OK);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				this.context.logger.debug(
					`User launcher not found: ${this.launcherPath}`,
					"UserLauncherStrategy",
				);
			} else if (code === "EACCES") {
				this.context.logger.warn(
					`User launcher not executable: ${this.launcherPath}`,
					"UserLauncherStrategy",
				);
			}
			return false;
		}
	}

	/**
	 * Get launcher info for audit logging
	 */
	getInfo(): LauncherInfo {
		return { type: "user", path: this.launcherPath };
	}

	/**
	 * Launch terminal at specified working directory
	 */
	async launch(
		workingDir: string,
		env?: NodeJS.ProcessEnv,
	): Promise<LaunchResult> {
		const launcherInfo = this.getInfo();

		try {
			// Use injected spawn for testing, fallback to native for production
			const spawn = this.context.spawn ?? nodeSpawn;

			// Spawn pattern from terminal-launcher-service.ts:231-240
			// Use array form to avoid shell parsing (handles paths with spaces)
			const child = spawn(this.launcherPath, [workingDir], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, ...env },
			});

			// Fully detach from parent process
			child.unref();

			if (child.pid) {
				this.context.processManager.track(child.pid);
				this.context.logger.info(
					`User launcher spawned (pid: ${child.pid})`,
					"UserLauncherStrategy",
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
	 * Validate launcher with detailed error information
	 */
	async validate(): Promise<LauncherValidationResult> {
		try {
			await fs.access(this.launcherPath, fs.constants.X_OK);
			return { isValid: true };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return {
					isValid: false,
					message: `Launcher not found: ${this.launcherPath}`,
					errorCode: "ENOENT",
				};
			}
			if (code === "EACCES") {
				return {
					isValid: false,
					message: `Launcher not executable: ${this.launcherPath}`,
					errorCode: "EACCES",
				};
			}
			return {
				isValid: false,
				message: `Validation failed: ${error}`,
				errorCode: "CONFIG",
			};
		}
	}
}
