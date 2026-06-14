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
