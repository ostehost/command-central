/**
 * SessionWatcher — Watch ~/.claude/sessions/ for active Claude Code sessions.
 *
 * Claude Code writes session state to ~/.claude/sessions/<PID>.json:
 *   { pid: number, sessionId: string, cwd: string, startedAt: number }
 *
 * This watcher monitors that directory for new/changed files, parses
 * the JSON, and emits discovered agents.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { classifyProcessCommand } from "./process-scanner.js";

/** Matches agent-mode invocations: -p, --print, exec subcommand, --prompt */
const AGENT_MODE_RE =
	/(?:\s|^)(?:-p|--print|exec\s|--prompt(?:\s|=)|--resume(?:\s|=|$))/i;

import type { DiscoveredAgent } from "./types.js";

/** Shape of ~/.claude/sessions/<PID>.json */
export interface ClaudeSessionFile {
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
}

/** Default session directory */
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const PROCESS_LOOKUP_TIMEOUT = 1_000;

export class SessionWatcher implements vscode.Disposable {
	private watcher: fs.FSWatcher | null = null;
	private agents = new Map<number, DiscoveredAgent>();
	/** filename -> last PID parsed from it, so a delete event can evict the agent */
	private filenamePids = new Map<string, number>();
	private onChange: (() => void) | null = null;
	private readonly sessionsDir: string;

	constructor(sessionsDir?: string) {
		this.sessionsDir = sessionsDir ?? SESSIONS_DIR;
	}

	/** Start watching. Call `onDidChange` to subscribe to updates. */
	start(onChange?: () => void): void {
		this.onChange = onChange ?? null;
		this.doFullScan();
		this.startWatching();
	}

	/** Current set of discovered agents from session files */
	getAgents(): DiscoveredAgent[] {
		return Array.from(this.agents.values());
	}

	/** Subscribe to change events (alternative to constructor callback) */
	setOnChange(callback: () => void): void {
		this.onChange = callback;
	}

	dispose(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.agents.clear();
		this.filenamePids.clear();
	}

	// ── Internal ────────────────────────────────────────────────────────

	/** Read all existing session files */
	private doFullScan(): void {
		try {
			const files = fs.readdirSync(this.sessionsDir);
			for (const file of files) {
				if (file.endsWith(".json")) {
					this.processFile(file);
				}
			}
		} catch {
			// Directory may not exist yet — that's fine
		}
	}

	private startWatching(): void {
		try {
			this.watcher = fs.watch(this.sessionsDir, (_event, filename) => {
				if (filename?.endsWith(".json")) {
					this.processFile(filename);
				}
			});
			this.watcher.on("error", () => {
				// Silently ignore — directory may be removed/recreated
			});
		} catch {
			// Directory doesn't exist — ok, will miss updates until restart
		}
	}

	/** Parse a single session JSON file */
	private processFile(filename: string): void {
		const filePath = path.join(this.sessionsDir, filename);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			// File was removed (ENOENT) — evict the agent it produced.
			// Other read errors (e.g. permissions) are left to settle on rescan.
			if (this.isMissingFileError(err)) this.evictByFilename(filename);
			return;
		}

		let session: ClaudeSessionFile;
		try {
			session = JSON.parse(content) as ClaudeSessionFile;
		} catch {
			// Transient malformed JSON (e.g. partial write) — preserve last value.
			return;
		}

		if (!this.isValidSession(session)) return;

		// Check if the process is still alive
		if (!this.isProcessAlive(session.pid)) {
			this.evictAgent(filename, session.pid);
			return;
		}
		if (!this.isAgentProcess(session.pid)) {
			this.evictAgent(filename, session.pid);
			return;
		}

		const agent: DiscoveredAgent = {
			pid: session.pid,
			projectDir: session.cwd,
			command: "",
			startTime: new Date(session.startedAt),
			sessionId: session.sessionId,
			source: "session-file",
		};

		const existing = this.agents.get(session.pid);
		const changed =
			!existing ||
			existing.projectDir !== agent.projectDir ||
			existing.sessionId !== agent.sessionId;

		this.agents.set(session.pid, agent);
		this.filenamePids.set(filename, session.pid);
		if (changed) this.onChange?.();
	}

	/** Remove a cached agent (by known PID) and its filename index entry. */
	private evictAgent(filename: string, pid: number): void {
		this.filenamePids.delete(filename);
		if (this.agents.has(pid)) {
			this.agents.delete(pid);
			this.onChange?.();
		}
	}

	/** Evict the agent produced by a now-missing file using the filename index. */
	private evictByFilename(filename: string): void {
		const pid = this.filenamePids.get(filename);
		if (pid === undefined) return;
		this.evictAgent(filename, pid);
	}

	/** True when an error reflects a missing file (deleted between events). */
	private isMissingFileError(err: unknown): boolean {
		if (this.errnoCode(err) === "ENOENT") return true;
		// Fallback for environments that surface ENOENT via the message only.
		return err instanceof Error && err.message.includes("ENOENT");
	}

	private errnoCode(err: unknown): string | undefined {
		if (!err || typeof err !== "object") return undefined;
		const code = (err as Record<string, unknown>)["code"];
		return typeof code === "string" ? code : undefined;
	}

	/** Minimal validation of session file shape */
	private isValidSession(s: unknown): s is ClaudeSessionFile {
		if (!s || typeof s !== "object") return false;
		const obj = s as Record<string, unknown>;
		return (
			typeof obj["pid"] === "number" &&
			typeof obj["cwd"] === "string" &&
			typeof obj["startedAt"] === "number"
		);
	}

	/** Check if a PID is still running */
	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	private isAgentProcess(pid: number): boolean {
		const command = this.getProcessCommand(pid);
		if (!command) {
			// If `ps` is unavailable, keep the session file rather than over-pruning.
			return true;
		}
		const identity = classifyProcessCommand(command);
		if (identity.kind !== "agent") return false;

		// Ensure the process is in agent mode (e.g. claude -p/--print, codex exec)
		// rather than an interactive CLI session that merely matches the binary.
		// Interactive sessions (bare `claude`, `codex` without exec) should be excluded.
		return AGENT_MODE_RE.test(command);
	}

	private getProcessCommand(pid: number): string | null {
		try {
			const stdout = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
				encoding: "utf-8",
				timeout: PROCESS_LOOKUP_TIMEOUT,
			});
			for (const line of stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					return trimmed;
				}
			}
			return null;
		} catch {
			return null;
		}
	}
}
