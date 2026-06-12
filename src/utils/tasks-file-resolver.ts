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
 *
 * Separately from the legacy quarantine, `commandCentral.laneRegistry.files`
 * names lane registry files for active Work Registry-backed lanes. The
 * setting defaults to {@link DEFAULT_LANE_REGISTRY_FILES} so registry-backed
 * lanes are visible zero-config; records read from lane registry files are
 * always restricted to registry-backed LaneRef records (`project_ref.id`
 * present) — see {@link resolveTaskRegistrySources}. Beyond that fixed
 * default, lane registry paths are never auto-detected, and an explicit
 * empty list reads nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

/**
 * Default lane registry files (`commandCentral.laneRegistry.files`), in
 * precedence order. Zero-config installs read these with the
 * `lane-records-only` filter, so only Work Registry-backed LaneRef records
 * (records carrying `project_ref.id`) can enter Agent Status — stale
 * launcher-era rows in the same files stay quarantined.
 *
 * Both entries are file bridges, not the end-state interface. OpenClaw has
 * no native lane concept today (`openclaw tasks` runtimes are subagent /
 * acp / cron / cli background runs; interactive launcher lanes are absent),
 * so lane producers write JSON registries and Command Central tails them.
 * The long-term primary source is the OpenClaw-native Work System
 * plugin/API — `workSystem.lanes.list` plus a per-session `workSystem`
 * projection from plugin session extensions — at which point these file
 * defaults retire behind a native service (like the existing
 * OpenClawTaskService/TaskFlowService consumers).
 *
 * - `~/.config/openclaw/lanes.json` — TRANSITIONAL bridge/outbox file in the
 *   OpenClaw config namespace. Not launcher-branded, but explicitly not
 *   final truth either.
 * - `~/.config/ghostty-launcher/tasks.json` — DEPRECATED launcher-branded
 *   compatibility fallback, kept only until the launcher mirrors LaneRef
 *   projection to the transitional bridge (or the native Work System
 *   projection lands). Never the product identity path.
 *
 * Must stay in sync with the `commandCentral.laneRegistry.files` default in
 * package.json (enforced by
 * `test/package-json/lane-registry-defaults-contract.test.ts`).
 */
export const DEFAULT_LANE_REGISTRY_FILES: readonly string[] = [
	"~/.config/openclaw/lanes.json",
	"~/.config/ghostty-launcher/tasks.json",
];

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
	/**
	 * Lane registry files (`commandCentral.laneRegistry.files`) for active
	 * Work Registry-backed lanes. Independent of the legacy quarantine and
	 * always ingested with the `lane-records-only` filter. Omitting the
	 * option applies {@link DEFAULT_LANE_REGISTRY_FILES}; pass an explicit
	 * empty array to read no lane registries.
	 */
	laneRegistryFiles?: readonly string[];
}

/**
 * How records from a registry file may enter Agent Status:
 * - `all`: every well-formed record (env override + legacy diagnostics opt-in).
 * - `lane-records-only`: only registry-backed LaneRef records (records carrying
 *   `project_ref.id`); legacy rows in the same file stay quarantined.
 */
export type TaskRegistryIngest = "all" | "lane-records-only";

export interface ResolvedTaskRegistrySource {
	path: string;
	ingest: TaskRegistryIngest;
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

/**
 * Resolve every task registry source with its record-level ingest mode.
 *
 * Env-override and legacy launcher paths (when the legacy opt-in is on)
 * resolve exactly as {@link resolveTasksFilePaths} and ingest every record.
 * `commandCentral.laneRegistry.files` paths — defaulting to
 * {@link DEFAULT_LANE_REGISTRY_FILES} when the option is omitted — are
 * appended with the `lane-records-only` filter so only Work Registry-backed
 * LaneRef records can enter Agent Status. A path resolved through both
 * channels keeps the wider `all` ingest (the legacy opt-in is the operator's
 * explicit diagnostics ask).
 */
export function resolveTaskRegistrySources(
	configValue: string,
	additionalConfigValues: readonly string[] = [],
	workspaceFolders?: readonly vscode.WorkspaceFolder[],
	options?: TasksFileResolverOptions,
): ResolvedTaskRegistrySource[] {
	const sources: ResolvedTaskRegistrySource[] = resolveTasksFilePaths(
		configValue,
		additionalConfigValues,
		workspaceFolders,
		options,
	).map((path) => ({ path, ingest: "all" }));

	const seen = new Set(sources.map((source) => source.path));
	const laneRegistryFiles =
		options?.laneRegistryFiles ?? DEFAULT_LANE_REGISTRY_FILES;
	for (const value of laneRegistryFiles) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const expanded = expandHome(trimmed);
		if (seen.has(expanded)) continue;
		seen.add(expanded);
		sources.push({ path: expanded, ingest: "lane-records-only" });
	}

	return sources;
}

/** Expand leading `~` to the user's home directory. */
function expandHome(p: string): string {
	if (p.startsWith("~")) {
		const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
		return path.join(home, p.slice(1));
	}
	return p;
}
