import * as path from "node:path";
import type { Uri } from "vscode";
import { getDisplayName } from "./extension-display-names";

/**
 * Represents metadata about a file extension across workspaces
 */
export interface FileExtensionInfo {
	/** File extension including dot (e.g., ".ts", ".md") or empty string for no extension */
	extension: string;

	/** Human-readable name (e.g., "TypeScript", "Markdown") */
	displayName: string;

	/** Per-workspace file counts */
	workspaceCounts: Map<string, number>;

	/** Total count across all workspaces */
	totalCount: number;
}

/**
 * Represents a Git change item with at minimum a URI
 * (Simplified interface - actual Git extension provides more properties)
 */
export interface GitChangeItem {
	uri: Uri;
	// Additional properties from Git API can be added as needed
}

/**
 * Workspace data structure for counting extensions
 */
export interface WorkspaceChanges {
	workspace: string;
	changes: GitChangeItem[];
}

/**
 * Counts file extensions per workspace
 *
 * @param workspaceData - Array of workspace changes
 * @returns Map of extension -> Map of workspace ID -> count
 */
export function countExtensionsByWorkspace(
	workspaceData: WorkspaceChanges[],
): Map<string, Map<string, number>> {
	const result = new Map<string, Map<string, number>>();

	for (const { workspace, changes } of workspaceData) {
		for (const change of changes) {
			// Extract and normalize extension
			const ext = path.extname(change.uri.fsPath).toLowerCase();

			// Get or create workspace counts map for this extension
			if (!result.has(ext)) {
				result.set(ext, new Map());
			}

			const workspaceCounts = result.get(ext);
			if (workspaceCounts) {
				const currentCount = workspaceCounts.get(workspace) || 0;
				workspaceCounts.set(workspace, currentCount + 1);
			}
		}
	}

	return result;
}

/**
 * Builds complete extension metadata from extension counts
 *
 * @param extensionCounts - Map of extension -> workspace counts
 * @returns Sorted array of FileExtensionInfo objects
 */
export function buildExtensionMetadata(
	extensionCounts: Map<string, Map<string, number>>,
): FileExtensionInfo[] {
	const result: FileExtensionInfo[] = [];

	for (const [extension, workspaceCounts] of extensionCounts) {
		// Calculate total count across all workspaces
		let totalCount = 0;
		for (const count of workspaceCounts.values()) {
			totalCount += count;
		}

		// Create metadata object with human-readable display name
		result.push({
			extension,
			displayName: getDisplayName(extension),
			workspaceCounts,
			totalCount,
		});
	}

	// Sort alphabetically by extension
	return result.sort((a, b) => a.extension.localeCompare(b.extension));
}
