/**
 * tmux-pane-health.ts
 *
 * Checks whether an agent process is actually running inside a tmux session.
 * The `isTmuxSessionAlive` check only confirms the tmux session/window exists;
 * it does NOT confirm a live agent process. This module probes pane-level process
 * information so callers can detect the "session alive, agent gone" case.
 *
 * Conservative fail-open contract: on ANY error (tmux not on PATH, invalid
 * session id, malformed output, timeout, permission error) → return `true`.
 * We'd rather surface a dead lane as still-running than incorrectly downgrade a
 * live agent lane to stopped.
 *
 * The only path that returns `false` is when:
 *  - `tmux list-panes` succeeds and enumerates every pane,
 *  - no pane has an AGENT_PROCESS_NAMES command as `pane_current_command`, AND
 *  - no descendant process of any pane pid matches AGENT_PROCESS_NAMES.
 */

import { execFileSync } from "node:child_process";

/** Known agent CLI process names (case-sensitive). */
export const AGENT_PROCESS_NAMES = [
	"claude",
	"codex",
	"cursor-agent",
	"aider",
	"ollama",
] as const;

const SESSION_ID_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_PIDS = 64;
const MAX_DEPTH = 4;
const TIMEOUT_MS = 500;

/**
 * Returns `true` if an agent process is alive in the given tmux session,
 * or if the check cannot be completed (fail-open). Returns `false` only
 * when we are confident no agent process is running in any pane.
 */
export function isTmuxPaneAgentAlive(
	sessionId: string,
	tmuxSocket?: string | null,
): boolean {
	// Validate session ID — reject anything that could cause shell injection.
	if (!SESSION_ID_RE.test(sessionId)) return true;

	// ── Step 1: list all panes and their current commands + pids ────────────
	let rawOutput: string;
	try {
		const args: string[] = [];
		if (tmuxSocket) {
			args.push("-S", tmuxSocket);
		}
		args.push(
			"list-panes",
			"-s",
			"-t",
			sessionId,
			"-F",
			"#{pane_current_command}|#{pane_pid}",
		);
		rawOutput = execFileSync("tmux", args, {
			timeout: TIMEOUT_MS,
			encoding: "utf8",
		});
	} catch {
		// fail-open: tmux unavailable, session gone already, timeout, etc.
		return true;
	}

	// ── Step 2: check pane_current_command directly ──────────────────────────
	const panePids: number[] = [];
	for (const line of rawOutput.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const sep = trimmed.indexOf("|");
		if (sep === -1) continue;
		const cmd = trimmed.slice(0, sep).trim();
		const pidStr = trimmed.slice(sep + 1).trim();
		if ((AGENT_PROCESS_NAMES as readonly string[]).includes(cmd)) {
			return true;
		}
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isNaN(pid) && pid > 0) {
			panePids.push(pid);
		}
	}

	// Fail-open when list-panes returned no pane lines we could parse — we have no
	// positive or negative evidence in that case.
	if (panePids.length === 0) return true;

	// ── Step 3: BFS over descendant pids (max depth 4, cap 64) ──────────────
	const visited = new Set<number>(panePids);
	let frontier = [...panePids];

	for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
		const nextFrontier: number[] = [];
		for (const ppid of frontier) {
			if (visited.size >= MAX_PIDS) break;
			let childOutput: string;
			try {
				childOutput = execFileSync("pgrep", ["-P", String(ppid)], {
					timeout: TIMEOUT_MS,
					encoding: "utf8",
				});
			} catch {
				// pgrep exits non-zero when no children found — not an error worth failing open.
				continue;
			}
			for (const part of childOutput.split("\n")) {
				const cpid = Number.parseInt(part.trim(), 10);
				if (!Number.isNaN(cpid) && cpid > 0 && !visited.has(cpid)) {
					visited.add(cpid);
					nextFrontier.push(cpid);
					if (visited.size >= MAX_PIDS) break;
				}
			}
		}
		frontier = nextFrontier;
	}

	// Remove the seed pane pids (already checked via pane_current_command).
	const descendantPids = [...visited].filter((p) => !panePids.includes(p));
	if (descendantPids.length === 0) return false;

	// ── Step 4: batch-check comm for all discovered descendant pids ─────────
	try {
		const pidArgs = descendantPids.map(String);
		// ps -p pid1,pid2,... -o comm= (no header)
		const psOutput = execFileSync(
			"ps",
			["-p", pidArgs.join(","), "-o", "comm="],
			{ timeout: TIMEOUT_MS, encoding: "utf8" },
		);
		for (const line of psOutput.split("\n")) {
			const comm = line.trim();
			if (comm && (AGENT_PROCESS_NAMES as readonly string[]).includes(comm)) {
				return true;
			}
		}
	} catch {
		// fail-open: ps unavailable or all pids already gone
		return true;
	}

	return false;
}
