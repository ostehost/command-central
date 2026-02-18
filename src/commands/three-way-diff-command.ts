/**
 * Three-Way Diff Command
 *
 * Opens three diff views side-by-side for files with both staged and unstaged changes (MM status).
 * This provides a comprehensive view of all file states:
 * - Column 1: HEAD ↔ Index (what's been staged)
 * - Column 2: Index ↔ Working Tree (what's not staged yet)
 * - Column 3: HEAD ↔ Working Tree (complete diff from last commit)
 *
 * PRD Reference: Product Requirements Document: Git Three-View File States
 * Implementation follows VS Code Git extension patterns for diff operations
 */

import * as path from "node:path";
import type * as vscode from "vscode";
import type { GitAPI, Repository } from "../types/git-extension.types.js";
import type { GitChangeItem } from "../types/tree-element.js";

/**
 * Opens three-way diff view for files with both staged and unstaged changes
 *
 * @param item - The git change item (must be MM status - staged-and-unstaged)
 * @param gitApi - The Git extension API (optional, will try to get if not provided)
 */
export async function openThreeWayDiff(
	item: GitChangeItem,
	gitApi: GitAPI | null,
): Promise<void> {
	// Dynamic import for testability
	const vscode = await import("vscode");
	// Validate that this is an MM file (both staged and unstaged)
	if (item.contextValue !== "staged-and-unstaged") {
		vscode.window.showWarningMessage(
			"Three-way diff is only available for files with both staged and unstaged changes.",
		);
		return;
	}

	// Ensure Git API is available
	if (!gitApi) {
		vscode.window.showErrorMessage(
			"Git extension not available. Please ensure Git extension is enabled.",
		);
		return;
	}

	try {
		// Find repository containing this file
		const repo = findRepositoryForFile(item.uri, gitApi);
		if (!repo) {
			vscode.window.showErrorMessage(
				`No repository found for ${item.uri.fsPath}`,
			);
			return;
		}

		// Find staged change (Index)
		const stagedChange = repo.state.indexChanges.find(
			(c) => c.uri?.fsPath === item.uri.fsPath,
		);

		if (!stagedChange?.originalUri || !stagedChange.uri) {
			vscode.window.showErrorMessage(
				`Could not find staged changes for ${path.basename(item.uri.fsPath)}`,
			);
			return;
		}

		// Find working tree change
		const workingChange = repo.state.workingTreeChanges.find(
			(c) => c.uri?.fsPath === item.uri.fsPath,
		);

		if (!workingChange?.uri) {
			vscode.window.showErrorMessage(
				`Could not find working tree changes for ${path.basename(item.uri.fsPath)}`,
			);
			return;
		}

		// Extract URIs for three-way comparison
		const headUri = stagedChange.originalUri; // HEAD version
		const indexUri = stagedChange.uri; // Staged (Index) version
		const workingUri = item.uri; // Working Tree version

		const filename = path.basename(item.uri.fsPath);

		// Open three diffs in columns (side-by-side)
		// Using ViewColumn to control editor placement

		// Column 1: HEAD ↔ Index (Staged changes)
		await vscode.commands.executeCommand(
			"vscode.diff",
			headUri,
			indexUri,
			`${filename} (HEAD ↔ Staged)`,
			{ viewColumn: vscode.ViewColumn.One },
		);

		// Column 2: Index ↔ Working Tree (Unstaged changes)
		await vscode.commands.executeCommand(
			"vscode.diff",
			indexUri,
			workingUri,
			`${filename} (Staged ↔ Working)`,
			{ viewColumn: vscode.ViewColumn.Two },
		);

		// Column 3: HEAD ↔ Working Tree (Complete changes)
		await vscode.commands.executeCommand(
			"vscode.diff",
			headUri,
			workingUri,
			`${filename} (HEAD ↔ Working)`,
			{ viewColumn: vscode.ViewColumn.Three },
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			`Failed to open three-way diff: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Finds the Git repository containing the specified file
 *
 * @param uri - File URI to find repository for
 * @param gitApi - Git API instance
 * @returns Repository containing the file, or undefined if not found
 */
function findRepositoryForFile(
	uri: vscode.Uri,
	gitApi: GitAPI,
): Repository | undefined {
	// Find repository whose root contains this file
	return gitApi.repositories.find((repo) => {
		const repoPath = repo.rootUri.fsPath;
		const filePath = uri.fsPath;
		return filePath.startsWith(repoPath);
	});
}
