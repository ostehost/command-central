/**
 * SecurityService - Central security management for VS Code extension
 * ESM module providing workspace trust, command validation, and audit logging
 */

import type {
	OutputChannel,
	VSCodeWindow,
	VSCodeWorkspace,
} from "../types/vscode-types.js";
import { Validator } from "./validator.js";

interface ExecutionLimits {
	timeout: number;
	maxBuffer: number;
	killSignal: "SIGTERM" | "SIGKILL";
	shell: boolean;
}

interface ValidationResult {
	command: string;
	args: string[];
	isValid: boolean;
}

interface AuditResult {
	success: boolean;
	error?: string;
}

export class SecurityService {
	private validator: Validator;
	private outputChannel: OutputChannel | null = null;
	private allowedCommands: string[];
	private executionTimeout: number;
	private maxBuffer: number;

	constructor(
		private workspace: VSCodeWorkspace,
		private window: VSCodeWindow,
		outputChannel?: OutputChannel,
	) {
		this.validator = new Validator();

		// Load configuration - use commandCentral.terminal configuration namespace
		const config = this.workspace.getConfiguration(
			"commandCentral.terminal",
			null,
		);
		// Always allow common terminal commands and utilities
		this.allowedCommands = ["ghostty", "ls", "pwd", "echo", "cat", "grep"];
		this.executionTimeout = config.get("executionTimeout", 30000) || 30000;
		this.maxBuffer =
			config.get("maxBuffer", 10 * 1024 * 1024) || 10 * 1024 * 1024;

		// Use provided output channel or create a new one
		this.outputChannel =
			outputChannel || this.window.createOutputChannel("Terminal Launcher");
	}

	/**
	 * Check if workspace is trusted for command execution
	 */
	async checkWorkspaceTrust(): Promise<boolean> {
		if (this.workspace.isTrusted !== false) {
			return true;
		}

		const choice = await this.window.showWarningMessage(
			"Terminal operations require a trusted workspace",
			{ modal: true },
			"Trust Workspace",
		);

		return choice === "Trust Workspace";
	}

	/**
	 * Check if a command is in the allowed list
	 * Accepts unknown at security boundary - validates type at runtime
	 */
	isCommandAllowed(command: unknown): boolean {
		if (!command || typeof command !== "string" || !command.trim()) {
			return false;
		}

		// Check if it's an absolute path (executable)
		if (command.startsWith("/") || command.includes("\\")) {
			return true; // Will be validated separately
		}

		// Always allow common terminal executables (case-insensitive)
		// This includes ghostty and other terminal emulators
		const cleanCommand = command.trim().toLowerCase();
		if (cleanCommand === "ghostty" || cleanCommand.includes("ghostty")) {
			return true;
		}

		return this.allowedCommands.includes(command);
	}

	/**
	 * Validate and sanitize a command and its arguments
	 */
	async validateCommand(
		command: string,
		args: string[],
	): Promise<ValidationResult> {
		// Check if it's an absolute path
		if (command.startsWith("/") || command.includes("\\")) {
			// Validate as executable path
			try {
				const validatedPath = this.validator.validateExecutable(command);
				const sanitizedArgs = this.validator.validateArgs(args);

				return {
					command: validatedPath,
					args: sanitizedArgs,
					isValid: true,
				};
			} catch (error) {
				throw new Error(`Invalid executable: ${(error as Error).message}`);
			}
		}

		// Check if command is allowed
		if (!this.isCommandAllowed(command)) {
			throw new Error(`Command "${command}" is not allowed`);
		}

		// Sanitize arguments
		const sanitizedArgs = this.validator.validateArgs(args);

		return {
			command,
			args: sanitizedArgs,
			isValid: true,
		};
	}

	/**
	 * Get execution limits for spawning processes
	 */
	getExecutionLimits(): ExecutionLimits {
		// Enforce reasonable limits
		const timeout = Math.max(1000, Math.min(300000, this.executionTimeout));
		const maxBuffer = Math.max(
			1024,
			Math.min(100 * 1024 * 1024, this.maxBuffer),
		);

		return {
			timeout,
			maxBuffer,
			killSignal: "SIGTERM",
			shell: false, // NEVER enable shell mode
		};
	}

	/**
	 * Log command execution for security audit
	 */
	auditLog(command: string, args: string[], result: AuditResult): void {
		if (!this.outputChannel) {
			this.outputChannel = this.window.createOutputChannel("Terminal Launcher");
		}

		const timestamp = new Date().toISOString();
		const status = result.success ? "SUCCESS" : "FAILED";
		const argsStr = args.join(" ");
		const errorInfo = result.error ? ` - Error: ${result.error}` : "";

		const logEntry = `[${timestamp}] ${status}: ${command} ${argsStr}${errorInfo}`;
		this.outputChannel.appendLine(logEntry);
	}

	/**
	 * Sanitize and validate a file path
	 */
	sanitizePath(path: string): string {
		return this.validator.validatePath(path);
	}

	/**
	 * Get the output channel for logging
	 */
	getOutputChannel(): OutputChannel {
		if (!this.outputChannel) {
			this.outputChannel = this.window.createOutputChannel("Terminal Launcher");
		}
		return this.outputChannel;
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		if (this.outputChannel) {
			this.outputChannel.dispose();
			this.outputChannel = null;
		}
	}
}
