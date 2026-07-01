import { execFileSync } from "node:child_process";
import type { AgentTask } from "../types/agent-task.js";
import {
	inspectTmuxPaneAgent,
	inspectTmuxPaneById,
	type TmuxPaneAgentEvidence,
} from "../utils/tmux-pane-health.js";
import { TtlCache } from "../utils/ttl-cache.js";

const CACHE_TTL_MS = 5_000;

/**
 * Owns tmux-backed liveness probing (`has-session`, `list-windows`, pane
 * inspection) and its 5s-TTL caches. Extracted from AgentStatusTreeProvider
 * so runtime-health checks can be tested and reasoned about independently of
 * tree rendering.
 */
export class TmuxLivenessChecker {
	private readonly sessionHealthCache = new TtlCache<boolean>(CACHE_TTL_MS);
	private readonly paneAgentCache = new TtlCache<boolean>(CACHE_TTL_MS);
	private readonly paneAgentEvidenceCache = new TtlCache<TmuxPaneAgentEvidence>(
		CACHE_TTL_MS,
	);

	private sessionHealthCacheKey(
		sessionId: string,
		socketPath?: string | null,
	): string {
		return `${socketPath ?? "__default__"}::${sessionId}`;
	}

	isSessionAlive(sessionId: string, socketPath?: string | null): boolean {
		const cacheKey = this.sessionHealthCacheKey(sessionId, socketPath);
		const cached = this.sessionHealthCache.getFresh(cacheKey);
		if (cached !== undefined) return cached;

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
		this.sessionHealthCache.set(cacheKey, alive);
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
		const cached = this.sessionHealthCache.getFresh(cacheKey);
		if (cached !== undefined) return cached;

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
		this.sessionHealthCache.set(cacheKey, alive);
		return alive;
	}

	getPaneAgentEvidence(task: AgentTask): TmuxPaneAgentEvidence {
		const usePaneSpecific = !!task.tmux_pane_id;
		const cacheKey = usePaneSpecific
			? `${task.tmux_socket ?? "__default__"}::pane::${task.tmux_pane_id}`
			: `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
		const cached = this.paneAgentEvidenceCache.getFresh(cacheKey);
		if (cached !== undefined) return cached;
		const evidence =
			usePaneSpecific && task.tmux_pane_id
				? inspectTmuxPaneById(task.tmux_pane_id, task.tmux_socket)
				: inspectTmuxPaneAgent(task.session_id, task.tmux_socket);
		this.paneAgentEvidenceCache.set(cacheKey, evidence);
		// Also seed the legacy boolean cache so any direct readers stay in sync.
		this.paneAgentCache.set(cacheKey, evidence !== "dead");
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
		return this.paneAgentEvidenceCache.getFresh(cacheKey);
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
		const matchesSession = (cacheKey: string) =>
			cacheKey.endsWith(`::${sessionId}`);
		this.sessionHealthCache.deleteWhere(matchesSession);
		this.paneAgentCache.deleteWhere(matchesSession);
		this.paneAgentEvidenceCache.deleteWhere(matchesSession);
	}

	clear(): void {
		this.sessionHealthCache.clear();
		this.paneAgentCache.clear();
		this.paneAgentEvidenceCache.clear();
	}
}
