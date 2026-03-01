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
	 * Checks whether the launcher binary is accessible.
	 * First tries the configured/PATH launcher, then fallback paths.
	 */
	async isLauncherInstalled(): Promise<boolean> {
		// Try configured path / PATH
		const primary = this.getLauncherPath();
		if (await this.isBinaryAccessible(primary)) {
			return true;
		}

		// Try known fallback paths
		for (const fallback of LAUNCHER_FALLBACK_PATHS) {
			if (fs.existsSync(fallback)) {
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
		const launcher = await this.resolvedLauncherPath();
		this.logger.info(
			`Creating project terminal for: ${workspaceRoot}`,
			"TerminalManager",
		);

		try {
			const { stdout, stderr } = await this.execLauncher(launcher, [
				"--create-bundle",
				workspaceRoot,
			]);

			if (stdout.trim()) {
				this.logger.debug(
					`launcher output: ${stdout.trim()}`,
					"TerminalManager",
				);
			}
			if (stderr.trim()) {
				this.logger.warn(
					`launcher stderr: ${stderr.trim()}`,
					"TerminalManager",
				);
			}

			this.logger.info(
				"Project terminal created successfully",
				"TerminalManager",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error(
				`Failed to create project terminal: ${message}`,
				err instanceof Error ? err : undefined,
				"TerminalManager",
			);
			throw new Error(`launcher --create-bundle failed: ${message}`);
		}
	}

	/**
	 * Retrieves terminal info (name, icon, tmux session) for the given workspace root.
	 * Runs --parse-name, --parse-icon, and --tmux-session in parallel.
	 */
	async getTerminalInfo(workspaceRoot: string): Promise<TerminalInfo> {
		const launcher = await this.resolvedLauncherPath();
		this.logger.debug(
			`Getting terminal info for: ${workspaceRoot}`,
			"TerminalManager",
		);

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

		if (nameResult.status === "rejected") {
			this.logger.warn(
				`--parse-name failed: ${nameResult.reason instanceof Error ? nameResult.reason.message : String(nameResult.reason)}`,
				"TerminalManager",
			);
		}
		if (iconResult.status === "rejected") {
			this.logger.warn(
				`--parse-icon failed: ${iconResult.reason instanceof Error ? iconResult.reason.message : String(iconResult.reason)}`,
				"TerminalManager",
			);
		}
		if (tmuxResult.status === "rejected") {
			this.logger.warn(
				`--tmux-session failed: ${tmuxResult.reason instanceof Error ? tmuxResult.reason.message : String(tmuxResult.reason)}`,
				"TerminalManager",
			);
		}

		return { name, icon, tmuxSession };
	}

	/**
	 * Runs the launcher binary with the given args, returning { stdout, stderr }.
	 * Exposed for testing — override to inject mock behavior.
	 */
	async execLauncher(
		launcher: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		return execFileAsync(launcher, args, { timeout: LAUNCHER_TIMEOUT_MS });
	}

	/**
	 * Resolves the launcher path, preferring fallback paths if the configured
	 * name is "launcher" and a known path exists on disk.
	 */
	private async resolvedLauncherPath(): Promise<string> {
		const primary = this.getLauncherPath();

		// If primary is an absolute path or custom value, use it directly
		if (path.isAbsolute(primary) || primary !== "launcher") {
			return primary;
		}

		// Try fallback paths when using the default "launcher" name
		for (const fallback of LAUNCHER_FALLBACK_PATHS) {
			if (fs.existsSync(fallback)) {
				return fallback;
			}
		}

		return primary;
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
}
