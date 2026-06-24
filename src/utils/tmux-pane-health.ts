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
import {
	classifyPaneAttention as _classifyPaneAttention,
	isBenignLivePane as _isBenignLivePane,
	type PaneAttentionState,
} from "./agent-status-sections.js";

/** Known agent CLI process names (case-sensitive). */
export const AGENT_PROCESS_NAMES = [
	"claude",
	"codex",
	"cursor-agent",
	"aider",
	"ollama",
] as const;

export type TmuxPaneAgentEvidence = "alive" | "dead" | "unknown";

// The live-pane attention taxonomy + pure classifier (CCSYNC-03 / PAR-228) are
// DEFINED in the pure, mock-free `agent-status-sections` module so the provider
// can import them from a module the tmux-health-mocking test suites do NOT shadow.
//
// Here we expose them as thin DELEGATING wrappers (not a `export … from` re-export)
// for the historical importers and unit tests that reach for them on this module.
// A re-export aliases the same export binding, which makes Bun's `mock.module`
// for THIS module also shadow that symbol in modules importing it straight from
// `agent-status-sections` — the exact cross-file leak this split removes. A
// locally-defined wrapper is a distinct binding owned by this module, so mocking
// here cannot reach the provider's sections-sourced import.
export type { PaneAttentionState } from "./agent-status-sections.js";

/** Delegates to the pure classifier in `agent-status-sections`. */
export function classifyPaneAttention(
	paneCommand: string | null | undefined,
	snippet: string,
): PaneAttentionState {
	return _classifyPaneAttention(paneCommand, snippet);
}

/** Delegates to the pure benign-pane predicate in `agent-status-sections`. */
export function isBenignLivePane(state: PaneAttentionState): boolean {
	return _isBenignLivePane(state);
}

const SESSION_ID_RE = /^[a-zA-Z0-9._-]+$/;
export const PANE_ID_RE = /^%\d+$/;
const MAX_PIDS = 64;
const MAX_DEPTH = 4;
const TIMEOUT_MS = 500;
/** How many trailing capture-pane lines the attention classifier inspects. */
const ATTENTION_SNIPPET_LINES = 40;

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

	return walkDescendants(panePids);
}

/**
 * Pane-specific inspector. When the launcher records a `tmux_pane_id` (e.g.
 * `%26`), this targets that exact pane via `tmux display-message -t <paneId>`
 * instead of scanning all panes in a session. This prevents unrelated live
 * panes in a shared session from producing false-positive "alive" evidence
 * for a different task.
 */
export function inspectTmuxPaneById(
	paneId: string,
	tmuxSocket?: string | null,
): TmuxPaneAgentEvidence {
	if (!PANE_ID_RE.test(paneId)) return "unknown";

	let rawOutput: string;
	try {
		const args: string[] = [];
		if (tmuxSocket) {
			args.push("-S", tmuxSocket);
		}
		args.push(
			"display-message",
			"-t",
			paneId,
			"-p",
			"#{pane_current_command}|#{pane_pid}",
		);
		rawOutput = execFileSync("tmux", args, {
			timeout: TIMEOUT_MS,
			encoding: "utf8",
		});
	} catch {
		return "unknown";
	}

	const trimmed = rawOutput.trim();
	if (!trimmed) return "unknown";
	const sep = trimmed.indexOf("|");
	if (sep === -1) return "unknown";

	const cmd = trimmed.slice(0, sep).trim();
	const pidStr = trimmed.slice(sep + 1).trim();

	if ((AGENT_PROCESS_NAMES as readonly string[]).includes(cmd)) {
		return "alive";
	}

	const pid = Number.parseInt(pidStr, 10);
	if (Number.isNaN(pid) || pid <= 0) return "unknown";

	return walkDescendants([pid]);
}

/**
 * READ-ONLY capture of the trailing lines of a pane, reusing the same
 * `tmux capture-pane -p` invocation pattern the OutputChannel streamer uses
 * (see services/agent-output-channels.ts). Returns the snippet text, or `null`
 * when capture is not possible (invalid target, tmux unavailable, timeout).
 * Never writes to the terminal.
 *
 * `target` is either a session id or a `%NN` pane id; both are validated to
 * prevent shell-arg injection. The `-S -<N>` start-line bounds the read to the
 * last N lines so the classifier sees recent state, not the whole scrollback.
 */
export function capturePaneSnippet(
	target: string,
	tmuxSocket?: string | null,
	maxLines: number = ATTENTION_SNIPPET_LINES,
): string | null {
	const isPane = PANE_ID_RE.test(target);
	if (!isPane && !SESSION_ID_RE.test(target)) return null;
	try {
		const args: string[] = [];
		if (tmuxSocket) args.push("-S", tmuxSocket);
		args.push(
			"capture-pane",
			"-p",
			"-t",
			target,
			"-S",
			`-${Math.max(1, Math.trunc(maxLines))}`,
		);
		return execFileSync("tmux", args, {
			timeout: TIMEOUT_MS,
			encoding: "utf8",
		});
	} catch {
		return null;
	}
}

// ── Shared descendant walk (steps 3–4) ─────────────────────────────────

/**
 * Walks the descendant pid tree of the given pane pids and classifies it.
 *
 * Liveness invariant: `"dead"` MUST mean "the walk completed and proved no
 * agent process exists." A transient `pgrep`/`ps` failure (timeout, signal,
 * fatal error) is NOT proof of absence — it must fail-open as `"unknown"`,
 * otherwise the Agent Status pane flips a live launcher lane to
 * "Agent process ended" on a probe race and back to running on the next tick.
 *
 * pgrep exit codes (per `man pgrep`):
 *   0 — one or more processes matched
 *   1 — no processes matched (legitimate "no children" — proof of absence)
 *   2 — syntax error in command line
 *   3 — fatal error
 * Node's `execFileSync` throws with `err.status` set to the exit code when
 * the process exited normally, or `null` when killed by a signal (e.g. the
 * `timeout` option). Only status === 1 is treated as a clean "no children".
 *
 * The `-a` flag is load-bearing: BSD/macOS pgrep silently excludes the
 * calling process AND all of its ancestors from matches. Without `-a`, an
 * extension host that is itself a descendant of the observed lane (e.g. the
 * installed-VSIX proof harness launched from inside that lane, or VS Code
 * started from an agent terminal) gets a clean "no children" exit for its
 * own ancestor chain and falsely flips the live lane to stopped. On Linux
 * procps, `-a` merely appends the command line to each output row, which
 * the pid parse below tolerates.
 */
function walkDescendants(panePids: number[]): TmuxPaneAgentEvidence {
	const visited = new Set<number>(panePids);
	let frontier = [...panePids];
	// Tracks whether any descendant probe failed for reasons other than
	// pgrep's clean "no matches" exit. When true, we cannot return "dead"
	// because we may have missed a live agent under an unreadable subtree.
	let probeFailure = false;

	for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
		const nextFrontier: number[] = [];
		for (const ppid of frontier) {
			if (visited.size >= MAX_PIDS) break;
			let childOutput: string;
			try {
				childOutput = execFileSync("pgrep", ["-a", "-P", String(ppid)], {
					timeout: TIMEOUT_MS,
					encoding: "utf8",
				});
			} catch (err) {
				const status = (err as { status?: number | null } | null)?.status;
				if (status !== 1) probeFailure = true;
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

	const descendantPids = [...visited].filter((p) => !panePids.includes(p));
	if (descendantPids.length === 0) {
		return probeFailure ? "unknown" : "dead";
	}

	try {
		const pidArgs = descendantPids.map(String);
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
		return "unknown";
	}

	// ps succeeded and saw no agent comm. If we had upstream probe failures
	// we may have missed a deeper agent descendant — fail-open as unknown.
	return probeFailure ? "unknown" : "dead";
}
