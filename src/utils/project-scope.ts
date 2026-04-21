import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Canonicalize project paths so symlink aliases (/tmp vs /private/tmp, linked
 * worktrees, etc.) compare consistently across launcher and discovery inputs.
 *
 * We only canonicalize absolute paths. If the path no longer exists (or cannot
 * be resolved), fall back to the original string so read-side normalization
 * never hides the underlying task/agent.
 */
export function canonicalizeProjectDir(projectDir: string): string {
	if (!projectDir || !path.isAbsolute(projectDir)) {
		return projectDir;
	}

	try {
		return fs.realpathSync(projectDir);
	} catch {
		return projectDir;
	}
}
