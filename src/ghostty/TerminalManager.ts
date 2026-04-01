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
import { ProjectIconManager } from "../services/project-icon-manager.js";

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

/**
 * Default fallback paths to check when launcher is not in PATH.
 * Includes common local dev checkout locations.
 */
const LAUNCHER_FALLBACK_PATHS: string[] = [
	path.join(os.homedir(), "projects", "ghostty-launcher", "launcher"),
	path.join(os.homedir(), "ghostty-launcher", "launcher"),
];

/** Timeout in milliseconds for launcher subprocess calls */
const LAUNCHER_TIMEOUT_MS = 10_000;
const AUTO_DETECTED_LAUNCHER_PATH_KEY =
	"commandCentral.ghostty.autoDetectedLauncherPath";

export interface TerminalInfo {
	name: string;
	icon: string;
	tmuxSession: string;
}

export interface ProjectIconEnsurer {
	ensureProjectIconPersisted(projectDir: string): Promise<string>;
}

export class TerminalManager {
	private readonly logger: LoggerService;
	private readonly projectIconEnsurer: ProjectIconEnsurer;
	private readonly globalState: vscode.Memento | undefined;
	private launcherValidationCache = new Map<string, boolean>();

	constructor(
		logger: LoggerService,
		projectIconEnsurer: ProjectIconEnsurer = new ProjectIconManager(),
		globalState?: vscode.Memento,
	) {
		this.logger = logger;
		this.projectIconEnsurer = projectIconEnsurer;
		this.globalState = globalState;
	}

	/**
	 * Returns the resolved path to the launcher binary.
	 * Checks (in order):
	 *   1. commandCentral.ghostty.launcherPath setting
	 *   2. `launcher` on PATH
	 *   3. Common local fallback paths (for example ~/projects/ghostty-launcher/launcher)
	 */
	getLauncherPath(): string {
		return this.getLauncherPathDetails().requestedPath;
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
		await this.projectIconEnsurer.ensureProjectIconPersisted(workspaceRoot);

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
	 * Opens/activates the project's Ghostty bundle launch surface.
	 * Runs: launcher <dir>
	 */
	private async openProjectTerminal(workspaceRoot: string): Promise<void> {
		this.logger.info(
			`Opening project terminal for: ${workspaceRoot}`,
			"TerminalManager",
		);

		const launcher = await this.resolvedLauncherPath();
		const { stdout, stderr } = await this.execLauncher(launcher, [
			workspaceRoot,
		]);

		if (stdout.trim()) {
			this.logger.debug(`launcher output: ${stdout.trim()}`, "TerminalManager");
		}
		if (stderr.trim()) {
			this.logger.warn(`launcher stderr: ${stderr.trim()}`, "TerminalManager");
		}
	}

	/**
	 * Retrieves terminal info (name, icon, tmux session) for the given workspace root.
	 * Runs --parse-name, --parse-icon, and --session-id in parallel.
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
			this.execLauncher(launcher, ["--session-id", workspaceRoot]),
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
			this.logCommandFailure("--session-id", error);
		}

		return { name, icon, tmuxSession };
	}

	async resolveLauncherHelperScriptPath(scriptName: string): Promise<string> {
		if (!/^[a-z0-9][a-z0-9.-]*\.sh$/i.test(scriptName)) {
			throw new Error(`Invalid launcher helper script name: ${scriptName}`);
		}

		const launcherPath = await this.resolvedLauncherPath();
		const scriptCandidates = this.getHelperScriptSearchDirs(launcherPath).map(
			(dir) => path.join(dir, scriptName),
		);

		for (const scriptPath of scriptCandidates) {
			if (fs.existsSync(scriptPath)) {
				return scriptPath;
			}
		}

		throw new Error(
			`Launcher helper script not found: ${scriptName}. Searched: ${scriptCandidates.join(", ")}. Check your launcher installation.`,
		);
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

			if (
				(error as NodeJS.ErrnoException & { signal?: string }).signal ===
					"SIGKILL" ||
				error.code === "TIMEOUT"
			) {
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
		const primaryDetails = this.getLauncherPathDetails();
		const primary = primaryDetails.requestedPath;
		const primaryCandidate = this.resolveBinaryPath(primary) ?? primary;
		const searchedPaths: string[] =
			primaryCandidate === primary ? [primary] : [primary, primaryCandidate];
		const primaryLabel =
			primaryDetails.source === "configured"
				? "configured"
				: primaryDetails.source === "cached"
					? "cached"
					: "default";

		this.logger.debug(
			`Resolving launcher path from ${primaryLabel} candidate: ${primaryCandidate}`,
			"TerminalManager",
		);

		// Check if configured/PATH launcher is accessible
		const primaryAccessible = await this.isBinaryAccessible(primaryCandidate);
		this.logger.debug(
			`Launcher candidate accessible=${String(primaryAccessible)} path=${primaryCandidate}`,
			"TerminalManager",
		);

		if (primaryAccessible) {
			// Binary exists, now validate it's the correct one
			if (await this.validateLauncherBinary(primaryCandidate)) {
				await this.cacheAutoDetectedLauncherPath(
					primaryCandidate,
					primaryDetails.source,
				);
				return primaryCandidate;
			}

			if (primaryDetails.source === "configured") {
				throw new LauncherValidationError(
					`Binary at '${primaryCandidate}' is not the ghostty-launcher executable. ` +
						"Please check your commandCentral.ghostty.launcherPath setting or install the correct launcher binary.",
					primaryCandidate,
				);
			}

			this.logger.warn(
				`Ignoring invalid ${primaryLabel} launcher candidate and continuing search: ${primaryCandidate}`,
				"TerminalManager",
			);
			if (primaryDetails.source === "cached") {
				await this.clearAutoDetectedLauncherPath();
			}
		} else if (primaryDetails.source === "cached") {
			this.logger.warn(
				`Cached launcher path is no longer accessible: ${primaryCandidate}`,
				"TerminalManager",
			);
			await this.clearAutoDetectedLauncherPath();
		}

		// Primary not found/accessible, try fallback paths when the user has not explicitly configured a path
		if (primaryDetails.source !== "configured") {
			for (const fallback of LAUNCHER_FALLBACK_PATHS) {
				searchedPaths.push(fallback);
				this.logger.debug(
					`Checking fallback launcher path: ${fallback}`,
					"TerminalManager",
				);
				if (fs.existsSync(fallback)) {
					// Check if fallback is accessible and valid
					if (await this.isBinaryAccessible(fallback)) {
						if (await this.validateLauncherBinary(fallback)) {
							await this.cacheAutoDetectedLauncherPath(
								fallback,
								primaryDetails.source,
							);
							this.logger.info(
								`Using fallback launcher path: ${fallback}`,
								"TerminalManager",
							);
							return fallback;
						}

						this.logger.warn(
							`Ignoring invalid fallback launcher binary: ${fallback}`,
							"TerminalManager",
						);
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

	private resolveBinaryPath(binary: string): string | null {
		if (!binary) {
			return null;
		}

		if (path.isAbsolute(binary) || binary.includes(path.sep)) {
			const candidate = path.resolve(binary);
			return fs.existsSync(candidate) ? candidate : null;
		}

		const pathEnv = process.env["PATH"];
		if (!pathEnv) {
			return null;
		}

		for (const entry of pathEnv.split(path.delimiter)) {
			if (!entry) {
				continue;
			}
			const candidate = path.join(entry, binary);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}

		return null;
	}

	private getLauncherPathDetails(): {
		requestedPath: string;
		source: "configured" | "cached" | "default";
	} {
		const configured = this.getConfiguredLauncherPath();
		if (configured) {
			return { requestedPath: configured, source: "configured" };
		}

		const cached = this.getCachedLauncherPath();
		if (cached) {
			return { requestedPath: cached, source: "cached" };
		}

		return { requestedPath: "launcher", source: "default" };
	}

	private getConfiguredLauncherPath(): string | null {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const configured = config.get<string>("ghostty.launcherPath");
		const trimmed = configured?.trim();
		return trimmed ? trimmed : null;
	}

	private getCachedLauncherPath(): string | null {
		const cached = this.globalState?.get<string>(
			AUTO_DETECTED_LAUNCHER_PATH_KEY,
		);
		const trimmed = cached?.trim();
		return trimmed ? trimmed : null;
	}

	private async cacheAutoDetectedLauncherPath(
		launcherPath: string,
		source: "configured" | "cached" | "default",
	): Promise<void> {
		if (!this.globalState || source === "configured") {
			return;
		}

		if (this.getCachedLauncherPath() === launcherPath) {
			return;
		}

		await this.globalState.update(
			AUTO_DETECTED_LAUNCHER_PATH_KEY,
			launcherPath,
		);
		this.logger.debug(
			`Cached auto-detected launcher path: ${launcherPath}`,
			"TerminalManager",
		);
	}

	private async clearAutoDetectedLauncherPath(): Promise<void> {
		if (!this.globalState || !this.getCachedLauncherPath()) {
			return;
		}

		await this.globalState.update(AUTO_DETECTED_LAUNCHER_PATH_KEY, undefined);
		this.logger.debug("Cleared stale cached launcher path", "TerminalManager");
	}

	private getHelperScriptSearchDirs(launcherPath: string): string[] {
		const launcherDir = path.dirname(launcherPath);
		const parentDir = path.dirname(launcherDir);
		const candidates = [
			path.join(launcherDir, "scripts"),
			path.basename(launcherDir) === "scripts" ? launcherDir : null,
			path.join(parentDir, "scripts"),
			...LAUNCHER_FALLBACK_PATHS.map((fallback) =>
				path.join(path.dirname(fallback), "scripts"),
			),
		];

		return [
			...new Set(candidates.filter((value): value is string => Boolean(value))),
		];
	}

	/**
	 * Routes a command through the project's Ghostty terminal.
	 *
	 * 1. If launcher is installed: gets launcher session ID, sends command via oste-steer.sh
	 *    or creates a new project terminal if no session exists.
	 * 2. If launcher is NOT installed: falls back to vscode.window.createTerminal().
	 *
	 * @param projectDir - The project directory (used to look up the tmux session)
	 * @param command - Optional shell command to execute in the terminal
	 * @param cwd - Optional working directory override (defaults to projectDir)
	 */
	async runInProjectTerminal(
		projectDir: string,
		command?: string,
		cwd?: string,
	): Promise<void> {
		try {
			const installed = await this.isLauncherInstalled();

			if (!installed) {
				this.logger.warn(
					"Ghostty launcher not installed — falling back to integrated terminal",
					"TerminalManager",
				);
				this.openIntegratedTerminal(projectDir, command, cwd);
				return;
			}

			// Try to find existing launcher session for the project
			const info = await this.getTerminalInfo(projectDir);

			if (info.tmuxSession && command) {
				// Send command to existing launcher session via oste-steer.sh
				try {
					await this.execCommand("oste-steer.sh", [
						info.tmuxSession,
						"--raw",
						command,
					]);
					this.logger.info(
						`Sent command to launcher session ${info.tmuxSession}`,
						"TerminalManager",
					);
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.logger.warn(
						`Failed to steer launcher session: ${message} — creating new terminal`,
						"TerminalManager",
					);
				}
			}

			if (info.tmuxSession && !command) {
				// Existing session, no command: surface the project bundle terminal.
				await this.openProjectTerminal(projectDir);
				return;
			}

			// No session: rebuild bundle identity, then open/activate launch surface.
			await this.createProjectTerminal(projectDir);
			await this.openProjectTerminal(projectDir);

			// If we just created a terminal and have a command, wait briefly then steer
			if (command) {
				// Re-fetch session info after terminal creation
				await new Promise((resolve) => setTimeout(resolve, 1500));
				try {
					const newInfo = await this.getTerminalInfo(projectDir);
					if (newInfo.tmuxSession) {
						await this.execCommand("oste-steer.sh", [
							newInfo.tmuxSession,
							"--raw",
							command,
						]);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.logger.warn(
						`Failed to send command after terminal creation: ${message}`,
						"TerminalManager",
					);
				}
			}
		} catch (error) {
			if (
				error instanceof LauncherNotFoundError ||
				error instanceof LauncherValidationError
			) {
				this.logger.warn(
					`${error.message} Falling back to VS Code integrated terminal.`,
					"TerminalManager",
				);
				this.openIntegratedTerminal(projectDir, command, cwd);
				return;
			}
			throw error;
		}
	}

	/**
	 * Executes an arbitrary command (not the launcher) via child_process.
	 * Used for oste-steer.sh and similar utilities.
	 */
	private async execCommand(
		binary: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);

		return await execFileAsync(binary, args, {
			timeout: LAUNCHER_TIMEOUT_MS,
		});
	}

	/**
	 * Checks if a binary exists on disk and is executable.
	 */
	private async isBinaryAccessible(binaryPath: string): Promise<boolean> {
		const resolved = this.resolveBinaryPath(binaryPath);
		if (resolved) {
			try {
				fs.accessSync(resolved, fs.constants.X_OK);
				return true;
			} catch {
				return false;
			}
		}

		if (path.isAbsolute(binaryPath) || binaryPath.includes(path.sep)) {
			const candidate = path.resolve(binaryPath);
			if (!fs.existsSync(candidate)) {
				return false;
			}
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return true;
			} catch {
				return false;
			}
		}

		try {
			await this.execLauncher(binaryPath, ["--help"]);
			return true;
		} catch (err) {
			if (
				err instanceof LauncherNotFoundError ||
				(err instanceof Error &&
					(err as NodeJS.ErrnoException).code === "ENOENT")
			) {
				return false;
			}
			// Any other error (non-zero exit, timeout, etc.) — binary exists
			return true;
		}
	}

	private openIntegratedTerminal(
		projectDir: string,
		command?: string,
		cwd?: string,
	): void {
		const terminal = vscode.window.createTerminal({
			name: `Terminal: ${path.basename(projectDir)}`,
			cwd: cwd ?? projectDir,
		});
		if (command) {
			terminal.sendText(command);
		}
		terminal.show();
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
			// Look for launcher-identifying keywords or a plain semver string.
			const output = stdout.trim().toLowerCase();
			const isValidLauncher =
				output.includes("launcher") ||
				output.includes("ghostty") ||
				output.includes("version") ||
				/v?\d+\.\d+\.\d+/.test(output);

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
