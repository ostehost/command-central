/**
 * TerminalManager - Wraps the ghostty-launcher CLI
 *
 * Provides project terminal creation and info retrieval via the
 * `launcher` binary (ghostty-launcher project).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";

/** Custom error types for better error handling */
export class LauncherNotFoundError extends Error {
	constructor(
		message: string,
		public readonly searchedPaths: string[] = [],
	) {
		super(message);
		this.name = "LauncherNotFoundError";
	}
}

export class LauncherExecutionError extends Error {
	constructor(
		message: string,
		public readonly launcherPath: string,
		public readonly stderr?: string,
		public readonly exitCode?: number,
	) {
		super(message);
		this.name = "LauncherExecutionError";
	}
}

export class LauncherTimeoutError extends Error {
	constructor(
		message: string,
		public readonly launcherPath: string,
		public readonly timeoutMs: number,
	) {
		super(message);
		this.name = "LauncherTimeoutError";
	}
}

export class LauncherValidationError extends Error {
	constructor(
		message: string,
		public readonly launcherPath: string,
		public readonly versionOutput?: string,
	) {
		super(message);
		this.name = "LauncherValidationError";
	}
}

/** Default fallback paths to check when launcher is not in PATH */
const LAUNCHER_FALLBACK_PATHS = [
	path.join(os.homedir(), "projects", "ghostty-launcher", "launcher"),
];

/** Timeout in milliseconds for launcher subprocess calls */
const LAUNCHER_TIMEOUT_MS = 10_000;

export interface TerminalInfo {
	name: string;
	icon: string;
	tmuxSession: string;
}

export class TerminalManager {
	private readonly logger: LoggerService;
	private launcherValidationCache = new Map<string, boolean>();

	constructor(logger: LoggerService) {
		this.logger = logger;
	}

	/**
	 * Returns the resolved path to the launcher binary.
	 * Checks (in order):
	 *   1. commandCentral.ghostty.launcherPath setting
	 *   2. `launcher` on PATH
	 *   3. ~/projects/ghostty-launcher/launcher
	 */
	getLauncherPath(): string {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const configured = config.get<string>("ghostty.launcherPath");
		if (configured && configured.trim() !== "") {
			return configured.trim();
		}
		return "launcher";
	}

	/**
	 * Checks whether the launcher binary is accessible and valid.
	 * First tries the configured/PATH launcher, then fallback paths.
	 * Validates that the found binary is actually the correct launcher executable.
	 */
	async isLauncherInstalled(): Promise<boolean> {
		// Try configured path / PATH
		const primary = this.getLauncherPath();
		if (
			(await this.isBinaryAccessible(primary)) &&
			(await this.validateLauncherBinary(primary))
		) {
			return true;
		}

		// Try known fallback paths
		for (const fallback of LAUNCHER_FALLBACK_PATHS) {
			if (
				fs.existsSync(fallback) &&
				(await this.validateLauncherBinary(fallback))
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Creates a Ghostty project terminal for the given workspace root.
	 * Runs: launcher --create-bundle <dir>
	 */
	async createProjectTerminal(workspaceRoot: string): Promise<void> {
		this.logger.info(
			`Creating project terminal for: ${workspaceRoot}`,
			"TerminalManager",
		);

		const launcher = await this.resolvedLauncherPath();

		const { stdout, stderr } = await this.execLauncher(launcher, [
			"--create-bundle",
			workspaceRoot,
		]);

		if (stdout.trim()) {
			this.logger.debug(`launcher output: ${stdout.trim()}`, "TerminalManager");
		}
		if (stderr.trim()) {
			this.logger.warn(`launcher stderr: ${stderr.trim()}`, "TerminalManager");
		}

		this.logger.info(
			"Project terminal created successfully",
			"TerminalManager",
		);
	}

	/**
	 * Retrieves terminal info (name, icon, tmux session) for the given workspace root.
	 * Runs --parse-name, --parse-icon, and --tmux-session in parallel.
	 */
	async getTerminalInfo(workspaceRoot: string): Promise<TerminalInfo> {
		this.logger.debug(
			`Getting terminal info for: ${workspaceRoot}`,
			"TerminalManager",
		);

		const launcher = await this.resolvedLauncherPath();

		const [nameResult, iconResult, tmuxResult] = await Promise.allSettled([
			this.execLauncher(launcher, ["--parse-name", workspaceRoot]),
			this.execLauncher(launcher, ["--parse-icon", workspaceRoot]),
			this.execLauncher(launcher, ["--tmux-session", workspaceRoot]),
		]);

		const name =
			nameResult.status === "fulfilled"
				? nameResult.value.stdout.trim()
				: path.basename(workspaceRoot);

		const icon =
			iconResult.status === "fulfilled" ? iconResult.value.stdout.trim() : "";

		const tmuxSession =
			tmuxResult.status === "fulfilled" ? tmuxResult.value.stdout.trim() : "";

		// Log specific errors with helpful context
		if (nameResult.status === "rejected") {
			const error = nameResult.reason;
			this.logCommandFailure("--parse-name", error);
		}
		if (iconResult.status === "rejected") {
			const error = iconResult.reason;
			this.logCommandFailure("--parse-icon", error);
		}
		if (tmuxResult.status === "rejected") {
			const error = tmuxResult.reason;
			this.logCommandFailure("--tmux-session", error);
		}

		return { name, icon, tmuxSession };
	}

	/**
	 * Logs command failures with appropriate detail based on error type.
	 */
	private logCommandFailure(command: string, error: unknown): void {
		if (error instanceof LauncherNotFoundError) {
			this.logger.error(
				`${command} failed: ${error.message}`,
				"TerminalManager",
			);
		} else if (error instanceof LauncherTimeoutError) {
			this.logger.warn(
				`${command} timed out after ${error.timeoutMs}ms`,
				"TerminalManager",
			);
		} else if (error instanceof LauncherExecutionError) {
			const details = error.stderr ? ` (stderr: ${error.stderr.trim()})` : "";
			this.logger.warn(
				`${command} failed with exit code ${error.exitCode}${details}`,
				"TerminalManager",
			);
		} else if (error instanceof LauncherValidationError) {
			this.logger.error(
				`${command} failed: ${error.message}`,
				"TerminalManager",
			);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn(`${command} failed: ${message}`, "TerminalManager");
		}
	}

	/**
	 * Runs the launcher binary with the given args, returning { stdout, stderr }.
	 * Throws specific error types for different failure modes.
	 * Exposed for testing — override to inject mock behavior.
	 */
	async execLauncher(
		launcher: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);

		try {
			return await execFileAsync(launcher, args, {
				timeout: LAUNCHER_TIMEOUT_MS,
			});
		} catch (err) {
			const error = err as NodeJS.ErrnoException & {
				stdout?: string;
				stderr?: string;
				code?: string | number;
			};

			// Handle different error types with specific messages
			if (error.code === "ENOENT") {
				throw new LauncherNotFoundError(
					`Launcher binary not found: ${launcher}. ` +
						"Install ghostty-launcher or check your commandCentral.ghostty.launcherPath setting.",
					[launcher],
				);
			}

			if (error.signal === "SIGKILL" || error.code === "TIMEOUT") {
				throw new LauncherTimeoutError(
					`Launcher timed out after ${LAUNCHER_TIMEOUT_MS}ms. The project may be too large or the launcher is unresponsive.`,
					launcher,
					LAUNCHER_TIMEOUT_MS,
				);
			}

			if (typeof error.code === "number" && error.code !== 0) {
				const stderr = error.stderr || "";
				throw new LauncherExecutionError(
					`Launcher failed with exit code ${error.code}${stderr ? `: ${stderr.trim()}` : ""}. ` +
						"Check launcher installation and project configuration.",
					launcher,
					stderr,
					error.code,
				);
			}

			// Generic execution error
			const message = error.message || String(error);
			throw new LauncherExecutionError(
				`Launcher execution failed: ${message}`,
				launcher,
				error.stderr,
			);
		}
	}

	/**
	 * Resolves the launcher path with comprehensive validation.
	 * Throws specific error types with actionable messages for different failure modes.
	 */
	private async resolvedLauncherPath(): Promise<string> {
		const primary = this.getLauncherPath();
		const searchedPaths: string[] = [primary];

		// Check if configured/PATH launcher is accessible
		const primaryAccessible = await this.isBinaryAccessible(primary);

		if (primaryAccessible) {
			// Binary exists, now validate it's the correct one
			if (await this.validateLauncherBinary(primary)) {
				return primary;
			} else {
				throw new LauncherValidationError(
					`Binary at '${primary}' is not the ghostty-launcher executable. ` +
						"Please check your commandCentral.ghostty.launcherPath setting or install the correct launcher binary.",
					primary,
				);
			}
		}

		// Primary not found/accessible, try fallback paths when using default "launcher" name
		if (primary === "launcher") {
			for (const fallback of LAUNCHER_FALLBACK_PATHS) {
				searchedPaths.push(fallback);
				if (fs.existsSync(fallback)) {
					// Check if fallback is accessible and valid
					if (await this.isBinaryAccessible(fallback)) {
						if (await this.validateLauncherBinary(fallback)) {
							this.logger.info(
								`Using fallback launcher path: ${fallback}`,
								"TerminalManager",
							);
							return fallback;
						} else {
							throw new LauncherValidationError(
								`Binary at fallback path '${fallback}' is not the ghostty-launcher executable. ` +
									"Please install the correct ghostty-launcher binary.",
								fallback,
							);
						}
					}
					// If not accessible, continue to next fallback
				}
			}
		}

		// No valid launcher found anywhere
		const installInstructions =
			"Install ghostty-launcher from https://github.com/ostehost/ghostty-launcher " +
			"or set commandCentral.ghostty.launcherPath to the correct binary path.";

		throw new LauncherNotFoundError(
			`Ghostty Launcher not found. Searched paths: ${searchedPaths.join(", ")}. ${installInstructions}`,
			searchedPaths,
		);
	}

	/**
	 * Checks if a binary is accessible by attempting to run it with --help.
	 * Returns true if the binary exists (even if it exits non-zero).
	 * Returns false only if the binary cannot be found (ENOENT).
	 */
	private async isBinaryAccessible(binaryPath: string): Promise<boolean> {
		try {
			await this.execLauncher(binaryPath, ["--help"]);
			return true;
		} catch (err) {
			// ENOENT means the binary was not found at all
			if (
				err instanceof Error &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return false;
			}
			// Any other error (non-zero exit, timeout, etc.) — binary exists
			return true;
		}
	}

	/**
	 * Validates that a binary is actually the correct launcher executable.
	 * Runs `launcher --version` and checks if the output contains expected content.
	 * Caches validation results to avoid repeated checks.
	 */
	private async validateLauncherBinary(binaryPath: string): Promise<boolean> {
		// Check cache first
		if (this.launcherValidationCache.has(binaryPath)) {
			return this.launcherValidationCache.get(binaryPath) ?? false;
		}

		try {
			const { stdout } = await this.execLauncher(binaryPath, ["--version"]);

			// Expected output contains launcher version info
			// Look for keywords that indicate this is the ghostty-launcher
			const output = stdout.toLowerCase();
			const isValidLauncher =
				output.includes("launcher") ||
				output.includes("ghostty") ||
				output.includes("version");

			this.launcherValidationCache.set(binaryPath, isValidLauncher);

			if (!isValidLauncher) {
				this.logger.warn(
					`Binary at ${binaryPath} does not appear to be ghostty-launcher (--version output: ${stdout.trim()})`,
					"TerminalManager",
				);
			} else {
				this.logger.debug(
					`Validated launcher at ${binaryPath}: ${stdout.trim()}`,
					"TerminalManager",
				);
			}

			return isValidLauncher;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.warn(
				`Failed to validate launcher at ${binaryPath}: ${message}`,
				"TerminalManager",
			);

			// Cache negative result
			this.launcherValidationCache.set(binaryPath, false);
			return false;
		}
	}
}
