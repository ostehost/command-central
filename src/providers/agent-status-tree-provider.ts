/**
 * AgentStatusTreeProvider - TreeView provider for Ghostty launcher agent status
 *
 * Reads a JSON task registry (tasks.json) and displays agent tasks in a tree:
 * - Root items: task ID + status + project name + time elapsed
 * - Child items: prompt file, worktree path, attempt count, PR info
 *
 * Watches the file for changes and auto-refreshes.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AgentRegistry } from "../discovery/agent-registry.js";
import type { DiscoveredAgent } from "../discovery/types.js";
import type { AgentEvent } from "../events/agent-events.js";
import { ProjectIconManager } from "../services/project-icon-manager.js";
import {
	type AgentCounts,
	countAgentStatuses,
	formatCountSummary,
} from "../utils/agent-counts.js";
import type { ListeningPort } from "../utils/port-detector.js";
import { detectListeningPortsAsync } from "../utils/port-detector.js";
import { resolveTasksFilePath } from "../utils/tasks-file-resolver.js";

export type { AgentEvent } from "../events/agent-events.js";

/** Validate session ID to prevent shell injection */
export function isValidSessionId(name: string): boolean {
	return /^[a-zA-Z0-9._-]+$/.test(name);
}

/** @deprecated Use isValidSessionId */
export const isValidTmuxSession = isValidSessionId;

// ── Task registry types ──────────────────────────────────────────────

export interface TaskRegistry {
	version: number;
	tasks: Record<string, AgentTask>;
}

export type AgentTaskStatus =
	| "running"
	| "stopped"
	| "killed"
	| "completed"
	| "completed_dirty"
	| "completed_stale"
	| "failed"
	| "contract_failure";

export type AgentRole = "developer" | "planner" | "reviewer" | "test";
export type AgentStatusScope = "all" | "currentProject";
export type AgentStatusSortMode = "recency" | "status" | "status-recency";

export interface AgentTask {
	id: string;
	status: AgentTaskStatus;
	project_dir: string;
	project_name: string;
	session_id: string;
	stream_file?: string | null;
	agent_backend?: string | null;
	cli_name?: string | null;
	tmux_session?: string;
	bundle_path: string;
	prompt_file: string;
	started_at: string;
	start_sha?: string | null;
	start_commit?: string | null;
	attempts: number;
	max_attempts: number;
	pr_number?: number | null;
	review_status?: "pending" | "approved" | "changes_requested" | null;
	role?: AgentRole | null;
	terminal_backend?: "tmux" | "persist" | "applescript";
	ghostty_bundle_id?: string | null;
	project_icon?: string | null;
	exit_code?: number | null;
	error_message?: string | null;
	completed_at?: string | null;
}

// ── Tree node types ──────────────────────────────────────────────────

export type AgentNode =
	| SummaryNode
	| TreeElement
	| DetailNode
	| FileChangeNode
	| DiscoveredNode
	| OlderRunsNode
	| StateNode;

export interface SummaryNode {
	type: "summary";
	label: string;
	tooltip?: string;
}

export interface TaskNode {
	type: "task";
	task: AgentTask;
}

export interface ProjectGroupNode {
	type: "projectGroup";
	projectName: string;
	projectDir?: string;
	tasks: AgentTask[];
	discoveredAgents?: DiscoveredAgent[];
	parentGroupKey?: string;
	parentGroupName?: string;
}

export interface FolderGroupNode {
	type: "folderGroup";
	groupKey: string;
	groupName: string;
	projectCount: number;
	projects: ProjectGroupNode[];
}

export type TreeElement = TaskNode | ProjectGroupNode | FolderGroupNode;

export interface DetailNode {
	type: "detail";
	label: string;
	value: string;
	taskId: string;
	description?: string;
	icon?: string;
	iconColor?: string;
}

export interface PerFileDiff {
	filePath: string;
	additions: number;
	deletions: number;
}

export interface FileChangeNode {
	type: "fileChange";
	taskId: string;
	projectDir: string;
	filePath: string;
	additions: number;
	deletions: number;
	taskStatus: AgentTask["status"];
	startCommit?: string;
}

export interface DiscoveredNode {
	type: "discovered";
	agent: DiscoveredAgent;
}

export interface OlderRunsNode {
	type: "olderRuns";
	label: string;
	hiddenNodes: SortableAgentNode[];
	parentProjectName?: string;
	parentProjectDir?: string;
	parentGroupKey?: string;
}

export interface StateNode {
	type: "state";
	label: string;
	description?: string;
	icon?: string;
}

type SortableAgentNode =
	| { type: "task"; task: AgentTask }
	| { type: "discovered"; agent: DiscoveredAgent };

// ── Agent type detection for discovered agents ───────────────────────

export type AgentType = "claude" | "codex" | "gemini" | "unknown";

type AgentTypeDetectionInput = {
	agent_backend?: string | null;
	cli_name?: string | null;
	process_name?: string | null;
	command?: string | null;
	model?: string | null;
	session_id?: string | null;
	id?: string | null;
};

function detectAgentTypeFromText(value: string): AgentType {
	if (
		value.includes("claude") ||
		value.includes("anthropic") ||
		value.includes("sonnet") ||
		value.includes("opus") ||
		value.includes("haiku")
	) {
		return "claude";
	}
	if (
		value.includes("codex") ||
		value.includes("openai") ||
		value.includes("gpt") ||
		/\bo1\b/.test(value) ||
		/\bo3\b/.test(value) ||
		/\bo4\b/.test(value)
	) {
		return "codex";
	}
	if (value.includes("gemini") || value.includes("google")) {
		return "gemini";
	}
	return "unknown";
}

function extractProcessName(command?: string | null): string {
	if (!command) return "";
	const [firstToken] = command.trim().split(/\s+/);
	if (!firstToken) return "";
	return path.basename(firstToken).toLowerCase();
}

export function detectAgentType(agent: AgentTypeDetectionInput): AgentType {
	const explicitHints = [
		agent.agent_backend,
		agent.cli_name,
		agent.process_name,
		extractProcessName(agent.command),
	];
	for (const hint of explicitHints) {
		if (!hint) continue;
		const detected = detectAgentTypeFromText(hint.toLowerCase());
		if (detected !== "unknown") return detected;
	}

	const fallbackHints = [
		agent.command,
		agent.model,
		agent.session_id,
		agent.id,
	];
	for (const hint of fallbackHints) {
		if (!hint) continue;
		const detected = detectAgentTypeFromText(hint.toLowerCase());
		if (detected !== "unknown") return detected;
	}

	return "unknown";
}

export function getAgentTypeIcon(
	agent: DiscoveredAgent | AgentTask | AgentTypeDetectionInput,
): vscode.ThemeIcon {
	const type = detectAgentType(agent);
	switch (type) {
		case "claude":
			return new vscode.ThemeIcon(
				"hubot",
				new vscode.ThemeColor("charts.purple"),
			);
		case "codex":
			return new vscode.ThemeIcon(
				"hubot",
				new vscode.ThemeColor("charts.green"),
			);
		case "gemini":
			return new vscode.ThemeIcon(
				"hubot",
				new vscode.ThemeColor("charts.blue"),
			);
		default:
			return new vscode.ThemeIcon("hubot");
	}
}

export function getStatusThemeIcon(
	status: AgentTask["status"],
): vscode.ThemeIcon {
	switch (status) {
		case "running":
			return new vscode.ThemeIcon(
				"sync~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "completed":
		case "completed_dirty":
			return new vscode.ThemeIcon(
				"check",
				new vscode.ThemeColor("charts.green"),
			);
		case "completed_stale":
			return new vscode.ThemeIcon(
				"check-all",
				new vscode.ThemeColor("charts.green"),
			);
		case "failed":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		case "contract_failure":
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.orange"),
			);
		case "stopped":
			return new vscode.ThemeIcon(
				"debug-stop",
				new vscode.ThemeColor("charts.purple"),
			);
		case "killed":
			return new vscode.ThemeIcon("close", new vscode.ThemeColor("charts.red"));
		default:
			return new vscode.ThemeIcon("circle-outline");
	}
}

function getStatusDisplayLabel(status: AgentTaskStatus): string {
	switch (status) {
		case "completed_dirty":
			return "completed (dirty)";
		case "completed_stale":
			return "completed (stale)";
		case "contract_failure":
			return "contract failure";
		default:
			return status;
	}
}

const ROLE_ICONS: Record<AgentRole, string> = {
	planner: "🔬",
	developer: "🔨",
	reviewer: "🔍",
	test: "🧪",
};

// ── Elapsed time formatting ──────────────────────────────────────────

export function formatElapsed(startedAt: string, now?: Date): string {
	const start = new Date(startedAt).getTime();
	const current = (now ?? new Date()).getTime();
	const diffMs = Math.max(0, current - start);
	const totalSeconds = Math.floor(diffMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	if (hours > 0) {
		if (minutes === 0) {
			return `${hours}h`;
		}
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

function getStatusElapsedReference(task: AgentTask): string {
	if (task.status === "running") {
		return task.started_at;
	}
	return task.completed_at ?? task.started_at;
}

export function formatTaskElapsedDescription(task: AgentTask): string {
	const elapsed = formatElapsed(getStatusElapsedReference(task));
	switch (task.status) {
		case "running":
			return `Running for ${elapsed}`;
		case "completed":
		case "completed_dirty":
		case "completed_stale":
			return `Completed ${elapsed} ago`;
		case "failed":
			return `Failed ${elapsed} ago`;
		case "contract_failure":
			return `Contract failure ${elapsed} ago`;
		case "stopped":
			return `Stopped ${elapsed} ago`;
		case "killed":
			return `Killed ${elapsed} ago`;
		default:
			return `Failed ${elapsed} ago`;
	}
}

// ── Task normalization (v1 → v2) ─────────────────────────────────────

const VALID_TASK_STATUSES = new Set<AgentTaskStatus>([
	"running",
	"stopped",
	"killed",
	"completed",
	"completed_dirty",
	"completed_stale",
	"failed",
	"contract_failure",
]);

const TASK_STATUS_PRIORITY: Record<AgentTaskStatus, number> = {
	failed: 0,
	killed: 1,
	contract_failure: 2,
	running: 3,
	stopped: 4,
	completed: 5,
	completed_dirty: 6,
	completed_stale: 7,
};

const AGENT_STATUS_SORT_MODES: AgentStatusSortMode[] = [
	"recency",
	"status",
	"status-recency",
];

const SORT_MODE_INDICATOR_LABELS: Record<AgentStatusSortMode, string> = {
	recency: "↓ Recent",
	status: "⚠ Status",
	"status-recency": "▶ Active",
};

type SortModeConfig = Pick<vscode.WorkspaceConfiguration, "get"> & {
	inspect?: vscode.WorkspaceConfiguration["inspect"];
};

function isAgentStatusSortMode(value: unknown): value is AgentStatusSortMode {
	return (
		typeof value === "string" &&
		AGENT_STATUS_SORT_MODES.includes(value as AgentStatusSortMode)
	);
}

function getExplicitSortMode(
	config: SortModeConfig,
): AgentStatusSortMode | undefined {
	if (typeof config.inspect === "function") {
		const inspected = config.inspect("agentStatus.sortMode");
		const explicitValue =
			inspected?.workspaceFolderValue ??
			inspected?.workspaceValue ??
			inspected?.globalValue;
		return isAgentStatusSortMode(explicitValue) ? explicitValue : undefined;
	}

	const rawValue = config.get<unknown>("agentStatus.sortMode");
	return isAgentStatusSortMode(rawValue) ? rawValue : undefined;
}

export function resolveAgentStatusSortMode(
	config: SortModeConfig,
): AgentStatusSortMode {
	const explicitSortMode = getExplicitSortMode(config);
	if (explicitSortMode) {
		return explicitSortMode;
	}

	return config.get<boolean>("agentStatus.sortByStatus", false)
		? "status"
		: "recency";
}

export function getNextAgentStatusSortMode(
	currentMode: AgentStatusSortMode,
): AgentStatusSortMode {
	const currentIndex = AGENT_STATUS_SORT_MODES.indexOf(currentMode);
	const nextIndex =
		currentIndex === -1
			? 0
			: (currentIndex + 1) % AGENT_STATUS_SORT_MODES.length;
	return AGENT_STATUS_SORT_MODES[nextIndex] ?? "recency";
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function asNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return value;
}

function asNullableNumber(value: unknown): number | null | undefined {
	if (value === null) return null;
	if (typeof value !== "number" || Number.isNaN(value)) return undefined;
	return value;
}

function normalizeTask(
	taskKey: string,
	raw: Record<string, unknown>,
): AgentTask | null {
	const sessionId = asString(raw["session_id"] ?? raw["tmux_session"]);
	if (!sessionId) return null;

	const id = asString(raw["id"]) ?? taskKey;
	const statusRaw = asString(raw["status"]);
	const status: AgentTaskStatus =
		!statusRaw || statusRaw === "active"
			? "running"
			: VALID_TASK_STATUSES.has(statusRaw as AgentTaskStatus)
				? (statusRaw as AgentTaskStatus)
				: "stopped";
	const projectDir = asString(raw["project_dir"]) ?? "";
	const projectName =
		asString(raw["project_name"]) ??
		(path.basename(projectDir) || "(unknown project)");
	const bundlePath = asString(raw["bundle_path"]) ?? "(unknown)";
	const promptFile = asString(raw["prompt_file"]) ?? "";

	return {
		id,
		status,
		project_dir: projectDir,
		project_name: projectName,
		session_id: sessionId,
		stream_file: asString(raw["stream_file"]) ?? null,
		agent_backend: asString(raw["agent_backend"]) ?? null,
		cli_name: asString(raw["cli_name"]) ?? null,
		tmux_session: asString(raw["tmux_session"]),
		bundle_path: bundlePath,
		prompt_file: promptFile,
		started_at: asString(raw["started_at"]) ?? new Date().toISOString(),
		start_sha: asString(raw["start_sha"]) ?? null,
		start_commit: asString(raw["start_commit"]) ?? null,
		attempts: Math.max(0, asNumber(raw["attempts"], 0)),
		max_attempts: Math.max(0, asNumber(raw["max_attempts"], 0)),
		pr_number: asNullableNumber(raw["pr_number"]) ?? null,
		review_status:
			raw["review_status"] === "pending" ||
			raw["review_status"] === "approved" ||
			raw["review_status"] === "changes_requested"
				? raw["review_status"]
				: null,
		role:
			raw["role"] === "developer" ||
			raw["role"] === "planner" ||
			raw["role"] === "reviewer" ||
			raw["role"] === "test"
				? raw["role"]
				: null,
		terminal_backend:
			raw["terminal_backend"] === "tmux" ||
			raw["terminal_backend"] === "persist" ||
			raw["terminal_backend"] === "applescript"
				? raw["terminal_backend"]
				: undefined,
		ghostty_bundle_id: asString(raw["ghostty_bundle_id"]) ?? null,
		project_icon: asString(raw["project_icon"]) ?? null,
		exit_code: asNullableNumber(raw["exit_code"]) ?? null,
		error_message: asString(raw["error_message"]) ?? null,
		completed_at: asString(raw["completed_at"]) ?? null,
	};
}

// ── Provider ─────────────────────────────────────────────────────────

export interface GitInfo {
	branch: string;
	lastCommit: string;
}

export class AgentStatusTreeProvider
	implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable
{
	private static readonly GIT_DIFF_TIMEOUT_MS = 1_500;
	private static readonly STUCK_THRESHOLD_DEFAULT_MINUTES = 15;
	private static readonly STUCK_THRESHOLD_MIN_MINUTES = 5;
	private static readonly STUCK_THRESHOLD_MAX_MINUTES = 60;
	private static readonly MAX_VISIBLE_AGENTS_DEFAULT = 50;
	private static readonly MAX_VISIBLE_AGENTS_MIN = 10;
	private static readonly MAX_VISIBLE_AGENTS_MAX = 500;
	private static readonly STREAM_BACKEND_PREFIXES = [
		"claude",
		"codex",
		"gemini",
	];

	private _onDidChangeTreeData = new vscode.EventEmitter<
		AgentNode | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _onAgentEvent = new vscode.EventEmitter<AgentEvent>();
	readonly onAgentEvent = this._onAgentEvent.event;

	private registry: TaskRegistry = { version: 2, tasks: {} };
	private fileWatcher: vscode.FileSystemWatcher | null = null;
	private _nativeWatcher: fs.FSWatcher | null = null;
	private _filePath: string | null = null;
	private disposables: vscode.Disposable[] = [];
	private debounceTimer: NodeJS.Timeout | null = null;
	private autoRefreshTimer: NodeJS.Timeout | null = null;
	private previousStatuses = new Map<string, string>();
	private _agentRegistry: AgentRegistry | null = null;
	private _discoveredAgents: DiscoveredAgent[] = [];
	private _allDiscoveredAgents: DiscoveredAgent[] = [];
	/** Cached port detection results per task ID (undefined = not yet detected) */
	private _portCache = new Map<string, ListeningPort[]>();
	/** Task IDs with ongoing async port detection */
	private _portDetecting = new Set<string>();
	/** Cached prompt summaries per file path */
	private _promptCache = new Map<string, string>();
	/** Cached prompt summaries for discovered agents keyed by sessionId or pid */
	private _discoveredPromptCache = new Map<string, string>();
	/** Cached diff summaries keyed by task/discovered cache key */
	private _diffSummaryCache = new Map<string, string | null>();
	/** Cache keys with ongoing async diff summary calculation */
	private _diffSummaryDetecting = new Set<string>();
	/** Tracks malformed/unsupported registry issues for inline error state */
	private _registryLoadIssue: string | null = null;
	/** First read loading indicator (shown only before initial reload finishes) */
	private _initialReadInProgress = true;
	/** Prevent stale async reload results from overwriting newer state */
	private _reloadGeneration = 0;
	private _agentStatusView: vscode.TreeView<AgentNode> | null = null;
	private previousStuckStates = new Map<string, boolean>();
	private hasInitializedStuckState = false;
	private readonly _tmuxSessionHealthCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private projectIconManager: ProjectIconManager;

	constructor(projectIconManager?: ProjectIconManager) {
		this.projectIconManager = projectIconManager ?? new ProjectIconManager();
		// Watch config changes for the tasks file path
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.agentTasksFile")) {
					this.setupFileWatch();
					void this.reload();
				}
				if (
					e.affectsConfiguration(
						"commandCentral.agentStatus.showOnlyRunning",
					) ||
					e.affectsConfiguration("commandCentral.agentStatus.scope") ||
					e.affectsConfiguration("commandCentral.agentStatus.groupByProject") ||
					e.affectsConfiguration("commandCentral.agentStatus.sortMode") ||
					e.affectsConfiguration(
						"commandCentral.agentStatus.maxVisibleAgents",
					) ||
					e.affectsConfiguration("commandCentral.agentStatus.sortByStatus") ||
					e.affectsConfiguration("commandCentral.project.group") ||
					e.affectsConfiguration("commandCentral.project.icon") ||
					e.affectsConfiguration("commandCentral.projects")
				) {
					this._onDidChangeTreeData.fire(undefined);
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.setupFileWatch();
				void this.reload();
			}),
		);
		this.setupFileWatch();
		if (process.env["NODE_ENV"] === "test") {
			this.reload();
		} else {
			void Promise.resolve().then(() => this.reload());
		}
		this.initDiscovery();
	}

	/** Initialize discovery module if enabled in config */
	private initDiscovery(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const enabled = config.get<boolean>("discovery.enabled", true);
		if (!enabled) return;

		this._agentRegistry = new AgentRegistry();
		this._agentRegistry.start();
		this._allDiscoveredAgents = this._agentRegistry.getAllDiscovered();
		this._discoveredAgents = this._agentRegistry.getDiscoveredAgents(
			this.getLauncherTasks(),
		);

		// Refresh tree when discovered agents change
		this.disposables.push(
			this._agentRegistry.onDidChangeAgents(() => {
				this._allDiscoveredAgents = this._agentRegistry
					? this._agentRegistry.getAllDiscovered()
					: [];
				this._discoveredAgents = this._agentRegistry
					? this._agentRegistry.getDiscoveredAgents(this.getLauncherTasks())
					: [];
				this.setHasAgentsContext();
				this.updateDockBadge();
				this._onDidChangeTreeData.fire(undefined);
			}),
		);

		// React to discovery enabled/disabled changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.discovery.enabled")) {
					const nowEnabled = vscode.workspace
						.getConfiguration("commandCentral")
						.get<boolean>("discovery.enabled", true);
					if (!nowEnabled && this._agentRegistry) {
						this._agentRegistry.dispose();
						this._agentRegistry = null;
						this._discoveredAgents = [];
						this._allDiscoveredAgents = [];
						this.setHasAgentsContext();
						this._onDidChangeTreeData.fire(undefined);
					} else if (nowEnabled && !this._agentRegistry) {
						this.initDiscovery();
					}
				}
			}),
		);
	}

	/** Public accessor for the configured file path */
	get filePath(): string | null {
		return this._filePath;
	}

	setTreeView(treeView: vscode.TreeView<AgentNode>): void {
		this._agentStatusView = treeView;
		this.updateDockBadge();
	}

	findTaskElement(taskId: string): TreeElement | undefined {
		const task = this.getDisplayTaskById(taskId);
		if (!task) return undefined;
		const scopedTasks = this.isRunningOnlyFilterEnabled()
			? this.getScopedLauncherTasks().filter((t) => t.status === "running")
			: this.getScopedLauncherTasks();
		if (!scopedTasks.some((t) => t.id === taskId)) return undefined;
		return { type: "task", task };
	}

	private getConfiguredPath(): string | null {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const configValue = config.get<string>("agentTasksFile") ?? "";
		return resolveTasksFilePath(configValue, vscode.workspace.workspaceFolders);
	}

	private setupFileWatch(): void {
		if (this.fileWatcher) {
			this.fileWatcher.dispose();
			this.fileWatcher = null;
		}
		if (this._nativeWatcher) {
			this._nativeWatcher.close();
			this._nativeWatcher = null;
		}

		// Clear existing debounce timer before setting up new watcher
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		const filePath = this.getConfiguredPath();
		this._filePath = filePath;
		if (!filePath) return;

		const debouncedReload = () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				void this.reload();
			}, 150);
		};

		// VS Code's createFileSystemWatcher can be unreliable for paths outside
		// the workspace (e.g., ~/.config/). Use both VS Code watcher AND native
		// fs.watch for defense-in-depth — whichever fires first wins via debounce.
		const pattern = new vscode.RelativePattern(
			vscode.Uri.file(path.dirname(filePath)),
			path.basename(filePath),
		);
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

		this.disposables.push(
			this.fileWatcher.onDidChange(debouncedReload),
			this.fileWatcher.onDidCreate(debouncedReload),
			this.fileWatcher.onDidDelete(debouncedReload),
		);

		// Native fs.watch fallback — watches the directory for changes to the target file
		try {
			const dir = path.dirname(filePath);
			const basename = path.basename(filePath);
			this._nativeWatcher = fs.watch(dir, (_eventType, filename) => {
				if (filename === basename) {
					debouncedReload();
				}
			});
			this._nativeWatcher.on("error", () => {
				// Silently ignore — VS Code watcher is the primary
			});
		} catch {
			// Directory doesn't exist yet or not watchable — that's fine
		}
	}

	private getTaskAgeMs(task: AgentTask): number | null {
		const startedMs = new Date(task.started_at).getTime();
		if (!Number.isFinite(startedMs)) return null;
		return Math.max(0, Date.now() - startedMs);
	}

	private hasLiveDiscoveredSession(task: AgentTask): boolean {
		if (!task.session_id) return false;
		return this._allDiscoveredAgents.some(
			(agent) => agent.sessionId === task.session_id,
		);
	}

	private isTmuxSessionAlive(sessionId: string): boolean {
		const cacheTtlMs = 5_000;
		const cached = this._tmuxSessionHealthCache.get(sessionId);
		const now = Date.now();
		if (cached && now - cached.checkedAt < cacheTtlMs) {
			return cached.alive;
		}

		let alive = false;
		try {
			execFileSync("tmux", ["has-session", "-t", sessionId], { timeout: 500 });
			alive = true;
		} catch {
			alive = false;
		}
		this._tmuxSessionHealthCache.set(sessionId, { alive, checkedAt: now });
		return alive;
	}

	private isRunningTaskHealthy(task: AgentTask): boolean {
		if (task.status !== "running") return true;

		const ageMs = this.getTaskAgeMs(task);
		const staleThresholdMs = Math.max(
			60 * 60_000,
			this.getStuckThresholdMinutes() * 60_000 * 4,
		);
		const looksStale =
			ageMs !== null && ageMs >= staleThresholdMs && this.isAgentStuck(task);

		// Launcher sessions are expected to be tmux-backed; verify session liveness.
		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === "persist") &&
			isValidSessionId(task.session_id)
		) {
			if (!this.isTmuxSessionAlive(task.session_id)) return false;
			return !looksStale;
		}

		if (this.hasLiveDiscoveredSession(task)) {
			return !looksStale;
		}
		return !looksStale;
	}

	private toDisplayTask(task: AgentTask): AgentTask {
		if (task.status !== "running") return task;

		const streamTerminalState = this.getStreamTerminalState(task);
		if (streamTerminalState) {
			return this.applyRuntimeStatusOverlay(task, streamTerminalState);
		}

		if (this.isRunningTaskHealthy(task)) return task;
		return this.applyRuntimeStatusOverlay(task, {
			status: "stopped",
			reason: "Session no longer appears active. Showing as stopped.",
		});
	}

	private applyRuntimeStatusOverlay(
		task: AgentTask,
		overlay: {
			status: AgentTaskStatus;
			reason?: string;
			completedAt?: string;
			exitCode?: number | null;
		},
	): AgentTask {
		return {
			...task,
			status: overlay.status,
			completed_at:
				overlay.completedAt ?? task.completed_at ?? new Date().toISOString(),
			exit_code:
				overlay.exitCode === undefined
					? overlay.status === "completed"
						? (task.exit_code ?? 0)
						: task.exit_code
					: overlay.exitCode,
			error_message:
				overlay.status === "stopped" || overlay.status === "failed"
					? (task.error_message ?? overlay.reason ?? null)
					: task.error_message,
		};
	}

	private getStreamTerminalState(task: AgentTask): {
		status: "completed" | "failed";
		reason?: string;
		completedAt?: string;
		exitCode?: number | null;
	} | null {
		const streamFile = this.resolveStreamFilePath(task);
		if (!streamFile) return null;

		try {
			const lastEventLine = fs
				.readFileSync(streamFile, "utf-8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.at(-1);
			if (!lastEventLine) return null;

			const event = JSON.parse(lastEventLine) as Record<string, unknown>;
			const eventType = asString(event["type"]);
			if (!eventType) return null;

			const completedAt = new Date(
				fs.statSync(streamFile).mtimeMs,
			).toISOString();
			if (eventType === "turn.completed") {
				return { status: "completed", completedAt, exitCode: 0 };
			}
			if (eventType === "turn.failed") {
				const reason =
					event["error"] && typeof event["error"] === "object"
						? asString((event["error"] as Record<string, unknown>)["message"])
						: undefined;
				return {
					status: "failed",
					completedAt,
					reason: reason ?? "Stream ended with a failed turn.",
				};
			}
			if (eventType !== "result") return null;

			const resultStatus = asString(event["status"]);
			if (resultStatus === "success" || event["is_error"] === false) {
				return { status: "completed", completedAt, exitCode: 0 };
			}
			if (resultStatus || event["is_error"] === true) {
				return {
					status: "failed",
					completedAt,
					reason: resultStatus
						? `Stream ended with result status ${resultStatus}.`
						: "Stream ended with an error result.",
				};
			}
		} catch {
			// Ignore malformed or unreadable stream output and fall back to health checks.
		}

		return null;
	}

	private getTaskStartedAtMs(task: AgentTask): number {
		const startedAtMs = new Date(task.started_at).getTime();
		return Number.isFinite(startedAtMs) ? startedAtMs : 0;
	}

	private reconcileDuplicateRunningSessions(tasks: AgentTask[]): AgentTask[] {
		const runningBySession = new Map<string, AgentTask[]>();
		for (const task of tasks) {
			if (task.status !== "running" || !task.session_id) continue;
			const existing = runningBySession.get(task.session_id);
			if (existing) {
				existing.push(task);
			} else {
				runningBySession.set(task.session_id, [task]);
			}
		}

		const staleTaskIds = new Set<string>();
		for (const [sessionId, sessionTasks] of runningBySession.entries()) {
			if (sessionTasks.length <= 1) continue;
			const newestTask = [...sessionTasks].sort((a, b) => {
				const startedDiff =
					this.getTaskStartedAtMs(b) - this.getTaskStartedAtMs(a);
				if (startedDiff !== 0) return startedDiff;
				return b.id.localeCompare(a.id);
			})[0];
			for (const task of sessionTasks) {
				if (task.id === newestTask?.id) continue;
				staleTaskIds.add(task.id);
			}
			this._tmuxSessionHealthCache.delete(sessionId);
		}

		return tasks.map((task) =>
			staleTaskIds.has(task.id)
				? this.applyRuntimeStatusOverlay(task, {
						status: "stopped",
						reason:
							"Superseded by a newer task on the same session. Showing as stopped.",
					})
				: task,
		);
	}

	private getDisplayLauncherTasks(): AgentTask[] {
		const displayTasks = Object.values(this.registry.tasks).map((task) =>
			this.toDisplayTask(task),
		);
		return this.reconcileDuplicateRunningSessions(displayTasks);
	}

	private getDisplayTaskById(taskId: string): AgentTask | undefined {
		return this.getDisplayLauncherTasks().find((task) => task.id === taskId);
	}

	private getAgentStatusScope(): AgentStatusScope {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<AgentStatusScope>("agentStatus.scope", "all");
	}

	private getOpenWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
		return vscode.workspace.workspaceFolders ?? [];
	}

	private matchesCurrentWorkspaceFolder(projectDir: string): boolean {
		if (this.getAgentStatusScope() !== "currentProject") {
			return true;
		}
		if (!projectDir || !path.isAbsolute(projectDir)) {
			return false;
		}

		const normalizedProjectDir = path.resolve(projectDir);
		return this.getOpenWorkspaceFolders().some(
			(folder) => path.resolve(folder.uri.fsPath) === normalizedProjectDir,
		);
	}

	private getScopedLauncherTasks(
		tasks = this.getDisplayLauncherTasks(),
	): AgentTask[] {
		if (this.getAgentStatusScope() === "all") {
			return tasks;
		}
		return tasks.filter((task) =>
			this.matchesCurrentWorkspaceFolder(task.project_dir),
		);
	}

	private getScopedDiscoveredAgents(
		agents = this._discoveredAgents,
	): DiscoveredAgent[] {
		if (this.getAgentStatusScope() === "all") {
			return agents;
		}
		return agents.filter((agent) =>
			this.matchesCurrentWorkspaceFolder(agent.projectDir),
		);
	}

	private getScopedTasksForSummary(
		tasks = this.getScopedLauncherTasks(),
		discovered = this.getScopedDiscoveredAgents(),
	): AgentTask[] {
		const syntheticDiscovered: AgentTask[] = discovered.map((agent) => ({
			id: `discovered-${agent.pid}`,
			status: "running" as const,
			project_dir: agent.projectDir,
			project_name: path.basename(agent.projectDir) || agent.projectDir,
			session_id: agent.sessionId ?? `pid-${agent.pid}`,
			bundle_path: "",
			prompt_file: "",
			started_at: agent.startTime.toISOString(),
			attempts: 0,
			max_attempts: 0,
		}));
		return [...tasks, ...syntheticDiscovered];
	}

	private getScopeIndicatorLabel(): string {
		if (this.getAgentStatusScope() === "all") {
			return "All";
		}

		const workspaceFolders = this.getOpenWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return "Current Project";
		}
		if (workspaceFolders.length === 1) {
			const [folder] = workspaceFolders;
			return folder?.name?.trim() || path.basename(folder?.uri.fsPath ?? "");
		}
		return `${workspaceFolders.length} projects`;
	}

	private formatScopedAgentCount(total: number): string {
		return total === 1 ? "1 agent" : `${total} agents`;
	}

	private getStuckRunningCount(tasks: AgentTask[]): number {
		return tasks.filter(
			(task) => task.status === "running" && this.isAgentStuck(task),
		).length;
	}

	private getSummaryTooltip(counts: AgentCounts, stuckCount: number): string {
		const hints: string[] = [];
		if (stuckCount > 0) {
			hints.push(
				`${stuckCount} running ${stuckCount === 1 ? "agent is" : "agents are"} possibly stuck`,
			);
		}
		const actionableCount = counts.attention;
		if (actionableCount > 0) {
			hints.push(
				`${actionableCount} ${actionableCount === 1 ? "agent needs" : "agents need"} attention — use Agent Actions in Agent Status tree to restart or inspect`,
			);
		}
		return hints.join("\n");
	}

	private formatDiscoveryFilterReason(
		reason: "excluded-binary" | "noise-process" | "cwd-unresolved" | undefined,
	): string {
		switch (reason) {
			case "excluded-binary":
				return "Excluded helper binary";
			case "noise-process":
				return "Filtered UI/helper noise";
			case "cwd-unresolved":
				return "Dropped after cwd lookup failed";
			default:
				return "Filtered";
		}
	}

	private setHasAgentsContext(): void {
		const hasAgents =
			Object.keys(this.registry.tasks).length > 0 ||
			this._discoveredAgents.length > 0;
		const hasTerminalTasks = this.getDisplayLauncherTasks().some(
			(task) => task.status !== "running",
		);
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.hasAgentTasks",
			hasAgents,
		);
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.agentStatus.hasTerminalTasks",
			hasTerminalTasks,
		);
	}

	reload(): void {
		const generation = ++this._reloadGeneration;
		const isInitial = this._initialReadInProgress;
		if (isInitial) {
			this._onDidChangeTreeData.fire(undefined);
		}
		this._registryLoadIssue = null;
		const nextRegistry = this.readRegistry();
		if (generation !== this._reloadGeneration) return;
		this.registry = nextRegistry;
		this._initialReadInProgress = false;
		this._allDiscoveredAgents = this._agentRegistry
			? this._agentRegistry.getAllDiscovered()
			: [];
		this._discoveredAgents = this._agentRegistry
			? this._agentRegistry.getDiscoveredAgents(this.getLauncherTasks())
			: [];
		this._diffSummaryCache.clear();
		this._diffSummaryDetecting.clear();
		this.checkCompletionNotifications();
		this.updateAutoRefreshTimer();
		this.checkStuckTransitions();
		// Clear port cache for tasks that are no longer running
		for (const [taskId, task] of Object.entries(this.registry.tasks)) {
			if (task.status !== "running") {
				this._portCache.delete(taskId);
				this._portDetecting.delete(taskId);
			}
		}
		this.setHasAgentsContext();
		this.updateDockBadge();
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Check for running→completed/failed transitions and fire notifications */
	private checkCompletionNotifications(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const masterEnabled = config.get<boolean>(
			"agentStatus.notifications",
			true,
		);
		const dockBounceEnabled = config.get<boolean>("dockBounce", true);
		const notifConfig = vscode.workspace.getConfiguration(
			"commandCentral.notifications",
		);
		const onCompletion = notifConfig.get<boolean>("onCompletion", true);
		const onFailure = notifConfig.get<boolean>("onFailure", true);
		const soundEnabled = notifConfig.get<boolean>("sound", false);
		const messageOptions = soundEnabled ? { modal: false } : undefined;

		for (const task of Object.values(this.registry.tasks)) {
			const prev = this.previousStatuses.get(task.id);
			if (
				prev === "running" &&
				(task.status === "completed" ||
					task.status === "completed_dirty" ||
					task.status === "failed")
			) {
				this.requestDockAttention(dockBounceEnabled);
			}
			if (masterEnabled && prev === "running") {
				const elapsed = formatElapsed(task.started_at);
				const backend = this.getBackendLabel(task);

				if (
					(task.status === "completed" || task.status === "completed_dirty") &&
					onCompletion
				) {
					const diffSummary = this.formatNotificationDiffSummary(
						this.getDiffSummary(task.project_dir, task),
					);
					const exitSuffix =
						task.exit_code != null ? ` · exit ${task.exit_code}` : "";
					const msg = `✅ ${task.id} completed (${elapsed}) · ${diffSummary} [${backend}]${exitSuffix}`;
					this.revealTaskInSidebar(task.id);
					this.playNotificationSound(soundEnabled);
					this.showInfoNotification(
						msg,
						messageOptions,
						"View Diff",
						"Show Output",
						"Focus Terminal",
					).then((action) => {
						if (action === "View Diff") {
							this.executeTaskCommand("commandCentral.viewAgentDiff", task);
						} else if (action === "Show Output") {
							this.executeTaskCommand("commandCentral.showAgentOutput", task);
						} else if (action === "Focus Terminal") {
							this.executeTaskCommand(
								"commandCentral.focusAgentTerminal",
								task,
							);
						}
					});
					this._onAgentEvent.fire({
						type: "agent-completed",
						taskId: task.id,
						timestamp: new Date(),
						projectDir: task.project_dir,
						elapsed,
					});
				} else if (task.status === "failed" && onFailure) {
					const exitCode = task.exit_code ?? "unknown";
					let msg = `❌ ${task.id} failed (${elapsed}) · exit ${exitCode} [${backend}]`;
					const errorMessage = this.truncateErrorMessage(task.error_message);
					if (errorMessage) msg += ` — ${errorMessage}`;
					this.revealTaskInSidebar(task.id);
					this.playNotificationSound(soundEnabled);
					this.showWarningNotification(
						msg,
						messageOptions,
						"Show Output",
						"View Diff",
						"Restart",
					).then((action) => {
						if (action === "Show Output") {
							this.executeTaskCommand("commandCentral.showAgentOutput", task);
						} else if (action === "View Diff") {
							this.executeTaskCommand("commandCentral.viewAgentDiff", task);
						} else if (action === "Restart") {
							this.executeTaskCommand("commandCentral.restartAgent", task);
						}
					});
					this._onAgentEvent.fire({
						type: "agent-failed",
						taskId: task.id,
						timestamp: new Date(),
						projectDir: task.project_dir,
					});
				} else if (task.status === "stopped" && onCompletion) {
					let msg = `⏹️ ${task.id} stopped (${elapsed}) [${backend}]`;
					const stopReason = this.truncateErrorMessage(task.error_message);
					if (stopReason) msg += ` — ${stopReason}`;
					this.revealTaskInSidebar(task.id);
					this.showInfoNotification(msg, messageOptions, "Show Output").then(
						(action) => {
							if (action === "Show Output") {
								this.executeTaskCommand("commandCentral.showAgentOutput", task);
							}
						},
					);
				} else if (task.status === "killed" && onFailure) {
					const msg = `💀 ${task.id} killed (${elapsed}) [${backend}]`;
					this.revealTaskInSidebar(task.id);
					this.showWarningNotification(msg, messageOptions, "Show Output").then(
						(action) => {
							if (action === "Show Output") {
								this.executeTaskCommand("commandCentral.showAgentOutput", task);
							}
						},
					);
				}
			}
			// Detect running transitions (new task appearing as running, or transition to running)
			if (
				task.status === "running" &&
				prev !== undefined &&
				prev !== "running"
			) {
				this._onAgentEvent.fire({
					type: "agent-started",
					taskId: task.id,
					timestamp: new Date(),
					projectDir: task.project_dir,
				});
			}
			this.previousStatuses.set(task.id, task.status);
		}
	}

	private showInfoNotification(
		message: string,
		options: vscode.MessageOptions | undefined,
		...actions: string[]
	): Thenable<string | undefined> {
		return options
			? vscode.window.showInformationMessage(message, options, ...actions)
			: vscode.window.showInformationMessage(message, ...actions);
	}

	private showWarningNotification(
		message: string,
		options: vscode.MessageOptions | undefined,
		...actions: string[]
	): Thenable<string | undefined> {
		return options
			? vscode.window.showWarningMessage(message, options, ...actions)
			: vscode.window.showWarningMessage(message, ...actions);
	}

	private executeTaskCommand(command: string, task: AgentTask): void {
		void vscode.commands.executeCommand(command, {
			type: "task" as const,
			task,
		});
	}

	private playNotificationSound(enabled: boolean): void {
		if (!enabled) return;
		try {
			process.stdout.write("\x07");
		} catch {
			// Best-effort only.
		}
	}

	private formatNotificationDiffSummary(summary: string | null): string {
		if (!summary) return "no changes detected";
		const filesMatch = summary.match(/(\d+)\s+files?/i);
		const additionsMatch = summary.match(/\+(\d+)/);
		const deletionsMatch = summary.match(/-(\d+)/);
		if (!filesMatch || !additionsMatch || !deletionsMatch) {
			return summary;
		}
		const fileCount = Number.parseInt(filesMatch[1] ?? "0", 10);
		const fileLabel = fileCount === 1 ? "1 file" : `${fileCount} files`;
		return `${fileLabel} · +${additionsMatch[1]} -${deletionsMatch[1]}`;
	}

	private getBackendLabel(task: AgentTask): string {
		const detected = detectAgentType(task);
		if (detected !== "unknown") return detected;
		const explicit = (task.agent_backend ?? task.cli_name ?? "").trim();
		return explicit.length > 0 ? explicit.toLowerCase() : "unknown";
	}

	private truncateErrorMessage(errorMessage?: string | null): string | null {
		if (!errorMessage) return null;
		const compact = errorMessage.trim().replace(/\s+/g, " ");
		if (compact.length <= 100) return compact;
		return `${compact.slice(0, 97)}...`;
	}

	private requestDockAttention(dockBounceEnabled: boolean): void {
		if (!dockBounceEnabled || process.platform !== "darwin") return;
		const windowWithAttention = vscode.window as typeof vscode.window & {
			requestAttention?: () => void;
		};
		if (typeof windowWithAttention.requestAttention !== "function") return;
		try {
			windowWithAttention.requestAttention();
		} catch {
			// Best-effort only.
		}
	}

	private updateDockBadge(): void {
		if (process.platform !== "darwin") return;
		const runningCount = this.getTasks().filter(
			(task) => task.status === "running",
		).length;
		const tooltip =
			runningCount === 1 ? "1 working agent" : `${runningCount} working agents`;
		const badge: vscode.ViewBadge | undefined =
			runningCount > 0 ? { value: runningCount, tooltip } : undefined;

		const windowWithBadge = vscode.window as typeof vscode.window & {
			badge?: vscode.ViewBadge;
		};
		try {
			windowWithBadge.badge = badge;
		} catch {
			// Best-effort only.
		}

		if (this._agentStatusView) {
			this._agentStatusView.badge = badge;
		}
	}

	private checkStuckTransitions(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const dockBounceEnabled = config.get<boolean>("dockBounce", true);
		const nextStates = new Map<string, boolean>();
		for (const task of this.getDisplayLauncherTasks()) {
			if (task.status !== "running") continue;
			const isStuck = this.isAgentStuck(task);
			nextStates.set(task.id, isStuck);

			const wasStuck = this.previousStuckStates.get(task.id) ?? false;
			if (this.hasInitializedStuckState && isStuck && !wasStuck) {
				this.requestDockAttention(dockBounceEnabled);
			}
		}
		this.previousStuckStates = nextStates;
		this.hasInitializedStuckState = true;
	}

	private revealTaskInSidebar(taskId: string): void {
		if (!this._agentStatusView) return;
		const taskElement = this.findTaskElement(taskId);
		if (!taskElement) return;
		try {
			void this._agentStatusView.reveal(taskElement, {
				select: true,
				focus: false,
			});
		} catch {
			// Reveal failures are non-fatal (e.g., filtered-out task).
		}
	}

	/** Start or stop auto-refresh timer based on whether any tasks are running */
	private updateAutoRefreshTimer(): void {
		const hasRunning = this.getDisplayLauncherTasks().some(
			(task) => task.status === "running",
		);

		if (hasRunning && !this.autoRefreshTimer) {
			const config = vscode.workspace.getConfiguration("commandCentral");
			const intervalMs = config.get<number>("agentStatus.autoRefreshMs", 5000);
			this.autoRefreshTimer = setInterval(() => {
				this.checkStuckTransitions();
				this._onDidChangeTreeData.fire(undefined);
			}, intervalMs);
		} else if (!hasRunning && this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
	}

	/** Exposed for testing — override to inject mock data */
	readRegistry(): TaskRegistry {
		this._registryLoadIssue = null;
		if (!this._filePath) return { version: 2, tasks: {} };
		try {
			const content = fs.readFileSync(this._filePath, "utf-8");
			const parsed = JSON.parse(content) as unknown;
			if (!parsed || typeof parsed !== "object") {
				this._registryLoadIssue = "Task registry is not a JSON object.";
				return { version: 2, tasks: {} };
			}
			const parsedRegistry = parsed as Record<string, unknown>;
			const version = parsedRegistry["version"];
			const tasks = parsedRegistry["tasks"];
			if (
				(version === 1 || version === 2) &&
				tasks &&
				typeof tasks === "object"
			) {
				const normalized: Record<string, AgentTask> = {};
				for (const [key, raw] of Object.entries(tasks)) {
					if (!raw || typeof raw !== "object") continue;
					const task = normalizeTask(key, raw as Record<string, unknown>);
					if (task) normalized[key] = task;
				}
				return { version: 2, tasks: normalized };
			}
			this._registryLoadIssue =
				version !== 1 && version !== 2
					? `Unsupported tasks.json version: ${String(version)}`
					: "tasks.json is missing a valid tasks object.";
			return { version: 2, tasks: {} };
		} catch (err) {
			this._registryLoadIssue =
				err instanceof Error ? err.message : "Failed to parse tasks.json";
			return { version: 2, tasks: {} };
		}
	}

	getTreeItem(element: AgentNode): vscode.TreeItem {
		if (element.type === "summary") {
			return this.createSummaryItem(element);
		}
		if (element.type === "task") {
			return this.createTaskItem(element.task);
		}
		if (element.type === "projectGroup") {
			return this.createProjectGroupItem(element);
		}
		if (element.type === "folderGroup") {
			return this.createFolderGroupItem(element);
		}
		if (element.type === "fileChange") {
			return this.createFileChangeItem(element);
		}
		if (element.type === "discovered") {
			return this.createDiscoveredItem(element);
		}
		if (element.type === "olderRuns") {
			return this.createOlderRunsItem(element);
		}
		if (element.type === "state") {
			return this.createStateItem(element);
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		if (!element) {
			const allTasks = this.getScopedLauncherTasks();
			const discovered = this.getScopedDiscoveredAgents();
			const hasAnyAgents = allTasks.length > 0 || discovered.length > 0;
			if (!hasAnyAgents) {
				if (this._initialReadInProgress && this._filePath) {
					return [
						{
							type: "state",
							label: "Loading agents...",
							description: "Reading tasks registry",
							icon: "loading~spin",
						},
					];
				}
				if (this._registryLoadIssue) {
					return [
						{
							type: "state",
							label: "Could not read tasks.json",
							description: this._registryLoadIssue,
							icon: "warning",
						},
					];
				}
				if (this.getAgentStatusScope() === "currentProject") {
					const hasAnyTrackedAgents =
						this.getDisplayLauncherTasks().length > 0 ||
						this._discoveredAgents.length > 0;
					if (this.getOpenWorkspaceFolders().length === 0) {
						return [
							{
								type: "state",
								label: "No workspace folders open",
								description: "Open a folder or switch scope to All Agents.",
								icon: "folder-opened",
							},
						];
					}
					if (hasAnyTrackedAgents) {
						return [
							{
								type: "state",
								label: "No agents in current project",
								description:
									"Switch scope to All Agents to see cross-project tasks.",
								icon: "project",
							},
						];
					}
				}
				return [
					{
						type: "state",
						label: "No agents tracked yet",
						description: "Start an agent task to populate this view.",
						icon: "info",
					},
				];
			}

			const runningOnly = this.isRunningOnlyFilterEnabled();
			const tasks = runningOnly
				? allTasks.filter((task) => task.status === "running")
				: allTasks;
			if (runningOnly && tasks.length === 0 && discovered.length === 0) {
				return [
					{
						type: "state",
						label: "No running agents",
						description: "Disable the Running filter to show completed agents.",
						icon: "debug-pause",
					},
				];
			}

			const groupedByProject = this.isProjectGroupingEnabled();
			const groupedNodes: AgentNode[] = groupedByProject
				? this.buildGroupedRootNodes(tasks, discovered)
				: [];
			const flatNodes: AgentNode[] = this.applyAgentVisibilityCap(
				this.sortAgentNodes([
					...tasks.map(
						(task) =>
							({ type: "task" as const, task }) satisfies SortableAgentNode,
					),
					...discovered.map(
						(agent) =>
							({
								type: "discovered" as const,
								agent,
							}) satisfies SortableAgentNode,
					),
				]),
			);

			const counts = countAgentStatuses(
				this.getScopedTasksForSummary(
					runningOnly ? tasks : allTasks,
					discovered,
				),
			);
			const stuckCount = this.getStuckRunningCount(allTasks);
			const summaryLabel = [
				this.getSortModeIndicatorLabel(),
				this.getScopeIndicatorLabel(),
				this.formatScopedAgentCount(counts.total),
				this.formatSummaryCounts(counts),
				...(stuckCount > 0 ? [`${stuckCount} stuck`] : []),
			]
				.filter((part) => part.length > 0)
				.join(" · ");
			const summaryTooltip = this.getSummaryTooltip(counts, stuckCount);

			return [
				{
					type: "summary" as const,
					label: summaryLabel,
					tooltip: summaryTooltip || undefined,
				},
				...(groupedByProject ? groupedNodes : flatNodes),
			];
		}

		if (element.type === "folderGroup") {
			return element.projects;
		}

		if (element.type === "projectGroup") {
			return this.applyAgentVisibilityCap(
				this.sortAgentNodes([
					...element.tasks.map(
						(task) =>
							({ type: "task" as const, task }) satisfies SortableAgentNode,
					),
					...(element.discoveredAgents ?? []).map(
						(agent) =>
							({
								type: "discovered" as const,
								agent,
							}) satisfies SortableAgentNode,
					),
				]),
				{
					parentProjectName: element.projectName,
					parentProjectDir: element.projectDir,
					parentGroupKey: element.parentGroupKey,
				},
			);
		}

		if (element.type === "olderRuns") {
			return element.hiddenNodes.map((node) => this.toAgentNode(node));
		}

		if (element.type === "task") {
			const compact = this.isCompactMode();
			const detailChildren = compact
				? this.getCompactChildren(element.task)
				: this.getDetailChildren(element.task);
			return [...detailChildren, ...this.getFileChangeChildren(element.task)];
		}

		if (element.type === "discovered") {
			return this.getDiscoveredChildren(element.agent);
		}

		return [];
	}

	private getTaskDiffCacheKey(task: AgentTask): string {
		return `task:${task.id}:${task.status}:${task.project_dir}:${task.started_at}`;
	}

	private getDiscoveredDiffCacheKey(agent: DiscoveredAgent): string {
		return `discovered:${agent.pid}:${agent.projectDir}`;
	}

	private getCachedDiffSummaryForTask(task: AgentTask): string | null {
		const cacheKey = this.getTaskDiffCacheKey(task);
		if (this._diffSummaryCache.has(cacheKey)) {
			return this._diffSummaryCache.get(cacheKey) ?? null;
		}

		// Test overrides often monkeypatch getDiffSummary on the instance.
		// Preserve deterministic synchronous behavior in that case.
		if (Object.hasOwn(this, "getDiffSummary")) {
			const value = this.getDiffSummary(task.project_dir, task);
			this._diffSummaryCache.set(cacheKey, value);
			return value;
		}

		if (!this._diffSummaryDetecting.has(cacheKey)) {
			this._diffSummaryDetecting.add(cacheKey);
			void this.computeDiffSummaryAsync(task.project_dir, task)
				.then((summary) => {
					this._diffSummaryCache.set(cacheKey, summary);
					this._onDidChangeTreeData.fire(undefined);
				})
				.finally(() => {
					this._diffSummaryDetecting.delete(cacheKey);
				});
		}

		return null;
	}

	private isTaskDiffSummaryLoading(task: AgentTask): boolean {
		return this._diffSummaryDetecting.has(this.getTaskDiffCacheKey(task));
	}

	private getCachedDiffSummaryForDiscovered(
		agent: DiscoveredAgent,
	): string | null {
		const cacheKey = this.getDiscoveredDiffCacheKey(agent);
		if (this._diffSummaryCache.has(cacheKey)) {
			return this._diffSummaryCache.get(cacheKey) ?? null;
		}

		const syntheticTask = { status: "running" } as AgentTask;
		if (Object.hasOwn(this, "getDiffSummary")) {
			const value = this.getDiffSummary(agent.projectDir, syntheticTask);
			this._diffSummaryCache.set(cacheKey, value);
			return value;
		}

		if (!this._diffSummaryDetecting.has(cacheKey)) {
			this._diffSummaryDetecting.add(cacheKey);
			void this.computeDiffSummaryAsync(agent.projectDir, syntheticTask)
				.then((summary) => {
					this._diffSummaryCache.set(cacheKey, summary);
					this._onDidChangeTreeData.fire(undefined);
				})
				.finally(() => {
					this._diffSummaryDetecting.delete(cacheKey);
				});
		}
		return null;
	}

	private isDiscoveredDiffSummaryLoading(agent: DiscoveredAgent): boolean {
		return this._diffSummaryDetecting.has(
			this.getDiscoveredDiffCacheKey(agent),
		);
	}

	private formatPerFileDiffSummary(fileDiffs: PerFileDiff[]): string | null {
		if (fileDiffs.length === 0) return null;

		const additions = fileDiffs.reduce(
			(total, diff) => total + Math.max(diff.additions, 0),
			0,
		);
		const deletions = fileDiffs.reduce(
			(total, diff) => total + Math.max(diff.deletions, 0),
			0,
		);
		const fileLabel =
			fileDiffs.length === 1 ? "1 file" : `${fileDiffs.length} files`;
		return `${fileLabel} · +${additions} / -${deletions}`;
	}

	private async computeDiffSummaryAsync(
		projectDir: string,
		task: AgentTask,
	): Promise<string | null> {
		const execFileAsync = promisify(execFile);
		const runNumstat = async (args: string[]): Promise<string> => {
			const { stdout } = await execFileAsync("git", args, {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
			});
			return stdout.trim();
		};

		try {
			const startCommit = this.getTaskDiffStartCommit(task);
			const primaryArgs = startCommit
				? ["-C", projectDir, "diff", "--numstat", `${startCommit}..HEAD`]
				: ["-C", projectDir, "diff", "--numstat"];

			let output = "";
			try {
				output = await runNumstat(primaryArgs);
			} catch {
				if (!startCommit) return null;
				output = await runNumstat([
					"-C",
					projectDir,
					"diff",
					"--numstat",
					"HEAD~1..HEAD",
				]);
			}

			if (!output && startCommit) {
				output = await runNumstat([
					"-C",
					projectDir,
					"diff",
					"--numstat",
					"HEAD~1..HEAD",
				]);
			}

			return this.formatPerFileDiffSummary(
				this.parsePerFileDiffsFromNumstat(output),
			);
		} catch {
			return null;
		}
	}

	/** Get detail children for discovered agents (no task record) */
	private getDiscoveredChildren(agent: DiscoveredAgent): DetailNode[] {
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "PID",
				value: `${agent.pid}`,
				taskId: `discovered-${agent.pid}`,
			},
			{
				type: "detail",
				label: "Working Dir",
				value: agent.projectDir,
				taskId: `discovered-${agent.pid}`,
			},
			{
				type: "detail",
				label: "Uptime",
				value: formatElapsed(agent.startTime.toISOString()),
				taskId: `discovered-${agent.pid}`,
			},
		];
		// Prompt for discovered agents
		const discoveredPrompt = this.readDiscoveredPrompt(agent);
		if (discoveredPrompt) {
			details.push({
				type: "detail",
				label: "Prompt",
				value: discoveredPrompt,
				taskId: `discovered-${agent.pid}`,
			});
		}
		// Diff summary for discovered agents (working tree vs HEAD)
		const diffSummary = this.getCachedDiffSummaryForDiscovered(agent);
		if (diffSummary) {
			details.push({
				type: "detail",
				label: "Changes",
				value: diffSummary,
				taskId: `discovered-${agent.pid}`,
			});
		} else if (this.isDiscoveredDiffSummaryLoading(agent)) {
			details.push({
				type: "detail",
				label: "Changes",
				value: "loading...",
				taskId: `discovered-${agent.pid}`,
			});
		}
		if (agent.model) {
			details.push({
				type: "detail",
				label: "Model",
				value: agent.model,
				taskId: `discovered-${agent.pid}`,
			});
		}
		if (agent.worktree?.isLinkedWorktree) {
			details.push({
				type: "detail",
				label: "Worktree",
				value: `${agent.worktree.branch} · ${agent.worktree.worktreeDir}`,
				taskId: `discovered-${agent.pid}`,
			});
		}
		return details;
	}

	private isCompactMode(): boolean {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<boolean>("agentStatus.compactMode", false);
	}

	private isRunningOnlyFilterEnabled(): boolean {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<boolean>("agentStatus.showOnlyRunning", false);
	}

	private isProjectGroupingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<boolean>("agentStatus.groupByProject", false);
	}

	private getSortMode(): AgentStatusSortMode {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return resolveAgentStatusSortMode(config);
	}

	private getMaxVisibleAgents(): number {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const raw = config.get<number>(
			"agentStatus.maxVisibleAgents",
			AgentStatusTreeProvider.MAX_VISIBLE_AGENTS_DEFAULT,
		);
		const numeric = Number.isFinite(raw)
			? raw
			: AgentStatusTreeProvider.MAX_VISIBLE_AGENTS_DEFAULT;
		return Math.max(
			AgentStatusTreeProvider.MAX_VISIBLE_AGENTS_MIN,
			Math.min(AgentStatusTreeProvider.MAX_VISIBLE_AGENTS_MAX, numeric),
		);
	}

	private getSortModeIndicatorLabel(): string {
		return SORT_MODE_INDICATOR_LABELS[this.getSortMode()];
	}

	private formatSummaryCounts(counts: AgentCounts): string {
		const sortMode = this.getSortMode();
		const parts =
			sortMode === "status"
				? [
						counts.attention > 0 ? `${counts.attention} attention` : null,
						counts.working > 0 ? `${counts.working} working` : null,
						counts.done > 0 ? `${counts.done} done` : null,
					]
				: [
						counts.working > 0 ? `${counts.working} working` : null,
						counts.done > 0 ? `${counts.done} done` : null,
						counts.attention > 0 ? `${counts.attention} attention` : null,
					];

		return (
			parts.filter((part): part is string => Boolean(part)).join(" · ") ||
			"No agents"
		);
	}

	private getTaskActivityTimeMs(task: AgentTask): number {
		const activityTimestamp = task.completed_at ?? task.started_at;
		const activityTimeMs = new Date(activityTimestamp).getTime();
		if (Number.isFinite(activityTimeMs)) {
			return activityTimeMs;
		}
		const startedAtMs = new Date(task.started_at).getTime();
		return Number.isFinite(startedAtMs) ? startedAtMs : 0;
	}

	private getDiscoveredActivityTimeMs(agent: DiscoveredAgent): number {
		const startedAtMs = agent.startTime.getTime();
		return Number.isFinite(startedAtMs) ? startedAtMs : 0;
	}

	private getNodeActivityTimeMs(node: SortableAgentNode): number {
		return node.type === "task"
			? this.getTaskActivityTimeMs(node.task)
			: this.getDiscoveredActivityTimeMs(node.agent);
	}

	private getNodeStatus(node: SortableAgentNode): AgentTaskStatus {
		return node.type === "task" ? node.task.status : "running";
	}

	private compareActivityTimeDesc(
		leftActivityTimeMs: number,
		rightActivityTimeMs: number,
	): number {
		return rightActivityTimeMs - leftActivityTimeMs;
	}

	private compareTaskNames(left: string, right: string): number {
		return left.localeCompare(right);
	}

	private compareSortableAgentNodes(
		left: SortableAgentNode,
		right: SortableAgentNode,
	): number {
		const sortMode = this.getSortMode();
		if (sortMode === "status") {
			const priorityDiff =
				TASK_STATUS_PRIORITY[this.getNodeStatus(left)] -
				TASK_STATUS_PRIORITY[this.getNodeStatus(right)];
			if (priorityDiff !== 0) {
				return priorityDiff;
			}
		}

		if (sortMode === "status-recency") {
			const leftRunning = this.getNodeStatus(left) === "running";
			const rightRunning = this.getNodeStatus(right) === "running";
			if (leftRunning !== rightRunning) {
				return leftRunning ? -1 : 1;
			}
		}

		const activityDiff = this.compareActivityTimeDesc(
			this.getNodeActivityTimeMs(left),
			this.getNodeActivityTimeMs(right),
		);
		if (activityDiff !== 0) {
			return activityDiff;
		}

		if (left.type === "task" && right.type === "task") {
			return this.compareTaskNames(left.task.id, right.task.id);
		}
		if (left.type === "discovered" && right.type === "discovered") {
			return right.agent.pid - left.agent.pid;
		}
		return left.type === "task" ? -1 : 1;
	}

	private sortAgentNodes(nodes: SortableAgentNode[]): SortableAgentNode[] {
		return [...nodes].sort((left, right) =>
			this.compareSortableAgentNodes(left, right),
		);
	}

	private toAgentNode(node: SortableAgentNode): AgentNode {
		return node.type === "task"
			? { type: "task", task: node.task }
			: { type: "discovered", agent: node.agent };
	}

	private isAlwaysVisibleAgentNode(node: SortableAgentNode): boolean {
		return this.getNodeStatus(node) === "running";
	}

	private matchesSortableNode(
		left: SortableAgentNode,
		right: SortableAgentNode,
	): boolean {
		if (left.type !== right.type) return false;
		if (left.type === "task") {
			const rightTask = right as Extract<SortableAgentNode, { type: "task" }>;
			return left.task.id === rightTask.task.id;
		}
		if (left.type === "discovered") {
			const rightAgent = right as Extract<
				SortableAgentNode,
				{ type: "discovered" }
			>;
			return left.agent.pid === rightAgent.agent.pid;
		}
		return false;
	}

	private olderRunsContainsNode(
		node: OlderRunsNode,
		target: SortableAgentNode,
	): boolean {
		return node.hiddenNodes.some((hidden) =>
			this.matchesSortableNode(hidden, target),
		);
	}

	private applyAgentVisibilityCap(
		nodes: SortableAgentNode[],
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
		},
	): AgentNode[] {
		const cap = this.getMaxVisibleAgents();
		if (nodes.length <= cap) {
			return nodes.map((node) => this.toAgentNode(node));
		}

		const visibleNodes: AgentNode[] = [];
		const hiddenNodes: SortableAgentNode[] = [];

		for (const [index, node] of nodes.entries()) {
			if (index < cap || this.isAlwaysVisibleAgentNode(node)) {
				visibleNodes.push(this.toAgentNode(node));
				continue;
			}
			hiddenNodes.push(node);
		}

		if (hiddenNodes.length === 0) {
			return visibleNodes;
		}

		const label =
			hiddenNodes.length === 1
				? "Show 1 older run..."
				: `Show ${hiddenNodes.length} older runs...`;
		return [
			...visibleNodes,
			{
				type: "olderRuns",
				label,
				hiddenNodes,
				parentProjectName: options?.parentProjectName,
				parentProjectDir: options?.parentProjectDir,
				parentGroupKey: options?.parentGroupKey,
			},
		];
	}

	private getProjectGroupFreshestActivityMs(group: {
		tasks: AgentTask[];
		discoveredAgents?: DiscoveredAgent[];
	}): number {
		const activityTimes = [
			...group.tasks.map((task) => this.getTaskActivityTimeMs(task)),
			...(group.discoveredAgents ?? []).map((agent) =>
				this.getDiscoveredActivityTimeMs(agent),
			),
		];
		return activityTimes.length > 0 ? Math.max(...activityTimes) : 0;
	}

	private compareProjectGroups(
		left: ProjectGroupNode,
		right: ProjectGroupNode,
	): number {
		const sortMode = this.getSortMode();
		if (sortMode === "status-recency") {
			const leftHasRunning = this.projectGroupHasRunning(left);
			const rightHasRunning = this.projectGroupHasRunning(right);
			if (leftHasRunning !== rightHasRunning) {
				return leftHasRunning ? -1 : 1;
			}
		}

		const activityDiff = this.compareActivityTimeDesc(
			this.getProjectGroupFreshestActivityMs(left),
			this.getProjectGroupFreshestActivityMs(right),
		);
		if (activityDiff !== 0) {
			return activityDiff;
		}
		return this.compareTaskNames(left.projectName, right.projectName);
	}

	private getFolderGroupFreshestActivityMs(group: {
		projects: ProjectGroupNode[];
	}): number {
		const activityTimes = group.projects.map((project) =>
			this.getProjectGroupFreshestActivityMs(project),
		);
		return activityTimes.length > 0 ? Math.max(...activityTimes) : 0;
	}

	private compareGroupedRoots(
		left: ProjectGroupNode | FolderGroupNode,
		right: ProjectGroupNode | FolderGroupNode,
	): number {
		const sortMode = this.getSortMode();
		const leftLabel =
			left.type === "folderGroup" ? left.groupName : left.projectName;
		const rightLabel =
			right.type === "folderGroup" ? right.groupName : right.projectName;
		if (sortMode === "status-recency") {
			const leftHasRunning =
				left.type === "folderGroup"
					? left.projects.some((project) =>
							this.projectGroupHasRunning(project),
						)
					: this.projectGroupHasRunning(left);
			const rightHasRunning =
				right.type === "folderGroup"
					? right.projects.some((project) =>
							this.projectGroupHasRunning(project),
						)
					: this.projectGroupHasRunning(right);
			if (leftHasRunning !== rightHasRunning) {
				return leftHasRunning ? -1 : 1;
			}
		}

		const activityDiff = this.compareActivityTimeDesc(
			left.type === "folderGroup"
				? this.getFolderGroupFreshestActivityMs(left)
				: this.getProjectGroupFreshestActivityMs(left),
			right.type === "folderGroup"
				? this.getFolderGroupFreshestActivityMs(right)
				: this.getProjectGroupFreshestActivityMs(right),
		);
		if (activityDiff !== 0) {
			return activityDiff;
		}
		return this.compareTaskNames(leftLabel, rightLabel);
	}

	private projectGroupHasRunning(group: ProjectGroupNode): boolean {
		return (
			group.tasks.some((task) => task.status === "running") ||
			(group.discoveredAgents?.length ?? 0) > 0
		);
	}

	private sortTasks(tasks: AgentTask[]): AgentTask[] {
		return [...tasks].sort((a, b) => {
			return this.compareSortableAgentNodes(
				{ type: "task", task: a },
				{ type: "task", task: b },
			);
		});
	}

	private buildProjectNodes(
		tasks: AgentTask[],
		discoveredAgents: DiscoveredAgent[],
	): ProjectGroupNode[] {
		const grouped = new Map<
			string,
			{
				projectName: string;
				projectDir: string;
				tasks: AgentTask[];
				discoveredAgents: DiscoveredAgent[];
			}
		>();

		for (const task of tasks) {
			const projectDir = task.project_dir || task.project_name || "";
			const projectName =
				task.project_name || path.basename(projectDir) || "(unknown project)";
			const groupKey = projectDir ? `dir:${projectDir}` : `name:${projectName}`;
			const existing = grouped.get(groupKey);
			if (existing) {
				existing.tasks.push(task);
			} else {
				grouped.set(groupKey, {
					projectName,
					projectDir,
					tasks: [task],
					discoveredAgents: [],
				});
			}
		}

		for (const agent of discoveredAgents) {
			const projectDir = this.getDiscoveredProjectDir(agent);
			const projectName = this.getDiscoveredProjectName(agent);
			const groupKey = projectDir ? `dir:${projectDir}` : `name:${projectName}`;
			const existing = grouped.get(groupKey);
			if (existing) {
				existing.discoveredAgents.push(agent);
			} else {
				grouped.set(groupKey, {
					projectName,
					projectDir,
					tasks: [],
					discoveredAgents: [agent],
				});
			}
		}

		return Array.from(grouped.values())
			.map((group) => ({
				type: "projectGroup" as const,
				projectName: group.projectName,
				projectDir: group.projectDir,
				tasks: this.sortTasks(group.tasks),
				discoveredAgents: [...group.discoveredAgents].sort((a, b) =>
					this.compareSortableAgentNodes(
						{ type: "discovered", agent: a },
						{ type: "discovered", agent: b },
					),
				),
			}))
			.sort((a, b) => this.compareProjectGroups(a, b));
	}

	private getWorkspaceParentGroups(): Map<
		string,
		{ count: number; workspaceDirs: Set<string> }
	> {
		const byParent = new Map<string, Set<string>>();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const workspaceDir = path.resolve(folder.uri.fsPath);
			const parentDir = path.dirname(workspaceDir);
			const siblingDirs = byParent.get(parentDir) ?? new Set<string>();
			siblingDirs.add(workspaceDir);
			byParent.set(parentDir, siblingDirs);
		}

		const result = new Map<
			string,
			{ count: number; workspaceDirs: Set<string> }
		>();
		for (const [parentDir, workspaceDirs] of byParent.entries()) {
			if (workspaceDirs.size >= 2) {
				result.set(parentDir, {
					count: workspaceDirs.size,
					workspaceDirs,
				});
			}
		}
		return result;
	}

	private getProjectGroupOverride(projectDir: string): string | null {
		if (!projectDir) return null;
		if (!path.isAbsolute(projectDir)) return null;
		const normalizedProjectDir = path.resolve(projectDir);
		const workspaceFolder = (vscode.workspace.workspaceFolders ?? []).find(
			(folder) => path.resolve(folder.uri.fsPath) === normalizedProjectDir,
		);
		if (workspaceFolder) {
			const workspaceOverride = vscode.workspace
				.getConfiguration("commandCentral", workspaceFolder.uri)
				.get<string>("project.group", "")
				.trim();
			if (workspaceOverride.length > 0) return workspaceOverride;
		}

		const settingsOverride = this.readProjectSettingFromFile(
			projectDir,
			"commandCentral.project.group",
		);
		return settingsOverride && settingsOverride.length > 0
			? settingsOverride
			: null;
	}

	private getAutoParentGroup(projectDir: string): {
		groupKey: string;
		groupName: string;
		projectCount: number;
	} | null {
		if (!projectDir) return null;
		if (!path.isAbsolute(projectDir)) return null;
		const normalizedProjectDir = path.resolve(projectDir);
		const parentDir = path.dirname(normalizedProjectDir);
		const workspaceParents = this.getWorkspaceParentGroups();
		const parentInfo = workspaceParents.get(parentDir);
		if (!parentInfo || !parentInfo.workspaceDirs.has(normalizedProjectDir)) {
			return null;
		}

		return {
			groupKey: `auto:${parentDir}`,
			groupName: path.basename(parentDir) || parentDir,
			projectCount: parentInfo.count,
		};
	}

	private buildGroupedRootNodes(
		tasks: AgentTask[],
		discoveredAgents: DiscoveredAgent[],
	): Array<ProjectGroupNode | FolderGroupNode> {
		const projectNodes = this.buildProjectNodes(tasks, discoveredAgents);
		const folderGroups = new Map<
			string,
			{
				groupName: string;
				projectCount: number;
				projects: ProjectGroupNode[];
			}
		>();
		const directProjects: ProjectGroupNode[] = [];

		for (const projectNode of projectNodes) {
			const projectDir =
				projectNode.projectDir ||
				projectNode.tasks[0]?.project_dir ||
				projectNode.projectName;
			const manualGroup = this.getProjectGroupOverride(projectDir);
			const autoParentGroup = manualGroup
				? null
				: this.getAutoParentGroup(projectDir);
			const targetGroup = manualGroup
				? {
						groupKey: `manual:${manualGroup.toLowerCase()}`,
						groupName: manualGroup,
						projectCount: 1,
					}
				: autoParentGroup;
			if (!targetGroup) {
				directProjects.push(projectNode);
				continue;
			}

			const existing = folderGroups.get(targetGroup.groupKey);
			if (existing) {
				existing.projects.push({
					...projectNode,
					parentGroupKey: targetGroup.groupKey,
					parentGroupName: targetGroup.groupName,
				});
				if (targetGroup.groupKey.startsWith("manual:")) {
					existing.projectCount += 1;
				}
				continue;
			}
			folderGroups.set(targetGroup.groupKey, {
				groupName: targetGroup.groupName,
				projectCount: targetGroup.projectCount,
				projects: [
					{
						...projectNode,
						parentGroupKey: targetGroup.groupKey,
						parentGroupName: targetGroup.groupName,
					},
				],
			});
		}

		const folderGroupNodes: FolderGroupNode[] = Array.from(
			folderGroups.entries(),
		)
			.map(([groupKey, entry]) => ({
				type: "folderGroup" as const,
				groupKey,
				groupName: entry.groupName,
				projectCount: entry.projectCount,
				projects: [...entry.projects].sort((a, b) =>
					this.compareProjectGroups(a, b),
				),
			}))
			.sort((a, b) => this.compareGroupedRoots(a, b));

		const sortedDirectProjects = [...directProjects].sort((a, b) =>
			this.compareProjectGroups(a, b),
		);
		return [...folderGroupNodes, ...sortedDirectProjects].sort((a, b) =>
			this.compareGroupedRoots(a, b),
		);
	}

	private getCompactChildren(t: AgentTask): DetailNode[] {
		const details: DetailNode[] = [];
		const gitInfo = this.getGitInfo(t.project_dir);
		if (gitInfo) {
			details.push({
				type: "detail",
				label: "Branch",
				value: gitInfo.branch,
				taskId: t.id,
			});
		}
		return details;
	}

	private getDetailChildren(t: AgentTask): DetailNode[] {
		const details: DetailNode[] = [];
		const rawStatus = this.registry.tasks[t.id]?.status;

		if (t.status === "failed" && t.exit_code != null) {
			const attemptsSuffix =
				t.attempts > 1 ? ` · ${t.attempts}/${t.max_attempts} attempts` : "";
			const errorMessage = t.error_message?.trim();
			details.push({
				type: "detail",
				label: `Error: Exit ${t.exit_code}${attemptsSuffix}`,
				value: "",
				taskId: t.id,
				description:
					errorMessage && errorMessage.length > 0 ? errorMessage : undefined,
				icon: "error",
				iconColor: "charts.red",
			});
		}
		if (rawStatus === "running" && t.status === "stopped") {
			details.push({
				type: "detail",
				label: "Session appears inactive",
				value: "Counted as stopped for health-aware summary",
				taskId: t.id,
				icon: "alert",
				iconColor: "charts.yellow",
			});
		}

		if (this.isAgentStuck(t)) {
			const thresholdMinutes = this.getStuckThresholdMinutes();
			details.push({
				type: "detail",
				label: `No activity for ${thresholdMinutes} minutes`,
				value: "",
				taskId: t.id,
				icon: "alert",
				iconColor: "charts.yellow",
			});
		}

		details.push({
			type: "detail",
			label: "Prompt",
			value: this.readPromptSummary(t.prompt_file),
			taskId: t.id,
		});

		// Diff summary
		const diffSummary = this.getCachedDiffSummaryForTask(t);
		if (diffSummary) {
			details.push({
				type: "detail",
				label: "Changes",
				value: diffSummary,
				taskId: t.id,
			});
		} else if (this.isTaskDiffSummaryLoading(t)) {
			details.push({
				type: "detail",
				label: "Changes",
				value: "loading...",
				taskId: t.id,
			});
		}

		// Git info — merged branch + hash
		const gitInfo = this.getGitInfo(t.project_dir);
		if (gitInfo) {
			details.push({
				type: "detail",
				label: "Git",
				value: `${gitInfo.branch} → ${gitInfo.lastCommit.split(" ")[0]}`,
				taskId: t.id,
			});
		}

		// Result — merged exit code + attempts (only for terminal states)
		if (
			t.exit_code != null &&
			(t.status === "completed" ||
				t.status === "completed_dirty" ||
				t.status === "stopped")
		) {
			details.push({
				type: "detail",
				label: "Result",
				value: `Exit ${t.exit_code} · Attempt ${t.attempts}/${t.max_attempts}`,
				taskId: t.id,
			});
		}

		// PR info
		if (t.pr_number) {
			details.push({
				type: "detail",
				label: "PR",
				value: `#${t.pr_number}${t.review_status ? ` (${t.review_status})` : ""}`,
				taskId: t.id,
			});
		}

		// Port detection — only for running tasks with a valid session (non-blocking)
		if (t.status === "running" && t.session_id) {
			const cached = this._portCache.get(t.id);
			if (cached !== undefined) {
				if (cached.length > 0) {
					details.push({
						type: "detail",
						label: "Ports",
						value: cached.map((p) => `${p.port} (${p.process})`).join(", "),
						taskId: t.id,
					});
				}
			} else if (!this._portDetecting.has(t.id)) {
				this._portDetecting.add(t.id);
				this._detectPortsAsync(t);
				details.push({
					type: "detail",
					label: "Ports",
					value: "detecting...",
					taskId: t.id,
				});
			} else {
				details.push({
					type: "detail",
					label: "Ports",
					value: "detecting...",
					taskId: t.id,
				});
			}
		}

		return details;
	}

	private getFileChangeChildren(t: AgentTask): FileChangeNode[] {
		const startCommit = this.getTaskDiffStartCommit(t);
		const fileDiffs = this.getPerFileDiffs(t.project_dir, startCommit);
		return fileDiffs.map((diff) => ({
			type: "fileChange",
			taskId: t.id,
			projectDir: t.project_dir,
			filePath: diff.filePath,
			additions: diff.additions,
			deletions: diff.deletions,
			taskStatus: t.status,
			startCommit,
		}));
	}

	private getTaskDiffStartCommit(t: AgentTask): string | undefined {
		if (t.status === "running") return undefined;

		if (t.start_commit && t.start_commit !== "unknown") {
			return t.start_commit;
		}
		if (t.start_sha && t.start_sha !== "unknown") {
			return t.start_sha;
		}

		if (t.started_at) {
			try {
				const commitHash = execFileSync(
					"git",
					[
						"-C",
						t.project_dir,
						"log",
						`--before=${t.started_at}`,
						"-1",
						"--format=%H",
					],
					{
						encoding: "utf-8",
						timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
					},
				).trim();
				if (commitHash) return commitHash;
			} catch {
				// Fallback to HEAD~1 below
			}
		}

		return "HEAD~1";
	}

	/** Kick off async port detection; fires onDidChangeTreeData when done */
	private async _detectPortsAsync(task: AgentTask): Promise<void> {
		try {
			const ports = await detectListeningPortsAsync(task.project_dir);
			// Only update if task is still running (could have finished by now)
			if (this.registry.tasks[task.id]?.status === "running") {
				this._portCache.set(task.id, ports);
				this._onDidChangeTreeData.fire(undefined);
			}
		} catch {
			this._portCache.set(task.id, []);
		} finally {
			this._portDetecting.delete(task.id);
		}
	}

	resolveTreeItem(
		item: vscode.TreeItem,
		element: AgentNode,
	): Thenable<vscode.TreeItem> {
		if (element.type === "task" && element.task.status === "running") {
			return this.getLastOutputLine(element.task).then((line) => {
				if (line) {
					item.description = `${item.description} | ${line}`;
				}
				return item;
			});
		}
		return Promise.resolve(item);
	}

	getGitInfo(projectDir: string): GitInfo | null {
		try {
			const branch = execFileSync(
				"git",
				["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"],
				{
					encoding: "utf-8",
					timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
				},
			).trim();
			const lastCommit = execFileSync(
				"git",
				["-C", projectDir, "log", "-1", "--format=%h %s (%cr)"],
				{
					encoding: "utf-8",
					timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
				},
			).trim();
			return { branch, lastCommit };
		} catch {
			return null;
		}
	}

	private truncatePromptSummary(value: string): string {
		return value.length > 80 ? `${value.substring(0, 80)}…` : value;
	}

	private normalizePromptSummaryLine(line: string): string | null {
		const normalized = line
			.trim()
			.replace(/^[-*+]\s+/, "")
			.replace(/^\d+\.\s+/, "")
			.replace(/^>\s+/, "")
			.replace(/\s+/g, " ")
			.trim();
		return normalized.length > 0 ? normalized : null;
	}

	private isPromptBoilerplateLine(line: string): boolean {
		return [
			/^At the START of your work/i,
			/^Use the task system/i,
			/^As you work/i,
			/^When ALL work is complete/i,
			/^The TaskCompleted hook/i,
			/^This is critical/i,
			/^\d+\.\s+\*\*Commit all changes/i,
			/^\d+\.\s+\*\*Verify clean working tree/i,
			/^\d+\.\s+\*\*Do not exit with uncommitted work/i,
			/^\d+\.\s+\*\*Fix hooks, never bypass them/i,
			/^\d+\.\s+\*\*Write the handoff file/i,
			/^\d+\.\s+\*\*Completion is automatic/i,
			/^You MUST write a completion report/i,
			/^This file is checked by the orchestrator/i,
		].some((pattern) => pattern.test(line));
	}

	private getPromptSummaryFromPreferredSection(lines: string[]): string | null {
		const preferredSectionPatterns = [
			/^#{1,6}\s+Task\b/i,
			/^#{1,6}\s+Goal\b/i,
			/^#{1,6}\s+Objective\b/i,
		];

		for (const headingPattern of preferredSectionPatterns) {
			let inSection = false;
			for (const line of lines) {
				const trimmed = line.trim();
				if (headingPattern.test(trimmed)) {
					inSection = true;
					continue;
				}
				if (!inSection) continue;
				if (/^#{1,6}\s+/.test(trimmed)) break;

				const candidate = this.normalizePromptSummaryLine(line);
				if (!candidate || this.isPromptBoilerplateLine(candidate)) continue;
				return this.truncatePromptSummary(candidate);
			}
		}

		return null;
	}

	/** Read the first meaningful line from a prompt file as a summary */
	readPromptSummary(promptFile: string): string {
		const cached = this._promptCache.get(promptFile);
		if (cached !== undefined) return cached;

		try {
			const content = fs.readFileSync(promptFile, "utf-8");
			const lines = content.split("\n");

			const preferredSectionSummary =
				this.getPromptSummaryFromPreferredSection(lines);
			if (preferredSectionSummary) {
				this._promptCache.set(promptFile, preferredSectionSummary);
				return preferredSectionSummary;
			}

			// Look for ## Goal section first
			let inGoalSection = false;
			for (const line of lines) {
				if (/^##\s+Goal/i.test(line)) {
					inGoalSection = true;
					continue;
				}
				if (inGoalSection) {
					const trimmed = line.trim();
					if (trimmed.length === 0) continue;
					if (trimmed.startsWith("#")) break; // next section
					const result = this.truncatePromptSummary(trimmed);
					this._promptCache.set(promptFile, result);
					return result;
				}
			}

			// Fallback: first non-empty, non-heading, non-frontmatter line
			let inFrontmatter = false;
			let inCodeFence = false;
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === "---") {
					inFrontmatter = !inFrontmatter;
					continue;
				}
				if (trimmed.startsWith("```")) {
					inCodeFence = !inCodeFence;
					continue;
				}
				if (inFrontmatter || inCodeFence) continue;
				if (trimmed.length === 0) continue;
				if (trimmed.startsWith("#")) continue;

				const candidate = this.normalizePromptSummaryLine(line);
				if (!candidate || this.isPromptBoilerplateLine(candidate)) continue;
				const result = this.truncatePromptSummary(candidate);
				this._promptCache.set(promptFile, result);
				return result;
			}

			// No meaningful content found, use basename
			const fallback = path.basename(promptFile);
			this._promptCache.set(promptFile, fallback);
			return fallback;
		} catch {
			const fallback = path.basename(promptFile);
			this._promptCache.set(promptFile, fallback);
			return fallback;
		}
	}

	/** Read a prompt summary for a discovered agent (no prompt_file available) */
	readDiscoveredPrompt(agent: DiscoveredAgent): string | null {
		const cacheKey = agent.sessionId ?? `pid:${agent.pid}`;
		const cached = this._discoveredPromptCache.get(cacheKey);
		if (cached !== undefined) return cached || null;

		// Try reading prompt.md from session directory
		if (agent.sessionId) {
			try {
				const homeDir = process.env["HOME"] ?? "";
				const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
				if (fs.existsSync(claudeProjectsDir)) {
					for (const projectEntry of fs.readdirSync(claudeProjectsDir)) {
						const sessionDir = path.join(
							claudeProjectsDir,
							projectEntry,
							"sessions",
							agent.sessionId,
						);
						const promptFile = path.join(sessionDir, "prompt.md");
						if (fs.existsSync(promptFile)) {
							const content = fs.readFileSync(promptFile, "utf-8").trim();
							if (content) {
								const firstLine = content.split("\n").find((l) => l.trim());
								const trimmed = firstLine?.trim() ?? "";
								const result =
									trimmed.length > 60
										? `${trimmed.substring(0, 60)}…`
										: trimmed;
								this._discoveredPromptCache.set(cacheKey, result);
								return result;
							}
						}
						// Fall back to parsing JSONL for initial user message
						const jsonlDir = path.join(claudeProjectsDir, projectEntry);
						if (fs.existsSync(jsonlDir)) {
							const jsonlFiles = fs
								.readdirSync(jsonlDir)
								.filter((f) => f.endsWith(".jsonl"));
							for (const jsonlFile of jsonlFiles) {
								try {
									const lines = fs
										.readFileSync(path.join(jsonlDir, jsonlFile), "utf-8")
										.split("\n")
										.filter(Boolean);
									for (const line of lines) {
										const entry = JSON.parse(line) as Record<string, unknown>;
										if (
											entry["sessionId"] === agent.sessionId &&
											entry["type"] === "user"
										) {
											const msg = entry["message"] as
												| Record<string, unknown>
												| undefined;
											const contentArr = msg?.["content"] as
												| Array<Record<string, unknown>>
												| string
												| undefined;
											let text = "";
											if (typeof contentArr === "string") {
												text = contentArr;
											} else if (Array.isArray(contentArr)) {
												const textBlock = contentArr.find(
													(c) => c["type"] === "text",
												);
												text =
													(textBlock?.["text"] as string | undefined) ?? "";
											}
											if (text) {
												const trimmed = text.trim();
												const result =
													trimmed.length > 60
														? `${trimmed.substring(0, 60)}…`
														: trimmed;
												this._discoveredPromptCache.set(cacheKey, result);
												return result;
											}
										}
									}
								} catch {
									// skip malformed JSONL
								}
							}
						}
					}
				}
			} catch {
				// fall through
			}
		}

		this._discoveredPromptCache.set(cacheKey, "");
		return null;
	}

	/** Get a formatted diff summary for an agent's working directory */
	getDiffSummary(projectDir: string, task: AgentTask): string | null {
		return this.formatPerFileDiffSummary(
			this.getPerFileDiffs(projectDir, this.getTaskDiffStartCommit(task)),
		);
	}

	private parsePerFileDiffsFromNumstat(output: string): PerFileDiff[] {
		if (!output.trim()) return [];

		const diffs: PerFileDiff[] = [];
		for (const line of output.split("\n")) {
			if (!line.trim()) continue;
			const [additionsRaw, deletionsRaw, ...fileParts] = line.split("\t");
			if (!additionsRaw || !deletionsRaw || fileParts.length === 0) continue;
			const filePath = fileParts.join("\t").trim();
			if (!filePath) continue;

			const isBinary = additionsRaw === "-" || deletionsRaw === "-";
			const additions = isBinary ? -1 : Number.parseInt(additionsRaw, 10);
			const deletions = isBinary ? -1 : Number.parseInt(deletionsRaw, 10);

			if (!isBinary && (Number.isNaN(additions) || Number.isNaN(deletions))) {
				continue;
			}

			diffs.push({ filePath, additions, deletions });
		}

		return diffs;
	}

	/**
	 * Get per-file diff stats via `git diff --numstat`.
	 *
	 * - Running agents: compare working tree vs HEAD (`startCommit` undefined)
	 * - Completed/stopped/failed: compare `startCommit..HEAD` (fallback: HEAD~1..HEAD)
	 */
	getPerFileDiffs(projectDir: string, startCommit?: string): PerFileDiff[] {
		const runNumstat = (args: string[]): string =>
			execFileSync("git", args, {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
			}).trim();
		try {
			const primaryArgs = startCommit
				? ["-C", projectDir, "diff", "--numstat", `${startCommit}..HEAD`]
				: ["-C", projectDir, "diff", "--numstat"];
			let output = "";
			try {
				output = runNumstat(primaryArgs);
			} catch {
				if (!startCommit) return [];
				output = runNumstat([
					"-C",
					projectDir,
					"diff",
					"--numstat",
					"HEAD~1..HEAD",
				]);
			}
			if (!output && startCommit) {
				// If a computed start ref is stale/missing, fall back to HEAD~1..HEAD.
				output = runNumstat([
					"-C",
					projectDir,
					"diff",
					"--numstat",
					"HEAD~1..HEAD",
				]);
			}
			if (!output) return [];

			return this.parsePerFileDiffsFromNumstat(output);
		} catch {
			return [];
		}
	}

	private async getLastOutputLine(
		task: AgentTask,
	): Promise<string | undefined> {
		if (task.status !== "running") return undefined;
		if (!task.session_id || !isValidSessionId(task.session_id))
			return undefined;
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			const { stdout: output } = await execFileAsync(
				"tmux",
				["capture-pane", "-t", task.session_id, "-p"],
				{
					encoding: "utf-8",
					timeout: 2000,
				},
			);
			const lines = output
				.trim()
				.split("\n")
				.filter((l) => l.trim());
			return lines[lines.length - 1]?.substring(0, 80);
		} catch {
			return undefined;
		}
	}

	getParent(element: AgentNode): AgentNode | undefined {
		if (this.isProjectGroupingEnabled()) {
			const allTasks = this.getScopedLauncherTasks();
			const visibleTasks = this.isRunningOnlyFilterEnabled()
				? allTasks.filter((task) => task.status === "running")
				: allTasks;
			const groupedRoots = this.buildGroupedRootNodes(
				visibleTasks,
				this.getScopedDiscoveredAgents(),
			);

			const findProjectParent = (
				matcher: (project: ProjectGroupNode) => boolean,
			): ProjectGroupNode | undefined => {
				for (const root of groupedRoots) {
					if (root.type === "projectGroup") {
						if (matcher(root)) return root;
						continue;
					}
					const nested = root.projects.find((project) => matcher(project));
					if (nested) return nested;
				}
				return undefined;
			};

			if (element.type === "task") {
				const sortableNode = { type: "task" as const, task: element.task };
				for (const root of groupedRoots) {
					const projects =
						root.type === "projectGroup" ? [root] : root.projects;
					for (const project of projects) {
						const olderRuns = this.getChildren(project).find(
							(node): node is OlderRunsNode => node.type === "olderRuns",
						);
						if (
							olderRuns &&
							this.olderRunsContainsNode(olderRuns, sortableNode)
						) {
							return olderRuns;
						}
					}
				}
				return findProjectParent((project) =>
					project.tasks.some((task) => task.id === element.task.id),
				);
			}

			if (element.type === "discovered") {
				const sortableNode = {
					type: "discovered" as const,
					agent: element.agent,
				};
				for (const root of groupedRoots) {
					const projects =
						root.type === "projectGroup" ? [root] : root.projects;
					for (const project of projects) {
						const olderRuns = this.getChildren(project).find(
							(node): node is OlderRunsNode => node.type === "olderRuns",
						);
						if (
							olderRuns &&
							this.olderRunsContainsNode(olderRuns, sortableNode)
						) {
							return olderRuns;
						}
					}
				}
				return findProjectParent((project) =>
					(project.discoveredAgents ?? []).some(
						(agent) => agent.pid === element.agent.pid,
					),
				);
			}

			if (element.type === "olderRuns") {
				return findProjectParent((project) => {
					const sameDir =
						(project.projectDir ?? "") === (element.parentProjectDir ?? "");
					if (sameDir && element.parentProjectDir) return true;
					return project.projectName === element.parentProjectName;
				});
			}

			if (element.type === "projectGroup") {
				const knownParentKey = element.parentGroupKey;
				if (knownParentKey) {
					return groupedRoots.find(
						(root) =>
							root.type === "folderGroup" && root.groupKey === knownParentKey,
					);
				}

				for (const root of groupedRoots) {
					if (root.type !== "folderGroup") continue;
					const match = root.projects.some((project) => {
						const sameDir =
							(project.projectDir ?? "") === (element.projectDir ?? "");
						if (sameDir && element.projectDir) return true;
						return project.projectName === element.projectName;
					});
					if (match) return root;
				}
			}
		} else {
			const allTasks = this.getScopedLauncherTasks();
			const visibleTasks = this.isRunningOnlyFilterEnabled()
				? allTasks.filter((task) => task.status === "running")
				: allTasks;
			const flatRootNodes = this.applyAgentVisibilityCap(
				this.sortAgentNodes([
					...visibleTasks.map(
						(task) =>
							({ type: "task" as const, task }) satisfies SortableAgentNode,
					),
					...this.getScopedDiscoveredAgents().map(
						(agent) =>
							({
								type: "discovered" as const,
								agent,
							}) satisfies SortableAgentNode,
					),
				]),
			);
			const olderRuns = flatRootNodes.find(
				(node): node is OlderRunsNode => node.type === "olderRuns",
			);

			if (olderRuns && element.type === "task") {
				const sortableNode = { type: "task" as const, task: element.task };
				if (this.olderRunsContainsNode(olderRuns, sortableNode)) {
					return olderRuns;
				}
			}

			if (olderRuns && element.type === "discovered") {
				const sortableNode = {
					type: "discovered" as const,
					agent: element.agent,
				};
				if (this.olderRunsContainsNode(olderRuns, sortableNode)) {
					return olderRuns;
				}
			}
		}
		if (element.type === "detail") {
			// Check if it belongs to a discovered agent
			if (element.taskId.startsWith("discovered-")) {
				const pid = Number.parseInt(
					element.taskId.replace("discovered-", ""),
					10,
				);
				const agent = this._discoveredAgents.find((a) => a.pid === pid);
				if (agent) return { type: "discovered", agent };
			}
			const task = this.getDisplayTaskById(element.taskId);
			if (task) return { type: "task", task };
		}
		if (element.type === "fileChange") {
			const task = this.getDisplayTaskById(element.taskId);
			if (task) return { type: "task", task };
		}
		// summary and root-level nodes have no parent
		return undefined;
	}

	/** Get the full task registry */
	getRegistry(): TaskRegistry {
		return this.registry;
	}

	/** Get launcher tasks with effective runtime status applied for UI display. */
	getDisplayRegistryTasks(): Record<string, AgentTask> {
		const displayTasks: Record<string, AgentTask> = {};
		for (const [id, task] of Object.entries(this.registry.tasks)) {
			displayTasks[id] = this.toDisplayTask(task);
		}
		return displayTasks;
	}

	/** Get launcher-managed tasks only (excludes discovered agents) */
	getLauncherTasks(): AgentTask[] {
		return Object.values(this.registry.tasks);
	}

	/**
	 * Get all tasks including synthetic entries for discovered agents.
	 *
	 * Discovered agents (found via process scanning) are always running.
	 * Including them here ensures the status bar and sidebar always agree
	 * on the running count, since both sources are counted in the sidebar
	 * summary node (getChildren) but the status bar previously only received
	 * launcher tasks.
	 */
	getTasks(): AgentTask[] {
		const launcherTasks = this.getDisplayLauncherTasks();
		const syntheticDiscovered: AgentTask[] = this._discoveredAgents.map(
			(agent) => ({
				id: `discovered-${agent.pid}`,
				status: "running" as const,
				project_dir: this.getDiscoveredProjectDir(agent),
				project_name: this.getDiscoveredProjectName(agent),
				session_id: agent.sessionId ?? `pid-${agent.pid}`,
				bundle_path: "",
				prompt_file: "",
				started_at: agent.startTime.toISOString(),
				attempts: 0,
				max_attempts: 0,
			}),
		);
		return [...launcherTasks, ...syntheticDiscovered];
	}

	getDiscoveryDiagnosticsReport(): string {
		const lines = ["Agent Status Discovery Diagnostics", ""];
		const displayTasks = this.getDisplayLauncherTasks();
		const runningTasks = displayTasks.filter(
			(task) => task.status === "running",
		);

		lines.push(`Tasks in registry: ${displayTasks.length}`);
		lines.push(`Launcher tasks marked running: ${runningTasks.length}`);
		lines.push(`Visible discovered agents: ${this._discoveredAgents.length}`);
		lines.push(`All discovered agents: ${this._allDiscoveredAgents.length}`);

		if (!this._agentRegistry) {
			lines.push("");
			lines.push("Discovery is disabled.");
			return lines.join("\n");
		}

		const diagnostics = this._agentRegistry.getDiagnostics();
		lines.push("");
		lines.push("Discovery liveness");
		lines.push(
			`- Session-file agents before PID pruning: ${diagnostics.sessionFileCount}`,
		);
		lines.push(
			`- Dead discovered agents pruned by PID liveness: ${diagnostics.prunedDeadAgents}`,
		);
		lines.push(
			`- Live discovered agents after merge: ${diagnostics.discoveredCount}`,
		);

		const processDiagnostics = diagnostics.processScanner;
		lines.push("");
		lines.push("Process scanner");
		lines.push(`- ps rows scanned: ${processDiagnostics.psRowCount}`);
		lines.push(
			`- Agent-like candidates: ${processDiagnostics.agentLikeCandidateCount}`,
		);
		lines.push(`- Retained: ${processDiagnostics.retained.length}`);
		lines.push(`- Filtered: ${processDiagnostics.filtered.length}`);

		if (processDiagnostics.filtered.length > 0) {
			lines.push("");
			lines.push("Filtered matches");
			for (const entry of processDiagnostics.filtered) {
				lines.push(
					`- ${this.formatDiscoveryFilterReason(entry.reason)} · PID ${entry.pid} · ${entry.binaryName ?? "unknown"} · ${entry.command}`,
				);
			}
		}

		if (processDiagnostics.retained.length > 0) {
			lines.push("");
			lines.push("Retained matches");
			for (const entry of processDiagnostics.retained) {
				const location = entry.projectDir ? ` · ${entry.projectDir}` : "";
				lines.push(
					`- PID ${entry.pid} · ${entry.binaryName ?? "unknown"}${location} · ${entry.command}`,
				);
			}
		}

		return lines.join("\n");
	}

	private getDiscoveredProjectDir(agent: DiscoveredAgent): string {
		if (agent.worktree?.isLinkedWorktree) {
			return agent.worktree.mainRepoDir;
		}
		return agent.projectDir;
	}

	private getDiscoveredProjectName(agent: DiscoveredAgent): string {
		const projectDir = this.getDiscoveredProjectDir(agent);
		return path.basename(projectDir) || projectDir;
	}

	private readProjectSettingFromFile(
		projectDir: string,
		settingKey: string,
	): string | null {
		if (!projectDir) return null;
		if (!path.isAbsolute(projectDir)) return null;
		const settingsPath = path.join(projectDir, ".vscode", "settings.json");
		if (!fs.existsSync(settingsPath)) return null;
		try {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const value = parsed[settingKey];
			return typeof value === "string" && value.trim().length > 0
				? value.trim()
				: null;
		} catch {
			return null;
		}
	}

	private getLegacyProjectEmoji(projectDir: string): string | null {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const projects = config.get<Array<{ name: string; emoji: string }>>(
			"projects",
			[],
		);
		const dirName = path.basename(projectDir);
		const match = projects.find((p) => p.name === dirName);
		return match?.emoji ?? null;
	}

	private getProjectIcon(
		projectDir: string,
		options?: { launcherIcon?: string | null },
	): string {
		const launcherIcon = options?.launcherIcon?.trim();
		if (launcherIcon) return launcherIcon;
		if (!projectDir || !path.isAbsolute(projectDir)) {
			return this.getLegacyProjectEmoji(projectDir) ?? "📁";
		}
		const configuredIcon = this.readProjectSettingFromFile(
			projectDir,
			"commandCentral.project.icon",
		);
		if (configuredIcon) return configuredIcon;
		const legacyIcon = this.getLegacyProjectEmoji(projectDir);
		if (legacyIcon) return legacyIcon;
		return this.projectIconManager.getIconForProject(projectDir);
	}

	private createSummaryItem(node: SummaryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.iconPath = this.getSummaryIcon();
		item.contextValue = "agentSummary";
		if (node.tooltip) item.tooltip = node.tooltip;
		return item;
	}

	private createProjectGroupItem(node: ProjectGroupNode): vscode.TreeItem {
		const projectDir =
			node.projectDir || node.tasks[0]?.project_dir || node.projectName;
		const launcherIcon =
			node.tasks.find((task) => task.project_icon)?.project_icon ?? null;
		const icon = this.getProjectIcon(projectDir, { launcherIcon });
		const item = new vscode.TreeItem(
			`${icon} ${node.projectName}`,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		const discoveredCount = node.discoveredAgents?.length ?? 0;
		const counts = countAgentStatuses(node.tasks);
		counts.working += discoveredCount;
		counts.total += discoveredCount;
		item.description = formatCountSummary(counts, {
			includeAttention: true,
		});
		const attentionCount = counts.attention;
		if (attentionCount > 0) {
			item.tooltip = `${attentionCount} ${attentionCount === 1 ? "agent needs" : "agents need"} attention in ${node.projectName}.`;
		}
		item.contextValue = "projectGroup";
		return item;
	}

	private createFolderGroupItem(node: FolderGroupNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			`📁 ${node.groupName} · ${node.projectCount}`,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		item.contextValue = "folderGroup";
		return item;
	}

	/** Compute summary icon based on aggregate agent state */
	private getSummaryIcon(): vscode.ThemeIcon {
		const tasks = this.getScopedLauncherTasks();
		const discovered = this.getScopedDiscoveredAgents();

		const hasRunning =
			tasks.some((t) => t.status === "running") || discovered.length > 0;
		const hasFailed = tasks.some(
			(t) => t.status === "failed" || t.status === "killed",
		);
		const hasContractFailure = tasks.some(
			(t) => t.status === "contract_failure",
		);
		const hasStopped = tasks.some((t) => t.status === "stopped");

		if (hasFailed) {
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		}
		if (hasContractFailure) {
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.orange"),
			);
		}
		if (hasStopped) {
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.yellow"),
			);
		}
		if (hasRunning) {
			return new vscode.ThemeIcon(
				"sync~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		}
		return new vscode.ThemeIcon(
			"check-all",
			new vscode.ThemeColor("charts.green"),
		);
	}

	private formatElapsedDescription(task: AgentTask): string {
		return formatTaskElapsedDescription(task);
	}

	private getStuckThresholdMinutes(): number {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const raw = config.get<number>(
			"agentStatus.stuckThresholdMinutes",
			AgentStatusTreeProvider.STUCK_THRESHOLD_DEFAULT_MINUTES,
		);
		const clamped = Math.max(
			AgentStatusTreeProvider.STUCK_THRESHOLD_MIN_MINUTES,
			Math.min(
				AgentStatusTreeProvider.STUCK_THRESHOLD_MAX_MINUTES,
				Number.isFinite(raw)
					? raw
					: AgentStatusTreeProvider.STUCK_THRESHOLD_DEFAULT_MINUTES,
			),
		);
		return clamped;
	}

	private getStreamFileCandidates(task: AgentTask): string[] {
		const explicitStreamFile = (
			task as AgentTask & { stream_file?: string | null }
		).stream_file;
		const prefixes = new Set<string>();
		if (task.agent_backend) prefixes.add(task.agent_backend);
		for (const backend of AgentStatusTreeProvider.STREAM_BACKEND_PREFIXES) {
			prefixes.add(backend);
		}
		const candidates = Array.from(prefixes).map(
			(backend) => `/tmp/${backend}-stream-${task.id}.jsonl`,
		);
		if (explicitStreamFile) {
			candidates.unshift(explicitStreamFile);
		}
		return candidates;
	}

	private resolveStreamFilePath(task: AgentTask): string | null {
		for (const candidate of this.getStreamFileCandidates(task)) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	public isAgentStuck(task: AgentTask): boolean {
		if (task.status !== "running") return false;

		const startedMs = new Date(task.started_at).getTime();
		if (!Number.isFinite(startedMs)) return false;

		const now = Date.now();
		const thresholdMs = this.getStuckThresholdMinutes() * 60_000;
		if (now - startedMs < thresholdMs) return false;

		const streamFile = this.resolveStreamFilePath(task);
		if (!streamFile) {
			// No stream file: fall back to elapsed runtime only.
			return true;
		}

		try {
			const stat = fs.statSync(streamFile);
			return now - stat.mtimeMs >= thresholdMs;
		} catch {
			// Stream stat failed: use runtime fallback.
			return true;
		}
	}

	private createTaskItem(task: AgentTask): vscode.TreeItem {
		const roleIcon = task.role ? ROLE_ICONS[task.role] : null;
		const elapsedDesc = this.formatElapsedDescription(task);
		const projectIcon = this.getProjectIcon(task.project_dir, {
			launcherIcon: task.project_icon,
		});
		const labelParts = [projectIcon, roleIcon, task.id].filter(Boolean);
		const label = labelParts.join(" ");
		const isStuck = this.isAgentStuck(task);
		const diffSummaryInline = this.getCachedDiffSummaryForTask(task);
		const diffLoading =
			!diffSummaryInline && this.isTaskDiffSummaryLoading(task);
		const baseDescription = diffSummaryInline
			? `${task.project_name} · ${elapsedDesc} · ${diffSummaryInline}`
			: diffLoading
				? `${task.project_name} · ${elapsedDesc} · loading diff...`
				: `${task.project_name} · ${elapsedDesc}`;
		const description = isStuck
			? `${baseDescription} (possibly stuck)`
			: baseDescription;

		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = description;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${task.id}** — ${getStatusDisplayLabel(task.status)}`,
				task.role ? `Role: ${task.role}` : null,
				`Project: ${task.project_name}`,
				`Dir: \`${task.project_dir}\``,
				`Started: ${task.started_at}`,
				`Attempts: ${task.attempts}/${task.max_attempts}`,
				task.terminal_backend ? `Terminal: ${task.terminal_backend}` : null,
				task.exit_code != null ? `Exit code: ${task.exit_code}` : null,
				task.pr_number ? `PR: #${task.pr_number}` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath = isStuck
			? new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"))
			: getStatusThemeIcon(task.status);
		item.contextValue = `agentTask.${task.status}`;
		item.resourceUri = vscode.Uri.parse(`agent-task:${task.id}`);
		const isRunning = task.status === "running";
		item.command = {
			command: isRunning
				? "commandCentral.focusAgentTerminal"
				: "commandCentral.agentQuickActions",
			title: isRunning ? "Focus Terminal" : "Agent Actions",
			arguments: [{ type: "task" as const, task }],
		};
		return item;
	}

	private createStateItem(node: StateNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "agentState";
		if (node.description) item.description = node.description;
		if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
		return item;
	}

	private createOlderRunsItem(node: OlderRunsNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.contextValue = "olderRuns";
		item.iconPath = new vscode.ThemeIcon("history");
		return item;
	}

	private createFileChangeItem(node: FileChangeNode): vscode.TreeItem {
		const label = path.basename(node.filePath);
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description =
			node.additions < 0 || node.deletions < 0
				? "binary"
				: `+${node.additions} -${node.deletions}`;
		item.tooltip = path.join(node.projectDir, node.filePath);
		item.iconPath = new vscode.ThemeIcon("file");
		item.contextValue = "agentFileChange";
		item.command = {
			command: "commandCentral.openFileDiff",
			title: "Open File Diff",
			arguments: [node],
		};
		return item;
	}

	private createDetailItem(node: DetailNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.value ? `${node.label}: ${node.value}` : node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "agentTaskDetail";
		if (node.description) {
			item.description = node.description;
		}
		if (node.icon) {
			item.iconPath = new vscode.ThemeIcon(
				node.icon,
				node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
			);
		}
		return item;
	}

	private createDiscoveredItem(node: DiscoveredNode): vscode.TreeItem {
		const agent = node.agent;
		const projectName = this.getDiscoveredProjectName(agent);
		const projectDir = this.getDiscoveredProjectDir(agent);
		const projectIcon = this.getProjectIcon(projectDir);
		const uptime = formatElapsed(agent.startTime.toISOString());
		const sourceLabel =
			agent.source === "process"
				? "(discovered via ps)"
				: "(discovered via session file)";
		const worktreeLabel = agent.worktree?.isLinkedWorktree
			? `${agent.worktree.branch} · worktree`
			: null;
		const label = `${projectIcon} ${projectName}`;
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		const discoveredDiff = this.getCachedDiffSummaryForDiscovered(agent);
		const discoveredDiffLoading =
			!discoveredDiff && this.isDiscoveredDiffSummaryLoading(agent);
		const descriptionParts = [`PID ${agent.pid}`, uptime];
		if (worktreeLabel) descriptionParts.push(worktreeLabel);
		if (discoveredDiff) {
			descriptionParts.push(discoveredDiff);
		} else if (discoveredDiffLoading) {
			descriptionParts.push("loading diff...");
		}
		descriptionParts.push(sourceLabel);
		item.description = descriptionParts.join(" · ");
		item.iconPath = getStatusThemeIcon("running");
		item.contextValue = "discoveredAgent.running";
		item.command = {
			command: "commandCentral.focusAgentTerminal",
			title: "Focus Terminal",
			arguments: [{ type: "discovered" as const, agent }],
		};
		item.tooltip = new vscode.MarkdownString(
			[
				`**Discovered Agent** — PID ${agent.pid}`,
				`Project: \`${agent.projectDir}\``,
				agent.worktree?.isLinkedWorktree
					? `Worktree: \`${agent.worktree.branch}\` in \`${agent.worktree.worktreeDir}\` (main repo: \`${agent.worktree.mainRepoDir}\`)`
					: null,
				`Source: ${agent.source}`,
				agent.model ? `Model: ${agent.model}` : null,
				agent.sessionId ? `Session: ${agent.sessionId}` : null,
				`Started: ${agent.startTime.toISOString()}`,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		return item;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		this._onAgentEvent.dispose();
		if (process.platform === "darwin") {
			const windowWithBadge = vscode.window as typeof vscode.window & {
				badge?: vscode.ViewBadge;
			};
			try {
				windowWithBadge.badge = undefined;
			} catch {
				// Best-effort only.
			}
			if (this._agentStatusView) {
				this._agentStatusView.badge = undefined;
			}
		}
		if (this.fileWatcher) this.fileWatcher.dispose();
		if (this._nativeWatcher) {
			this._nativeWatcher.close();
			this._nativeWatcher = null;
		}
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
		if (this._agentRegistry) {
			this._agentRegistry.dispose();
			this._agentRegistry = null;
		}
		this._tmuxSessionHealthCache.clear();
		for (const d of this.disposables) d.dispose();
	}
}
