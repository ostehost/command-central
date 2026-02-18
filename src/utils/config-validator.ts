/**
 * Configuration Validator
 * Validates extension configuration at startup and on changes
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	VSCodeCommands,
	VSCodeWindow,
	VSCodeWorkspace,
	WorkspaceConfiguration,
} from "../types/vscode-types.js";

export interface ValidationResult {
	isValid: boolean;
	criticalErrors: string[]; // Errors that prevent extension from working
	errors: string[]; // Errors that should be fixed but don't break extension
	warnings: string[]; // Suggestions for improvement
}

/**
 * NOTE: TerminalLauncherConfig interface was moved to legacy/unused-code/
 * on 2025-10-19. It was unused (not referenced anywhere in this file or others).
 * Terminal launcher configuration is now directly validated without a separate interface.
 */

export class ConfigValidator {
	private readonly validLogLevels = ["debug", "info", "warn", "error", "none"];
	private readonly maxTimeout = 300000; // 5 minutes
	private readonly maxBufferSize = 50 * 1024 * 1024; // 50MB

	constructor(
		private workspace: VSCodeWorkspace,
		private window: VSCodeWindow,
		private commands?: VSCodeCommands,
	) {}

	/**
	 * Validate all terminal launcher configuration
	 */
	async validateConfiguration(): Promise<ValidationResult> {
		const config = this.workspace.getConfiguration("commandCentral.terminal");
		const result: ValidationResult = {
			isValid: true,
			criticalErrors: [],
			errors: [],
			warnings: [],
		};

		// Validate terminal launcher path
		await this.validatePath(config, result);

		// Validate arguments
		this.validateArgs(config, result);

		// Validate environment variables
		this.validateEnv(config, result);

		// Validate execution timeout
		this.validateTimeout(config, result);

		// Validate max buffer size
		this.validateMaxBuffer(config, result);

		// Validate log level
		this.validateLogLevel(config, result);

		// Critical errors prevent the extension from working at all
		// Regular errors are configuration issues that should be fixed
		result.isValid = result.criticalErrors.length === 0;
		return result;
	}

	/**
	 * Validate terminal launcher executable path
	 */
	private async validatePath(
		config: WorkspaceConfiguration,
		result: ValidationResult,
	): Promise<void> {
		const terminalPath = config.get<string>("path");

		if (!terminalPath) {
			// Using default path, no validation needed
			return;
		}

		// Check for suspicious patterns - only block actual traversal attempts
		// Allow ".." in legitimate absolute paths like /Users/../Users/jane
		if (terminalPath.includes("~")) {
			result.errors.push(
				`Invalid terminal path: "${terminalPath}". Path should not contain "~". Use absolute paths instead.`,
			);
			return;
		}

		// Check for actual path traversal attempts (relative paths trying to escape)
		if (!path.isAbsolute(terminalPath) && terminalPath.includes("..")) {
			result.errors.push(
				`Invalid terminal path: "${terminalPath}". Relative paths with ".." are not allowed for security reasons.`,
			);
			return;
		}

		// Platform-specific validation
		const plat = process.platform;

		if (plat === "darwin") {
			// macOS: Should be .app bundle
			if (!terminalPath.endsWith(".app") && !terminalPath.includes(".app")) {
				result.warnings.push(
					"Terminal path on macOS should point to the .app bundle (e.g., /Applications/Terminal.app), not the binary inside.",
				);
			}

			// Check if path exists
			try {
				await fs.access(terminalPath);
			} catch {
				result.errors.push(
					`Terminal not found at configured path: "${terminalPath}". Please check your settings.`,
				);
			}
		} else if (plat === "win32") {
			// Windows: Should be .exe
			if (!terminalPath.endsWith(".exe")) {
				result.warnings.push(
					"Terminal path on Windows should end with .exe (e.g., C:\\Program Files\\Terminal\\terminal.exe)",
				);
			}
		}
	}

	/**
	 * Validate command arguments
	 */
	private validateArgs(
		config: WorkspaceConfiguration,
		result: ValidationResult,
	): void {
		const args = config.get<string[]>("args");

		if (!args || args.length === 0) {
			return;
		}

		// Check for dangerous arguments
		const dangerousPatterns = [
			/^--command=/,
			/^-e$/,
			/^--execute=/,
			/;\s*rm\s/,
			/&&/,
			/\|\|/,
			/`/,
			/\$\(/,
			/\${/,
		];

		args.forEach((arg, index) => {
			// Check for dangerous patterns
			for (const pattern of dangerousPatterns) {
				if (pattern.test(arg)) {
					result.errors.push(
						`Potentially dangerous argument at index ${index}: "${arg}". Command execution arguments are not allowed for security reasons.`,
					);
					return;
				}
			}

			// Check for empty strings
			if (arg.trim() === "") {
				result.warnings.push(
					`Empty argument at index ${index}. This will be ignored.`,
				);
			}

			// Check for unbalanced quotes
			const quotes = arg.match(/["']/g);
			if (quotes && quotes.length % 2 !== 0) {
				result.warnings.push(
					`Possibly unbalanced quotes in argument at index ${index}: "${arg}"`,
				);
			}
		});
	}

	/**
	 * Validate environment variables
	 */
	private validateEnv(
		config: WorkspaceConfiguration,
		result: ValidationResult,
	): void {
		const env = config.get<Record<string, string>>("env");

		if (!env || Object.keys(env).length === 0) {
			return;
		}

		// Check for sensitive or dangerous environment variables
		const sensitiveVars = [
			"LD_PRELOAD",
			"LD_LIBRARY_PATH",
			"DYLD_INSERT_LIBRARIES",
			"DYLD_LIBRARY_PATH",
			"NODE_OPTIONS",
			"PYTHONPATH",
			"RUBYOPT",
		];

		Object.keys(env).forEach((key) => {
			// Check for sensitive variables
			if (sensitiveVars.includes(key.toUpperCase())) {
				result.warnings.push(
					`Setting environment variable "${key}" may have security implications. Please ensure this is intended.`,
				);
			}

			// Check for empty values
			if (env[key] === "") {
				result.warnings.push(
					`Environment variable "${key}" has an empty value. This will unset the variable.`,
				);
			}

			// Check for command injection attempts
			const value = env[key];
			if (
				value &&
				(value.includes("`") ||
					value.includes("$(") ||
					value.includes("${") ||
					value.includes("&&") ||
					value.includes("||"))
			) {
				result.errors.push(
					`Environment variable "${key}" contains potentially dangerous characters. Command substitution is not allowed.`,
				);
			}
		});
	}

	/**
	 * Validate execution timeout
	 */
	private validateTimeout(
		config: WorkspaceConfiguration,
		result: ValidationResult,
	): void {
		const timeout = config.get<number>("executionTimeout");

		if (timeout === undefined || timeout === null) {
			return;
		}

		if (typeof timeout !== "number") {
			result.errors.push(
				`Execution timeout must be a number, got ${typeof timeout}`,
			);
			return;
		}

		if (timeout < 0) {
			result.errors.push(
				`Execution timeout cannot be negative (got ${timeout}ms)`,
			);
		} else if (timeout === 0) {
			result.warnings.push(
				`Execution timeout is set to 0 (no timeout). This may cause the extension to hang if the terminal doesn't respond.`,
			);
		} else if (timeout > this.maxTimeout) {
			result.warnings.push(
				`Execution timeout (${timeout}ms) exceeds recommended maximum (${this.maxTimeout}ms / 5 minutes)`,
			);
		}
	}

	/**
	 * Validate max buffer size
	 */
	private validateMaxBuffer(
		config: WorkspaceConfiguration,
		result: ValidationResult,
	): void {
		const maxBuffer = config.get<number>("maxBuffer");

		if (maxBuffer === undefined || maxBuffer === null) {
			return;
		}

		if (typeof maxBuffer !== "number") {
			result.errors.push(
				`Max buffer size must be a number, got ${typeof maxBuffer}`,
			);
			return;
		}

		if (maxBuffer < 0) {
			result.errors.push(
				`Max buffer size cannot be negative (got ${maxBuffer} bytes)`,
			);
		} else if (maxBuffer === 0) {
			result.errors.push("Max buffer size cannot be 0");
		} else if (maxBuffer > this.maxBufferSize) {
			result.warnings.push(
				`Max buffer size (${maxBuffer} bytes) exceeds recommended maximum (${this.maxBufferSize} bytes / 50MB). This may cause memory issues.`,
			);
		}
	}

	/**
	 * Validate log level
	 */
	private validateLogLevel(
		config: WorkspaceConfiguration,
		result: ValidationResult,
	): void {
		const logLevel = config.get<string>("logLevel");

		if (!logLevel) {
			return;
		}

		if (!this.validLogLevels.includes(logLevel.toLowerCase())) {
			result.errors.push(
				`Invalid log level: "${logLevel}". Must be one of: ${this.validLogLevels.join(", ")}`,
			);
		}
	}

	/**
	 * Show validation results to user
	 */
	showValidationResults(result: ValidationResult): void {
		// Show critical errors first - these prevent the extension from working
		if (result.criticalErrors.length > 0) {
			const message = `Terminal launcher cannot start due to critical errors:\n${result.criticalErrors.join("\n")}`;
			this.window
				.showErrorMessage(message, "Open Settings")
				.then((selection) => {
					if (selection === "Open Settings" && this.commands) {
						this.commands.executeCommand(
							"workbench.action.openSettings",
							"commandCentral.terminal",
						);
					}
				});
		}
		// Show regular errors - configuration issues that should be fixed
		else if (result.errors.length > 0) {
			const message = `Terminal configuration has errors:\n${result.errors.join("\n")}`;
			this.window
				.showErrorMessage(message, "Open Settings", "Ignore")
				.then((selection) => {
					if (selection === "Open Settings" && this.commands) {
						this.commands.executeCommand(
							"workbench.action.openSettings",
							"commandCentral.terminal",
						);
					}
				});
		}
		// Show warnings - suggestions for improvement
		else if (result.warnings.length > 0) {
			const message = `Terminal configuration warnings:\n${result.warnings.join("\n")}`;
			this.window
				.showWarningMessage(message, "Open Settings", "Ignore")
				.then((selection) => {
					if (selection === "Open Settings" && this.commands) {
						this.commands.executeCommand(
							"workbench.action.openSettings",
							"commandCentral.terminal",
						);
					}
				});
		}
	}
}
