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
