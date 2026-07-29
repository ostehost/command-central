import type {
	AgentStatusGroup,
	AgentTaskStatus,
} from "../providers/agent-status-tree-provider.js";

/**
 * Agent Status V2 — the unified status-tree section model.
 *
 * V2 collapses the lane/work history into ONE lifecycle-led tree with five
 * sections. Four of them are *lane buckets* — every lane lands in exactly one —
 * and the fifth (`sources`) is a fixed, read-only provenance/diagnostics feed
 * that absorbs the old Symphony Status surface (see the design receipt
 * research/RESULT-cc-unified-status-tree-ux-20260613.md).
 *
 * This module is intentionally pure: no VS Code, no provider state, no I/O. It
 * holds the section vocabulary, the count denominator, and the classification
 * predicate so they can be unit-tested in isolation and reused by the provider
 * render path without dragging the tree's hot-path caches into scope.
 *
 * Doctrine baked in here (overrides everything):
 *  - No "none active": counts always render an explicit `live: N` (zero allowed)
 *    and retain the full history count. Absence is stated, never implied.
 *  - Detached ≠ failed: liveness is evaluated first, so an alive lane is always
 *    Live regardless of attach state (the `sectionFromSignals` ordering).
 *  - One denominator: a single `live · review · action · history` vocabulary.
 *  - The activity-bar badge counts `live + action` only (work that is live or
 *    broken) — never review/history.
 */

/** The four lane buckets — every lane lands in exactly one. */
export type V2LaneSection = "live" | "review" | "action" | "history";

/** Lane buckets plus the fixed read-only provenance/diagnostics section. */
export type V2Section = V2LaneSection | "sources";

/** Canonical display order of the lane sections (live first, history last). */
export const V2_LANE_SECTION_ORDER: readonly V2LaneSection[] = [
	"live",
	"review",
	"action",
	"history",
];

/**
 * Human-facing section headers (used by the V2 render path / M3).
 *
 * CENTRALIZED on purpose: section wording is still being sanity-checked against
 * VS Code tree conventions, so every user-facing section label flows from this
 * one map. Rename here to re-word the whole tree — do not inline section strings
 * at call sites.
 */
export const V2_SECTION_HEADERS: Record<V2Section, string> = {
	live: "Live",
	review: "Needs Review",
	action: "Action Required",
	history: "History",
	sources: "Sources",
};

/**
 * Short count-word for each lane section, used in the root/project count
 * vocabulary (`Live N · Review N · Action N · History N`). Centralized alongside
 * the headers so a wording refinement is a one-line change. These intentionally
 * differ from the section headers — terser ("Review" vs "Needs Review",
 * "Action" vs "Action Required") because they appear inline in a dense count.
 */
export const V2_SECTION_COUNT_WORDS: Record<V2LaneSection, string> = {
	live: "Live",
	review: "Review",
	action: "Action",
	history: "History",
};

/**
 * Mapping from the existing four-bucket status engine (`getNodeStatusGroup`) to
 * the V2 lane sections. This is the RC-safe relabel: it is consistent 1:1 with
 * the buckets the tree already renders, so the V2 counts never disagree with the
 * group a lane is shown under.
 *
 * The richer §2 re-bucketing (pending-review → review even when it currently
 * sits in `attention`, broken-pipeline → action even when it currently sits in
 * `limbo`) lives in {@link sectionFromSignals} and is wired into the render path
 * separately (post-RC M3) so the root counts and group membership stay aligned.
 */
export const AGENT_STATUS_GROUP_TO_SECTION: Record<
	AgentStatusGroup,
	V2LaneSection
> = {
	running: "live",
	limbo: "review",
	attention: "action",
	done: "history",
};

export function sectionFromStatusGroup(group: AgentStatusGroup): V2LaneSection {
	return AGENT_STATUS_GROUP_TO_SECTION[group];
}

/** The single V2 count denominator. */
export interface UnifiedCounts {
	live: number;
	review: number;
	action: number;
	history: number;
}

export function emptyUnifiedCounts(): UnifiedCounts {
	return { live: 0, review: 0, action: 0, history: 0 };
}

/** The total number of lanes across all four sections. */
export function unifiedCountTotal(counts: UnifiedCounts): number {
	return counts.live + counts.review + counts.action + counts.history;
}

/** Tally an iterable of lane sections into the single denominator. */
export function countV2Sections(
	sections: Iterable<V2LaneSection>,
): UnifiedCounts {
	const counts = emptyUnifiedCounts();
	for (const section of sections) {
		counts[section] += 1;
	}
	return counts;
}

/**
 * The unified count vocabulary used for both the root summary and per-project
 * rows: every section always shown, including explicit zeros. This is the "no
 * none active" rule — `Live 0` is stated, the full history count is retained.
 *
 *   `Live 2 · Review 1 · Action 1 · History 47`
 */
export function formatV2Summary(counts: UnifiedCounts): string {
	return V2_LANE_SECTION_ORDER.map(
		(section) => `${V2_SECTION_COUNT_WORDS[section]} ${counts[section]}`,
	).join(" · ");
}

/**
 * Activity-bar badge value: live + action only — work that is live or broken.
 * Review/history never inflate the badge (they are not actionable-now).
 */
export function unifiedBadgeCount(counts: UnifiedCounts): number {
	return counts.live + counts.action;
}

/**
 * Statuses that represent a dead failure needing operator action — reached only
 * after liveness has been ruled out (an alive process always wins as Live).
 */
export const DEAD_FAILURE_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
	"failed",
	"stopped",
	"killed",
	"contract_failure",
]);

/**
 * Evidence needed to classify a single lane into a V2 lane section. All fields
 * are pre-computed by the caller from already-warmed caches/predicates so this
 * predicate stays pure and never touches a subprocess on the hot path.
 */
export interface V2SectionSignals {
	/** The lane's display status (post `toDisplayTask`). */
	status: AgentTaskStatus;
	/**
	 * The cached terminal-task liveness verdict says the session/process is
	 * positively alive (a terminal-status-but-alive lane is a lifecycle conflict
	 * and is still Live). For a `running` status this is irrelevant — running is
	 * already Live.
	 */
	livenessAlive: boolean;
	/**
	 * Completed and awaiting a human review verdict — `review_status` is
	 * pending/changes_requested and the lane has not been marked reviewed.
	 */
	awaitingReviewVerdict: boolean;
	/**
	 * The review pipeline is broken: the declared handoff artifact is missing OR
	 * the review-queue receipt is missing. The reviewer literally cannot review,
	 * so this is operator action, not a reading task.
	 *
	 * CCSYNC-01: the caller MUST exclude a stale read-model projection from this
	 * signal. A row whose review metadata still says `pending` but whose receipt
	 * is missing AND that has no live pane/process evidence is reconciliation
	 * backlog (Needs Review), not a broken pipeline — feeding it here would
	 * inflate the badge-counted `action` section with stale work. The tree's
	 * `getNodeStatusGroup` already routes such rows to `limbo`/`review`; this
	 * signal must agree when the M3 render engine is wired in.
	 */
	reviewPipelineBroken: boolean;
}

/**
 * Classify a lane into a V2 lane section, evaluated top-down, first match wins
 * (design receipt §2). Liveness is evaluated FIRST so a detached-but-alive lane
 * is Live, never Action — the detached≠failed invariant. ACTION precedes REVIEW
 * because a broken review pipeline needs an operator before a reviewer.
 *
 * This is the richer V2 classifier (the M3 render engine). It can re-bucket a
 * lane that the legacy four-bucket engine currently routes differently:
 *  - a completed pending-review lane → `review` (legacy `attention`)
 *  - a completed missing-handoff/receipt lane → `action` (legacy `limbo`)
 */
export function sectionFromSignals(signals: V2SectionSignals): V2LaneSection {
	// 0. PAUSED — intentionally parked, awaiting an operator decision. Resolved
	// ABOVE the liveness short-circuit: a paused lane's process is typically
	// still alive, but a parked lane is Needs Review, never Live. (Mirrors the
	// legacy engine's `paused → limbo → review` mapping in getNodeStatusGroup.)
	if (signals.status === "paused") return "review";

	// 1. LIVE — an alive process wins over any recorded terminal status.
	if (signals.status === "running") return "live";
	if (signals.livenessAlive) return "live";

	// 2. ACTION REQUIRED — broken and needs an operator to act.
	if (DEAD_FAILURE_STATUSES.has(signals.status)) return "action";
	if (signals.reviewPipelineBroken) return "action";

	// 3. NEEDS REVIEW — finished, pipeline intact, awaiting a human verdict.
	if (signals.awaitingReviewVerdict) return "review";
	if (
		signals.status === "completed_dirty" ||
		signals.status === "completed_stale"
	) {
		return "review";
	}

	// 4. HISTORY — terminal, succeeded/approved, or aged. Always revisitable.
	return "history";
}

// ── Live-pane attention classifier (CCSYNC-03 / PAR-228) ─────────────────────
//
// Lives here — in the pure, I/O-free, mock-free section module — rather than in
// `tmux-pane-health` so the provider can import it from a module the tmux-health-
// mocking tree-view test suites do NOT shadow. `tmux-pane-health` exposes thin
// DELEGATING wrappers around `classifyPaneAttention`/`isBenignLivePane` (plus a
// `PaneAttentionState` type re-export) for its historical importers and unit
// tests, without aliasing this module's export bindings into the mock boundary.
// Pairing the classifier with a captured pane snippet lets the badge avoid
// over-counting benign live shells.

/**
 * Live-pane attention taxonomy.
 *
 *  - "active-agent"         — an agent CLI owns the pane (or is producing
 *                             output). Live work, not attention.
 *  - "awaiting-user-input"  — the agent/program is asking the human a question
 *                             (a y/N, "continue?", numbered choice, password,
 *                             etc.). This IS attention.
 *  - "completed-at-prompt"  — a command/test run finished and left the shell at
 *                             its prompt (PASS/FAIL/exit summary visible above a
 *                             bare prompt). Benign — the result is already shown.
 *  - "empty-stale-shell"    — a bare/blank shell with no meaningful output.
 *                             Benign — a just-spawned or long-idle shell.
 *  - "idle-agent-repl"      — an interactive agent CLI's input UI sitting idle:
 *                             empty input box + status footer, no running turn,
 *                             no pending question. The launcher's harness
 *                             contract tells agents to `/exit` when done, but
 *                             lanes routinely complete (stop-hook fires, row
 *                             goes terminal) while the REPL stays open — this
 *                             state lets callers keep such finished-but-open
 *                             sessions out of the attention badge. Benign.
 *  - "unknown"              — not enough evidence (fail-open). Callers must not
 *                             downgrade or suppress on this alone.
 */
export type PaneAttentionState =
	| "active-agent"
	| "awaiting-user-input"
	| "completed-at-prompt"
	| "empty-stale-shell"
	| "idle-agent-repl"
	| "unknown";

/**
 * Known agent CLI process names the classifier treats as "an agent owns this
 * pane". Kept local to the pure classifier so this module stays free of the
 * tmux-health surface (and its test mocks).
 */
const CLASSIFIER_AGENT_COMMANDS: readonly string[] = [
	"claude",
	"codex",
	"cursor-agent",
	"aider",
	"ollama",
];

/**
 * Lines that are pure shell prompts — the pane is idling, waiting for the NEXT
 * command, not for an answer to a question. Matches the common bare prompt
 * suffixes ($, %, #, ❯, ➜, →, ») optionally followed by trailing whitespace,
 * and the bracketed `[user@host dir]$` form.
 */
const SHELL_PROMPT_RE = /(?:^|\n)[^\n]*[$%#❯➜→»]\s*$/;
const BRACKET_PROMPT_RE = /(?:^|\n)\[[^\]\n]+\][$%#]\s*$/;

/**
 * Strong "a program is asking the human something" cues. Kept conservative —
 * a false "awaiting-user-input" badges a benign pane as attention, the exact
 * over-count CCSYNC-03 removes, so only unambiguous interactive prompts match.
 */
const AWAITING_INPUT_RES: readonly RegExp[] = [
	/\([yY]\/[nN]\)\s*[?:]?\s*$/, // (y/n)? / (Y/n):
	/\[[yY]\/[nN]\]\s*[?:]?\s*$/, // [y/N]
	/\bpassword\b\s*[:?]\s*$/i,
	/\bpassphrase\b.*[:?]\s*$/i,
	/\bcontinue\?\s*$/i,
	/\bproceed\?\s*$/i,
	/\boverwrite\b.*\?\s*$/i,
	/\bare you sure\b.*\?\s*$/i,
	/\bpress\s+(?:enter|return|any key)\b/i,
	/\bdo you want to\b.*\?\s*$/i,
	/❯\s+\d+\.\s/, // an active numbered-choice selector row (claude/gum style)
	/^\s*\d+\)\s.+\n[^\n]*[:?]\s*$/m, // numbered menu ending in a prompt
];

/**
 * Signals that a finished command/test run left its result above the prompt:
 * a benign "completed-at-prompt" pane, NOT attention. Conservative on purpose.
 *
 * SCOPE: {@link classifyPaneAttention} only, where the question is "does this
 * SHELL pane need a human?" and a false positive merely suppresses an
 * attention badge. These patterns are deliberately loose (`3 passed`, `exit 0`,
 * a `✓` glyph) and MUST NOT be used to decide that a lane finished — an agent
 * REPL's own transcript prose matches them constantly. See
 * {@link LANE_COMPLETION_BOUNDARY_RES}.
 */
const COMPLETION_SUMMARY_RES: readonly RegExp[] = [
	/\bREADY_FOR_REVIEW\b/i,
	/\bready for review\b/i,
	/\b(?:type|run|enter)\s+\/?exit\b/i,
	/\b\/?exit\b.*\b(?:finish|quit|close|end)\b/i,
	/\b(?:finish|quit|close|end)\b.*\b\/?exit\b/i,
	/\b\d+\s+pass(?:ed|ing)?\b/i,
	/\b\d+\s+fail(?:ed|ing|ures?)?\b/i,
	/\ball tests? passed\b/i,
	/\btests?:?\s+\d+\b/i,
	/\b\d+\s+(?:tests?|specs?|files?)\b.*\b\d+\s+(?:pass|fail)/i,
	/\bdone in\b/i,
	/\bexit(?:ed)?\s+(?:code\s+)?\d+\b/i,
	/\bbuild (?:succeeded|failed|complete)\b/i,
	/\bcompiled (?:successfully|with)\b/i,
	/[✓✗✔✘]\s/,
];

/**
 * Unambiguous "this lane reached its handoff/review boundary" markers.
 *
 * Distinct from {@link COMPLETION_SUMMARY_RES} because the stakes are inverted:
 * a match here DEMOTES a `running` row out of the live surface, so anything an
 * agent could plausibly type mid-turn must be excluded. A live Claude lane
 * narrating `11/11 passed`, `exit 0`, `build complete` or printing a `✓` is
 * working, not finished — those patterns stay out of this list.
 *
 * What survives: the launcher's literal READY_FOR_REVIEW marker token, and the
 * explicit `/exit` completion prompt the wrapper prints when the agent is done.
 * Both are emitted by the harness, not composed by the model.
 */
// NB: `\b` does not match before the leading `/` of `/exit` (both sides
// non-word at string start), so these anchor on the slash itself.
const LANE_COMPLETION_BOUNDARY_RES: readonly RegExp[] = [
	/\bREADY_FOR_REVIEW\b/i,
	/\b(?:type|run|enter)\s+\/exit\b/i,
	/\/exit\b.*\b(?:finish|quit|close|end)\b/i,
	/\b(?:finish|quit|close|end)\b.*\/exit\b/i,
];

/**
 * Idle interactive agent REPL detection (Claude Code-style UI). ALL cues must
 * hold — conservative on purpose, a false idle verdict would hide live work:
 *  - the REPL status footer is rendered (stable UI chrome, e.g. the
 *    "shift+tab to cycle" mode hint or the "? for shortcuts" help hint);
 *  - the input box is EMPTY (a line that is exactly `❯`) — typed-but-unsent
 *    input or a `❯ 1.` dialog selector row does not qualify;
 *  - no turn is running — see {@link AGENT_REPL_TURN_RUNNING_RES}.
 */
const AGENT_REPL_FOOTER_RES: readonly RegExp[] = [
	/shift\+tab to cycle/i,
	/\?\s+for shortcuts/i,
];
const AGENT_REPL_EMPTY_INPUT_RE = /(?:^|\n)❯\s*(?:\n|$)/;

/**
 * Cues that a turn is IN FLIGHT, so the REPL is not idle no matter how empty
 * its input box looks.
 *
 * The interrupt hint alone is not enough. During a long turn the transcript
 * scrolls, and a bounded `capture-pane` window can retain the working-spinner
 * status line while the interrupt hint has already scrolled past — observed on
 * a lane that had been thinking for 22 minutes:
 *
 *     ✳ Philosophising… (22m 41s · almost done thinking with xhigh effort)
 *     ────────────────────────────────────────────────────────
 *     ❯
 *       ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
 *
 * All three idle cues held, so a hard-working agent classified as
 * `idle-agent-repl`. The spinner's `…` + parenthesised elapsed timer is
 * rendered for the whole turn and is the more durable signal.
 */
/**
 * The live spinner STATUS LINE — structural, and therefore usable as a block
 * boundary (unlike the bare `esc to interrupt` substring, which can appear
 * inside completed prose).
 */
const AGENT_REPL_SPINNER_LINE_RE =
	// Structural, not "a duration appears somewhere": the elapsed timer must sit
	// on a line that OPENS with a spinner glyph. Claude marks finished results
	// with `⏺`, so prose like `⏺ Handled Manifesting… (16m 32s)` in an agent's
	// closing summary is not a running turn and must not beat an empty prompt.
	// The class is the live animation sequence (`·` `✢` `✳` `✶` `✻` `✽`) —
	// `·` included, since dropping a real frame is how a working lane gets
	// reported idle. Only ASCII `*` is excluded: it is an ordinary Markdown
	// bullet, so `* Build… (1m 2s)` in a timing summary must not read as chrome.
	// The glyph must OPEN the line, so `·` as Claude's own mid-line separator
	// (`(22m 41s · ↓ 100.6k tokens)`) is unaffected.
	/^[^\S\n]*[·✻✽✳✢✶✷✸✹∗]\s.*…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/m;

/**
 * The interrupt hint rendered as its OWN status line — the whole line is the
 * hint, bar indentation and parentheses.
 *
 * Distinct from the loose `esc to interrupt` substring below: a result line
 * that merely mentions the hint (`… restored handling of "esc to interrupt"`)
 * carries other content and is prose, while a line that is nothing but the hint
 * is chrome. Only the latter may bound a result block.
 */
const AGENT_REPL_INTERRUPT_LINE_RE =
	/^[^\S\n]*\(?\s*(?:press\s+)?esc to interrupt\s*\)?[^\S\n]*$/i;

/** Structural status lines: never result content, always a block boundary. */
const AGENT_REPL_CHROME_LINE_RES: readonly RegExp[] = [
	AGENT_REPL_SPINNER_LINE_RE,
	AGENT_REPL_INTERRUPT_LINE_RE,
];

const AGENT_REPL_TURN_RUNNING_RES: readonly RegExp[] = [
	/esc to interrupt/i,
	AGENT_REPL_SPINNER_LINE_RE,
];

/**
 * Whether the pane is rendering an agent REPL at all, idle or not — keyed on
 * the stable status-footer chrome. Launcher panes report the wrapper shell as
 * `pane_current_command`, so this is how a REPL is recognized when the process
 * name cannot say so.
 */
export function isAgentReplSnippet(snippet: string): boolean {
	return AGENT_REPL_FOOTER_RES.some((re) => re.test(snippet));
}

/**
 * How many trailing lines count as the REPL's LIVE status area. Claude renders
 * the spinner directly above the input box and footer, so the current frame
 * comfortably fits; anything higher up is scrollback.
 */
const AGENT_REPL_STATUS_TAIL_LINES = 8;

/**
 * A COMPLETED result line. Claude opens each finished result with `⏺`, so one
 * appearing after a spinner cue proves that turn already produced its answer.
 */
const AGENT_REPL_RESULT_LINE_RE = /^[^\S\n]*⏺\s/m;

/**
 * Positive evidence that a turn is in flight RIGHT NOW, anchored to the live
 * status area at the bottom of the pane.
 *
 * Anchored, with no unanchored variant on purpose. `capturePaneSnippet` returns
 * the trailing 40 lines, so a whole-snippet match also fires on a remnant of an
 * ALREADY-FINISHED turn — or on an agent quoting a spinner line in its own
 * transcript. Scanning that far cost the benign idle verdict: a cleanly
 * completed lane whose REPL sits at an empty prompt would fail
 * {@link isIdleAgentReplSnippet} on a leftover `… (22m 41s)` and get reported
 * as an attention-worthy lifecycle conflict instead.
 *
 * The long-turn case that motivated the spinner cue is unaffected — the spinner
 * is rendered directly above the input box, well inside the window.
 */
export function isAgentReplTurnRunning(snippet: string): boolean {
	const text = snippet.replace(/\s+$/, "");
	// Attribute result blocks across the FULL capture, then require the cue to
	// sit in the live status tail. Slicing first cut the `⏺` opener off any
	// result long enough to fill the window, orphaning its continuation lines
	// so they read as chrome — the very confusion the block rule exists to end.
	const lineCount = text.split("\n").length;
	const tailStart = Math.max(0, lineCount - AGENT_REPL_STATUS_TAIL_LINES);
	const cueAt = lastTurnCueLine(text, tailStart);
	if (cueAt < 0) return false;
	// Position alone is not currency. A SHORT turn leaves its spinner inside the
	// window, directly above the answer it produced — so a completed result
	// printed after the cue ends the turn however few lines separate them.
	// Without this, an idle REPL was reported as working (and its stuck/dock
	// signals suppressed) until enough lines scrolled the remnant away.
	return cueAt > lastMatchLine(text, [AGENT_REPL_RESULT_LINE_RE]);
}

/**
 * Index of the LAST LINE matching any pattern in `res`, or -1 when none match.
 *
 * Deliberately line-granular rather than character-granular. A completed result
 * line can QUOTE a cue — `⏺ READY_FOR_REVIEW — fixed handling of "esc to
 * interrupt"` — and a character offset would rank that quote after the very
 * line containing it. Comparing lines makes a same-line quote a tie, which the
 * callers resolve in favour of the completed output.
 */
/**
 * Index of the last line carrying a LIVE turn cue.
 *
 * Completed-result lines are skipped outright: an agent that writes
 * `⏺ READY_FOR_REVIEW — fixed handling of "esc to interrupt"` is describing a
 * turn, not running one, and finished output must never impersonate chrome.
 */
function lastTurnCueLine(text: string, minIndex = 0): number {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= minIndex; i--) {
		if (isResultBlockLine(lines, i)) continue;
		if (AGENT_REPL_TURN_RUNNING_RES.some((re) => re.test(lines[i] ?? ""))) {
			return i;
		}
	}
	return -1;
}

/**
 * Whether line `i` belongs to a completed `⏺` result — its opening line OR any
 * of the indented continuation lines the result wraps onto.
 *
 * Skipping only the opening line was not enough. A narrow pane wraps a result
 * across several lines, so
 *
 *     ⏺ READY_FOR_REVIEW — fixed handling of
 *       "esc to interrupt"
 *
 * left the continuation readable as live chrome: it vetoed the very completion
 * marker it belongs to, and made an idle REPL look active. A continuation is
 * indented, so it is attributed to the nearest preceding line that ISN'T —
 * which also keeps a genuinely indented status hint (Claude renders
 * `  (esc to interrupt)` under the spinner) attached to the spinner line rather
 * than to some result further up.
 */
function isResultBlockLine(lines: readonly string[], i: number): boolean {
	const line = lines[i] ?? "";
	if (AGENT_REPL_RESULT_LINE_RE.test(line)) return true;
	// A structural status line (spinner, or a standalone interrupt hint) is
	// chrome in its own right, whatever its indent — it can never be a result's
	// continuation.
	if (AGENT_REPL_CHROME_LINE_RES.some((re) => re.test(line))) return false;
	if (!/^\s+\S/.test(line)) return false;
	for (let j = i - 1; j >= 0; j--) {
		const prev = lines[j] ?? "";
		// Test for the opener FIRST: the result-line contract permits leading
		// whitespace, so an indented `  ⏺ …` is an opener, not a sibling. The
		// indent skip below would otherwise walk straight past it and leave the
		// whole block readable as chrome.
		if (AGENT_REPL_RESULT_LINE_RE.test(prev)) return true;
		// Chrome BOUNDS the block. Ownership by indentation alone would let an
		// earlier result swallow a later `  ✻ Working… (4m)` or a standalone
		// `  (esc to interrupt)`, reporting an active turn as idle — the exact
		// inversion this block rule exists to prevent.
		if (AGENT_REPL_CHROME_LINE_RES.some((re) => re.test(prev))) return false;
		// Blank lines do not close a block; further indented lines are siblings.
		if (!prev.trim() || /^\s+\S/.test(prev)) continue;
		return false;
	}
	return false;
}

function lastMatchLine(text: string, res: readonly RegExp[]): number {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		if (res.some((re) => re.test(line))) return i;
	}
	return -1;
}

/**
 * Whether the most recent turn cue in the pane is NEWER than the most recent
 * lane-completion boundary marker.
 *
 * The precise question for a completion veto, and strictly better than a
 * tail window there: the veto only ever matters when a boundary marker is
 * present, so what decides it is which signal came LAST. A finished turn that
 * left its spinner immediately above its own `READY_FOR_REVIEW` is complete,
 * however few lines separate the two.
 */
export function isTurnCueNewerThanCompletion(snippet: string): boolean {
	const turnAt = lastTurnCueLine(snippet);
	if (turnAt < 0) return false;
	return turnAt > lastMatchLine(snippet, LANE_COMPLETION_BOUNDARY_RES);
}

export function isIdleAgentReplSnippet(snippet: string): boolean {
	if (!isAgentReplSnippet(snippet)) return false;
	if (!AGENT_REPL_EMPTY_INPUT_RE.test(snippet)) return false;
	return !isAgentReplTurnRunning(snippet);
}

/**
 * Read-only terminal evidence that a launcher row's work already reached its
 * handoff/review boundary even if the lifecycle row still says `running`.
 *
 * Unlike {@link classifyPaneAttention}, this helper intentionally ignores
 * `pane_current_command`: a Claude process can still be alive at its `/exit`
 * prompt after it has emitted READY_FOR_REVIEW, and a completed pane can also
 * have fallen back to `bash`. Callers must gate this with their own staleness /
 * local-terminal checks before using it to demote a running row.
 *
 * Matches only {@link LANE_COMPLETION_BOUNDARY_RES} — harness-emitted boundary
 * markers. It deliberately does NOT reuse the looser attention-side
 * {@link COMPLETION_SUMMARY_RES}: those matched a live lane's own transcript
 * (`exit 0`, `20/20 passed`, `✓`) and demoted working agents to
 * "Stale — no completion signal".
 */
export function hasReadOnlyCompletionEvidence(snippet: string): boolean {
	const text = snippet.replace(/\s+$/, "");
	if (!text.trim()) return false;
	return LANE_COMPLETION_BOUNDARY_RES.some((re) => re.test(text));
}

function lastNonEmptyLine(snippet: string): string {
	const lines = snippet.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = (lines[i] ?? "").replace(/\s+$/, "");
		if (trimmed.trim().length > 0) return trimmed;
	}
	return "";
}

function endsAtShellPrompt(snippet: string): boolean {
	const tail = snippet.replace(/\n+$/, "");
	return SHELL_PROMPT_RE.test(tail) || BRACKET_PROMPT_RE.test(tail);
}

/**
 * PURE classifier: given a pane's `pane_current_command` (may be undefined when
 * unavailable) and a recent `capture-pane` snippet (the trailing lines of the
 * pane), decide whether the pane needs human attention.
 *
 * Precedence (first match wins):
 *  1. active-agent       — the pane command IS an agent CLI.
 *  2. awaiting-user-input— the tail contains an unambiguous interactive prompt.
 *  3. completed-at-prompt— a command result/summary sits above a bare prompt.
 *  4. empty-stale-shell  — a bare shell prompt (or blank), no meaningful output.
 *  5. unknown            — no usable evidence (no command + empty snippet).
 *
 * No I/O — safe to unit-test in isolation and safe on a render hot path once the
 * caller has the snippet in hand.
 */
export function classifyPaneAttention(
	paneCommand: string | null | undefined,
	snippet: string,
): PaneAttentionState {
	const cmd = paneCommand?.trim();
	const text = snippet.replace(/\s+$/, "");
	if (cmd && CLASSIFIER_AGENT_COMMANDS.includes(cmd)) {
		// An agent CLI owns the pane. Distinguish a provably idle REPL (empty
		// input box, no running turn) from live agent work; anything ambiguous
		// stays "active-agent" (never benign).
		return isIdleAgentReplSnippet(text) ? "idle-agent-repl" : "active-agent";
	}

	const hasMeaningfulText = text.trim().length > 0;
	if (!cmd && !hasMeaningfulText) return "unknown";

	const tail = lastNonEmptyLine(text);
	if (AWAITING_INPUT_RES.some((re) => re.test(text) || re.test(tail))) {
		return "awaiting-user-input";
	}

	// Launcher panes usually report the wrapper shell (`bash`) as the pane
	// command while the agent REPL runs inside it — recognize the REPL UI by
	// its chrome. Checked AFTER awaiting-user-input so a pending question
	// rendered inside the REPL always wins.
	if (isAgentReplSnippet(text)) {
		if (isIdleAgentReplSnippet(text)) return "idle-agent-repl";
		// Only a POSITIVE turn cue promotes to active-agent. REPL chrome alone is
		// ambiguous (typed-but-unsent input, a footer with no input box), and
		// ambiguity must fall through to the fail-open path below rather than
		// claim work is in flight.
		if (isAgentReplTurnRunning(text)) return "active-agent";
	}

	const atPrompt = endsAtShellPrompt(text);
	if (atPrompt && COMPLETION_SUMMARY_RES.some((re) => re.test(text))) {
		return "completed-at-prompt";
	}

	// A bare/blank shell at a prompt with no completion summary and no question
	// is just an idle shell — benign.
	if (atPrompt || !hasMeaningfulText) return "empty-stale-shell";

	// Output present, not a recognizable prompt/question/summary — we cannot
	// safely call this benign, so fail-open as unknown (caller must not suppress).
	return "unknown";
}

/**
 * True for live panes that are BENIGN — a finished command sitting at its prompt
 * or a bare/idle shell. Callers use this to keep such panes OUT of the attention
 * badge while still surfacing genuine "awaiting-user-input" prompts.
 */
export function isBenignLivePane(state: PaneAttentionState): boolean {
	return (
		state === "completed-at-prompt" ||
		state === "empty-stale-shell" ||
		state === "idle-agent-repl"
	);
}
