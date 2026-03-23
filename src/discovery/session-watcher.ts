/**
 * SessionWatcher — Watch ~/.claude/sessions/ for active Claude Code sessions.
 *
 * Claude Code writes session state to ~/.claude/sessions/<PID>.json:
 *   { pid: number, sessionId: string, cwd: string, startedAt: number }
 *
 * This watcher monitors that directory for new/changed files, parses
 * the JSON, and emits discovered agents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
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

export class SessionWatcher implements vscode.Disposable {
	private watcher: fs.FSWatcher | null = null;
	private agents = new Map<number, DiscoveredAgent>();
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
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const session = JSON.parse(content) as ClaudeSessionFile;

			if (!this.isValidSession(session)) return;

			// Check if the process is still alive
			if (!this.isProcessAlive(session.pid)) {
				if (this.agents.has(session.pid)) {
					this.agents.delete(session.pid);
					this.onChange?.();
				}
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
			if (changed) this.onChange?.();
		} catch {
			// Invalid JSON or file disappeared — ignore
		}
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
}
