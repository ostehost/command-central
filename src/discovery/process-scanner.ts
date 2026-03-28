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
import { promisify } from "node:util";
import type { DiscoveredAgent } from "./types.js";
import { resolveWorktree } from "./worktree-resolver.js";

const defaultExecFileAsync = promisify(execFile);

/** Timeout for shell commands (ms) */
const CMD_TIMEOUT = 5_000;

/**
 * Regex hints used to identify supported agent CLIs.
 *
 * These cover direct binaries as well as common package-path invocations
 * (for example node/bun wrappers running package entrypoints).
 */
const CLAUDE_CLI_HINT_RE =
	/(?:^|\/)claude(?:\.js)?(?:\s|$)|\/claude-code\/|@anthropic-ai\/claude-code/i;
const CODEX_CLI_HINT_RE =
	/(?:^|\/)codex(?:\.js)?(?:\s|$)|\/codex(?:-cli)?\/|@openai\/codex/i;
const GEMINI_CLI_HINT_RE =
	/(?:^|\/)gemini(?:\.js)?(?:\s|$)|\/gemini(?:-cli)?\/|@google\/gemini-cli/i;
const AGENT_CLI_RE = new RegExp(
	[
		CLAUDE_CLI_HINT_RE.source,
		CODEX_CLI_HINT_RE.source,
		GEMINI_CLI_HINT_RE.source,
	].join("|"),
	"i",
);

const NOISE_RE = /electron|helper|renderer|gpu-process|crashpad|--type=/i;

type ExecFileFn = typeof defaultExecFileAsync;
type ResolveWorktreeFn = typeof resolveWorktree;

export class ProcessScanner {
	private execFileAsync: ExecFileFn;
	private resolveWorktreeFn: ResolveWorktreeFn;

	constructor(execFileFn?: ExecFileFn, resolveWorktreeFn?: ResolveWorktreeFn) {
		this.execFileAsync = execFileFn ?? defaultExecFileAsync;
		this.resolveWorktreeFn = resolveWorktreeFn ?? resolveWorktree;
	}

	/**
	 * Scan the process table for supported CLI agent instances.
	 * Returns one DiscoveredAgent per unique PID.
	 */
	async scan(): Promise<DiscoveredAgent[]> {
		const psLines = await this.getPsOutput();
		const candidates = this.parsePsOutput(psLines);

		// Resolve CWDs in parallel (bounded by candidate count, typically < 10)
		const results = await Promise.all(
			candidates.map(async (c) => {
				const projectDir = await this.getProcessCwd(c.pid);
				if (!projectDir) return null;
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
				return agent;
			}),
		);

		return results.filter((a): a is DiscoveredAgent => a !== null);
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
		const results: Array<{ pid: number; startTime: Date; command: string }> =
			[];

		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("PID")) continue;

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
			if (NOISE_RE.test(command)) continue;

			results.push({ pid, startTime, command });
		}

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
}
