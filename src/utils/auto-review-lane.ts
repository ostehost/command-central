import type { AgentTask } from "../providers/agent-status-tree-provider.js";

const AUTO_REVIEW_ID_PREFIX = "review-";
const TMP_REVIEW_DIR_PATTERN = /^\/tmp\/.*-review$/;

/**
 * Detects automatic review lanes spawned in temporary worktrees.
 *
 * Requires the project_dir to be a /tmp/*-review path (the defining
 * characteristic of launcher-spawned review worktrees) plus at least
 * one corroborating signal. Reviewer lanes in real project dirs are
 * never filtered — they are legitimate manual work.
 */
export function isAutoReviewLane(task: AgentTask): boolean {
	if (!TMP_REVIEW_DIR_PATTERN.test(task.project_dir)) return false;

	const hasReviewIdPrefix = task.id.startsWith(AUTO_REVIEW_ID_PREFIX);
	const isReviewerRole = task.role === "reviewer";
	const hasReviewHandoff = task.handoff_file?.includes("/REVIEW-") ?? false;

	return hasReviewIdPrefix || isReviewerRole || hasReviewHandoff;
}

/**
 * Detects a review-ONLY lane regardless of where it executed.
 *
 * Unlike {@link isAutoReviewLane} (which is deliberately narrow — it only
 * matches launcher-spawned review worktrees under `/tmp/*-review`, so that
 * reviewer lanes running in real project dirs are never *hidden* as
 * disposable auto-review noise), this predicate identifies any lane whose JOB
 * is to produce a review. It exists for lifecycle reconciliation, not
 * filtering: a reviewer lane is `no_review_expected` by disposition — its
 * handoff IS the review artifact and it is never itself reviewed — so callers
 * use this to (a) finalize a stale `running` reviewer row that already
 * delivered its artifact, and (b) suppress a false "review receipt missing"
 * gap for a lane that was never owed a receipt of itself.
 *
 * Signals, strongest first:
 *  - `role === "reviewer"` — the launcher's explicit role.
 *  - `lane_kind === "review"` — the Work System canonical lane kind.
 *  - `review-` id prefix CORROBORATED by a `/REVIEW-` handoff artifact — the
 *    weaker heuristics are required together so an implementation task that
 *    merely starts with `review-` is not misclassified as a reviewer lane.
 */
export function isReviewOnlyLane(task: AgentTask): boolean {
	if (task.role === "reviewer") return true;
	if (task.lane_kind?.trim().toLowerCase() === "review") return true;
	const hasReviewIdPrefix = task.id.startsWith(AUTO_REVIEW_ID_PREFIX);
	const hasReviewHandoff = task.handoff_file?.includes("/REVIEW-") ?? false;
	return hasReviewIdPrefix && hasReviewHandoff;
}

/**
 * Extracts the source task ID from an auto-review lane.
 * Convention: review lane id is `review-<sourceTaskId>`.
 * Returns null if the task is not an auto-review lane or has no prefix.
 */
export function extractSourceTaskId(task: AgentTask): string | null {
	if (!task.id.startsWith(AUTO_REVIEW_ID_PREFIX)) return null;
	const sourceId = task.id.slice(AUTO_REVIEW_ID_PREFIX.length);
	return sourceId.length > 0 ? sourceId : null;
}

/**
 * Partitions tasks into primary (visible) and auto-review (hidden) groups.
 */
export function partitionAutoReviewLanes(tasks: AgentTask[]): {
	primary: AgentTask[];
	reviewLanes: AgentTask[];
} {
	const primary: AgentTask[] = [];
	const reviewLanes: AgentTask[] = [];
	for (const task of tasks) {
		if (isAutoReviewLane(task)) {
			reviewLanes.push(task);
		} else {
			primary.push(task);
		}
	}
	return { primary, reviewLanes };
}
