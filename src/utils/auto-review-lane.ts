import type { AgentTask } from "../providers/agent-status-tree-provider.js";

const AUTO_REVIEW_ID_PREFIX = "review-";
const TMP_REVIEW_DIR_PATTERN = /^\/tmp\/.*-review$/;

/**
 * Detects automatic review lanes spawned in temporary worktrees.
 * Uses multiple heuristics so the logic is robust even when launcher
 * metadata is incomplete (e.g. missing role or bogus project_id).
 *
 * Returns true when at least two of the four signals match:
 *   1. task id starts with "review-"
 *   2. role is "reviewer"
 *   3. project_dir is a /tmp/*-review path
 *   4. handoff_file contains "/REVIEW-"
 */
export function isAutoReviewLane(task: AgentTask): boolean {
	let signals = 0;
	if (task.id.startsWith(AUTO_REVIEW_ID_PREFIX)) signals++;
	if (task.role === "reviewer") signals++;
	if (TMP_REVIEW_DIR_PATTERN.test(task.project_dir)) signals++;
	if (task.handoff_file?.includes("/REVIEW-")) signals++;
	return signals >= 2;
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
