/**
 * Checks whether a task's advertised pending-review receipt exists on disk.
 *
 * Fail-open contract: only report "missing" on confirmed ENOENT or a
 * directory at the expected path. Any other filesystem error or invalid input
 * is "unknown" so the read-only UI does not falsely demote live work.
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
