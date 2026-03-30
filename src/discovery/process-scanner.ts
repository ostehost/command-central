/**
 * ProcessScanner — Detect running CLI agent instances via `ps` + `lsof`.
 *
 * Scanning approach:
 *   1. `ps -eo pid,lstart,command` → find processes whose command hints at claude/codex/gemini
 *   2. Filter to actual CLI processes (skip electron helpers, renderer/gpu processes, etc.)
 *   3. `lsof -p PID -d cwd -Fn` → resolve working directory
 *   4. Parse command args for backend/model/session metadata used in UI detection
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { promisify } from "node:util";
import type { DiscoveredAgent } from "./types.js";
import { resolveWorktree } from "./worktree-resolver.js";

const defaultExecFileAsync = promisify(execFile);

/** Timeout for shell commands (ms) */
const CMD_TIMEOUT = 5_000;
const DEFAULT_STALE_PROCESS_AGE_MS = 4 * 60 * 60_000;
const DEFAULT_STALE_STREAM_THRESHOLD_MS = 10 * 60_000;
const TASK_START_MATCH_WINDOW_MS = 15 * 60_000;

/**
 * Regex hints used to identify supported agent CLIs.
 *
 * These cover direct binaries as well as common package-path invocations
 * (for example node/bun wrappers running package entrypoints).
 */
const CLAUDE_CLI_HINT_RE =
	/(?:^|\/)claude(?:\.js)?(?:\s|$)|\/claude-code\/|@anthropic-ai\/claude-code/i;
const CLI_TOKEN_PREFIX = String.raw`(?:^|[\s"'])`;
const CLI_TOKEN_SUFFIX = String.raw`(?=$|[\s"'])`;
const CODEX_CLI_HINT_RE = new RegExp(
	[
		// Direct executable token (for example: codex, /usr/local/bin/codex, codex-cli)
		`${CLI_TOKEN_PREFIX}(?:[^\\s"']*/)*codex(?:-cli)?(?:\\.js)?${CLI_TOKEN_SUFFIX}`,
		// Known npm package path invocations
		`${CLI_TOKEN_PREFIX}(?:[^\\s"']*/)*node_modules/@openai/codex(?:/[^\\s"']+)*${CLI_TOKEN_SUFFIX}`,
		// npx/pnpm dlx package-name token
		`${CLI_TOKEN_PREFIX}@openai/codex${CLI_TOKEN_SUFFIX}`,
	].join("|"),
	"i",
);
const GEMINI_CLI_HINT_RE = new RegExp(
	[
		// Direct executable token (for example: gemini, /usr/local/bin/gemini, gemini-cli)
		`${CLI_TOKEN_PREFIX}(?:[^\\s"']*/)*gemini(?:-cli)?(?:\\.js)?${CLI_TOKEN_SUFFIX}`,
		// Known npm package path invocations
		`${CLI_TOKEN_PREFIX}(?:[^\\s"']*/)*node_modules/@google/gemini-cli(?:/[^\\s"']+)*${CLI_TOKEN_SUFFIX}`,
		// npx/pnpm dlx package-name token
		`${CLI_TOKEN_PREFIX}@google/gemini-cli${CLI_TOKEN_SUFFIX}`,
	].join("|"),
	"i",
);
const AGENT_CLI_RE = new RegExp(
	[
		CLAUDE_CLI_HINT_RE.source,
		CODEX_CLI_HINT_RE.source,
		GEMINI_CLI_HINT_RE.source,
	].join("|"),
	"i",
);

const NOISE_RE = /electron|helper|renderer|gpu-process|crashpad|--type=/i;
const EXCLUDED_BINARY_RE = new RegExp(
	`${CLI_TOKEN_PREFIX}(?:[^\\s"']*/)*(?:terminal-notifier|osascript|notify-send)${CLI_TOKEN_SUFFIX}`,
	"i",
);
const SHELL_BINARY_RE = /^(?:-)?(?:bash|zsh|fish|sh|ksh|tcsh|csh|dash)$/i;

export type ProcessCommandKind = "agent" | "shell" | "other";

export interface ProcessCommandIdentity {
	kind: ProcessCommandKind;
	binaryName?: string;
}

type ExecFileFn = typeof defaultExecFileAsync;
type ResolveWorktreeFn = typeof resolveWorktree;
type NowProviderFn = () => number;

export interface LauncherTaskSnapshot {
	status?: string | null;
	pid?: number | null;
	session_id?: string | null;
	project_dir?: string | null;
	started_at?: string | null;
	stream_file?: string | null;
	agent_backend?: string | null;
	cli_name?: string | null;
}

export interface ProcessScannerOptions {
	launcherTasksProvider?: () => LauncherTaskSnapshot[];
	staleProcessAgeMs?: number;
	staleStreamThresholdMs?: number;
	nowProvider?: NowProviderFn;
}

export type ProcessScanFilterReason =
	| "excluded-binary"
	| "interactive-process"
	| "noise-process"
	| "shell-process"
	| "stale-process"
	| "cwd-unresolved"
	| "internal-tool-dir";

export interface ProcessScanDiagnosticEntry {
	pid: number;
	command: string;
	startTime: Date;
	binaryName?: string;
	projectDir?: string;
	reason?: ProcessScanFilterReason;
}

export interface ProcessScanDiagnostics {
	psRowCount: number;
	agentLikeCandidateCount: number;
	retained: ProcessScanDiagnosticEntry[];
	filtered: ProcessScanDiagnosticEntry[];
}

export class ProcessScanner {
	private execFileAsync: ExecFileFn;
	private resolveWorktreeFn: ResolveWorktreeFn;
	private launcherTasksProvider: () => LauncherTaskSnapshot[];
	private staleProcessAgeMs: number;
	private staleStreamThresholdMs: number;
	private nowProvider: NowProviderFn;
	private lastDiagnostics: ProcessScanDiagnostics = {
		psRowCount: 0,
		agentLikeCandidateCount: 0,
		retained: [],
		filtered: [],
	};

	constructor(
		execFileFn?: ExecFileFn,
		resolveWorktreeFn?: ResolveWorktreeFn,
		options?: ProcessScannerOptions,
	) {
		this.execFileAsync = execFileFn ?? defaultExecFileAsync;
		this.resolveWorktreeFn = resolveWorktreeFn ?? resolveWorktree;
		this.launcherTasksProvider = options?.launcherTasksProvider ?? (() => []);
		this.staleProcessAgeMs = Math.max(
			60_000,
			options?.staleProcessAgeMs ?? DEFAULT_STALE_PROCESS_AGE_MS,
		);
		this.staleStreamThresholdMs = Math.max(
			60_000,
			options?.staleStreamThresholdMs ?? DEFAULT_STALE_STREAM_THRESHOLD_MS,
		);
		this.nowProvider = options?.nowProvider ?? (() => Date.now());
	}

	/**
	 * Scan the process table for supported CLI agent instances.
	 * Returns one DiscoveredAgent per unique PID.
	 */
	async scan(): Promise<DiscoveredAgent[]> {
		const psLines = await this.getPsOutput();
		const candidates = this.parsePsOutput(psLines);
		const retained: ProcessScanDiagnosticEntry[] = [];
		const filtered = [...this.lastDiagnostics.filtered];

		// Resolve CWDs in parallel (bounded by candidate count, typically < 10)
		const results = await Promise.all(
			candidates.map(async (c) => {
				const lsofCwd = await this.getProcessCwd(c.pid);
				const explicitDir = this.extractExplicitProjectDir(c.command);
				const projectDir = explicitDir ?? lsofCwd;
				if (!projectDir) {
					filtered.push({
						pid: c.pid,
						command: c.command,
						startTime: c.startTime,
						binaryName: this.extractBinaryName(c.command),
						reason: "cwd-unresolved",
					});
					return null;
				}
				if (this.isInternalToolDir(projectDir)) {
					filtered.push({
						pid: c.pid,
						command: c.command,
						startTime: c.startTime,
						binaryName: this.extractBinaryName(c.command),
						projectDir,
						reason: "internal-tool-dir",
					});
					return null;
				}
				const meta = this.parseClaudeArgs(c.command);
				const worktree = await this.resolveWorktreeFn(projectDir);
				const agent: DiscoveredAgent = {
					pid: c.pid,
					projectDir,
					command: c.command,
					startTime: c.startTime,
					source: "process",
					worktree: worktree ?? undefined,
					...meta,
				};
				if (this.isStaleProcess(agent)) {
					filtered.push({
						pid: c.pid,
						command: c.command,
						startTime: c.startTime,
						binaryName: this.extractBinaryName(c.command),
						projectDir,
						reason: "stale-process",
					});
					return null;
				}
				retained.push({
					pid: c.pid,
					command: c.command,
					startTime: c.startTime,
					binaryName: this.extractBinaryName(c.command),
					projectDir,
				});
				return agent;
			}),
		);

		this.lastDiagnostics = {
			...this.lastDiagnostics,
			retained,
			filtered,
		};

		return results.filter((a): a is DiscoveredAgent => a !== null);
	}

	getLastDiagnostics(): ProcessScanDiagnostics {
		return {
			psRowCount: this.lastDiagnostics.psRowCount,
			agentLikeCandidateCount: this.lastDiagnostics.agentLikeCandidateCount,
			retained: [...this.lastDiagnostics.retained],
			filtered: [...this.lastDiagnostics.filtered],
		};
	}

	// ── Internal helpers ────────────────────────────────────────────────

	/** Run `ps` and return raw stdout */
	private async getPsOutput(): Promise<string> {
		try {
			const { stdout } = await this.execFileAsync(
				"ps",
				["-eo", "pid,lstart,command"],
				{ timeout: CMD_TIMEOUT },
			);
			return stdout;
		} catch {
			return "";
		}
	}

	/**
	 * Parse `ps -eo pid,lstart,command` output into candidate entries.
	 *
	 * lstart format: "Day Mon DD HH:MM:SS YYYY" (5 tokens).
	 * Example line:
	 *   12345 Mon Jan  6 14:03:22 2025 /usr/local/bin/claude --model opus ...
	 */
	parsePsOutput(
		raw: string,
	): Array<{ pid: number; startTime: Date; command: string }> {
		const diagnostics: ProcessScanDiagnostics = {
			psRowCount: 0,
			agentLikeCandidateCount: 0,
			retained: [],
			filtered: [],
		};
		const results: Array<{ pid: number; startTime: Date; command: string }> =
			[];

		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("PID")) continue;
			diagnostics.psRowCount += 1;

			// PID is the first token
			const pidMatch = trimmed.match(/^(\d+)\s+/);
			if (!pidMatch) continue;
			const pid = Number(pidMatch[1]);

			// lstart is 5 tokens after the PID
			const afterPid = trimmed.slice(pidMatch[0].length);
			const lstartMatch = afterPid.match(
				/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/,
			);
			if (!lstartMatch) continue;

			const startTimeStr = lstartMatch[1];
			const command = lstartMatch[2];
			if (!startTimeStr || !command) continue;

			const startTime = new Date(startTimeStr);

			// Filter: must look like a supported CLI agent command and not be noise
			if (!AGENT_CLI_RE.test(command)) continue;
			diagnostics.agentLikeCandidateCount += 1;

			const identity = classifyProcessCommand(command);
			const binaryName = identity.binaryName;
			if (EXCLUDED_BINARY_RE.test(command)) {
				diagnostics.filtered.push({
					pid,
					command,
					startTime,
					binaryName,
					reason: "excluded-binary",
				});
				continue;
			}
			if (identity.kind === "shell") {
				diagnostics.filtered.push({
					pid,
					command,
					startTime,
					binaryName,
					reason: "shell-process",
				});
				continue;
			}
			const backend = this.detectBackend(command);
			if (!backend || !this.isAgentModeProcess(command, backend)) {
				diagnostics.filtered.push({
					pid,
					command,
					startTime,
					binaryName,
					reason: "interactive-process",
				});
				continue;
			}
			if (NOISE_RE.test(command)) {
				diagnostics.filtered.push({
					pid,
					command,
					startTime,
					binaryName,
					reason: "noise-process",
				});
				continue;
			}

			results.push({ pid, startTime, command });
		}

		this.lastDiagnostics = diagnostics;
		return results;
	}

	/**
	 * Resolve the current working directory for a PID.
	 * macOS: `lsof -p PID -d cwd -Fn`
	 */
	async getProcessCwd(pid: number): Promise<string | null> {
		try {
			const { stdout } = await this.execFileAsync(
				"lsof",
				["-p", String(pid), "-d", "cwd", "-Fn"],
				{ timeout: CMD_TIMEOUT },
			);
			// lsof -Fn output: lines starting with 'n' contain the filename
			for (const line of stdout.split("\n")) {
				if (line.startsWith("n") && line.length > 1) {
					return line.slice(1);
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Extract metadata from agent command-line arguments.
	 */
	parseClaudeArgs(
		command: string,
	): Pick<
		DiscoveredAgent,
		"agent_backend" | "model" | "sessionId" | "cli_name"
	> {
		const result: Pick<
			DiscoveredAgent,
			"agent_backend" | "model" | "sessionId" | "cli_name"
		> = {};

		const backend = this.detectBackend(command);
		if (backend) {
			result.agent_backend = backend;
			result.cli_name = backend;
		}

		const modelMatch = command.match(
			/(?:--model(?:=|\s+)|\s-m\s+)([^\s"']+|"[^"]+"|'[^']+')/,
		);
		if (modelMatch?.[1]) {
			result.model = modelMatch[1].replace(/^['"]|['"]$/g, "");
		}

		const sessionMatch = command.match(/--session[_-]id(?:=|\s+)(\S+)/);
		if (sessionMatch?.[1]) result.sessionId = sessionMatch[1];

		// Also try --resume which takes a session id
		if (!result.sessionId) {
			const resumeMatch = command.match(/--resume(?:=|\s+)(\S+)/);
			if (resumeMatch?.[1]) result.sessionId = resumeMatch[1];
		}

		return result;
	}

	private detectBackend(
		command: string,
	): DiscoveredAgent["agent_backend"] | undefined {
		if (CLAUDE_CLI_HINT_RE.test(command)) return "claude";
		if (CODEX_CLI_HINT_RE.test(command)) return "codex";
		if (GEMINI_CLI_HINT_RE.test(command)) return "gemini";
		return undefined;
	}

	private extractBinaryName(command: string): string | undefined {
		return classifyProcessCommand(command).binaryName;
	}

	/**
	 * Extract an explicit project directory from the command string.
	 * Codex CLI uses `--cd <dir>` to specify the working project directory.
	 */
	extractExplicitProjectDir(command: string): string | null {
		const match = command.match(/--cd(?:=|\s+)(\S+)/);
		return match?.[1] ?? null;
	}

	/**
	 * Returns true if the given directory is inside a known internal tool path
	 * (e.g. ~/.claude/, ~/.codex/, ~/.config/).
	 */
	private isInternalToolDir(dir: string): boolean {
		const home = os.homedir();
		const internalPrefixes = [
			`${home}/.claude/`,
			`${home}/.codex/`,
			`${home}/.config/`,
		];
		return internalPrefixes.some(
			(prefix) => dir === prefix.slice(0, -1) || dir.startsWith(prefix),
		);
	}

	private isAgentModeProcess(
		command: string,
		backend: NonNullable<DiscoveredAgent["agent_backend"]>,
	): boolean {
		const invocation = parseAgentCliInvocation(command);
		if (!invocation || invocation.backend !== backend) return false;
		const args = invocation.args.map((arg) => arg.toLowerCase());
		switch (backend) {
			case "claude":
				return args.includes("-p") || args.includes("--print");
			case "codex":
			case "gemini":
				return (
					args[0] === "exec" ||
					args.includes("-p") ||
					args.includes("--print") ||
					args.includes("--prompt")
				);
			default:
				return false;
		}
	}

	private isStaleProcess(agent: DiscoveredAgent): boolean {
		const matchingTask = this.findMatchingLauncherTask(agent);
		if (matchingTask && matchingTask.status !== "running") {
			return true;
		}
		if (matchingTask?.status === "running") {
			if (this.isTaskStreamStale(matchingTask)) {
				return true;
			}
			if (this.hasRecentTaskStream(matchingTask)) {
				return false;
			}
		}

		return (
			this.nowProvider() - agent.startTime.getTime() >= this.staleProcessAgeMs
		);
	}

	private findMatchingLauncherTask(
		agent: DiscoveredAgent,
	): LauncherTaskSnapshot | null {
		for (const task of this.launcherTasksProvider()) {
			if (!task) continue;
			const taskPid =
				typeof task.pid === "number" && Number.isFinite(task.pid)
					? task.pid
					: null;
			if (taskPid !== null && taskPid === agent.pid) {
				return task;
			}

			if (
				task.session_id &&
				agent.sessionId &&
				task.session_id === agent.sessionId
			) {
				return task;
			}

			if (!task.project_dir || task.project_dir !== agent.projectDir) {
				continue;
			}

			const taskBackend = normalizeBackendHint(
				task.agent_backend ?? task.cli_name ?? undefined,
			);
			if (
				taskBackend &&
				agent.agent_backend &&
				taskBackend !== agent.agent_backend
			) {
				continue;
			}

			const taskStartedAtMs = new Date(task.started_at ?? "").getTime();
			const agentStartedAtMs = agent.startTime.getTime();
			if (
				!Number.isFinite(taskStartedAtMs) ||
				!Number.isFinite(agentStartedAtMs)
			) {
				continue;
			}

			if (
				Math.abs(taskStartedAtMs - agentStartedAtMs) <=
				TASK_START_MATCH_WINDOW_MS
			) {
				return task;
			}
		}

		return null;
	}

	private hasRecentTaskStream(task: LauncherTaskSnapshot): boolean {
		const mtimeMs = this.getTaskStreamMtime(task);
		if (mtimeMs === null) return false;
		return this.nowProvider() - mtimeMs < this.staleStreamThresholdMs;
	}

	private isTaskStreamStale(task: LauncherTaskSnapshot): boolean {
		const mtimeMs = this.getTaskStreamMtime(task);
		if (mtimeMs === null) return false;
		return this.nowProvider() - mtimeMs >= this.staleStreamThresholdMs;
	}

	private getTaskStreamMtime(task: LauncherTaskSnapshot): number | null {
		if (!task.stream_file) return null;
		try {
			return fs.statSync(task.stream_file).mtimeMs;
		} catch {
			return null;
		}
	}
}

export function classifyProcessCommand(
	command: string,
): ProcessCommandIdentity {
	const binaryName = extractCommandBinaryName(command);
	if (binaryName && SHELL_BINARY_RE.test(binaryName)) {
		return { kind: "shell", binaryName };
	}
	if (AGENT_CLI_RE.test(command)) {
		return { kind: "agent", binaryName };
	}
	return { kind: "other", binaryName };
}

function extractCommandBinaryName(command: string): string | undefined {
	const [token] = command.trim().split(/\s+/, 1);
	if (!token) return undefined;
	const unquoted = token.replace(/^['"]|['"]$/g, "");
	return unquoted.split("/").at(-1) ?? unquoted;
}

type AgentCliInvocation = {
	backend: NonNullable<DiscoveredAgent["agent_backend"]>;
	args: string[];
};

function parseAgentCliInvocation(command: string): AgentCliInvocation | null {
	const tokens = tokenizeCommand(command);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		const backend = detectBackendFromToken(token);
		if (!backend) continue;
		return {
			backend,
			args: tokens.slice(index + 1).map((token) => stripMatchingQuotes(token)),
		};
	}
	return null;
}

function tokenizeCommand(command: string): string[] {
	return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripMatchingQuotes(token: string): string {
	return token.replace(/^(['"])(.*)\1$/s, "$2");
}

function detectBackendFromToken(
	token: string,
): NonNullable<DiscoveredAgent["agent_backend"]> | null {
	const normalized = stripMatchingQuotes(token);
	const basename = normalized.split("/").at(-1)?.toLowerCase() ?? "";
	const lower = normalized.toLowerCase();

	if (
		basename === "claude" ||
		basename === "claude.js" ||
		lower.includes("/claude-code/") ||
		lower === "@anthropic-ai/claude-code"
	) {
		return "claude";
	}
	if (
		basename === "codex" ||
		basename === "codex.js" ||
		basename === "codex-cli" ||
		basename === "codex-cli.js" ||
		lower.includes("node_modules/@openai/codex") ||
		lower === "@openai/codex"
	) {
		return "codex";
	}
	if (
		basename === "gemini" ||
		basename === "gemini.js" ||
		basename === "gemini-cli" ||
		basename === "gemini-cli.js" ||
		lower.includes("node_modules/@google/gemini-cli") ||
		lower === "@google/gemini-cli"
	) {
		return "gemini";
	}

	return null;
}

function normalizeBackendHint(
	value: string | undefined,
): DiscoveredAgent["agent_backend"] | undefined {
	if (!value) return undefined;
	const lower = value.toLowerCase();
	if (lower.includes("claude")) return "claude";
	if (lower.includes("codex") || lower.includes("openai")) return "codex";
	if (lower.includes("gemini") || lower.includes("google")) return "gemini";
	return undefined;
}
