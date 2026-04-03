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
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AgentRegistry } from "../discovery/agent-registry.js";
import type {
	ProcessScanDiagnosticEntry,
	ProcessScanFilterReason,
} from "../discovery/process-scanner.js";
import type { DiscoveredAgent } from "../discovery/types.js";
import type { AgentEvent } from "../events/agent-events.js";
import type { AcpSessionService } from "../services/acp-session-service.js";
import type {
	OpenClawAgentModel,
	OpenClawConfigService,
} from "../services/openclaw-config-service.js";
import type { OpenClawTaskService } from "../services/openclaw-task-service.js";
import { ProjectIconManager } from "../services/project-icon-manager.js";
import { ReviewTracker } from "../services/review-tracker.js";
import type { TaskFlowService } from "../services/taskflow-service.js";
import {
	type OpenClawTask,
	openclawStatusToIcon,
	openclawStatusToLabel,
} from "../types/openclaw-task-types.js";
import {
	type TaskFlow,
	taskflowStatusToIcon,
	taskflowStatusToLabel,
} from "../types/taskflow-types.js";
import {
	type AgentCounts,
	countAgentStatuses,
	formatCountSummary,
} from "../utils/agent-counts.js";
import {
	CLEARABLE_AGENT_TASK_STATUSES,
	STALE_AGENT_STATUS_DESCRIPTION,
} from "../utils/agent-task-registry.js";
import { getModelAlias } from "../utils/model-aliases.js";
import { isPersistSessionAlive as checkPersistSessionAlive } from "../utils/persist-health.js";
import type { ListeningPort } from "../utils/port-detector.js";
import { detectListeningPortsAsync } from "../utils/port-detector.js";
import { relativeTime } from "../utils/relative-time.js";
import { resolveTasksFilePath } from "../utils/tasks-file-resolver.js";
import {
	groupByTimePeriod,
	TIME_PERIOD_LABELS,
	type TimePeriod,
} from "../utils/time-grouping.js";

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

function createEmptyTaskRegistry(): TaskRegistry {
	return { version: 2, tasks: {} };
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
export type AgentStatusScope = "all";
export type AgentStatusSortMode = "status-recency";

export interface AgentTask {
	id: string;
	status: AgentTaskStatus;
	project_dir: string;
	project_name: string;
	session_id: string;
	stream_file?: string | null;
	agent_backend?: string | null;
	claude_session_id?: string | null;
	cli_name?: string | null;
	persist_socket?: string | null;
	tmux_socket?: string | null;
	tmux_conf?: string | null;
	tmux_session?: string;
	tmux_window_id?: string | null;
	tmux_window_name?: string | null;
	tmux_pane_id?: string | null;
	bundle_path: string;
	prompt_file: string;
	started_at: string;
	start_sha?: string | null;
	start_commit?: string | null;
	end_commit?: string | null;
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
	updated_at?: string | null;
	model?: string | null;
	actual_model?: string | null;
	thinking_budget?: number | null;
	prompt_summary?: string | null;
}

// ── Tree node types ──────────────────────────────────────────────────

export type AgentNode =
	| SummaryNode
	| TreeElement
	| DetailNode
	| FileChangeNode
	| DiscoveredNode
	| OpenClawTaskNode
	| BackgroundTasksNode
	| TaskFlowGroupNode
	| TaskFlowChildNode
	| TaskFlowsContainerNode
	| StatusTimeGroupNode
	| OlderRunsNode
	| StateNode;

export interface TaskFlowGroupNode {
	type: "taskFlowGroup";
	flow: TaskFlow;
}

export interface TaskFlowChildNode {
	type: "taskFlowChild";
	taskId: string;
	flowId: string;
	label: string;
	status: string;
}

export interface TaskFlowsContainerNode {
	type: "taskflows";
	flows: TaskFlow[];
}

export interface TaskFlowSingleNode {
	type: "taskflow";
	flow: TaskFlow;
}

export interface SummaryNode {
	type: "summary";
	label: string;
	tooltip?: string;
}

export interface TaskNode {
	type: "task";
	task: AgentTask;
}

export interface OpenClawTaskNode {
	type: "openclawTask";
	task: OpenClawTask;
}

export interface BackgroundTasksNode {
	type: "backgroundTasks";
	tasks: OpenClawTask[];
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

export type AgentStatusGroup = "running" | "done" | "attention";

export interface StatusGroupNode {
	type: "statusGroup";
	status: AgentStatusGroup;
	nodes: SortableAgentNode[];
	parentProjectName?: string;
	parentProjectDir?: string;
	parentGroupKey?: string;
}

export type StatusTimeGroupPeriod = Extract<
	TimePeriod,
	"today" | "yesterday" | "last7days" | "last30days" | "older"
>;

export interface StatusTimeGroupNode {
	type: "statusTimeGroup";
	status: AgentStatusGroup;
	period: StatusTimeGroupPeriod;
	label: string;
	nodes: SortableAgentNode[];
	collapsibleState: vscode.TreeItemCollapsibleState;
}

export type TreeElement =
	| TaskNode
	| ProjectGroupNode
	| FolderGroupNode
	| StatusGroupNode
	| StatusTimeGroupNode;

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
	endCommit?: string;
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
	| { type: "discovered"; agent: DiscoveredAgent }
	| { type: "openclawTask"; task: OpenClawTask };

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

const TASK_STATUS_PRIORITY: Record<AgentStatusGroup, number> = {
	running: 0,
	attention: 1,
	done: 2,
};

const PORT_LOADING_LABEL = "Detecting ports...";
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_GROUP_LABELS: Record<AgentStatusGroup, string> = {
	running: "Running",
	done: "Completed",
	attention: "Failed & Stopped",
};

const STATUS_GROUP_ICONS: Record<AgentStatusGroup, vscode.ThemeIcon> = {
	running: getStatusThemeIcon("running"),
	done: getStatusThemeIcon("completed"),
	attention: new vscode.ThemeIcon(
		"warning",
		new vscode.ThemeColor("charts.orange"),
	),
};

export function resolveAgentStatusSortMode(): AgentStatusSortMode {
	return "status-recency";
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
		claude_session_id: asString(raw["claude_session_id"]) ?? null,
		cli_name: asString(raw["cli_name"]) ?? null,
		persist_socket: asString(raw["persist_socket"]) ?? null,
		tmux_socket: asString(raw["tmux_socket"]) ?? null,
		tmux_conf: asString(raw["tmux_conf"]) ?? null,
		tmux_session: asString(raw["tmux_session"]),
		tmux_window_id: asString(raw["tmux_window_id"]) ?? null,
		tmux_window_name: asString(raw["tmux_window_name"]) ?? null,
		tmux_pane_id: asString(raw["tmux_pane_id"]) ?? null,
		bundle_path: bundlePath,
		prompt_file: promptFile,
		started_at: asString(raw["started_at"]) ?? new Date().toISOString(),
		start_sha: asString(raw["start_sha"]) ?? null,
		start_commit: asString(raw["start_commit"]) ?? null,
		end_commit: asString(raw["end_commit"]) ?? null,
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
		updated_at: asString(raw["updated_at"]) ?? null,
		model: asString(raw["model"]) ?? null,
		actual_model: asString(raw["actual_model"]) ?? null,
		thinking_budget: asNullableNumber(raw["thinking_budget"]) ?? null,
		prompt_summary: asString(raw["prompt_summary"]) ?? null,
	};
}

function normalizeRegistryTasks(
	tasks: unknown,
): Record<string, AgentTask> | null {
	if (!tasks || typeof tasks !== "object") {
		return null;
	}

	const normalized: Record<string, AgentTask> = {};
	for (const [key, raw] of Object.entries(tasks)) {
		if (!raw || typeof raw !== "object") continue;
		const task = normalizeTask(key, raw as Record<string, unknown>);
		if (task) normalized[key] = task;
	}

	return normalized;
}

function warnTaskRegistryFallback(filePath: string, reason: string): void {
	console.warn(
		`[Command Central] Falling back to an empty tasks registry for ${filePath}: ${reason}`,
	);
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
	private static readonly OPENCLAW_AUDIT_TIMEOUT_MS = 5_000;
	private static readonly STUCK_THRESHOLD_DEFAULT_MINUTES = 15;
	private static readonly STUCK_THRESHOLD_MIN_MINUTES = 5;
	private static readonly STUCK_THRESHOLD_MAX_MINUTES = 60;
	private static readonly MAX_VISIBLE_AGENTS_DEFAULT = 50;
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
	private treeRefreshTimer: NodeJS.Timeout | null = null;
	private pendingGlobalRefresh = false;
	private pendingElementRefreshes = new Map<string, AgentNode>();
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
	private staleTaskReasons = new Map<string, string>();
	private readonly _tmuxSessionHealthCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private readonly _persistSessionHealthCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private projectIconManager: ProjectIconManager;
	private _openclawConfigService: OpenClawConfigService | null = null;
	private _openclawTaskService: OpenClawTaskService | null = null;
	private _acpSessionService: AcpSessionService | null = null;
	private _taskFlowService: TaskFlowService | null = null;
	private _reviewTracker: ReviewTracker = new ReviewTracker();

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
					e.affectsConfiguration("commandCentral.agentStatus.groupByProject") ||
					e.affectsConfiguration("commandCentral.project.group") ||
					e.affectsConfiguration("commandCentral.project.icon") ||
					e.affectsConfiguration("commandCentral.projects")
				) {
					this.scheduleTreeRefresh();
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
				this.scheduleTreeRefresh();
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
						this.scheduleTreeRefresh();
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

	setOpenClawConfigService(service: OpenClawConfigService): void {
		this._openclawConfigService = service;
	}

	setOpenClawTaskService(service: OpenClawTaskService): void {
		this._openclawTaskService = service;
	}

	setAcpSessionService(service: AcpSessionService): void {
		this._acpSessionService = service;
	}

	setTaskFlowService(service: TaskFlowService): void {
		this._taskFlowService = service;
	}

	setReviewTracker(tracker: ReviewTracker): void {
		this._reviewTracker = tracker;
	}

	markTaskReviewed(taskId: string): void {
		this._reviewTracker.markReviewed(taskId);
		// Refresh the specific task node so the badge appears immediately
		const element = this.getTaskRefreshElement(taskId);
		this.scheduleTreeRefresh(element);
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

	private getRefreshElementKey(element: AgentNode): string | null {
		switch (element.type) {
			case "task":
				return `task:${element.task.id}`;
			case "discovered":
				return `discovered:${element.agent.pid}`;
			case "openclawTask":
				return `openclaw:${element.task.taskId}`;
			case "projectGroup":
				return `project:${element.projectDir ?? element.projectName}`;
			case "folderGroup":
				return `folder:${element.groupKey}`;
			case "statusGroup":
				return `status-group:${element.status}`;
			case "backgroundTasks":
				return "backgroundTasks";
			case "olderRuns":
				return [
					"olderRuns",
					element.parentGroupKey ?? "",
					element.parentProjectDir ?? "",
					element.label,
				].join(":");
			case "summary":
				return "summary";
			case "state":
				return `state:${element.label}`;
			default:
				return null;
		}
	}

	private scheduleTreeRefresh(element?: AgentNode): void {
		if (!element) {
			this.pendingGlobalRefresh = true;
			this.pendingElementRefreshes.clear();
		} else if (!this.pendingGlobalRefresh) {
			const key = this.getRefreshElementKey(element);
			if (key) {
				this.pendingElementRefreshes.set(key, element);
			} else {
				this.pendingGlobalRefresh = true;
				this.pendingElementRefreshes.clear();
			}
		}

		if (this.treeRefreshTimer) return;
		this.treeRefreshTimer = setTimeout(() => {
			this.treeRefreshTimer = null;
			const refreshAll =
				this.pendingGlobalRefresh || this.pendingElementRefreshes.size === 0;
			const elements = refreshAll
				? []
				: [...this.pendingElementRefreshes.values()];
			this.pendingGlobalRefresh = false;
			this.pendingElementRefreshes.clear();

			if (refreshAll) {
				this._onDidChangeTreeData.fire(undefined);
				return;
			}

			for (const pending of elements) {
				this._onDidChangeTreeData.fire(pending);
			}
		}, 0);
	}

	private pruneDiffSummaryCache(
		tasks: AgentTask[],
		discoveredAgents: DiscoveredAgent[],
	): void {
		const validCacheKeys = new Set<string>([
			...tasks.map((task) => this.getTaskDiffCacheKey(task)),
			...discoveredAgents.map((agent) => this.getDiscoveredDiffCacheKey(agent)),
		]);

		for (const key of this._diffSummaryCache.keys()) {
			if (!validCacheKeys.has(key)) {
				this._diffSummaryCache.delete(key);
			}
		}
		for (const key of this._diffSummaryDetecting) {
			if (!validCacheKeys.has(key)) {
				this._diffSummaryDetecting.delete(key);
			}
		}
	}

	private getTaskRefreshElement(taskId: string): AgentNode | undefined {
		return this.findTaskElement(taskId);
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

	private getTmuxSessionHealthCacheKey(
		sessionId: string,
		socketPath?: string | null,
	): string {
		return `${socketPath ?? "__default__"}::${sessionId}`;
	}

	private isTmuxSessionAlive(
		sessionId: string,
		socketPath?: string | null,
	): boolean {
		const cacheTtlMs = 5_000;
		const cacheKey = this.getTmuxSessionHealthCacheKey(sessionId, socketPath);
		const cached = this._tmuxSessionHealthCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.checkedAt < cacheTtlMs) {
			return cached.alive;
		}

		let alive = false;
		try {
			const args = socketPath
				? ["-S", socketPath, "has-session", "-t", sessionId]
				: ["has-session", "-t", sessionId];
			execFileSync("tmux", args, { timeout: 500 });
			alive = true;
		} catch {
			alive = false;
		}
		this._tmuxSessionHealthCache.set(cacheKey, { alive, checkedAt: now });
		return alive;
	}

	/**
	 * Checks whether a specific tmux window (by `@N` ID) still exists.
	 * More accurate than `isTmuxSessionAlive` for multi-window sessions where
	 * multiple tasks share a single session but occupy distinct windows.
	 */
	private isTmuxWindowAlive(
		sessionId: string,
		windowId: string,
		socketPath?: string | null,
	): boolean {
		const cacheTtlMs = 5_000;
		const cacheKey = `${socketPath ?? "__default__"}::${sessionId}::${windowId}`;
		const cached = this._tmuxSessionHealthCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.checkedAt < cacheTtlMs) {
			return cached.alive;
		}

		let alive = false;
		try {
			const args = socketPath
				? [
						"-S",
						socketPath,
						"list-windows",
						"-t",
						sessionId,
						"-F",
						"#{window_id}",
					]
				: ["list-windows", "-t", sessionId, "-F", "#{window_id}"];
			const output = execFileSync("tmux", args, { timeout: 500 }).toString();
			alive = output.split("\n").some((line) => line.trim() === windowId);
		} catch {
			alive = false;
		}
		this._tmuxSessionHealthCache.set(cacheKey, { alive, checkedAt: now });
		return alive;
	}

	private getPersistSocketPath(task: AgentTask): string | null {
		if (task.persist_socket) return task.persist_socket;
		if (!isValidSessionId(task.session_id)) return null;
		return path.join(
			os.homedir(),
			".local",
			"share",
			"cc",
			"sockets",
			`${task.session_id}.sock`,
		);
	}

	private isPersistTaskAlive(task: AgentTask): boolean {
		const socketPath = this.getPersistSocketPath(task);
		if (!socketPath) return false;

		const cacheTtlMs = 5_000;
		const cached = this._persistSessionHealthCache.get(socketPath);
		const now = Date.now();
		if (cached && now - cached.checkedAt < cacheTtlMs) {
			return cached.alive;
		}

		const alive = checkPersistSessionAlive(socketPath);
		this._persistSessionHealthCache.set(socketPath, {
			alive,
			checkedAt: now,
		});
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

		if (task.terminal_backend === "persist") {
			if (!this.isPersistTaskAlive(task)) return false;
			return !looksStale;
		}

		// Backward compatibility: tasks without terminal_backend were tmux-backed.
		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === undefined) &&
			isValidSessionId(task.session_id)
		) {
			// Use window-level check when available — more accurate for multi-window
			// sessions where all tasks share the same session ID.
			const windowAlive = task.tmux_window_id
				? this.isTmuxWindowAlive(
						task.session_id,
						task.tmux_window_id,
						task.tmux_socket,
					)
				: this.isTmuxSessionAlive(task.session_id, task.tmux_socket);
			if (!windowAlive) return false;
			return !looksStale;
		}

		if (this.hasLiveDiscoveredSession(task)) {
			return !looksStale;
		}
		return !looksStale;
	}

	private toDisplayTask(task: AgentTask): AgentTask {
		const staleReason = this.staleTaskReasons.get(task.id);
		if (staleReason) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed_stale",
				reason: staleReason,
			});
		}
		if (task.status !== "running") return task;

		const streamTerminalState = this.getStreamTerminalState(task);
		if (streamTerminalState) {
			return this.applyRuntimeStatusOverlay(task, streamTerminalState);
		}

		if (this.isRunningTaskHealthy(task)) return task;

		// The process is dead, but check for completion evidence before
		// defaulting to "stopped".  Many tasks finish successfully but the
		// completion hook doesn't fire (race / Ghostty lifecycle), leaving
		// tasks.json stuck at "running".  Exit code and completed_at are
		// ground-truth signals that should override the inference.
		if (task.exit_code === 0 || (task.exit_code == null && task.completed_at)) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed",
				reason: "Session ended with completion evidence.",
			});
		}
		if (task.exit_code != null && task.exit_code !== 0) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "failed",
				reason: `Session ended with exit code ${task.exit_code}.`,
			});
		}

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
				overlay.status === "stopped" ||
				overlay.status === "failed" ||
				overlay.status === "completed_stale"
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
			// Tmux tasks with a unique window ID are independent processes in the
			// same session — don't treat them as duplicate sessions.
			const sessionKey =
				(task.terminal_backend === "tmux" ||
					task.terminal_backend === undefined) &&
				task.tmux_window_id
					? `${task.session_id}::${task.tmux_window_id}`
					: task.session_id;
			const existing = runningBySession.get(sessionKey);
			if (existing) {
				existing.push(task);
			} else {
				runningBySession.set(sessionKey, [task]);
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
				const persistSocketPath = this.getPersistSocketPath(task);
				if (persistSocketPath) {
					this._persistSessionHealthCache.delete(persistSocketPath);
				}
			}
			for (const cacheKey of this._tmuxSessionHealthCache.keys()) {
				if (cacheKey.endsWith(`::${sessionId}`)) {
					this._tmuxSessionHealthCache.delete(cacheKey);
				}
			}
			this._persistSessionHealthCache.delete(sessionId);
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

	private getScopedLauncherTasks(
		tasks = this.getDisplayLauncherTasks(),
	): AgentTask[] {
		return tasks;
	}

	private getScopedDiscoveredAgents(
		agents = this._discoveredAgents,
	): DiscoveredAgent[] {
		return agents;
	}

	private mapOpenClawTaskToAgentStatus(task: OpenClawTask): AgentTaskStatus {
		switch (task.status) {
			case "queued":
			case "running":
				return "running";
			case "succeeded":
			case "cancelled":
				return "completed";
			case "blocked":
			case "failed":
			case "timed_out":
			case "lost":
				return "failed";
		}
	}

	private toSyntheticOpenClawTask(task: OpenClawTask): AgentTask {
		const timestamp = task.startedAt ?? task.createdAt ?? Date.now();
		return {
			id: `openclaw-${task.taskId}`,
			status: this.mapOpenClawTaskToAgentStatus(task),
			project_dir: "",
			project_name: "Background Tasks",
			session_id: task.childSessionKey ?? task.taskId,
			bundle_path: "",
			prompt_file: "",
			started_at: new Date(timestamp).toISOString(),
			attempts: 0,
			max_attempts: 0,
			completed_at: task.endedAt ? new Date(task.endedAt).toISOString() : null,
			updated_at: task.lastEventAt
				? new Date(task.lastEventAt).toISOString()
				: null,
			error_message: task.error ?? null,
			prompt_summary: task.progressSummary ?? task.terminalSummary ?? null,
		};
	}

	private isOpenClawTaskActive(task: OpenClawTask): boolean {
		return task.status === "queued" || task.status === "running";
	}

	private isOpenClawTaskVisibleInRunningMode(task: OpenClawTask): boolean {
		return this.isOpenClawTaskActive(task);
	}

	private getOpenClawTaskActivityTimeMs(task: OpenClawTask): number {
		return (
			task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt ?? 0
		);
	}

	private getOpenClawTaskDisplayTitle(task: OpenClawTask): string {
		return task.label?.trim() || task.task.trim() || task.taskId;
	}

	private shouldDedupOpenClawTask(task: OpenClawTask): boolean {
		const launcherTasks = this.getLauncherTasks();
		if (
			task.childSessionKey &&
			launcherTasks.some(
				(launcherTask) =>
					launcherTask.session_id &&
					task.childSessionKey?.includes(launcherTask.session_id),
			)
		) {
			return true;
		}
		if (
			task.label &&
			launcherTasks.some((launcherTask) => launcherTask.id === task.label)
		) {
			return true;
		}
		return false;
	}

	private getNonLauncherOpenClawTasks(): OpenClawTask[] {
		// Merge tasks from both sources. ACP source wins on taskId conflict.
		const taskMap = new Map<string, OpenClawTask>();
		for (const task of this._openclawTaskService?.getTasks() ?? []) {
			taskMap.set(task.taskId, task);
		}
		for (const task of this._acpSessionService?.getTasks() ?? []) {
			taskMap.set(task.taskId, task);
		}
		return Array.from(taskMap.values()).filter(
			(task) => !this.shouldDedupOpenClawTask(task),
		);
	}

	private getVisibleOpenClawTasks(
		tasks = this.getNonLauncherOpenClawTasks(),
	): OpenClawTask[] {
		const filtered = this.isRunningOnlyFilterEnabled()
			? tasks.filter((task) => this.isOpenClawTaskVisibleInRunningMode(task))
			: tasks;
		return [...filtered].sort(
			(left, right) =>
				this.getOpenClawTaskActivityTimeMs(right) -
				this.getOpenClawTaskActivityTimeMs(left),
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
		const syntheticOpenClaw = this.getVisibleOpenClawTasks().map((task) =>
			this.toSyntheticOpenClawTask(task),
		);
		return [...tasks, ...syntheticDiscovered, ...syntheticOpenClaw];
	}

	private getScopedAgentTasksForSummary(
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
				`${actionableCount} stopped ${actionableCount === 1 ? "agent" : "agents"} — use Agent Actions in Agent Status tree to restart or inspect`,
			);
		}
		return hints.join("\n");
	}

	private setHasAgentsContext(): void {
		const hasAgents =
			Object.keys(this.registry.tasks).length > 0 ||
			this._discoveredAgents.length > 0 ||
			this.getNonLauncherOpenClawTasks().length > 0;
		const hasTerminalTasks = this.getDisplayLauncherTasks().some((task) =>
			CLEARABLE_AGENT_TASK_STATUSES.has(task.status),
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
		this.checkStaleTransitions();
		this.pruneDiffSummaryCache(
			this.getDisplayLauncherTasks(),
			this._allDiscoveredAgents,
		);
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

	private getTaskAgentIdentities(task: AgentTask): string[] {
		return [task.role, task.agent_backend, task.cli_name]
			.map((value) => value?.trim())
			.filter((value): value is string => Boolean(value));
	}

	private resolveInheritedTaskModel(
		task: AgentTask,
	): OpenClawAgentModel | null {
		if (!this._openclawConfigService) return null;

		for (const agentId of this.getTaskAgentIdentities(task)) {
			const model = this._openclawConfigService.getAgentModel(agentId);
			if (model?.model?.trim()) return model;
		}

		return null;
	}

	private resolveTaskModelDisplay(task: AgentTask): {
		fullName: string;
		alias: string;
		isExplicit: boolean;
	} | null {
		const explicitModel = task.model?.trim();
		if (explicitModel) {
			return {
				fullName: explicitModel,
				alias: getModelAlias(explicitModel),
				isExplicit: true,
			};
		}

		const inheritedModel = this.resolveInheritedTaskModel(task);
		if (!inheritedModel) return null;

		return {
			fullName: inheritedModel.model,
			alias: getModelAlias(inheritedModel.model),
			isExplicit: inheritedModel.isExplicit,
		};
	}

	/**
	 * Detect provider fallback: actual_model differs from requested model.
	 */
	private getTaskFallbackInfo(task: AgentTask): {
		actualFull: string;
		actualAlias: string;
		requestedFull: string;
		requestedAlias: string;
	} | null {
		const actual = task.actual_model?.trim();
		const requested = task.model?.trim();
		if (!actual || !requested || actual === requested) return null;
		return {
			actualFull: actual,
			actualAlias: getModelAlias(actual),
			requestedFull: requested,
			requestedAlias: getModelAlias(requested),
		};
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

	public checkStaleTransitions(): void {
		const nextReasons = new Map<string, string>();
		for (const task of Object.values(this.registry.tasks)) {
			const reason = this.getStaleTransitionReason(task);
			if (reason) {
				nextReasons.set(task.id, reason);
			}
		}
		this.staleTaskReasons = nextReasons;
	}

	public getStaleLauncherTasks(): AgentTask[] {
		return this.getDisplayLauncherTasks().filter(
			(task) => task.status === "completed_stale",
		);
	}

	private getStaleTransitionReason(task: AgentTask): string | null {
		if (task.status !== "running") return null;
		if (this.getStreamTerminalState(task)) return null;
		if (!this.isAgentStuck(task)) return null;
		if (this.isRunningTaskHealthy(task)) return null;
		if (!this.isTaskSessionConfirmedDead(task)) return null;
		return STALE_AGENT_STATUS_DESCRIPTION;
	}

	private isTaskSessionConfirmedDead(task: AgentTask): boolean {
		if (task.terminal_backend === "persist") {
			return !this.isPersistTaskAlive(task);
		}

		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === undefined) &&
			isValidSessionId(task.session_id)
		) {
			// Use window-level check when available for multi-window sessions.
			if (task.tmux_window_id) {
				return !this.isTmuxWindowAlive(
					task.session_id,
					task.tmux_window_id,
					task.tmux_socket,
				);
			}
			return !this.isTmuxSessionAlive(task.session_id, task.tmux_socket);
		}

		if (this.hasLiveDiscoveredSession(task)) {
			return false;
		}

		return !this.isRunningTaskHealthy(task);
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
				this.checkStaleTransitions();
				this.checkStuckTransitions();
				this.scheduleTreeRefresh();
			}, intervalMs);
		} else if (!hasRunning && this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
	}

	/** Exposed for testing — override to inject mock data */
	readRegistry(): TaskRegistry {
		this._registryLoadIssue = null;
		if (!this._filePath) return createEmptyTaskRegistry();

		let content = "";

		try {
			content = fs.readFileSync(this._filePath, "utf-8");
		} catch (err) {
			if (
				err instanceof Error &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return createEmptyTaskRegistry();
			}

			warnTaskRegistryFallback(
				this._filePath,
				err instanceof Error ? err.message : "Failed to read tasks.json",
			);
			return createEmptyTaskRegistry();
		}

		if (content.trim().length === 0) {
			warnTaskRegistryFallback(this._filePath, "tasks.json is empty");
			return createEmptyTaskRegistry();
		}

		try {
			const parsed = JSON.parse(content) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				warnTaskRegistryFallback(
					this._filePath,
					"tasks.json root is not a JSON object",
				);
				return createEmptyTaskRegistry();
			}

			const parsedRegistry = parsed as Record<string, unknown>;
			const version = parsedRegistry["version"];
			const normalizedTasks = normalizeRegistryTasks(parsedRegistry["tasks"]);
			if ((version === 1 || version === 2) && normalizedTasks) {
				return { version: 2, tasks: normalizedTasks };
			}

			warnTaskRegistryFallback(
				this._filePath,
				version !== 1 && version !== 2
					? `unsupported tasks.json version: ${String(version)}`
					: "tasks.json is missing a valid tasks collection",
			);
			return createEmptyTaskRegistry();
		} catch (err) {
			warnTaskRegistryFallback(
				this._filePath,
				err instanceof Error ? err.message : "Failed to parse tasks.json",
			);
			return createEmptyTaskRegistry();
		}
	}

	getTreeItem(element: AgentNode): vscode.TreeItem {
		if (element.type === "summary") {
			return this.createSummaryItem(element);
		}
		if (element.type === "task") {
			return this.createTaskItem(element.task);
		}
		if (element.type === "openclawTask") {
			return this.createOpenClawTaskItem(element.task);
		}
		if (element.type === "backgroundTasks") {
			return this.createBackgroundTasksItem(element);
		}
		if (element.type === "taskFlowGroup") {
			return this.createTaskFlowItem(element.flow);
		}
		if (element.type === "taskflows") {
			return this.createTaskFlowsItem(element);
		}
		if (element.type === "projectGroup") {
			return this.createProjectGroupItem(element);
		}
		if (element.type === "folderGroup") {
			return this.createFolderGroupItem(element);
		}
		if (element.type === "statusGroup") {
			return this.createStatusGroupItem(element);
		}
		if (element.type === "statusTimeGroup") {
			return this.createStatusTimeGroupItem(element);
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
		if (element.type === "taskFlowChild") {
			const item = new vscode.TreeItem(element.label);
			item.description = element.status;
			item.iconPath = new vscode.ThemeIcon("circle-outline");
			return item;
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		if (!element) {
			const allTasks = this.getScopedLauncherTasks();
			const discovered = this.getScopedDiscoveredAgents();
			const openclawTasks = this.getVisibleOpenClawTasks();
			const taskFlows = this.getVisibleTaskFlows();
			const hasAnyAgents =
				allTasks.length > 0 ||
				discovered.length > 0 ||
				openclawTasks.length > 0 ||
				taskFlows.length > 0;
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
				return [
					{
						type: "state",
						label: "No agents tracked yet",
						description: "Start an agent task to populate this view.",
						icon: "info",
					},
				];
			}

			const tasks = allTasks;
			const groupedByProject = this.isProjectGroupingEnabled();
			const showOpenClawInline = !groupedByProject;
			const sortableFlatNodes = this.sortAgentNodes([
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
				...(showOpenClawInline
					? openclawTasks.map(
							(task) =>
								({
									type: "openclawTask" as const,
									task,
								}) satisfies SortableAgentNode,
						)
					: []),
			]);
			const groupedNodes: AgentNode[] = groupedByProject
				? this.buildGroupedRootNodes(tasks, discovered)
				: [];
			const flatNodes: AgentNode[] = groupedByProject
				? []
				: this.applyAgentVisibilityCap(sortableFlatNodes);

			const agentCounts = countAgentStatuses(
				this.getScopedAgentTasksForSummary(tasks, discovered),
			);
			const counts = countAgentStatuses(
				this.getScopedTasksForSummary(tasks, discovered),
			);
			const backgroundTaskCount = openclawTasks.length;
			const stuckCount = this.getStuckRunningCount(allTasks);
			const summaryLabel = [
				this.formatScopedAgentCount(agentCounts.total),
				this.formatSummaryCounts(counts),
				...(backgroundTaskCount > 0
					? [
							backgroundTaskCount === 1
								? "1 background task"
								: `${backgroundTaskCount} background tasks`,
						]
					: []),
				...(stuckCount > 0 ? [`${stuckCount} stuck`] : []),
			]
				.filter((part) => part.length > 0)
				.join(" · ");
			const summaryTooltip = this.getSummaryTooltip(agentCounts, stuckCount);

			return [
				{
					type: "summary" as const,
					label: summaryLabel,
					tooltip: summaryTooltip || undefined,
				},
				...(!showOpenClawInline && openclawTasks.length > 0
					? [
							{
								type: "backgroundTasks" as const,
								tasks: openclawTasks,
							},
						]
					: []),
				...(taskFlows.length > 0
					? [
							{
								type: "taskflows" as const,
								flows: taskFlows,
							},
						]
					: []),
				...(groupedByProject ? groupedNodes : flatNodes),
			];
		}

		if (element.type === "folderGroup") {
			return element.projects;
		}

		if (element.type === "projectGroup") {
			return this.getProjectGroupChildren(element);
		}

		if (element.type === "statusGroup") {
			return this.getStatusGroupChildren(element);
		}

		if (element.type === "statusTimeGroup") {
			return element.nodes.map((node) => this.toAgentNode(node));
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

		if (element.type === "openclawTask") {
			return this.getOpenClawTaskDetailChildren(element.task);
		}

		if (element.type === "taskflows") {
			return element.flows.map(
				(flow): TaskFlowGroupNode => ({ type: "taskFlowGroup", flow }),
			);
		}

		if (element.type === "taskFlowGroup") {
			return this.getTaskFlowDetailChildren(element.flow);
		}

		if (element.type === "backgroundTasks") {
			return this.applyAgentVisibilityCap(
				this.sortAgentNodes(
					element.tasks.map(
						(task) =>
							({
								type: "openclawTask" as const,
								task,
							}) satisfies SortableAgentNode,
					),
				),
			);
		}

		if (element.type === "discovered") {
			return this.getDiscoveredChildren(element.agent);
		}

		return [];
	}

	private getTaskDiffCacheKey(task: AgentTask): string {
		return [
			"task",
			task.id,
			task.status,
			task.project_dir,
			task.started_at,
			task.start_sha ?? task.start_commit ?? "",
			task.updated_at ?? "",
			task.completed_at ?? "",
		].join(":");
	}

	private getDiscoveredDiffCacheKey(agent: DiscoveredAgent): string {
		return `discovered:${agent.pid}:${agent.projectDir}:${agent.startTime.toISOString()}`;
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
					this.scheduleTreeRefresh(this.getTaskRefreshElement(task.id));
				})
				.finally(() => {
					this._diffSummaryDetecting.delete(cacheKey);
				});
		}

		return null;
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
					this.scheduleTreeRefresh({
						type: "discovered",
						agent,
					});
				})
				.finally(() => {
					this._diffSummaryDetecting.delete(cacheKey);
				});
		}
		return null;
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
		const sourceLabel =
			agent.source === "process"
				? "Discovered via ps"
				: "Discovered via session file";
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "PID",
				value: `${agent.pid}`,
				taskId: `discovered-${agent.pid}`,
			},
			{
				type: "detail",
				label: "Source",
				value: sourceLabel,
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
		}
		// Omit diff loading placeholder — show nothing until ready
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
		return false;
	}

	private isProjectGroupingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<boolean>("agentStatus.groupByProject", true);
	}

	private getMaxVisibleAgents(): number {
		return AgentStatusTreeProvider.MAX_VISIBLE_AGENTS_DEFAULT;
	}

	private formatSummaryCounts(counts: AgentCounts): string {
		const parts = [
			counts.working > 0 ? `${counts.working} working` : null,
			counts.attention > 0 ? `${counts.attention} stopped` : null,
			counts.done > 0 ? `${counts.done} done` : null,
		];

		return (
			parts.filter((part): part is string => Boolean(part)).join(" · ") ||
			"No agents"
		);
	}

	private getTimestampMs(timestamp?: string | null): number {
		if (!timestamp) return 0;
		const timeMs = new Date(timestamp).getTime();
		return Number.isFinite(timeMs) ? timeMs : 0;
	}

	private getTaskStartedTimeMs(task: AgentTask): number {
		return this.getTimestampMs(task.started_at);
	}

	private getTaskActivityTimeMs(task: AgentTask): number {
		return Math.max(
			this.getTaskStartedTimeMs(task),
			this.getTimestampMs(task.completed_at),
			this.getTimestampMs(task.updated_at),
		);
	}

	private getDiscoveredActivityTimeMs(agent: DiscoveredAgent): number {
		const startedAtMs = agent.startTime.getTime();
		return Number.isFinite(startedAtMs) ? startedAtMs : 0;
	}

	private getNodeActivityTimeMs(node: SortableAgentNode): number {
		if (node.type === "task") {
			return this.getTaskActivityTimeMs(node.task);
		}
		if (node.type === "discovered") {
			return this.getDiscoveredActivityTimeMs(node.agent);
		}
		return this.getOpenClawTaskActivityTimeMs(node.task);
	}

	private getNodeStatus(node: SortableAgentNode): AgentTaskStatus {
		if (node.type === "task") return node.task.status;
		if (node.type === "discovered") return "running";
		return this.mapOpenClawTaskToAgentStatus(node.task);
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
		const priorityDiff =
			TASK_STATUS_PRIORITY[this.getNodeStatusGroup(left)] -
			TASK_STATUS_PRIORITY[this.getNodeStatusGroup(right)];
		if (priorityDiff !== 0) {
			return priorityDiff;
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
		if (left.type === "openclawTask" && right.type === "openclawTask") {
			return this.compareTaskNames(left.task.taskId, right.task.taskId);
		}
		if (left.type === "discovered" && right.type === "discovered") {
			return right.agent.pid - left.agent.pid;
		}
		if (left.type === "task") return -1;
		if (right.type === "task") return 1;
		if (left.type === "openclawTask") return -1;
		if (right.type === "openclawTask") return 1;
		return 1;
	}

	private sortAgentNodes(nodes: SortableAgentNode[]): SortableAgentNode[] {
		return [...nodes].sort((left, right) =>
			this.compareSortableAgentNodes(left, right),
		);
	}

	private toAgentNode(node: SortableAgentNode): AgentNode {
		if (node.type === "task") {
			return { type: "task", task: node.task };
		}
		if (node.type === "discovered") {
			return { type: "discovered", agent: node.agent };
		}
		return { type: "openclawTask", task: node.task };
	}

	private getNodeStatusGroup(node: SortableAgentNode): AgentStatusGroup {
		const status = this.getNodeStatus(node);
		if (status === "running") return "running";
		if (
			status === "completed" ||
			status === "completed_dirty" ||
			status === "completed_stale"
		) {
			return "done";
		}
		return "attention";
	}

	private buildStatusGroupNodes(
		nodes: SortableAgentNode[],
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
		},
	): AgentNode[] {
		const grouped = new Map<AgentStatusGroup, SortableAgentNode[]>();
		for (const node of nodes) {
			const statusGroup = this.getNodeStatusGroup(node);
			const bucket = grouped.get(statusGroup) ?? [];
			bucket.push(node);
			grouped.set(statusGroup, bucket);
		}

		return (["running", "attention", "done"] as AgentStatusGroup[])
			.map((status) => {
				const groupNodes = grouped.get(status) ?? [];
				if (groupNodes.length === 0) return null;
				const groupNode: StatusGroupNode = {
					type: "statusGroup",
					status,
					nodes: groupNodes,
				};
				if (options?.parentProjectName) {
					groupNode.parentProjectName = options.parentProjectName;
				}
				if (options?.parentProjectDir) {
					groupNode.parentProjectDir = options.parentProjectDir;
				}
				if (options?.parentGroupKey) {
					groupNode.parentGroupKey = options.parentGroupKey;
				}
				return groupNode;
			})
			.filter((node): node is StatusGroupNode => Boolean(node));
	}

	private shouldUseStatusTimeGrouping(
		_status: AgentStatusGroup,
		_nodes: SortableAgentNode[],
	): boolean {
		return false;
	}

	private getStatusGroupRecentThresholdMs(status: AgentStatusGroup): number {
		if (status === "running") return Number.POSITIVE_INFINITY;
		if (status === "attention") return 2 * DAY_MS;
		return DAY_MS;
	}

	private buildStatusTimeGroups(
		status: AgentStatusGroup,
		nodes: SortableAgentNode[],
	): StatusTimeGroupNode[] {
		const periods: StatusTimeGroupPeriod[] = [
			"today",
			"yesterday",
			"last7days",
			"last30days",
			"older",
		];
		const grouped = groupByTimePeriod(
			nodes,
			(node) => this.getNodeActivityTimeMs(node),
			periods,
		);

		return periods
			.map((period) => {
				const periodNodes = grouped.get(period) ?? [];
				if (periodNodes.length === 0) return null;

				return {
					type: "statusTimeGroup" as const,
					status,
					period,
					label: `${TIME_PERIOD_LABELS[period]} (${periodNodes.length})`,
					nodes: periodNodes,
					collapsibleState:
						period === "older" || period === "last30days"
							? vscode.TreeItemCollapsibleState.Collapsed
							: vscode.TreeItemCollapsibleState.Expanded,
				};
			})
			.filter((group): group is StatusTimeGroupNode => Boolean(group));
	}

	private getStatusGroupChildren(node: StatusGroupNode): AgentNode[] {
		if (!this.shouldUseStatusTimeGrouping(node.status, node.nodes)) {
			return this.applyAgentVisibilityCap(node.nodes, {
				parentProjectName: node.parentProjectName,
				parentProjectDir: node.parentProjectDir,
				parentGroupKey: node.parentGroupKey,
			});
		}

		return this.buildStatusTimeGroups(node.status, node.nodes);
	}

	private getProjectGroupChildren(node: ProjectGroupNode): AgentNode[] {
		return this.buildStatusGroupNodes(
			this.sortAgentNodes([
				...node.tasks.map(
					(task) =>
						({ type: "task" as const, task }) satisfies SortableAgentNode,
				),
				...(node.discoveredAgents ?? []).map(
					(agent) =>
						({
							type: "discovered" as const,
							agent,
						}) satisfies SortableAgentNode,
				),
			]),
			{
				parentProjectName: node.projectName,
				parentProjectDir: node.projectDir,
				parentGroupKey: node.parentGroupKey,
			},
		);
	}

	private statusGroupHasRecentItems(node: StatusGroupNode): boolean {
		if (node.status === "running") return true;

		const now = Date.now();
		const thresholdMs = this.getStatusGroupRecentThresholdMs(node.status);
		return node.nodes.some((child) => {
			const activityMs = this.getNodeActivityTimeMs(child);
			return activityMs > 0 && now - activityMs <= thresholdMs;
		});
	}

	private isAlwaysVisibleAgentNode(node: SortableAgentNode): boolean {
		if (node.type === "openclawTask") {
			return this.isOpenClawTaskActive(node.task);
		}
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
		if (left.type === "openclawTask") {
			const rightTask = right as Extract<
				SortableAgentNode,
				{ type: "openclawTask" }
			>;
			return left.task.taskId === rightTask.task.taskId;
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
		const leftHasRunning = this.projectGroupHasRunning(left);
		const rightHasRunning = this.projectGroupHasRunning(right);
		if (leftHasRunning !== rightHasRunning) {
			return leftHasRunning ? -1 : 1;
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
		const leftLabel =
			left.type === "folderGroup" ? left.groupName : left.projectName;
		const rightLabel =
			right.type === "folderGroup" ? right.groupName : right.projectName;
		const leftHasRunning =
			left.type === "folderGroup"
				? left.projects.some((project) => this.projectGroupHasRunning(project))
				: this.projectGroupHasRunning(left);
		const rightHasRunning =
			right.type === "folderGroup"
				? right.projects.some((project) => this.projectGroupHasRunning(project))
				: this.projectGroupHasRunning(right);
		if (leftHasRunning !== rightHasRunning) {
			return leftHasRunning ? -1 : 1;
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
			const retrySuffix =
				t.attempts > 1 ? ` · Retry ${t.attempts}/${t.max_attempts}` : "";
			const errorMessage = t.error_message?.trim();
			details.push({
				type: "detail",
				label: `Error: ❌ Failed (code ${t.exit_code})${retrySuffix}`,
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
				label: "Agent process ended",
				value: "Click to restart or dismiss",
				taskId: t.id,
				icon: "alert",
				iconColor: "charts.yellow",
			});
		}
		if (rawStatus === "running" && t.status === "completed_stale") {
			details.push({
				type: "detail",
				label: STALE_AGENT_STATUS_DESCRIPTION,
				value: "Mark as failed to persist the transition",
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

		const promptSummary = this.readPromptSummary(t.prompt_file);
		const isPromptFallback =
			!promptSummary || promptSummary === path.basename(t.prompt_file);
		const promptValue =
			isPromptFallback && t.prompt_summary ? t.prompt_summary : promptSummary;
		if (promptValue && promptValue !== "---" && !promptValue.endsWith(".md")) {
			details.push({
				type: "detail",
				label: "Prompt",
				value: promptValue,
				taskId: t.id,
			});
		}

		// Diff summary
		const diffSummary = this.getCachedDiffSummaryForTask(t);
		if (diffSummary) {
			details.push({
				type: "detail",
				label: "Changes",
				value: diffSummary,
				taskId: t.id,
			});
		}
		// Omit diff loading placeholder — show nothing until ready

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
			const resultText =
				t.exit_code === 0 ? "✅ Success" : `❌ Failed (code ${t.exit_code})`;
			const retrySuffix =
				t.attempts > 1 ? ` · Retry ${t.attempts}/${t.max_attempts}` : "";
			details.push({
				type: "detail",
				label: "Result",
				value: `${resultText}${retrySuffix}`,
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

		// Model — from tasks.json (spawn-time) or OpenClaw config (policy)
		const detailFallback = this.getTaskFallbackInfo(t);
		const modelDisplay = this.resolveTaskModelDisplay(t);
		if (detailFallback) {
			details.push({
				type: "detail",
				label: "Model",
				value: `${detailFallback.actualFull} (fallback from ${detailFallback.requestedFull})`,
				taskId: t.id,
			});
		} else if (modelDisplay) {
			details.push({
				type: "detail",
				label: "Model",
				value: `${modelDisplay.fullName} (${modelDisplay.isExplicit ? "explicit" : "inherited"})`,
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
				void this._detectPortsAsync(t);
				details.push({
					type: "detail",
					label: "Ports",
					value: PORT_LOADING_LABEL,
					taskId: t.id,
				});
			} else {
				details.push({
					type: "detail",
					label: "Ports",
					value: PORT_LOADING_LABEL,
					taskId: t.id,
				});
			}
		}

		return details;
	}

	private getFileChangeChildren(t: AgentTask): FileChangeNode[] {
		const startCommit = this.getTaskDiffStartCommit(t);
		const endCommit = this.getTaskDiffEndCommit(t);
		const fileDiffs = this.getPerFileDiffs(
			t.project_dir,
			startCommit,
			endCommit,
		);
		return fileDiffs.map((diff) => ({
			type: "fileChange",
			taskId: t.id,
			projectDir: t.project_dir,
			filePath: diff.filePath,
			additions: diff.additions,
			deletions: diff.deletions,
			taskStatus: t.status,
			startCommit,
			endCommit,
		}));
	}

	private formatOpenClawTaskDuration(task: OpenClawTask): string | null {
		const start = task.startedAt ?? task.createdAt;
		if (!start) return null;
		const end = task.endedAt ?? Date.now();
		const durationMs = Math.max(0, end - start);
		const totalMinutes = Math.floor(durationMs / 60_000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
		if (hours > 0) return `${hours}h`;
		return `${minutes}m`;
	}

	private getOpenClawRuntimeIcon(runtime: OpenClawTask["runtime"]): string {
		switch (runtime) {
			case "cron":
				return "clock";
			case "acp":
				return "hubot";
			case "subagent":
				return "organization";
			case "cli":
				return "terminal";
		}
	}

	private getOpenClawTaskDetailChildren(task: OpenClawTask): DetailNode[] {
		const taskId = `openclaw-${task.taskId}`;
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Runtime",
				value: task.runtime,
				taskId,
				icon: this.getOpenClawRuntimeIcon(task.runtime),
			},
			{
				type: "detail",
				label: "Status",
				value: openclawStatusToLabel(task.status),
				taskId,
				icon: openclawStatusToIcon(task.status).id,
				iconColor: openclawStatusToIcon(task.status).color?.id,
			},
		];

		if (task.agentId) {
			details.push({
				type: "detail",
				label: "Agent",
				value: task.agentId,
				taskId,
				icon: "hubot",
			});
		}

		const duration = this.formatOpenClawTaskDuration(task);
		if (duration) {
			details.push({
				type: "detail",
				label: "Duration",
				value: duration,
				taskId,
				icon: "watch",
			});
		}

		if (task.error) {
			details.push({
				type: "detail",
				label: "Error",
				value: task.error,
				taskId,
				icon: "error",
				iconColor: "charts.red",
			});
		}

		const summary =
			task.terminalSummary?.trim() || task.progressSummary?.trim();
		if (summary) {
			details.push({
				type: "detail",
				label: "Summary",
				value: summary,
				taskId,
				icon: "note",
			});
		}

		return details;
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

	private getTaskDiffEndCommit(t: AgentTask): string | undefined {
		if (t.status === "running") return undefined;
		if (t.end_commit && t.end_commit !== "unknown") {
			return t.end_commit;
		}
		if (t.completed_at) {
			try {
				const commitHash = execFileSync(
					"git",
					[
						"-C",
						t.project_dir,
						"log",
						`--before=${t.completed_at}`,
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
				// Fallback to HEAD below
			}
		}
		return "HEAD";
	}

	/** Kick off async port detection; fires onDidChangeTreeData when done */
	private async _detectPortsAsync(task: AgentTask): Promise<void> {
		try {
			const ports = await detectListeningPortsAsync(task.project_dir);
			// Only update if task is still running (could have finished by now)
			if (this.registry.tasks[task.id]?.status === "running") {
				this._portCache.set(task.id, ports);
				this.scheduleTreeRefresh(this.getTaskRefreshElement(task.id));
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
			this.getPerFileDiffs(
				projectDir,
				this.getTaskDiffStartCommit(task),
				this.getTaskDiffEndCommit(task),
			),
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
	 * - Completed/stopped/failed: compare `startCommit..endCommit` (fallback: HEAD~1..HEAD)
	 */
	getPerFileDiffs(
		projectDir: string,
		startCommit?: string,
		endCommit?: string,
	): PerFileDiff[] {
		const runNumstat = (args: string[]): string =>
			execFileSync("git", args, {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
			}).trim();
		try {
			const resolvedEnd = endCommit ?? "HEAD";
			const primaryArgs = startCommit
				? [
						"-C",
						projectDir,
						"diff",
						"--numstat",
						`${startCommit}..${resolvedEnd}`,
					]
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
		const toSortableNode = (
			node: TaskNode | DiscoveredNode | OpenClawTaskNode,
		): SortableAgentNode => {
			if (node.type === "task") {
				return { type: "task", task: node.task };
			}
			if (node.type === "discovered") {
				return { type: "discovered", agent: node.agent };
			}
			return { type: "openclawTask", task: node.task };
		};

		if (this.isProjectGroupingEnabled()) {
			const openclawTasks = this.getVisibleOpenClawTasks();
			const groupedRoots = this.buildGroupedRootNodes(
				this.getScopedLauncherTasks(),
				this.getScopedDiscoveredAgents(),
			);
			const projects = groupedRoots.flatMap((root) =>
				root.type === "projectGroup" ? [root] : root.projects,
			);

			const findProjectParent = (
				matcher: (project: ProjectGroupNode) => boolean,
			): ProjectGroupNode | undefined => projects.find(matcher);

			if (element.type === "openclawTask") {
				if (openclawTasks.some((task) => task.taskId === element.task.taskId)) {
					return { type: "backgroundTasks", tasks: openclawTasks };
				}
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

			if (element.type === "statusGroup") {
				return findProjectParent((project) =>
					this.getProjectGroupChildren(project).some(
						(node) =>
							node.type === "statusGroup" && node.status === element.status,
					),
				);
			}

			for (const project of projects) {
				const projectChildren = this.getProjectGroupChildren(project);
				const statusGroups = projectChildren.filter(
					(node): node is StatusGroupNode => node.type === "statusGroup",
				);

				for (const statusGroup of statusGroups) {
					const statusChildren = this.getStatusGroupChildren(statusGroup);

					if (
						element.type === "statusTimeGroup" &&
						statusChildren.some(
							(node) =>
								node.type === "statusTimeGroup" &&
								node.status === element.status &&
								node.period === element.period,
						)
					) {
						return statusGroup;
					}

					if (
						element.type === "olderRuns" &&
						statusChildren.some(
							(node) =>
								node.type === "olderRuns" &&
								node.label === element.label &&
								node.parentProjectDir === element.parentProjectDir &&
								node.parentProjectName === element.parentProjectName,
						)
					) {
						return statusGroup;
					}

					if (element.type === "task" || element.type === "discovered") {
						const targetNode = toSortableNode(element);
						const olderRuns = statusChildren.find(
							(node): node is OlderRunsNode =>
								node.type === "olderRuns" &&
								this.olderRunsContainsNode(node, targetNode),
						);
						if (olderRuns) {
							return olderRuns;
						}

						const timeGroup = statusChildren.find(
							(node): node is StatusTimeGroupNode =>
								node.type === "statusTimeGroup" &&
								node.nodes.some((child) =>
									this.matchesSortableNode(child, targetNode),
								),
						);
						if (timeGroup) {
							return timeGroup;
						}

						if (
							statusChildren.some(
								(node) =>
									(node.type === "task" &&
										targetNode.type === "task" &&
										node.task.id === targetNode.task.id) ||
									(node.type === "discovered" &&
										targetNode.type === "discovered" &&
										node.agent.pid === targetNode.agent.pid),
							)
						) {
							return statusGroup;
						}
					}
				}
			}
		} else {
			const openclawTasks = this.getVisibleOpenClawTasks();
			const showOpenClawInline = true;
			const sortableNodes = this.sortAgentNodes([
				...this.getScopedLauncherTasks().map(
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
				...(showOpenClawInline
					? openclawTasks.map(
							(task) =>
								({
									type: "openclawTask" as const,
									task,
								}) satisfies SortableAgentNode,
						)
					: []),
			]);
			const flatRootNodes = this.applyAgentVisibilityCap(sortableNodes);
			const olderRuns = flatRootNodes.find(
				(node): node is OlderRunsNode => node.type === "olderRuns",
			);
			if (
				olderRuns &&
				(element.type === "task" ||
					element.type === "discovered" ||
					element.type === "openclawTask")
			) {
				const sortableNode = toSortableNode(element);
				if (this.olderRunsContainsNode(olderRuns, sortableNode)) {
					return olderRuns;
				}
			}
		}
		if (element.type === "backgroundTasks") {
			return undefined;
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
			if (element.taskId.startsWith("openclaw-")) {
				const openclawTaskId = element.taskId.replace("openclaw-", "");
				const task = this.getVisibleOpenClawTasks().find(
					(entry) => entry.taskId === openclawTaskId,
				);
				if (task) return { type: "openclawTask", task };
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
		for (const task of this.getDisplayLauncherTasks()) {
			displayTasks[task.id] = task;
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
		const syntheticOpenClaw = this.getVisibleOpenClawTasks().map((task) =>
			this.toSyntheticOpenClawTask(task),
		);
		return [...launcherTasks, ...syntheticDiscovered, ...syntheticOpenClaw];
	}

	getDiscoveryDiagnosticsReport(): string {
		const lines = ["Agent Status Discovery Diagnostics", ""];
		const displayTasks = this.getDisplayLauncherTasks();
		const runningTasks = displayTasks.filter(
			(task) => task.status === "running",
		);
		const backgroundTasks = this.getVisibleOpenClawTasks();
		const backgroundRunningCount = backgroundTasks.filter((task) =>
			this.isOpenClawTaskActive(task),
		).length;
		const backgroundSucceededCount = backgroundTasks.filter(
			(task) => task.status === "succeeded",
		).length;
		const backgroundOtherCount =
			backgroundTasks.length -
			backgroundRunningCount -
			backgroundSucceededCount;
		const discoveredAgents =
			this._allDiscoveredAgents.length > 0
				? this._allDiscoveredAgents
				: this._discoveredAgents;
		const runningAgentSubjects =
			discoveredAgents.length > 0 ? discoveredAgents : runningTasks;
		const now = new Date();
		const olderRegistryCount = displayTasks.filter((task) => {
			const activityMs = this.getTaskActivityTimeMs(task);
			return activityMs <= 0 || now.getTime() - activityMs > 24 * 60 * 60_000;
		}).length;
		const stuckCount = runningTasks.filter((task) =>
			this.isAgentStuck(task),
		).length;
		const healthStatus = !this._agentRegistry
			? "⚪ Discovery Disabled"
			: stuckCount > 0
				? "⚠️ Needs Attention"
				: "✅ Healthy";

		lines.push(`Agent Discovery Health: ${healthStatus}`);
		lines.push(
			`  Running agents: ${runningAgentSubjects.length} (${this.formatAgentTypeSummary(runningAgentSubjects)})`,
		);
		lines.push(
			`  Background tasks: ${backgroundTasks.length} (${this.formatBackgroundTaskSummary(backgroundRunningCount, backgroundSucceededCount, backgroundOtherCount)})`,
		);
		lines.push(
			`  Registry: ${displayTasks.length} tasks (${runningTasks.length} running, ${displayTasks.length - runningTasks.length} completed/archived)`,
		);

		if (!this._agentRegistry) {
			lines.push("");
			lines.push("Discovery: disabled");
			lines.push("");
			lines.push("Registry age:");
			for (const line of this.getRegistryAgeSummaryLines(displayTasks, now)) {
				lines.push(line);
			}
			lines.push("");
			lines.push("Recommendations:");
			lines.push("  ⚠️ Discovery is disabled in settings.");
			if (olderRegistryCount > 50 || displayTasks.length > 100) {
				lines.push(
					`  ⚠️ ${displayTasks.length} tasks in registry — consider: commandCentral.clearCompletedAgents`,
				);
			}
			lines.push("");
			for (const line of this.getOpenClawTaskLedgerLines()) {
				lines.push(line);
			}
			return lines.join("\n");
		}

		const diagnostics = this._agentRegistry.getDiagnostics();
		const processDiagnostics = diagnostics.processScanner;
		const processAgentCount = discoveredAgents.filter(
			(agent) => agent.source === "process",
		).length;
		const sessionFileAgentCount = discoveredAgents.filter(
			(agent) => agent.source === "session-file",
		).length;
		const filteredGroups = this.summarizeFilteredDiscoveryMatches(
			processDiagnostics.filtered,
		);

		lines.push(
			`  Discovery: ${processAgentCount} agents found via process scanner, ${sessionFileAgentCount} via session files`,
		);
		lines.push("");
		lines.push("Registry age:");
		for (const line of this.getRegistryAgeSummaryLines(displayTasks, now)) {
			lines.push(line);
		}

		if (filteredGroups.length > 0) {
			lines.push("");
			lines.push(`Filtered (${processDiagnostics.filtered.length} matches):`);
			for (const group of filteredGroups) {
				const detail = group.note
					? `${group.names} — ${group.note}`
					: group.names;
				lines.push(`  ${group.label}: ${group.count} (${detail})`);
			}
		}

		if (processDiagnostics.retained.length > 0) {
			lines.push("");
			lines.push(`Active agents (${processDiagnostics.retained.length}):`);
			for (const entry of processDiagnostics.retained) {
				lines.push(`  ${this.formatRetainedDiscoveryEntry(entry, now)}`);
			}
		}

		lines.push("");
		lines.push("Recommendations:");
		for (const line of this.getDiscoveryRecommendationLines({
			displayTasks,
			runningTasks,
			stuckCount,
			olderRegistryCount,
			filtered: processDiagnostics.filtered,
		})) {
			lines.push(line);
		}

		lines.push("");
		for (const line of this.getOpenClawTaskLedgerLines()) {
			lines.push(line);
		}

		return lines.join("\n");
	}

	private getOpenClawTaskLedgerLines(): string[] {
		const taskService = this._openclawTaskService;
		if (!taskService || taskService.isInstalled === false) {
			return ["OpenClaw: not detected (task audit skipped)"];
		}

		const tasks = taskService.getTasks();
		const runningCount = tasks.filter(
			(task) => task.status === "queued" || task.status === "running",
		).length;
		const succeededCount = tasks.filter(
			(task) => task.status === "succeeded",
		).length;
		const failedCount = tasks.length - runningCount - succeededCount;
		const audit = this.getOpenClawTaskAuditData();
		const staleRunningCount = audit.summary.byCode["stale_running"] ?? 0;

		const lines = [
			"OpenClaw Task Ledger:",
			` Total: ${tasks.length} tasks (7-day window)`,
			` Running: ${runningCount}${staleRunningCount > 0 ? ` (${this.formatOpenClawAuditStatusLabel("stale_running", staleRunningCount)})` : ""}`,
			` Succeeded: ${succeededCount}`,
			` Failed: ${failedCount}`,
			"",
			"Audit findings:",
		];

		if (audit.error) {
			lines.push(` ⚠️ Task audit failed: ${audit.error}`);
			return lines;
		}

		const staleLabel =
			staleRunningCount === 1 ? "stale running task" : "stale running tasks";
		if (staleRunningCount > 0) {
			lines.push(
				` ⚠️ ${staleRunningCount} ${staleLabel} — may need manual cleanup`,
			);
		}

		const inconsistentTimestamps =
			audit.summary.byCode["inconsistent_timestamps"] ?? 0;
		if (inconsistentTimestamps > 0) {
			const label =
				inconsistentTimestamps === 1
					? "inconsistent timestamp"
					: "inconsistent timestamps";
			lines.push(
				` ℹ️ ${inconsistentTimestamps} ${label} (OpenClaw-side, cosmetic)`,
			);
		}

		const remainingErrors = Math.max(
			0,
			audit.summary.errors - staleRunningCount,
		);
		const remainingWarnings = Math.max(
			0,
			audit.summary.warnings - inconsistentTimestamps,
		);
		if (remainingErrors > 0) {
			lines.push(
				` ⚠️ ${remainingErrors} additional audit error${remainingErrors === 1 ? "" : "s"}`,
			);
		}
		if (remainingWarnings > 0) {
			lines.push(
				` ℹ️ ${remainingWarnings} additional audit warning${remainingWarnings === 1 ? "" : "s"}`,
			);
		}
		if (audit.summary.total === 0) {
			lines.push(" ✅ No audit findings");
		}

		return lines;
	}

	private getOpenClawTaskAuditData(): {
		summary: {
			total: number;
			warnings: number;
			errors: number;
			byCode: Record<string, number>;
		};
		error?: string;
	} {
		const emptySummary = {
			total: 0,
			warnings: 0,
			errors: 0,
			byCode: {
				stale_queued: 0,
				stale_running: 0,
				lost: 0,
				delivery_failed: 0,
				missing_cleanup: 0,
				inconsistent_timestamps: 0,
			} satisfies Record<string, number>,
		};

		try {
			const stdout = execFileSync("openclaw", ["tasks", "audit", "--json"], {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.OPENCLAW_AUDIT_TIMEOUT_MS,
			});
			const parsed = JSON.parse(stdout) as {
				summary?: {
					total?: number;
					warnings?: number;
					errors?: number;
					byCode?: Record<string, number>;
				};
			};
			return {
				summary: {
					total: Number(parsed.summary?.total ?? 0),
					warnings: Number(parsed.summary?.warnings ?? 0),
					errors: Number(parsed.summary?.errors ?? 0),
					byCode: {
						...emptySummary.byCode,
						...(parsed.summary?.byCode ?? {}),
					},
				},
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException & {
				stdout?: string | Buffer;
				stderr?: string | Buffer;
			};
			if (err.code === "ENOENT") {
				return { summary: emptySummary, error: "OpenClaw is not installed" };
			}

			const detail =
				typeof err.stderr === "string" && err.stderr.trim().length > 0
					? err.stderr.trim()
					: err.message;
			return { summary: emptySummary, error: detail };
		}
	}

	private formatOpenClawAuditStatusLabel(code: string, count: number): string {
		if (code === "stale_running") {
			return count === 1
				? "stale_running error detected"
				: "stale_running errors detected";
		}
		return count === 1 ? `${code} detected` : `${code} findings detected`;
	}

	private formatAgentTypeSummary(
		agents: Array<DiscoveredAgent | AgentTask>,
	): string {
		if (agents.length === 0) return "none";

		const counts = new Map<string, number>();
		for (const agent of agents) {
			const type = detectAgentType(agent);
			const label = type === "unknown" ? "unknown" : type;
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}

		return [...counts.entries()]
			.sort((left, right) =>
				right[1] === left[1]
					? left[0].localeCompare(right[0])
					: right[1] - left[1],
			)
			.map(([label, count]) => `${count} ${label}`)
			.join(", ");
	}

	private formatBackgroundTaskSummary(
		runningCount: number,
		succeededCount: number,
		otherCount: number,
	): string {
		const parts = [
			runningCount > 0 ? `${runningCount} running` : null,
			succeededCount > 0 ? `${succeededCount} succeeded` : null,
			otherCount > 0 ? `${otherCount} other` : null,
		];
		return (
			parts.filter((part): part is string => part !== null).join(", ") || "none"
		);
	}

	private getRegistryAgeSummaryLines(
		tasks: AgentTask[],
		now = new Date(),
	): string[] {
		const bucket1h = tasks.filter((task) => {
			const activityMs = this.getTaskActivityTimeMs(task);
			return activityMs > 0 && now.getTime() - activityMs <= 60 * 60_000;
		});
		const bucket24h = tasks.filter((task) => {
			const activityMs = this.getTaskActivityTimeMs(task);
			return (
				activityMs > 0 &&
				now.getTime() - activityMs > 60 * 60_000 &&
				now.getTime() - activityMs <= 24 * 60 * 60_000
			);
		});
		const older = tasks.length - bucket1h.length - bucket24h.length;

		return [
			`  Last 1h: ${bucket1h.length} tasks (${this.formatRegistryBucketStatusSummary(bucket1h)})`,
			`  Last 24h: ${bucket24h.length} tasks`,
			`  Older: ${older} tasks${older > 0 ? " (archive candidates)" : ""}`,
		];
	}

	private formatRegistryBucketStatusSummary(tasks: AgentTask[]): string {
		if (tasks.length === 0) return "0 running, 0 completed";
		const runningCount = tasks.filter(
			(task) => task.status === "running",
		).length;
		const archivedCount = tasks.length - runningCount;
		return `${runningCount} running, ${archivedCount} completed`;
	}

	private summarizeFilteredDiscoveryMatches(
		entries: ProcessScanDiagnosticEntry[],
	): Array<{ label: string; count: number; names: string; note?: string }> {
		const groups = new Map<
			string,
			{
				label: string;
				note?: string;
				count: number;
				nameCounts: Map<string, number>;
			}
		>();

		for (const entry of entries) {
			const category = this.getDiscoveryFilterCategory(entry.reason);
			const group = groups.get(category.key) ?? {
				label: category.label,
				note: category.note,
				count: 0,
				nameCounts: new Map<string, number>(),
			};
			group.count += 1;
			const name = this.getDiscoveryDiagnosticName(entry);
			group.nameCounts.set(name, (group.nameCounts.get(name) ?? 0) + 1);
			groups.set(category.key, group);
		}

		return [...groups.values()]
			.sort((left, right) => right.count - left.count)
			.map((group) => ({
				label: group.label,
				count: group.count,
				names: this.formatDiscoveryNameCounts(group.nameCounts),
				note: group.note,
			}));
	}

	private getDiscoveryFilterCategory(
		reason: ProcessScanFilterReason | undefined,
	): { key: string; label: string; note?: string } {
		switch (reason) {
			case "excluded-binary":
				return {
					key: "helper-binaries",
					label: "Helper binaries",
					note: "consider killing stale processes",
				};
			case "interactive-process":
			case "shell-process":
				return {
					key: "interactive-cli",
					label: "Interactive CLIs",
					note: "idle sessions, not agents",
				};
			case "noise-process":
				return {
					key: "ui-noise",
					label: "UI/helper noise",
					note: "renderer/helper processes",
				};
			case "stale-process":
				return {
					key: "stale-processes",
					label: "Stale processes",
					note: "inactive streams or long-idle shells",
				};
			case "cwd-unresolved":
				return {
					key: "cwd-unresolved",
					label: "CWD lookup failures",
					note: "missing usable project directories",
				};
			case "internal-tool-dir":
				return {
					key: "internal-tools",
					label: "Internal tool directories",
					note: "internal tooling, not user agents",
				};
			default:
				return { key: "other", label: "Other filtered matches" };
		}
	}

	private getDiscoveryDiagnosticName(
		entry: ProcessScanDiagnosticEntry,
	): string {
		const binaryName = entry.binaryName?.trim().toLowerCase();
		if (binaryName) return binaryName;
		const detected = detectAgentType({
			process_name: entry.binaryName,
			command: entry.command,
		});
		return detected === "unknown" ? "unknown" : detected;
	}

	private formatDiscoveryNameCounts(nameCounts: Map<string, number>): string {
		const entries = [...nameCounts.entries()].sort((left, right) =>
			right[1] === left[1]
				? left[0].localeCompare(right[0])
				: right[1] - left[1],
		);
		return entries
			.slice(0, 3)
			.map(([name, count]) => (count > 1 ? `${count} ${name}` : name))
			.join(", ");
	}

	private formatRetainedDiscoveryEntry(
		entry: ProcessScanDiagnosticEntry,
		now = new Date(),
	): string {
		const agentType = detectAgentType({
			process_name: entry.binaryName,
			command: entry.command,
		});
		const projectName = entry.projectDir
			? path.basename(entry.projectDir) || entry.projectDir
			: "unknown";
		return `${agentType === "unknown" ? (entry.binaryName ?? "unknown") : agentType} · ${projectName} · PID ${entry.pid} · running ${formatElapsed(entry.startTime.toISOString(), now)}`;
	}

	private getDiscoveryRecommendationLines(args: {
		displayTasks: AgentTask[];
		runningTasks: AgentTask[];
		stuckCount: number;
		olderRegistryCount: number;
		filtered: ProcessScanDiagnosticEntry[];
	}): string[] {
		const lines: string[] = [];
		const terminalNotifierCount = args.filtered.filter(
			(entry) => entry.binaryName?.toLowerCase() === "terminal-notifier",
		).length;

		if (terminalNotifierCount > 0) {
			lines.push(
				`  ⚠️ ${terminalNotifierCount} stale terminal-notifier processes — run: pkill -f "terminal-notifier.*oste"`,
			);
		}

		if (args.olderRegistryCount > 50 || args.displayTasks.length > 100) {
			lines.push(
				`  ⚠️ ${args.displayTasks.length} tasks in registry — consider: commandCentral.clearCompletedAgents`,
			);
		}

		if (args.stuckCount > 0) {
			lines.push(
				`  ⚠️ ${args.stuckCount} running ${args.stuckCount === 1 ? "agent looks" : "agents look"} stuck — inspect the session before reusing it`,
			);
		} else {
			lines.push("  ✅ No stuck agents detected");
		}

		if (
			args.runningTasks.length > 0 &&
			args.runningTasks.every(
				(task) =>
					task.terminal_backend === "tmux" &&
					Boolean(task.session_id) &&
					!this.isAgentStuck(task),
			)
		) {
			lines.push("  ✅ All running agents have healthy tmux sessions");
		}

		if (lines.length === 0) {
			lines.push("  ✅ No action needed");
		}

		return lines;
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

	private createBackgroundTasksItem(
		node: BackgroundTasksNode,
	): vscode.TreeItem {
		const count = node.tasks.length;
		const item = new vscode.TreeItem(
			count === 1 ? "Background Tasks · 1" : `Background Tasks · ${count}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = count === 1 ? "1 task" : `${count} tasks`;
		item.contextValue = "backgroundTasks";
		item.iconPath = new vscode.ThemeIcon("pulse");
		return item;
	}

	private createTaskFlowsItem(node: TaskFlowsContainerNode): vscode.TreeItem {
		const count = node.flows.length;
		const activeCount = node.flows.filter(
			(f) =>
				f.status === "queued" ||
				f.status === "running" ||
				f.status === "waiting",
		).length;
		const item = new vscode.TreeItem(
			count === 1 ? "Task Flows · 1" : `Task Flows · ${count}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description =
			activeCount > 0
				? `${activeCount} active`
				: count === 1
					? "1 flow"
					: `${count} flows`;
		item.contextValue = "taskflows";
		item.iconPath = new vscode.ThemeIcon("layers");
		return item;
	}

	private createTaskFlowItem(flow: TaskFlow): vscode.TreeItem {
		const title = flow.label?.trim() || flow.flowId;
		const progressPart =
			flow.taskCount > 0
				? `${flow.completedCount}/${flow.taskCount} tasks`
				: undefined;
		const descriptionParts = [
			taskflowStatusToLabel(flow.status),
			progressPart,
			flow.failedCount > 0 ? `${flow.failedCount} failed` : undefined,
		].filter((part): part is string => Boolean(part));
		const item = new vscode.TreeItem(
			title,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = descriptionParts.join(" · ");
		item.tooltip = new vscode.MarkdownString(
			[
				`**${title}**`,
				`Flow ID: \`${flow.flowId}\``,
				`Status: ${taskflowStatusToLabel(flow.status)}`,
				flow.agentId ? `Agent: ${flow.agentId}` : null,
				flow.taskCount > 0
					? `Progress: ${flow.completedCount}/${flow.taskCount} completed`
					: null,
				flow.failedCount > 0 ? `Failed: ${flow.failedCount}` : null,
				flow.error ? `Error: ${flow.error}` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath = taskflowStatusToIcon(flow.status);
		item.contextValue = `taskflow.${flow.status}`;
		item.resourceUri = vscode.Uri.parse(`taskflow:${flow.flowId}`);
		return item;
	}

	private getTaskFlowDetailChildren(flow: TaskFlow): DetailNode[] {
		const flowId = `taskflow-${flow.flowId}`;
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Status",
				value: taskflowStatusToLabel(flow.status),
				taskId: flowId,
				icon: taskflowStatusToIcon(flow.status).id,
				iconColor: taskflowStatusToIcon(flow.status).color?.id,
			},
		];

		if (flow.agentId) {
			details.push({
				type: "detail",
				label: "Agent",
				value: flow.agentId,
				taskId: flowId,
				icon: "hubot",
			});
		}

		if (flow.taskCount > 0) {
			details.push({
				type: "detail",
				label: "Progress",
				value: `${flow.completedCount}/${flow.taskCount} completed`,
				taskId: flowId,
				icon: "checklist",
			});
		}

		if (flow.failedCount > 0) {
			details.push({
				type: "detail",
				label: "Failed",
				value: `${flow.failedCount}`,
				taskId: flowId,
				icon: "error",
				iconColor: "charts.red",
			});
		}

		const duration = this.formatTaskFlowDuration(flow);
		if (duration) {
			details.push({
				type: "detail",
				label: "Duration",
				value: duration,
				taskId: flowId,
				icon: "watch",
			});
		}

		if (flow.error) {
			details.push({
				type: "detail",
				label: "Error",
				value: flow.error,
				taskId: flowId,
				icon: "error",
				iconColor: "charts.red",
			});
		}

		return details;
	}

	private formatTaskFlowDuration(flow: TaskFlow): string | null {
		const start = flow.startedAt ?? flow.createdAt;
		if (!start) return null;
		const end = flow.endedAt ?? Date.now();
		const durationMs = Math.max(0, end - start);
		const totalMinutes = Math.floor(durationMs / 60_000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
		if (hours > 0) return `${hours}h`;
		return `${minutes}m`;
	}

	private getVisibleTaskFlows(): TaskFlow[] {
		const flows = this._taskFlowService?.getFlows() ?? [];
		return [...flows].sort(
			(left, right) =>
				(right.endedAt ?? right.startedAt ?? right.createdAt ?? 0) -
				(left.endedAt ?? left.startedAt ?? left.createdAt ?? 0),
		);
	}

	private createProjectGroupItem(node: ProjectGroupNode): vscode.TreeItem {
		const projectDir =
			node.projectDir || node.tasks[0]?.project_dir || node.projectName;
		const launcherIcon =
			node.tasks.find((task) => task.project_icon)?.project_icon ?? null;
		const icon = this.getProjectIcon(projectDir, { launcherIcon });
		const latestActivity = this.getProjectGroupRelativeActivity(node);
		const item = new vscode.TreeItem(
			`${icon} ${node.projectName}`,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		const discoveredCount = node.discoveredAgents?.length ?? 0;
		const counts = countAgentStatuses(node.tasks);
		counts.working += discoveredCount;
		counts.total += discoveredCount;
		const description = formatCountSummary(counts, {
			includeAttention: true,
		});
		item.description = latestActivity
			? `${description} · ${latestActivity}`
			: description;
		const attentionCount = counts.attention;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${node.projectName}**`,
				projectDir ? `Dir: \`${projectDir}\`` : null,
				`Agents: ${description}`,
				latestActivity ? `Latest activity: ${latestActivity}` : null,
				attentionCount > 0 ? `${attentionCount} needs attention` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
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

	private createStatusGroupItem(node: StatusGroupNode): vscode.TreeItem {
		const count = node.nodes.length;
		const item = new vscode.TreeItem(
			`${STATUS_GROUP_LABELS[node.status]} · ${count} ${count === 1 ? "agent" : "agents"}`,
			this.statusGroupHasRecentItems(node)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.id = `status-group:${node.status}`;
		item.contextValue = "statusGroup";
		item.iconPath = STATUS_GROUP_ICONS[node.status];
		item.tooltip = `${STATUS_GROUP_LABELS[node.status]} • ${count} ${count === 1 ? "agent" : "agents"}`;
		return item;
	}

	private createStatusTimeGroupItem(
		node: StatusTimeGroupNode,
	): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, node.collapsibleState);
		item.id = `status-time-group:${node.status}:${node.period}`;
		item.contextValue = "statusTimeGroup";
		item.iconPath = new vscode.ThemeIcon("calendar");
		item.tooltip = `${STATUS_GROUP_LABELS[node.status]} • ${node.label}`;
		return item;
	}

	/** Compute summary icon based on aggregate agent state */
	private getSummaryIcon(): vscode.ThemeIcon {
		const tasks = this.getScopedLauncherTasks();
		const discovered = this.getScopedDiscoveredAgents();
		const openclawTasks = this.getVisibleOpenClawTasks();

		const hasRunning =
			tasks.some((t) => t.status === "running") ||
			discovered.length > 0 ||
			openclawTasks.some((task) => this.isOpenClawTaskActive(task));
		const hasFailed =
			tasks.some((t) => t.status === "failed" || t.status === "killed") ||
			openclawTasks.some(
				(task) => task.status === "failed" || task.status === "timed_out",
			);
		const hasContractFailure = tasks.some(
			(t) => t.status === "contract_failure",
		);
		const hasStopped =
			tasks.some((t) => t.status === "stopped") ||
			openclawTasks.some(
				(task) => task.status === "blocked" || task.status === "lost",
			);

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

	private getTaskActivityDescription(task: AgentTask): string {
		const reference =
			task.status === "running"
				? task.started_at
				: (task.completed_at ?? task.updated_at ?? task.started_at ?? null);
		return relativeTime(reference);
	}

	private getTaskDuration(task: AgentTask): string | null {
		if (!task.started_at) return null;
		const startedAt = new Date(task.started_at).getTime();
		if (!Number.isFinite(startedAt)) return null;
		const endedAt = task.completed_at
			? new Date(task.completed_at).getTime()
			: Date.now();
		if (!Number.isFinite(endedAt)) return null;
		return formatElapsed(
			task.started_at,
			new Date(Math.max(startedAt, endedAt)),
		);
	}

	private getProjectGroupRelativeActivity(
		node: ProjectGroupNode,
	): string | null {
		const freshestActivityMs = this.getProjectGroupFreshestActivityMs(node);
		return freshestActivityMs > 0 ? relativeTime(freshestActivityMs) : null;
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

	public getStreamFileCandidates(task: AgentTask): string[] {
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

	public resolveStreamFilePath(task: AgentTask): string | null {
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
		const modelDisplay = this.resolveTaskModelDisplay(task);
		const projectIcon = this.getProjectIcon(task.project_dir, {
			launcherIcon: task.project_icon,
		});
		const labelParts = [projectIcon, roleIcon, task.id].filter(Boolean);
		const label = labelParts.join(" ");
		const isStuck = this.isAgentStuck(task);
		const diffSummaryInline = this.getCachedDiffSummaryForTask(task);
		const descriptionParts: string[] = [];
		if (!this.isProjectGroupingEnabled()) {
			descriptionParts.push(task.project_name);
		}
		if (task.status === "completed_stale") {
			descriptionParts.push(STALE_AGENT_STATUS_DESCRIPTION);
		}
		if (diffSummaryInline) {
			descriptionParts.push(diffSummaryInline);
		}
		// Omit diff loading placeholder — show nothing until ready (no flicker)
		const fallback = this.getTaskFallbackInfo(task);
		if (fallback) {
			descriptionParts.push(`${fallback.actualAlias} (fallback)`);
		} else if (modelDisplay?.alias) {
			descriptionParts.push(modelDisplay.alias);
		}
		const isDoneStatus =
			task.status === "completed" ||
			task.status === "completed_dirty" ||
			task.status === "completed_stale" ||
			task.status === "failed" ||
			task.status === "contract_failure" ||
			task.status === "stopped" ||
			task.status === "killed";
		const isReviewed = isDoneStatus && this._reviewTracker.isReviewed(task.id);
		if (task.status === "running") {
			if (descriptionParts.length === 0) {
				descriptionParts.push(this.getTaskActivityDescription(task));
			}
		} else {
			descriptionParts.push(relativeTime(this.getTaskActivityTimeMs(task)));
		}
		if (isReviewed) {
			descriptionParts.push("✓ reviewed");
		}
		const description = isStuck
			? `${descriptionParts.join(" · ")} (possibly stuck)`
			: descriptionParts.join(" · ");
		const duration = this.getTaskDuration(task);

		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = description;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${task.id}**`,
				`Status: ${getStatusDisplayLabel(task.status)}`,
				fallback
					? `Model: ${fallback.actualFull} (fallback from ${fallback.requestedFull})`
					: modelDisplay
						? `Model: ${modelDisplay.fullName}`
						: null,
				duration ? `Duration: ${duration}` : null,
				task.project_dir ? `Dir: \`${task.project_dir}\`` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath =
			task.status === "completed_stale" || isStuck
				? new vscode.ThemeIcon(
						"warning",
						new vscode.ThemeColor("charts.yellow"),
					)
				: isReviewed
					? new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"))
					: getStatusThemeIcon(task.status);
		item.contextValue = isReviewed
			? `agentTask.${task.status}.reviewed`
			: `agentTask.${task.status}`;
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

	private createOpenClawTaskItem(task: OpenClawTask): vscode.TreeItem {
		const title = this.getOpenClawTaskDisplayTitle(task);
		const activity = relativeTime(this.getOpenClawTaskActivityTimeMs(task));
		const summary =
			task.status === "queued" || task.status === "running"
				? task.progressSummary?.trim()
				: task.error?.trim() || task.terminalSummary?.trim();
		const descriptionParts = [
			task.runtime,
			openclawStatusToLabel(task.status),
			activity,
			summary,
		].filter((part): part is string => Boolean(part));
		const item = new vscode.TreeItem(
			title,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = descriptionParts.join(" · ");
		item.tooltip = new vscode.MarkdownString(
			[
				`**${title}**`,
				`Task ID: \`${task.taskId}\``,
				`Runtime: ${task.runtime}`,
				`Status: ${openclawStatusToLabel(task.status)}`,
				`Owner: ${task.ownerKey}`,
				`Scope: ${task.scopeKind}`,
				task.agentId ? `Agent: ${task.agentId}` : null,
				task.runId ? `Run: ${task.runId}` : null,
				task.childSessionKey
					? `Child Session: \`${task.childSessionKey}\``
					: null,
				task.error ? `Error: ${task.error}` : null,
				task.terminalSummary ? `Summary: ${task.terminalSummary}` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath = openclawStatusToIcon(task.status);
		item.contextValue = `openclawTask.${task.status}`;
		item.resourceUri = vscode.Uri.parse(`openclaw-task:${task.taskId}`);
		item.command = {
			command: "commandCentral.showOpenClawTaskDetail",
			title: "Show Details",
			arguments: [{ type: "openclawTask" as const, task }],
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
		const worktreeLabel = agent.worktree?.isLinkedWorktree
			? `${agent.worktree.branch} · worktree`
			: null;
		const label = `${projectIcon} ${projectName}`;
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		const discoveredDiff = this.getCachedDiffSummaryForDiscovered(agent);
		const descriptionParts = ["running", uptime];
		if (worktreeLabel) descriptionParts.push(worktreeLabel);
		if (discoveredDiff) {
			descriptionParts.push(discoveredDiff);
		}
		// Omit diff loading placeholder — show nothing until ready (no flicker)
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
		if (this.treeRefreshTimer) {
			clearTimeout(this.treeRefreshTimer);
			this.treeRefreshTimer = null;
		}
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
		if (this._agentRegistry) {
			this._agentRegistry.dispose();
			this._agentRegistry = null;
		}
		this._tmuxSessionHealthCache.clear();
		this._persistSessionHealthCache.clear();
		for (const d of this.disposables) d.dispose();
	}
}
