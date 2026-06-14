import { describe, expect, test } from "bun:test";
import type {
	AgentStatusGroup,
	AgentTaskStatus,
} from "../../src/providers/agent-status-tree-provider.js";
import {
	AGENT_STATUS_GROUP_TO_SECTION,
	type UnifiedCounts,
	type V2SectionSignals,
	countV2Sections,
	emptyUnifiedCounts,
	formatV2Summary,
	formatV2SummaryCompact,
	sectionFromSignals,
	sectionFromStatusGroup,
	unifiedBadgeCount,
	unifiedCountTotal,
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

describe("formatV2Summary (root) — explicit live, no 'none active'", () => {
	test("AT1: renders live/review/action/history in canonical order", () => {
		const counts: UnifiedCounts = {
			live: 2,
			review: 1,
			action: 1,
			history: 47,
		};
		expect(formatV2Summary(counts)).toBe(
			"live: 2 · review: 1 · action: 1 · history: 47",
		);
	});

	test("AT2: zero live renders explicit live:0 and retains history; never 'none active'", () => {
		const counts: UnifiedCounts = {
			live: 0,
			review: 0,
			action: 0,
			history: 101,
		};
		const label = formatV2Summary(counts);
		expect(label.startsWith("live: 0")).toBe(true);
		expect(label).toContain("history: 101");
		expect(label).not.toContain("none active");
		expect(label).toBe("live: 0 · review: 0 · action: 0 · history: 101");
	});
});

describe("formatV2SummaryCompact (dense rows) — live always explicit", () => {
	test("shows live plus only the non-zero sections", () => {
		expect(
			formatV2SummaryCompact({ live: 1, review: 0, action: 1, history: 5 }),
		).toBe("live: 1 · action: 1 · history: 5");
	});

	test("history-only project still states live:0 explicitly", () => {
		expect(
			formatV2SummaryCompact({ live: 0, review: 0, action: 0, history: 12 }),
		).toBe("live: 0 · history: 12");
	});

	test("never emits 'none active' even when everything but live is zero", () => {
		const label = formatV2SummaryCompact(emptyUnifiedCounts());
		expect(label).toBe("live: 0");
		expect(label).not.toContain("none active");
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

describe("sectionFromSignals — §2 classification (liveness first)", () => {
	test("running is always Live", () => {
		expect(sectionFromSignals(signals({ status: "running" }))).toBe("live");
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
