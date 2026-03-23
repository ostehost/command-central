/**
 * ProcessScanner — Detect running Claude Code instances via `ps` + `lsof`.
 *
 * Scanning approach:
 *   1. `ps -eo pid,lstart,command` → find processes whose command contains "claude"
 *   2. Filter to actual Claude Code CLIs (skip electron helpers, node children, etc.)
 *   3. `lsof -p PID -d cwd -Fn` → resolve working directory
 *   4. Parse command args for --model, --session-id, etc.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiscoveredAgent } from "./types.js";

const execFileAsync = promisify(execFile);

/** Timeout for shell commands (ms) */
const CMD_TIMEOUT = 5_000;

/**
 * Regex to identify a genuine Claude Code CLI process.
 * Matches lines like:
 *   /usr/local/bin/claude --print ...
 *   claude --permission-mode ...
 *   node /path/to/claude ...  (when run via npx/bunx)
 *
 * Rejects electron/helper/renderer processes.
 */
const CLAUDE_CLI_RE =
	/(?:^|\/)claude(?:\.js)?\s|\/claude-code\//i;

const NOISE_RE =
	/electron|helper|renderer|gpu-process|crashpad|--type=/i;

export class ProcessScanner {
	/**
	 * Scan the process table for Claude Code instances.
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
				const agent: DiscoveredAgent = {
					pid: c.pid,
					projectDir,
					command: c.command,
					startTime: c.startTime,
					source: "process",
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
			const { stdout } = await execFileAsync(
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

			// Filter: must look like Claude Code, must not be noise
			if (!CLAUDE_CLI_RE.test(command)) continue;
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
			const { stdout } = await execFileAsync(
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
	 * Extract metadata from Claude Code command-line arguments.
	 */
	parseClaudeArgs(
		command: string,
	): Pick<DiscoveredAgent, "model" | "sessionId"> {
		const result: Pick<DiscoveredAgent, "model" | "sessionId"> = {};

		const modelMatch = command.match(/--model\s+(\S+)/);
		if (modelMatch) result.model = modelMatch[1];

		const sessionMatch = command.match(/--session[_-]id\s+(\S+)/);
		if (sessionMatch) result.sessionId = sessionMatch[1];

		// Also try --resume which takes a session id
		if (!result.sessionId) {
			const resumeMatch = command.match(/--resume\s+(\S+)/);
			if (resumeMatch) result.sessionId = resumeMatch[1];
		}

		return result;
	}
}
