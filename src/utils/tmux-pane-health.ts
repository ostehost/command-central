/**
 * tmux-pane-health.ts
 *
 * Checks whether an agent process is actually running inside a tmux session.
 * The `isTmuxSessionAlive` check only confirms the tmux session/window exists;
 * it does NOT confirm a live agent process. This module probes pane-level process
 * information so callers can detect the "session alive, agent gone" case.
 *
 * Two surfaces:
 *
 *  - `inspectTmuxPaneAgent(...)` returns a tri-state evidence enum:
 *      • "alive"   — positively confirmed an agent process in a pane (current
 *                    command match or descendant comm match).
 *      • "dead"    — pane enumeration succeeded and confirmed no agent.
 *      • "unknown" — fail-open: tmux unavailable, malformed output, timeout,
 *                    permission error, etc. Caller should not downgrade based
 *                    on this alone.
 *
 *  - `isTmuxPaneAgentAlive(...)` is the legacy two-state wrapper and is
 *    equivalent to `inspectTmuxPaneAgent(...) !== "dead"` (alive AND unknown
 *    map to true). Prefer `inspectTmuxPaneAgent` when you need to distinguish
 *    positive evidence from "we couldn't tell" — for example, when you want
 *    to keep a launcher-managed interactive Claude lane visible based on
 *    positive pane evidence rather than letting stream silence downgrade it.
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

export type TmuxPaneAgentEvidence = "alive" | "dead" | "unknown";

const SESSION_ID_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_PIDS = 64;
const MAX_DEPTH = 4;
const TIMEOUT_MS = 500;

/**
 * Returns `true` if an agent process is alive in the given tmux session,
 * or if the check cannot be completed (fail-open). Returns `false` only
 * when we are confident no agent process is running in any pane.
 *
 * Equivalent to `inspectTmuxPaneAgent(...) !== "dead"`.
 */
export function isTmuxPaneAgentAlive(
	sessionId: string,
	tmuxSocket?: string | null,
): boolean {
	return inspectTmuxPaneAgent(sessionId, tmuxSocket) !== "dead";
}

/**
 * Tri-state pane-agent inspector. Returns:
 *  - "alive"   when a pane's `pane_current_command` is an agent name OR a
 *              descendant process's comm matches an agent name.
 *  - "dead"    when pane enumeration succeeded and no agent was found.
 *  - "unknown" when the inspection could not be completed (fail-open).
 *
 * Callers should treat "unknown" as ambiguous evidence — fall back to other
 * signals (stream activity, runtime age) rather than treating it as "alive".
 */
export function inspectTmuxPaneAgent(
	sessionId: string,
	tmuxSocket?: string | null,
): TmuxPaneAgentEvidence {
	// Validate session ID — reject anything that could cause shell injection.
	if (!SESSION_ID_RE.test(sessionId)) return "unknown";

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
		return "unknown";
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
			return "alive";
		}
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isNaN(pid) && pid > 0) {
			panePids.push(pid);
		}
	}

	// Fail-open when list-panes returned no pane lines we could parse — we have no
	// positive or negative evidence in that case.
	if (panePids.length === 0) return "unknown";

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
	if (descendantPids.length === 0) return "dead";

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
				return "alive";
			}
		}
	} catch {
		// fail-open: ps unavailable or all pids already gone
		return "unknown";
	}

	return "dead";
}
