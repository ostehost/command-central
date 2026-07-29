import { describe, expect, test } from "bun:test";
import type {
	AgentStatusGroup,
	AgentTaskStatus,
} from "../../src/providers/agent-status-tree-provider.js";
import {
	AGENT_STATUS_GROUP_TO_SECTION,
	classifyPaneAttention,
	countV2Sections,
	emptyUnifiedCounts,
	formatV2Summary,
	hasReadOnlyCompletionEvidence,
	isAgentReplTurnRunning,
	isIdleAgentReplSnippet,
	isTurnCueNewerThanCompletion,
	sectionFromSignals,
	sectionFromStatusGroup,
	type UnifiedCounts,
	unifiedBadgeCount,
	unifiedCountTotal,
	V2_SECTION_HEADERS,
	type V2SectionSignals,
} from "../../src/utils/agent-status-sections.js";

function signals(overrides: Partial<V2SectionSignals> = {}): V2SectionSignals {
	return {
		status: "completed",
		livenessAlive: false,
		awaitingReviewVerdict: false,
		reviewPipelineBroken: false,
		...overrides,
	};
}

describe("group → V2 section mapping (RC-safe, render-consistent)", () => {
	test("each legacy bucket maps to exactly one lane section", () => {
		expect(sectionFromStatusGroup("running")).toBe("live");
		expect(sectionFromStatusGroup("limbo")).toBe("review");
		expect(sectionFromStatusGroup("attention")).toBe("action");
		expect(sectionFromStatusGroup("done")).toBe("history");
	});

	test("the mapping is total over every AgentStatusGroup", () => {
		const groups: AgentStatusGroup[] = [
			"running",
			"limbo",
			"attention",
			"done",
		];
		for (const group of groups) {
			expect(AGENT_STATUS_GROUP_TO_SECTION[group]).toBeDefined();
		}
	});
});

describe("countV2Sections + unifiedCountTotal", () => {
	test("tallies sections into the single denominator", () => {
		const counts = countV2Sections([
			"live",
			"live",
			"review",
			"action",
			"history",
			"history",
			"history",
		]);
		expect(counts).toEqual({ live: 2, review: 1, action: 1, history: 3 });
		expect(unifiedCountTotal(counts)).toBe(7);
	});

	test("empty input yields explicit zeros (not absence)", () => {
		expect(countV2Sections([])).toEqual(emptyUnifiedCounts());
		expect(emptyUnifiedCounts()).toEqual({
			live: 0,
			review: 0,
			action: 0,
			history: 0,
		});
	});
});

describe("formatV2Summary (root + project rows) — explicit live, no 'none active'", () => {
	test("AT1: renders the locked 'Live N · Review N · Action N · History N' format", () => {
		const counts: UnifiedCounts = {
			live: 2,
			review: 1,
			action: 1,
			history: 47,
		};
		expect(formatV2Summary(counts)).toBe(
			"Live 2 · Review 1 · Action 1 · History 47",
		);
	});

	test("AT2: zero live renders explicit Live 0 and retains history; never 'none active'", () => {
		const counts: UnifiedCounts = {
			live: 0,
			review: 0,
			action: 0,
			history: 101,
		};
		const label = formatV2Summary(counts);
		expect(label.startsWith("Live 0")).toBe(true);
		expect(label).toContain("History 101");
		expect(label).not.toContain("none active");
		expect(label).toBe("Live 0 · Review 0 · Action 0 · History 101");
	});

	test("avoids forbidden wording from the naming lock", () => {
		const label = formatV2Summary({
			live: 0,
			review: 0,
			action: 0,
			history: 0,
		});
		for (const forbidden of [
			"none active",
			"Live now",
			"Current",
			"Failed & Stopped",
			"Archive",
		]) {
			expect(label).not.toContain(forbidden);
		}
	});
});

describe("V2_SECTION_HEADERS — locked, centralized section labels", () => {
	test("uses the locked label wording", () => {
		expect(V2_SECTION_HEADERS.live).toBe("Live");
		expect(V2_SECTION_HEADERS.review).toBe("Needs Review");
		expect(V2_SECTION_HEADERS.action).toBe("Action Required");
		expect(V2_SECTION_HEADERS.history).toBe("History");
		expect(V2_SECTION_HEADERS.sources).toBe("Sources");
	});

	test("avoids the forbidden section words", () => {
		const labels = Object.values(V2_SECTION_HEADERS).join(" ");
		for (const forbidden of [
			"Current",
			"Live now",
			"Issues",
			"Problems",
			"Failed & Stopped",
			"Archive",
			"Diagnostics",
		]) {
			expect(labels).not.toContain(forbidden);
		}
	});
});

describe("unifiedBadgeCount — live + action only", () => {
	test("AT12: badge counts live + action, never review/history", () => {
		expect(
			unifiedBadgeCount({ live: 2, review: 5, action: 1, history: 40 }),
		).toBe(3);
	});

	test("badge is zero when nothing is live or broken", () => {
		expect(
			unifiedBadgeCount({ live: 0, review: 9, action: 0, history: 99 }),
		).toBe(0);
	});
});

describe("hasReadOnlyCompletionEvidence", () => {
	test("recognizes Symphony/Claude review-ready terminal markers", () => {
		expect(
			hasReadOnlyCompletionEvidence(
				"work complete\nREADY_FOR_REVIEW\nuser@host project %",
			),
		).toBe(true);
	});

	test("recognizes explicit /exit completion prompts without treating arbitrary output as completion", () => {
		expect(
			hasReadOnlyCompletionEvidence("Ready for review. Type /exit to close."),
		).toBe(true);
		expect(hasReadOnlyCompletionEvidence("thinking...\n> /help")).toBe(false);
	});

	// A live agent narrates test runs, exit codes and checkmarks constantly.
	// Those matched the attention-side COMPLETION_SUMMARY_RES and demoted
	// working lanes to "Stale — no completion signal"; only harness-emitted
	// boundary markers may demote a running row.
	test("does NOT treat a working agent's own transcript prose as a completion boundary", () => {
		const liveTranscript = [
			"⏺ Both suites pass through the symlinked checkout — 11/11 and 20/20.",
			'  onboard_status="error"   # any other non-zero = execution failure',
			"  [[ $rc -eq 1 ]] && exit 0",
			"  ✓ 4 passed, 0 failed · build complete · done in 2.1s",
			"✳ Manifesting… (16m 32s · ↓ 73.9k tokens)",
			"❯ ",
			"  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
		].join("\n");
		expect(hasReadOnlyCompletionEvidence(liveTranscript)).toBe(false);
	});

	test("a bare `exit 0` / checkmark / pass count is never completion evidence on its own", () => {
		for (const snippet of [
			"exit 0",
			"exited 1",
			"20 passed",
			"3 failures",
			"tests: 12",
			"✓ done",
			"build succeeded",
			"compiled successfully",
			"done in 3.4s",
		]) {
			expect(hasReadOnlyCompletionEvidence(snippet)).toBe(false);
		}
	});

	test("still fires on the harness-emitted boundary markers", () => {
		expect(hasReadOnlyCompletionEvidence("READY_FOR_REVIEW")).toBe(true);
		expect(hasReadOnlyCompletionEvidence("run /exit to finish")).toBe(true);
		expect(hasReadOnlyCompletionEvidence("/exit when you want to quit")).toBe(
			true,
		);
	});
});

describe("isIdleAgentReplSnippet", () => {
	const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent";

	test("an empty input box under the REPL footer with no running turn is idle", () => {
		expect(isIdleAgentReplSnippet(`⏺ All done.\n❯ \n${FOOTER}`)).toBe(true);
	});

	test("a running turn is not idle", () => {
		expect(
			isIdleAgentReplSnippet(
				`✳ Manifesting… (16m 32s)\n  (esc to interrupt)\n❯ \n${FOOTER}`,
			),
		).toBe(false);
	});

	test("a plain shell pane is not an idle REPL", () => {
		expect(isIdleAgentReplSnippet("ostehost@MacBookPro config$ ")).toBe(false);
	});

	// Observed on a lane 22 minutes into an extended-thinking turn: the
	// interrupt hint had scrolled out of the bounded capture window, so all
	// three idle cues held and a hard-working agent read as idle.
	test("the working spinner keeps a long turn out of the idle verdict without the interrupt hint", () => {
		const midTurn = [
			"✻ Philosophising… (22m 41s · ↓ 100.6k tokens · thinking with xhigh effort)",
			"────────────────────────────────────────────",
			"❯ ",
			"────────────────────────────────────────────",
			FOOTER,
		].join("\n");
		expect(midTurn).not.toContain("esc to interrupt");
		expect(isAgentReplTurnRunning(midTurn)).toBe(true);
		expect(isIdleAgentReplSnippet(midTurn)).toBe(false);
		expect(classifyPaneAttention("bash", midTurn)).toBe("active-agent");
	});

	test("an idle REPL is still idle — the spinner cue needs an elapsed timer", () => {
		// Guards against the turn cue over-matching on ordinary ellipsis prose.
		const idle = [
			"⏺ Wrote the handoff… everything is committed.",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(idle)).toBe(false);
		expect(isIdleAgentReplSnippet(idle)).toBe(true);
		expect(classifyPaneAttention("bash", idle)).toBe("idle-agent-repl");
	});

	test("a completed idle REPL keeps its BENIGN verdict despite a spinner remnant", () => {
		// The turn cue is anchored to the live status area. Scanning the whole
		// 40-line capture let a finished turn's leftover spinner beat the empty
		// input box, so a cleanly completed lane classified as `active-agent`
		// (non-benign) and surfaced a false attention / lifecycle conflict.
		// A SHORT turn leaves its spinner inside the tail window, directly above
		// the answer it produced — so position alone cannot settle this; the
		// completed result line after the cue has to end the turn.
		const completed = [
			"✻ Philosophising… (1m 2s · ↓ 4.1k tokens)",
			"⏺ All done — handoff written.",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(completed)).toBe(false);
		expect(isIdleAgentReplSnippet(completed)).toBe(true);
		expect(classifyPaneAttention("bash", completed)).toBe("idle-agent-repl");
	});

	test("an elapsed time in a finished result line is not a running spinner", () => {
		// The timer cue is structural: it must open a spinner-glyph line. Claude
		// marks completed results with `⏺`, so a closing summary that happens to
		// quote a duration must not beat the empty prompt and re-classify a
		// clean completed lane as active.
		const summarised = [
			"⏺ Handled Manifesting… (16m 32s) and wrote the handoff.",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(summarised)).toBe(false);
		expect(isIdleAgentReplSnippet(summarised)).toBe(true);
		expect(classifyPaneAttention("bash", summarised)).toBe("idle-agent-repl");
	});

	test("an ASCII Markdown bullet with a duration is not a spinner", () => {
		// `*` is an ordinary list bullet, so a timing summary must not read as
		// live chrome and suppress stuck/attention reporting.
		const timings = [
			"⏺ Timing summary",
			"* Build… (1m 2s)",
			"* Tests… (0m 44s)",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(timings)).toBe(false);
		expect(isIdleAgentReplSnippet(timings)).toBe(true);
	});

	test("the middle-dot spinner frame still reads as a live turn", () => {
		// `·` is a real frame of Claude's animation sequence, not punctuation.
		// Dropping it would report a working lane as idle whenever a capture
		// landed on that frame with the interrupt hint scrolled away.
		const midDotFrame = ["· Philosophising… (3m 7s)", "❯ ", FOOTER].join("\n");
		expect(isAgentReplTurnRunning(midDotFrame)).toBe(true);
		expect(isIdleAgentReplSnippet(midDotFrame)).toBe(false);
		expect(classifyPaneAttention("bash", midDotFrame)).toBe("active-agent");
	});

	test("a cue quoted inside a completed result line is prose, not chrome", () => {
		// Finished output describing a turn must never impersonate a running one
		// — it would veto the very completion boundary on the same line.
		const quoted = [
			'⏺ READY_FOR_REVIEW — fixed handling of "esc to interrupt"',
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(quoted)).toBe(false);
		expect(hasReadOnlyCompletionEvidence(quoted)).toBe(true);
	});

	test("a cue on a WRAPPED result's continuation line is still prose", () => {
		// A narrow pane wraps a completed result across lines. Skipping only the
		// opening `⏺` line left the continuation readable as live chrome, so it
		// vetoed the very completion marker it belongs to.
		const wrapped = [
			"⏺ READY_FOR_REVIEW — fixed handling of",
			'  "esc to interrupt"',
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(wrapped)).toBe(false);
		expect(isIdleAgentReplSnippet(wrapped)).toBe(true);
		expect(hasReadOnlyCompletionEvidence(wrapped)).toBe(true);
	});

	test("a wrapped result longer than the status tail keeps its block identity", () => {
		// Block attribution runs over the FULL capture. Truncating to the tail
		// first sliced the `⏺` opener off any result long enough to fill the
		// window, orphaning its continuations so they read as live chrome.
		const longResult = [
			"⏺ READY_FOR_REVIEW — closed out the lane:",
			...Array.from({ length: 8 }, (_, i) => `  step ${i + 1} verified`),
			'  restored handling of "esc to interrupt"',
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(longResult)).toBe(false);
		expect(isIdleAgentReplSnippet(longResult)).toBe(true);
		expect(hasReadOnlyCompletionEvidence(longResult)).toBe(true);
	});

	test("an INDENTED result opener still owns its continuation lines", () => {
		// The result-line contract allows leading whitespace, so `  ⏺ …` is an
		// opener. Walking past it as though it were a sibling left the block
		// readable as chrome.
		const indentedOpener = [
			"  ⏺ READY_FOR_REVIEW — closed the lane after",
			'    restoring handling of "esc to interrupt"',
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(indentedOpener)).toBe(false);
		expect(isIdleAgentReplSnippet(indentedOpener)).toBe(true);
		expect(hasReadOnlyCompletionEvidence(indentedOpener)).toBe(true);
	});

	test("an indented spinner after an indented result is still a live turn", () => {
		// Ownership by indentation alone let the earlier result swallow the
		// spinner AND its hint, reporting an active turn as idle — and, with a
		// READY_FOR_REVIEW in that result, demoting a working lane.
		const resumed = [
			"  ⏺ READY_FOR_REVIEW — first pass done",
			"  ✻ Working… (4m 2s)",
			"  (esc to interrupt)",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(resumed)).toBe(true);
		expect(isIdleAgentReplSnippet(resumed)).toBe(false);
		expect(isTurnCueNewerThanCompletion(resumed)).toBe(true);
	});

	test("a standalone interrupt hint survives a preceding result with no spinner", () => {
		// Chrome exemption must not depend on spinner recognition. A resumed turn
		// can render the hint alone under the previous result; attributing it to
		// that result reported an active lane idle and let the stale
		// READY_FOR_REVIEW demote it.
		const resumedNoSpinner = [
			"⏺ READY_FOR_REVIEW — first pass done",
			"  (esc to interrupt)",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(resumedNoSpinner)).toBe(true);
		expect(isIdleAgentReplSnippet(resumedNoSpinner)).toBe(false);
		expect(isTurnCueNewerThanCompletion(resumedNoSpinner)).toBe(true);
	});

	test("an indented status hint under the spinner still counts as live chrome", () => {
		// Control for the block rule: `  (esc to interrupt)` is indented too, but
		// it hangs off the SPINNER line, not off a result — attributing it to a
		// result further up would resurrect the false-idle bug.
		const midTurn = [
			"⏺ Ran the suite — 20/20 passed.",
			"  all green",
			"✻ Philosophising… (4m 2s)",
			"  (esc to interrupt)",
			"❯ ",
			FOOTER,
		].join("\n");
		expect(isAgentReplTurnRunning(midTurn)).toBe(true);
		expect(isIdleAgentReplSnippet(midTurn)).toBe(false);
	});

	test("REPL chrome alone never claims a turn is in flight", () => {
		// Ambiguous panes (typed-but-unsent input, footer with no input box) must
		// keep failing open rather than asserting work.
		const typed = ["❯ /exit", FOOTER].join("\n");
		expect(isAgentReplTurnRunning(typed)).toBe(false);
		expect(classifyPaneAttention("bash", typed)).toBe("unknown");
	});
});

describe("sectionFromSignals — §2 classification (liveness first)", () => {
	test("running is always Live", () => {
		expect(sectionFromSignals(signals({ status: "running" }))).toBe("live");
	});

	test("a paused lane is Needs Review even while its process is still alive", () => {
		// Forward-compat for the M3 render engine (DESIGN-paused-lane-lifecycle-v2
		// §C4): paused is resolved ABOVE the livenessAlive short-circuit, so a
		// paused-but-alive lane never leaks back into Live.
		expect(
			sectionFromSignals(signals({ status: "paused", livenessAlive: true })),
		).toBe("review");
		expect(
			sectionFromSignals(signals({ status: "paused", livenessAlive: false })),
		).toBe("review");
	});

	test("AT3: detached-but-alive terminal lane is Live, not Action", () => {
		// status recorded terminal, but the session is positively alive — the
		// detached≠failed invariant keeps it Live.
		expect(
			sectionFromSignals(signals({ status: "failed", livenessAlive: true })),
		).toBe("live");
		expect(
			sectionFromSignals(signals({ status: "stopped", livenessAlive: true })),
		).toBe("live");
	});

	test("AT4: a dead failed lane is Action Required", () => {
		for (const status of [
			"failed",
			"stopped",
			"killed",
			"contract_failure",
		] as AgentTaskStatus[]) {
			expect(
				sectionFromSignals(signals({ status, livenessAlive: false })),
			).toBe("action");
		}
	});

	test("AT5: a finished, approved, dead lane is History", () => {
		expect(
			sectionFromSignals(
				signals({
					status: "completed",
					livenessAlive: false,
					awaitingReviewVerdict: false,
					reviewPipelineBroken: false,
				}),
			),
		).toBe("history");
	});

	test("AT6: a completed lane awaiting a review verdict is Needs Review", () => {
		expect(
			sectionFromSignals(
				signals({ status: "completed", awaitingReviewVerdict: true }),
			),
		).toBe("review");
	});

	test("completed_dirty / completed_stale are Needs Review", () => {
		expect(sectionFromSignals(signals({ status: "completed_dirty" }))).toBe(
			"review",
		);
		expect(sectionFromSignals(signals({ status: "completed_stale" }))).toBe(
			"review",
		);
	});

	test("AT7: a broken review pipeline is Action Required, not Needs Review", () => {
		// Even though the lane is also awaiting a verdict, the artifact a reviewer
		// needs never arrived — operator action takes precedence over review.
		expect(
			sectionFromSignals(
				signals({
					status: "completed",
					reviewPipelineBroken: true,
					awaitingReviewVerdict: true,
				}),
			),
		).toBe("action");
	});

	test("liveness wins even over a broken pipeline (alive is never Action)", () => {
		expect(
			sectionFromSignals(
				signals({
					status: "failed",
					livenessAlive: true,
					reviewPipelineBroken: true,
				}),
			),
		).toBe("live");
	});
});
