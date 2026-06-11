/**
 * Tasks file resolver — resolves the path to the agent task registry (tasks.json).
 *
 * Launcher tasks.json ingestion is QUARANTINED by default: Ghostty Launcher
 * registries (explicit settings, workspace-local `.ghostty-launcher/tasks.json`,
 * and global `~/.config/ghostty-launcher` / `~/.ghostty-launcher` locations)
 * are only consulted when the legacy diagnostics escape hatch
 * (`commandCentral.legacyLauncherTasks.enabled`) is explicitly turned on.
 *
 * The `TASKS_FILE` environment variable remains an unconditional override: it
 * is a per-process, explicit injection used by hermetic tests and dev-host
 * fixtures, and it never falls back to operator-global registries.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

/** Well-known auto-detect search locations (relative to home dir). */
const AUTO_DETECT_CANDIDATES = [
	// 1. XDG config standard
	() => path.join(os.homedir(), ".config", "ghostty-launcher", "tasks.json"),
	// 2. Simple home dir
	() => path.join(os.homedir(), ".ghostty-launcher", "tasks.json"),
];

export interface TasksFileResolverOptions {
	/** Env override input for hermetic tests and dev-host fixtures. */
	envTasksFile?: string | undefined;
	/**
	 * Legacy launcher diagnostics opt-in (`commandCentral.legacyLauncherTasks.enabled`).
	 * Default `false`: launcher tasks.json registries are never resolved.
	 */
	legacyLauncherEnabled?: boolean;
}

/**
 * Resolve the tasks file path from configuration or auto-detection.
 *
 * @param configValue - The value of `commandCentral.agentTasksFile` (may be empty).
 * @param workspaceFolders - Current VS Code workspace folders in precedence order.
 * @param options - Env override and legacy launcher opt-in.
 * @returns The resolved absolute path, or `null` if no tasks file was found
 *   (always `null` when legacy launcher ingestion is disabled and no
 *   `TASKS_FILE` override is present).
 */
export function resolveTasksFilePath(
	configValue: string,
	workspaceFolders?: readonly vscode.WorkspaceFolder[],
	options?: TasksFileResolverOptions,
): string | null {
	const envTasksFile = options?.envTasksFile ?? process.env["TASKS_FILE"];
	if (envTasksFile && envTasksFile.trim() !== "") {
		const expandedEnvTasksFile = expandHome(envTasksFile.trim());
		if (fs.existsSync(expandedEnvTasksFile)) {
			return expandedEnvTasksFile;
		}
	}

	// Quarantine: launcher registries (settings, workspace-local, global) are
	// legacy diagnostics only — never resolved without the explicit opt-in.
	if (options?.legacyLauncherEnabled !== true) {
		return null;
	}

	// If the user configured an explicit path, use it (with ~ expansion)
	if (configValue && configValue.trim() !== "") {
		return expandHome(configValue.trim());
	}

	// Workspace-local files win over global auto-detect locations.
	for (const workspaceFolder of workspaceFolders ?? []) {
		const workspaceFolderPath = workspaceFolder.uri.fsPath;
		if (!workspaceFolderPath) continue;

		const candidate = path.join(
			workspaceFolderPath,
			".ghostty-launcher",
			"tasks.json",
		);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	// Auto-detect: check each global candidate in priority order.
	for (const candidateFn of AUTO_DETECT_CANDIDATES) {
		const candidate = candidateFn();
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

/**
 * Resolve the primary tasks file plus any additional read-only registry files.
 *
 * Additional paths are explicit only. They do not participate in auto-detection,
 * and — like the primary launcher resolution — they are ignored entirely unless
 * legacy launcher ingestion is enabled.
 */
export function resolveTasksFilePaths(
	configValue: string,
	additionalConfigValues: readonly string[] = [],
	workspaceFolders?: readonly vscode.WorkspaceFolder[],
	options?: TasksFileResolverOptions,
): string[] {
	const paths: string[] = [];
	const primary = resolveTasksFilePath(configValue, workspaceFolders, options);
	if (primary) paths.push(primary);

	if (options?.legacyLauncherEnabled === true) {
		for (const value of additionalConfigValues) {
			const trimmed = value.trim();
			if (!trimmed) continue;
			paths.push(expandHome(trimmed));
		}
	}

	return Array.from(new Set(paths));
}

/** Expand leading `~` to the user's home directory. */
function expandHome(p: string): string {
	if (p.startsWith("~")) {
		const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
		return path.join(home, p.slice(1));
	}
	return p;
}
