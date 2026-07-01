import { execFileSync } from "node:child_process";
import type { AgentTask } from "../types/agent-task.js";
import {
	inspectTmuxPaneAgent,
	inspectTmuxPaneById,
	type TmuxPaneAgentEvidence,
} from "../utils/tmux-pane-health.js";

const CACHE_TTL_MS = 5_000;

/**
 * Owns tmux-backed liveness probing (`has-session`, `list-windows`, pane
 * inspection) and its 5s-TTL caches. Extracted from AgentStatusTreeProvider
 * so runtime-health checks can be tested and reasoned about independently of
 * tree rendering.
 */
export class TmuxLivenessChecker {
	private readonly sessionHealthCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private readonly paneAgentCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private readonly paneAgentEvidenceCache = new Map<
		string,
		{ evidence: TmuxPaneAgentEvidence; checkedAt: number }
	>();

	private sessionHealthCacheKey(
		sessionId: string,
		socketPath?: string | null,
	): string {
		return `${socketPath ?? "__default__"}::${sessionId}`;
	}

	isSessionAlive(sessionId: string, socketPath?: string | null): boolean {
		const cacheKey = this.sessionHealthCacheKey(sessionId, socketPath);
		const cached = this.sessionHealthCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
			return cached.alive;
		}

		let alive = false;
		try {
			const args = socketPath
				? ["-S", socketPath, "has-session", "-t", sessionId]
				: ["has-session", "-t", sessionId];
			execFileSync("tmux", args, { timeout: 500 });
			alive = true;
		} catch {
			alive = false;
		}
		this.sessionHealthCache.set(cacheKey, { alive, checkedAt: now });
		return alive;
	}

	/**
	 * More accurate than {@link isSessionAlive} for multi-window sessions where
	 * the session persists but the specific window a task cared about closed.
	 */
	isWindowAlive(
		sessionId: string,
		windowId: string,
		socketPath?: string | null,
	): boolean {
		const cacheKey = `${socketPath ?? "__default__"}::${sessionId}::${windowId}`;
		const cached = this.sessionHealthCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
			return cached.alive;
		}

		let alive = false;
		try {
			const args = socketPath
				? [
						"-S",
						socketPath,
						"list-windows",
						"-t",
						sessionId,
						"-F",
						"#{window_id}",
					]
				: ["list-windows", "-t", sessionId, "-F", "#{window_id}"];
			const output = execFileSync("tmux", args, { timeout: 500 }).toString();
			alive = output.split("\n").some((line) => line.trim() === windowId);
		} catch {
			alive = false;
		}
		this.sessionHealthCache.set(cacheKey, { alive, checkedAt: now });
		return alive;
	}

	getPaneAgentEvidence(task: AgentTask): TmuxPaneAgentEvidence {
		const usePaneSpecific = !!task.tmux_pane_id;
		const cacheKey = usePaneSpecific
			? `${task.tmux_socket ?? "__default__"}::pane::${task.tmux_pane_id}`
			: `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
		const now = Date.now();
		const cached = this.paneAgentEvidenceCache.get(cacheKey);
		if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
			return cached.evidence;
		}
		const evidence =
			usePaneSpecific && task.tmux_pane_id
				? inspectTmuxPaneById(task.tmux_pane_id, task.tmux_socket)
				: inspectTmuxPaneAgent(task.session_id, task.tmux_socket);
		this.paneAgentEvidenceCache.set(cacheKey, { evidence, checkedAt: now });
		// Also seed the legacy boolean cache so any direct readers stay in sync.
		this.paneAgentCache.set(cacheKey, {
			alive: evidence !== "dead",
			checkedAt: now,
		});
		return evidence;
	}

	/**
	 * Backward-compat: caller treats "unknown" (fail-open) as healthy and only
	 * "dead" (positively confirmed absent) as unhealthy.
	 */
	isPaneAgentHealthy(task: AgentTask): boolean {
		return this.getPaneAgentEvidence(task) !== "dead";
	}

	/**
	 * Cache-only read: returns warm evidence if within TTL, else undefined.
	 * Never shells out — safe for hot render paths that must not block on
	 * subprocess calls.
	 */
	peekPaneAgentEvidence(task: AgentTask): TmuxPaneAgentEvidence | undefined {
		const usePaneSpecific = !!task.tmux_pane_id;
		const cacheKey = usePaneSpecific
			? `${task.tmux_socket ?? "__default__"}::pane::${task.tmux_pane_id}`
			: `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
		const cached = this.paneAgentEvidenceCache.get(cacheKey);
		if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
			return cached.evidence;
		}
		return undefined;
	}

	/** Invalidates cached liveness for one task's session/window, e.g. when a task's runtime identity is superseded. */
	invalidateSession(
		sessionId: string,
		socketPath?: string | null,
		windowId?: string | null,
	): void {
		const key = this.sessionHealthCacheKey(sessionId, socketPath);
		this.sessionHealthCache.delete(key);
		if (windowId) {
			this.sessionHealthCache.delete(`${key}::${windowId}`);
		}
	}

	/** Invalidates every cache entry (across all three caches) keyed by this session id, regardless of socket. */
	invalidateAllForSessionId(sessionId: string): void {
		for (const cacheKey of this.sessionHealthCache.keys()) {
			if (cacheKey.endsWith(`::${sessionId}`)) {
				this.sessionHealthCache.delete(cacheKey);
			}
		}
		for (const cacheKey of this.paneAgentCache.keys()) {
			if (cacheKey.endsWith(`::${sessionId}`)) {
				this.paneAgentCache.delete(cacheKey);
			}
		}
		for (const cacheKey of this.paneAgentEvidenceCache.keys()) {
			if (cacheKey.endsWith(`::${sessionId}`)) {
				this.paneAgentEvidenceCache.delete(cacheKey);
			}
		}
	}

	clear(): void {
		this.sessionHealthCache.clear();
		this.paneAgentCache.clear();
		this.paneAgentEvidenceCache.clear();
	}
}
