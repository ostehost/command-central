/**
 * Tasks file resolver — resolves the path to the agent task registry (tasks.json).
 *
 * When the user has configured an explicit path, that is used directly.
 * Otherwise, auto-detection searches well-known locations in priority order.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

/** Well-known auto-detect search locations (relative to home dir or workspace). */
const AUTO_DETECT_CANDIDATES = [
	// 1. Project-local (per-workspace)
	(workspaceFolder: string) =>
		path.join(workspaceFolder, ".ghostty-launcher", "tasks.json"),
	// 2. XDG config standard
	() =>
		path.join(os.homedir(), ".config", "ghostty-launcher", "tasks.json"),
	// 3. Simple home dir
	() => path.join(os.homedir(), ".ghostty-launcher", "tasks.json"),
];

/**
 * Resolve the tasks file path from configuration or auto-detection.
 *
 * @param configValue - The value of `commandCentral.agentTasksFile` (may be empty).
 * @param workspaceFolders - Current VS Code workspace folders (for project-local detection).
 * @returns The resolved absolute path, or `null` if no tasks file was found.
 */
export function resolveTasksFilePath(
	configValue: string,
	workspaceFolders?: readonly vscode.WorkspaceFolder[],
): string | null {
	// If the user configured an explicit path, use it (with ~ expansion)
	if (configValue && configValue.trim() !== "") {
		return expandHome(configValue.trim());
	}

	// Auto-detect: check each candidate in priority order
	const workspacePaths =
		workspaceFolders?.map((f) => f.uri.fsPath) ?? [];

	for (const candidateFn of AUTO_DETECT_CANDIDATES) {
		// For workspace-local candidates, check each workspace folder
		if (candidateFn.length > 0) {
			for (const wsPath of workspacePaths) {
				const candidate = candidateFn(wsPath);
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		} else {
			const candidate = (candidateFn as () => string)();
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return null;
}

/** Expand leading `~` to the user's home directory. */
function expandHome(p: string): string {
	if (p.startsWith("~")) {
		const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
		return path.join(home, p.slice(1));
	}
	return p;
}
