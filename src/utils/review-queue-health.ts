/**
 * Checks whether a task's advertised pending-review receipt exists on disk.
 *
 * Fail-open contract: only report "missing" on confirmed ENOENT or a
 * directory at the expected path. Any other filesystem error or invalid input
 * is "unknown" so the read-only UI does not falsely demote live work.
 *
 * Source-of-truth rule: a local file probe is only evidence about THIS
 * machine. Callers must gate the probe on the task having executed on the
 * current host (see isLocalFileProbeAuthoritative in
 * agent-task-classification.ts) and must let the task's own review metadata
 * win first (see {@link isReviewLifecycleResolved}): once the launcher
 * records the review as resolved, the receipt has been consumed by the
 * review flow and its absence is the expected steady state — not a queue gap.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type AdvertisedReviewQueueState =
	| "absent"
	| "present"
	| "missing"
	| "unknown";

export interface ReviewQueueTaskShape {
	project_dir: string;
	pending_review_path?: string | null;
}

export interface ReviewLifecycleShape {
	review_status?: string | null;
	review_state?: string | null;
}

/**
 * Launcher `review_state` values that mean the review cycle is over (or was
 * never expected), so the pending-review receipt has been legitimately
 * consumed/never written. The launcher vocabulary is pending / reviewing /
 * awaiting_fixup / blocked / reviewed / no_review_expected (see
 * ghostty-launcher oste-complete.sh and oste-review-watchdog-runner.sh).
 */
const RESOLVED_REVIEW_STATES = new Set(["reviewed", "no_review_expected"]);

/**
 * Whether the task's own metadata already settles the review lifecycle.
 *
 * When this returns true the absence of the advertised pending-review
 * receipt is expected (the review flow consumes it on approval), so the UI
 * must NOT surface "review queue pending" — regardless of what a local
 * filesystem probe says. Metadata is the authority; the probe is only a
 * health check for reviews that are still owed a receipt.
 */
export function isReviewLifecycleResolved(task: ReviewLifecycleShape): boolean {
	if (task.review_status === "approved") return true;
	const state = task.review_state?.trim().toLowerCase();
	return state !== undefined && RESOLVED_REVIEW_STATES.has(state);
}

export function checkAdvertisedReviewQueue(
	task: ReviewQueueTaskShape,
): AdvertisedReviewQueueState {
	const declared =
		typeof task.pending_review_path === "string"
			? task.pending_review_path.trim()
			: "";
	if (!declared) return "absent";

	const projectDir =
		typeof task.project_dir === "string" ? task.project_dir : "";

	let resolvedPath: string;
	try {
		if (path.isAbsolute(declared)) {
			resolvedPath = path.resolve(declared);
		} else {
			if (!projectDir) return "unknown";
			const projectRoot = path.resolve(projectDir);
			const candidate = path.resolve(projectRoot, declared);
			const rel = path.relative(projectRoot, candidate);
			if (rel.startsWith("..") || path.isAbsolute(rel)) return "unknown";
			resolvedPath = candidate;
		}
	} catch {
		return "unknown";
	}

	try {
		const stat = fs.statSync(resolvedPath);
		if (stat.isDirectory()) return "missing";
		return "present";
	} catch (err) {
		if (
			err !== null &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code?: unknown }).code === "ENOENT"
		) {
			return "missing";
		}
		return "unknown";
	}
}
