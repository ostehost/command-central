/**
 * Shared Git repository utilities
 *
 * Extracted from SortedGitChangesProvider to avoid duplication.
 * Used by both sorted-changes-provider.ts and three-way-diff-command.ts.
 */

import * as fsSync from "node:fs";
import type * as vscode from "vscode";
import type { GitAPI, Repository } from "../types/git-extension.types.js";

/**
 * Cross-platform path containment check.
 *
 * Treats both POSIX (`/`) and Windows (`\`) separators as boundaries, so it
 * works regardless of the OS that produced the fsPath (and regardless of the
 * OS the code runs on — `node:path` is platform-locked, but a VS Code fsPath
 * carries native separators we must honor either way).
 *
 * A path is "inside" another when it equals the parent OR is the parent
 * followed by a separator and at least one more character. Trailing
 * separators on the parent are tolerated so callers need not normalize.
 *
 * @param parent - Candidate ancestor path
 * @param child - Candidate descendant path
 * @returns true if child equals parent or is nested under it
 */
function isPathInside(parent: string, child: string): boolean {
	const isSep = (c: string | undefined): boolean => c === "/" || c === "\\";
	// Strip any trailing separator(s) from the parent for a stable boundary.
	let end = parent.length;
	while (end > 0 && isSep(parent[end - 1])) {
		end--;
	}
	const base = parent.slice(0, end);
	if (child === base) {
		return true;
	}
	return (
		child.length > base.length &&
		child.startsWith(base) &&
		isSep(child[base.length])
	);
}

/**
 * Finds the repository that contains the given file URI
 * Uses longest-match strategy for multi-root workspaces
 *
 * Supports two scenarios:
 * 1. File/folder inside repo: /repo/src/file.ts → finds repo at /repo
 * 2. Nested repo: workspace at /parent, repo at /parent/sub → finds repo at /parent/sub
 *    (VS Code's git extension auto-discovers nested repos via git.autoRepositoryDetection)
 *
 * @param uri - File URI to find repository for
 * @param gitApi - Git API instance
 * @returns Repository containing the file, or undefined if not found
 */
export function findRepositoryForFile(
	uri: vscode.Uri,
	gitApi: GitAPI,
): Repository | undefined {
	const filePath = uri.fsPath;

	// Sort by longest path first (most specific match wins in multi-root workspaces)
	const sorted = gitApi.repositories
		.slice()
		.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);

	// Strategy 1: Find repo that CONTAINS this path (file/folder inside repo)
	const containingRepo = sorted.find((r) => {
		const repoPath = r.rootUri.fsPath;
		// Direct match (exact or path prefix with separator, POSIX or Windows)
		if (isPathInside(repoPath, filePath)) {
			return true;
		}
		// Symlink-resolved match (e.g., macOS /tmp → /private/tmp)
		try {
			const resolvedFile = fsSync.realpathSync(filePath);
			const resolvedRepo = fsSync.realpathSync(repoPath);
			return isPathInside(resolvedRepo, resolvedFile);
		} catch {
			return false;
		}
	});

	if (containingRepo) {
		return containingRepo;
	}

	// Strategy 2: Find repo that IS CONTAINED BY this path (nested repo case)
	// Handles workspaces where the git root is in a subdirectory of the workspace folder
	// e.g., workspace = ~/.openclaw, repo = ~/.openclaw/workspace
	// Pick the shallowest nested repo (closest to workspace root)
	const nestedRepos = gitApi.repositories.filter((r) => {
		const repoPath = r.rootUri.fsPath;
		// Reverse containment: repo root is strictly nested under filePath.
		// (Equality is handled by Strategy 1, so we exclude it here.)
		if (repoPath !== filePath && isPathInside(filePath, repoPath)) {
			return true;
		}
		// Symlink-resolved match
		try {
			const resolvedFile = fsSync.realpathSync(filePath);
			const resolvedRepo = fsSync.realpathSync(repoPath);
			return (
				resolvedRepo !== resolvedFile &&
				isPathInside(resolvedFile, resolvedRepo)
			);
		} catch {
			return false;
		}
	});

	if (nestedRepos.length > 0) {
		// Sort by shallowest first (shortest path = closest to workspace root)
		nestedRepos.sort(
			(a, b) => a.rootUri.fsPath.length - b.rootUri.fsPath.length,
		);
		return nestedRepos[0];
	}

	return undefined;
}
