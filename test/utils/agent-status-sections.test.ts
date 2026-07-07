import { describe, expect, test } from "bun:test";
import type {
	AgentStatusGroup,
	AgentTaskStatus,
} from "../../src/providers/agent-status-tree-provider.js";
import {
	AGENT_STATUS_GROUP_TO_SECTION,
	countV2Sections,
	emptyUnifiedCounts,
	formatV2Summary,
	hasReadOnlyCompletionEvidence,
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
