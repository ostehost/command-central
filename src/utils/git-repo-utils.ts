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
		// Direct match (exact or path prefix with separator)
		if (filePath === repoPath || filePath.startsWith(`${repoPath}/`)) {
			return true;
		}
		// Symlink-resolved match (e.g., macOS /tmp → /private/tmp)
		try {
			const resolvedFile = fsSync.realpathSync(filePath);
			const resolvedRepo = fsSync.realpathSync(repoPath);
			return (
				resolvedFile === resolvedRepo ||
				resolvedFile.startsWith(`${resolvedRepo}/`)
			);
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
	const filePathWithSep = filePath.endsWith("/") ? filePath : `${filePath}/`;

	const nestedRepos = gitApi.repositories.filter((r) => {
		const repoPath = r.rootUri.fsPath;
		if (repoPath.startsWith(filePathWithSep)) {
			return true;
		}
		// Symlink-resolved match
		try {
			const resolvedFile = fsSync.realpathSync(filePath);
			const resolvedFileSep = resolvedFile.endsWith("/")
				? resolvedFile
				: `${resolvedFile}/`;
			const resolvedRepo = fsSync.realpathSync(repoPath);
			return resolvedRepo.startsWith(resolvedFileSep);
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
