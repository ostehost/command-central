/**
 * handoff-file-health.ts
 *
 * Checks whether a task's declared handoff/report file actually exists on disk.
 *
 * Conservative fail-open contract: only returns `"missing"` on confirmed ENOENT
 * (or a directory at the expected path). Any other filesystem error, invalid
 * shape, or path traversal attempt → `"unknown"`. A live-but-undocumented lane
 * must never be falsely demoted.
 *
 * States:
 *  - `"absent"`  — no declaration; task didn't promise a handoff file.
 *  - `"present"` — declared file exists and is a regular file.
 *  - `"missing"` — declaration exists, but confirmed ENOENT (or path is a directory).
 *  - `"unknown"` — cannot verify (any other error, invalid input, traversal).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type DeclaredHandoffState = "absent" | "present" | "missing" | "unknown";

export interface HandoffTaskShape {
	project_dir: string;
	handoff_file?: string | null;
}

export function checkDeclaredHandoff(
	task: HandoffTaskShape,
): DeclaredHandoffState {
	const declared =
		typeof task.handoff_file === "string" ? task.handoff_file.trim() : "";
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
			if (rel.startsWith("..") || path.isAbsolute(rel)) {
				return "unknown";
			}
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
