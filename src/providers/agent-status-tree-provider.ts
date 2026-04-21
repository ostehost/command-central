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
	type TaskFlowTask,
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
import {
	checkDeclaredHandoff,
	type DeclaredHandoffState,
} from "../utils/handoff-file-health.js";
import { getModelAlias } from "../utils/model-aliases.js";
import {
	readPendingReviewReceipt,
	receiptToOverlay,
} from "../utils/pending-review-probe.js";
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
import { defaultTimingRecorder } from "../utils/timing-recorder.js";
import {
	inspectTmuxPaneAgent,
	type TmuxPaneAgentEvidence,
} from "../utils/tmux-pane-health.js";

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
	handoff_file?: string | null;
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

export type AgentStatusGroup = "running" | "done" | "attention" | "limbo";

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
	parentProjectName?: string;
	parentProjectDir?: string;
	parentGroupKey?: string;
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
	command?: vscode.Command;
}

export interface PerFileDiff {
	filePath: string;
	additions: number;
	deletions: number;
	status?: FileChangeStatus;
}

export type FileChangeStatus = "A" | "M" | "D";

export interface FileChangeNode {
	type: "fileChange";
	taskId: string;
	projectDir: string;
	projectName: string;
	filePath: string;
	additions: number;
	deletions: number;
	status: FileChangeStatus;
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

/**
 * Static classification of a task's terminal surface, derived only from the
 * launcher-recorded metadata (terminal_backend, ghostty_bundle_id,
 * bundle_path). Used to narrate — in tree item labels and tooltips — what
 * clicking "Focus Terminal" will actually target, BEFORE the user clicks.
 *
 * This is complementary to the runtime-truth gate (shouldTrustBundleSurface)
 * in extension.ts: that gate probes tmux liveness at click time to decide
 * between bundle focus and fresh attach. This classifier only reads static
 * metadata, so it is cheap enough to run on every tree render. Liveness is
 * intentionally NOT probed here — a launcher-bundle task with a dead tmux
 * session is still classified as "launcher-bundle", because metadata is what
 * the task declares; liveness shapes *which* open strategy wins, not *what
 * surface* the task authoritatively owns.
 *
 * See 98caa1e (fresh-attach notification) and 1a52857 (bundle-trust gate) for
 * the full backend-truthful contract.
 */
export type TaskSurfaceKind =
	| "launcher-bundle"
	| "tmux-fresh-attach"
	| "persist"
	| "applescript"
	| "unknown";

export interface TaskSurfaceSummary {
	kind: TaskSurfaceKind;
	/** Full sentence for the tooltip. Always non-empty. */
	tooltipLine: string;
	/**
	 * Compact inline tag for the tree item description. Null for the
	 * happy-path launcher-bundle surface (no noise on the common case).
	 */
	shortTag: string | null;
}

export function classifyTaskSurface(task: AgentTask): TaskSurfaceSummary {
	const hasLauncherBundle =
		Boolean(task.ghostty_bundle_id) ||
		(Boolean(task.bundle_path) &&
			task.bundle_path !== "(tmux-mode)" &&
			task.bundle_path !== "(test-mode)");

	if (task.terminal_backend === "tmux") {
		if (hasLauncherBundle) {
			return {
				kind: "launcher-bundle",
				tooltipLine:
					"Surface: launcher Ghostty bundle · tmux session (focus raises the bundle window)",
				shortTag: null,
			};
		}
		return {
			kind: "tmux-fresh-attach",
			tooltipLine:
				"Surface: tmux session only — no launcher bundle; focus spawns a fresh Ghostty attach",
			shortTag: "tmux · fresh attach",
		};
	}
	if (task.terminal_backend === "persist") {
		return {
			kind: "persist",
			tooltipLine:
				"Surface: persist backend — no visible Ghostty window (headless socket lane)",
			shortTag: "persist",
		};
	}
	if (task.terminal_backend === "applescript") {
		return {
			kind: "applescript",
			tooltipLine: "Surface: AppleScript Ghostty (no launcher bundle)",
			shortTag: "applescript",
		};
	}
	if (hasLauncherBundle) {
		return {
			kind: "launcher-bundle",
			tooltipLine: "Surface: launcher Ghostty bundle",
			shortTag: null,
		};
	}
	return {
		kind: "unknown",
		tooltipLine: "Surface: no authoritative terminal surface recorded",
		shortTag: "surface?",
	};
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

/**
 * Format duration between two ISO timestamps (or from start to now) with
 * minute+second precision, e.g. "4m 32s", "1h 12m", "< 1m".
 */
function formatDurationPrecise(
	startIso: string,
	endIso?: string | null,
): string {
	const start = new Date(startIso).getTime();
	const end = endIso ? new Date(endIso).getTime() : Date.now();
	const diffMs = Math.max(0, end - start);
	const totalSeconds = Math.floor(diffMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	if (minutes > 0) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	return totalSeconds > 0 ? `${seconds}s` : "< 1s";
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
	limbo: 2,
	done: 3,
};

// PORT_LOADING_LABEL removed — ports row only renders with real data
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_GROUP_LABELS: Record<AgentStatusGroup, string> = {
	running: "Running",
	done: "Completed",
	attention: "Failed & Stopped",
	limbo: "Needs Review",
};

const STATUS_GROUP_ICONS: Record<AgentStatusGroup, vscode.ThemeIcon> = {
	running: getStatusThemeIcon("running"),
	done: getStatusThemeIcon("completed"),
	attention: new vscode.ThemeIcon(
		"warning",
		new vscode.ThemeColor("charts.orange"),
	),
	limbo: new vscode.ThemeIcon(
		"question",
		new vscode.ThemeColor("charts.yellow"),
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
		handoff_file: asString(raw["handoff_file"]) ?? null,
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
	private static readonly COMPLETED_TASK_LIMIT_DEFAULT = 10;
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
	private _tmuxPaneAgentCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private _tmuxPaneAgentEvidenceCache = new Map<
		string,
		{ evidence: TmuxPaneAgentEvidence; checkedAt: number }
	>();
	private _handoffFileCache = new Map<
		string,
		{ state: DeclaredHandoffState; checkedAt: number }
	>();
	private readonly _persistSessionHealthCache = new Map<
		string,
		{ alive: boolean; checkedAt: number }
	>();
	private projectIconManager: ProjectIconManager;
	/** Project filter: when set, only show agents from this project dir */
	private _projectFilter: string | null = null;
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
					e.affectsConfiguration(
						"commandCentral.agentStatus.completedTaskLimit",
					) ||
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

	/** Filter the tree to show only agents from the given project dir. Pass null to clear. */
	filterToProject(projectDir: string | null): void {
		this._projectFilter = projectDir;
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.agentStatus.projectFilterActive",
			projectDir != null,
		);
		if (this._agentStatusView) {
			this._agentStatusView.description = projectDir
				? `Filtered: ${path.basename(projectDir)}`
				: undefined;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Get the current project filter dir (if any). */
	get projectFilter(): string | null {
		return this._projectFilter;
	}

	/** Filter to the project that owns the currently active editor file. */
	filterToCurrentProject(): void {
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		if (!activeUri) {
			vscode.window.showInformationMessage(
				"No active editor — cannot determine current project.",
			);
			return;
		}
		const filePath = activeUri.fsPath;
		// Find which project dir the file belongs to
		const tasks = this.getTasks();
		const match = tasks.find(
			(t) => t.project_dir && filePath.startsWith(t.project_dir),
		);
		if (match?.project_dir) {
			this.filterToProject(match.project_dir);
		} else {
			vscode.window.showInformationMessage(
				"No agent project found for the active editor file.",
			);
		}
	}

	/** Return all known project directories from tasks and discovered agents. */
	getKnownProjectDirs(): string[] {
		const dirs = new Set<string>();
		for (const task of this.getScopedLauncherTasks()) {
			if (task.project_dir) dirs.add(task.project_dir);
		}
		for (const agent of this.getScopedDiscoveredAgents()) {
			dirs.add(this.getDiscoveredProjectDir(agent));
		}
		return Array.from(dirs).sort();
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

	private isTmuxPaneAgentHealthy(task: AgentTask): boolean {
		// Backward-compat: caller treats "unknown" (fail-open) as healthy and
		// only "dead" (positively confirmed absent) as unhealthy.
		return this.getTmuxPaneAgentEvidence(task) !== "dead";
	}

	private getTmuxPaneAgentEvidence(task: AgentTask): TmuxPaneAgentEvidence {
		const cacheTtlMs = 5_000;
		const cacheKey = `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
		const now = Date.now();
		const cached = this._tmuxPaneAgentEvidenceCache.get(cacheKey);
		if (cached && now - cached.checkedAt < cacheTtlMs) {
			return cached.evidence;
		}
		const evidence = inspectTmuxPaneAgent(task.session_id, task.tmux_socket);
		this._tmuxPaneAgentEvidenceCache.set(cacheKey, {
			evidence,
			checkedAt: now,
		});
		// Also seed the legacy boolean cache so any direct readers stay in sync.
		this._tmuxPaneAgentCache.set(cacheKey, {
			alive: evidence !== "dead",
			checkedAt: now,
		});
		return evidence;
	}

	private getDeclaredHandoffState(task: AgentTask): DeclaredHandoffState {
		const cacheTtlMs = 5_000;
		const cacheKey = `${task.project_dir}::${task.handoff_file ?? ""}`;
		const cached = this._handoffFileCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.checkedAt < cacheTtlMs) {
			return cached.state;
		}
		const state = checkDeclaredHandoff(task);
		this._handoffFileCache.set(cacheKey, { state, checkedAt: now });
		return state;
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
			const paneEvidence = this.getTmuxPaneAgentEvidence(task);
			if (paneEvidence === "dead") return false;
			// Positive pane evidence is authoritative for launcher-managed work:
			// the user is actively in the lane (interactive Claude / awaiting
			// input). Don't downgrade to stale just because the JSONL stream is
			// silent — interactive REPL turns frequently produce no stream.
			if (paneEvidence === "alive") return true;
			// "unknown" (fail-open): if discovery cross-validates the session is
			// live, that is also positive evidence of the lane being alive.
			if (this.hasLiveDiscoveredSession(task)) return true;
			return !looksStale;
		}

		// Non-tmux, non-persist (e.g. external terminal discovery). If process
		// discovery confirms the session is live, treat that as positive
		// evidence of an active lane and skip the stream-staleness downgrade.
		if (this.hasLiveDiscoveredSession(task)) return true;
		return !looksStale;
	}

	/**
	 * True when there is positive evidence that the launcher-managed lane is
	 * still alive — distinct from "we couldn't tell". Used to suppress
	 * stuck-warning UI for tasks that are interactive/awaiting-input rather
	 * than actually wedged.
	 */
	private hasPositiveLivenessEvidence(task: AgentTask): boolean {
		if (task.status !== "running") return false;
		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === undefined) &&
			isValidSessionId(task.session_id)
		) {
			if (this.getTmuxPaneAgentEvidence(task) === "alive") return true;
		}
		if (this.hasLiveDiscoveredSession(task)) return true;
		return false;
	}

	/**
	 * Reconcile a raw tasks.json record into a display-ready AgentTask.
	 *
	 * Source-of-truth hierarchy (highest → lowest):
	 *
	 *   Tier 1 — Launcher-local authoritative state
	 *     1a. tasks.json terminal status (completed / failed / stopped / ...)
	 *         is already final; return unchanged.
	 *     1b. Pending-review receipt (`/tmp/oste-pending-review/<id>.json`)
	 *         written by `oste-complete.sh` the moment the agent really
	 *         finishes. Overlays a `running` entry that tasks.json has not
	 *         yet caught up to.
	 *
	 *   Tier 2 — Launcher-local secondary signals
	 *     2a. CC staleness cache (`staleTaskReasons`) populated during prior
	 *         reconciliations — sticky so a task doesn't bounce back to
	 *         `running` once we've decided it's stale.
	 *     2b. JSONL stream terminal event (`turn.completed` / `turn.failed`
	 *         / `result`). Authoritative when present because the launcher-
	 *         spawned agent writes it directly.
	 *
	 *   Tier 3 — Liveness overlay (does NOT decide status on its own)
	 *     Tmux pane evidence + discovered-session presence are consulted by
	 *     `isRunningTaskHealthy()` only to decide whether to keep trusting a
	 *     `running` status. They can never promote or demote a task without
	 *     corroborating Tier 1/2 signals.
	 *
	 *   Tier 4 — Last-resort inference (only when Tier 1–3 say "unhealthy")
	 *     4a. `exit_code === 0` or `completed_at` set → completed.
	 *     4b. non-zero `exit_code` → failed.
	 *     4c. Commits since start → completed_dirty.
	 *     4d. Default → stopped.
	 *
	 *   See research/COMMAND-CENTRAL-LAUNCHER-TRUTH-HIERARCHY-2026-04-20.md
	 *   for the full rationale.
	 */
	private toDisplayTask(task: AgentTask): AgentTask {
		// Tier 1b — Pending-review receipt is ground truth for a running task.
		// The launcher's oste-complete.sh writes it the moment the agent
		// actually finishes, which can land before tasks.json is updated. Trust
		// it over both the CC-local staleness cache and the runtime health
		// inference. For non-running statuses, tasks.json itself is already
		// Tier 1a authoritative, so we don't probe.
		if (task.status === "running") {
			const receipt = readPendingReviewReceipt(task.id);
			const overlay = receipt ? receiptToOverlay(receipt) : null;
			if (overlay) {
				return this.applyRuntimeStatusOverlay(task, overlay);
			}
		}

		// Tier 2a — Staleness cache (sticky CC-local decision).
		const staleReason = this.staleTaskReasons.get(task.id);
		if (staleReason) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed_stale",
				reason: staleReason,
			});
		}
		if (task.status !== "running") return task; // Tier 1a: terminal → keep.

		// Tier 2b — JSONL stream terminal event.
		const streamTerminalState = this.getStreamTerminalState(task);
		if (streamTerminalState) {
			return this.applyRuntimeStatusOverlay(task, streamTerminalState);
		}

		// Tier 3 — Liveness overlay. `isRunningTaskHealthy()` folds tmux pane
		// evidence and discovered-session presence into a single verdict. If it
		// still says "healthy", keep the task as running.
		if (this.isRunningTaskHealthy(task)) return task;

		// Tier 4 — Last-resort inference. The process is gone; we have no
		// receipt, no stream terminal event, and liveness signals say dead.
		// Look for completion evidence before defaulting to "stopped". Many
		// tasks finish successfully but the completion hook doesn't fire
		// (race / Ghostty lifecycle), leaving tasks.json stuck at "running".
		// Exit code and completed_at are ground-truth signals that should
		// override the inference.
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

		// Dirty-exit tasks lack exit_code and completed_at, but may have
		// produced commits.  Check git history as a last-resort signal
		// before defaulting to "stopped".
		if (this.hasCommitsSinceStart(task)) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed_dirty",
				reason:
					"Session ended without completion signal, but commits were produced.",
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
			endCommit?: string | null;
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
			end_commit: overlay.endCommit ?? task.end_commit,
			error_message:
				overlay.status === "stopped" ||
				overlay.status === "failed" ||
				overlay.status === "completed_stale"
					? (task.error_message ?? overlay.reason ?? null)
					: task.error_message,
		};
	}

	/**
	 * Check if a task's project has commits after its start_commit.
	 * Used as a last-resort signal for dirty-exit tasks that lack
	 * exit_code and completed_at but actually produced work.
	 */
	private hasCommitsSinceStart(task: AgentTask): boolean {
		const startRef = task.start_commit;
		if (!startRef || startRef === "unknown") return false;
		if (!task.project_dir) return false;

		try {
			const output = execFileSync(
				"git",
				["-C", task.project_dir, "rev-list", "--count", `${startRef}..HEAD`],
				{ encoding: "utf-8", timeout: 3000 },
			);
			const count = Number.parseInt(output.trim(), 10);
			return Number.isFinite(count) && count > 0;
		} catch {
			// Git call failed (missing repo, bad ref, etc.) — fall through.
			return false;
		}
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

	private getTaskRuntimeBackend(
		task: AgentTask,
	): NonNullable<AgentTask["terminal_backend"]> {
		return task.terminal_backend ?? "tmux";
	}

	private getRunningRuntimeIdentityKey(task: AgentTask): string | null {
		if (task.status !== "running") return null;

		const backend = this.getTaskRuntimeBackend(task);
		const bundlePath = task.bundle_path.trim();
		const identity: Record<string, string> = {
			backend,
			projectDir: task.project_dir,
		};

		if (bundlePath) {
			identity["bundlePath"] = bundlePath;
		}

		if (backend === "persist") {
			const persistSocketPath =
				task.persist_socket ?? this.getPersistSocketPath(task);
			if (persistSocketPath) {
				identity["persistSocket"] = persistSocketPath;
			} else if (task.session_id) {
				identity["sessionId"] = task.session_id;
			} else {
				return null;
			}
			return JSON.stringify(identity);
		}

		if (backend === "tmux") {
			if (!task.session_id) return null;
			identity["tmuxSocket"] = task.tmux_socket ?? "__default__";
			identity["sessionId"] = task.session_id;
			identity["windowId"] = task.tmux_window_id ?? "__session__";
			return JSON.stringify(identity);
		}

		if (!task.session_id) return null;
		identity["sessionId"] = task.session_id;
		return JSON.stringify(identity);
	}

	private getTaskRuntimeIdentityBreadcrumb(task: AgentTask): string | null {
		const backend = this.getTaskRuntimeBackend(task);
		const breadcrumbs: string[] = [backend];
		const projectName = task.project_dir
			? path.basename(task.project_dir)
			: task.project_name;
		if (projectName) {
			breadcrumbs.push(`project=${projectName}`);
		}

		if (task.session_id) {
			breadcrumbs.push(`session=${task.session_id}`);
		}

		if (backend === "persist") {
			const persistSocketPath =
				task.persist_socket ?? this.getPersistSocketPath(task);
			if (persistSocketPath) {
				breadcrumbs.push(`socket=${path.basename(persistSocketPath)}`);
			}
		} else if (backend === "tmux") {
			if (task.tmux_window_id) {
				breadcrumbs.push(`window=${task.tmux_window_id}`);
			}
			if (task.tmux_socket) {
				breadcrumbs.push(`socket=${path.basename(task.tmux_socket)}`);
			}
		}

		const bundlePath = task.bundle_path.trim();
		if (bundlePath) {
			breadcrumbs.push(`bundle=${path.basename(bundlePath)}`);
		}

		return breadcrumbs.length > 0 ? breadcrumbs.join(" · ") : null;
	}

	private getTaskTranscriptBreadcrumb(task: AgentTask): string | null {
		const claudeSessionId = task.claude_session_id?.trim();
		if (claudeSessionId) {
			return claudeSessionId.length > 40
				? `claude=${claudeSessionId.slice(0, 16)}...${claudeSessionId.slice(-8)}`
				: `claude=${claudeSessionId}`;
		}

		const streamFile = task.stream_file?.trim();
		return streamFile ? `stream=${path.basename(streamFile)}` : null;
	}

	private clearRuntimeHealthCache(task: AgentTask): void {
		const persistSocketPath =
			task.persist_socket ?? this.getPersistSocketPath(task);
		if (persistSocketPath) {
			this._persistSessionHealthCache.delete(persistSocketPath);
		}

		if (!task.session_id) return;

		const tmuxSessionKey = `${task.tmux_socket ?? "__default__"}::${task.session_id}`;
		this._tmuxSessionHealthCache.delete(tmuxSessionKey);
		if (task.tmux_window_id) {
			this._tmuxSessionHealthCache.delete(
				`${tmuxSessionKey}::${task.tmux_window_id}`,
			);
		}
	}

	private reconcileDuplicateRunningSessions(tasks: AgentTask[]): AgentTask[] {
		const runningByRuntime = new Map<string, AgentTask[]>();
		for (const task of tasks) {
			const runtimeKey = this.getRunningRuntimeIdentityKey(task);
			if (!runtimeKey) continue;
			const existing = runningByRuntime.get(runtimeKey);
			if (existing) {
				existing.push(task);
			} else {
				runningByRuntime.set(runtimeKey, [task]);
			}
		}

		const staleReasons = new Map<string, string>();
		for (const sessionTasks of runningByRuntime.values()) {
			if (sessionTasks.length <= 1) continue;
			const newestTask = [...sessionTasks].sort((a, b) => {
				const startedDiff =
					this.getTaskStartedAtMs(b) - this.getTaskStartedAtMs(a);
				if (startedDiff !== 0) return startedDiff;
				return b.id.localeCompare(a.id);
			})[0];
			if (!newestTask) continue;
			const runtimeBreadcrumb =
				this.getTaskRuntimeIdentityBreadcrumb(newestTask) ?? "the same runtime";
			for (const task of sessionTasks) {
				if (task.id === newestTask?.id) continue;
				staleReasons.set(
					task.id,
					`Superseded by newer running task ${newestTask.id} on ${runtimeBreadcrumb}.`,
				);
				this.clearRuntimeHealthCache(task);
			}
			const sessionId = newestTask.session_id;
			if (sessionId) {
				for (const cacheKey of this._tmuxSessionHealthCache.keys()) {
					if (cacheKey.endsWith(`::${sessionId}`)) {
						this._tmuxSessionHealthCache.delete(cacheKey);
					}
				}
				for (const cacheKey of this._tmuxPaneAgentCache.keys()) {
					if (cacheKey.endsWith(`::${sessionId}`)) {
						this._tmuxPaneAgentCache.delete(cacheKey);
					}
				}
				for (const cacheKey of this._tmuxPaneAgentEvidenceCache.keys()) {
					if (cacheKey.endsWith(`::${sessionId}`)) {
						this._tmuxPaneAgentEvidenceCache.delete(cacheKey);
					}
				}
			}
			const persistSocketPath =
				newestTask.persist_socket ?? this.getPersistSocketPath(newestTask);
			if (persistSocketPath) {
				this._persistSessionHealthCache.delete(persistSocketPath);
			}
		}

		return tasks.map((task) =>
			staleReasons.has(task.id)
				? this.applyRuntimeStatusOverlay(task, {
						status: "stopped",
						reason: staleReasons.get(task.id),
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
		const reloadStart = performance.now();
		const generation = ++this._reloadGeneration;
		const isInitial = this._initialReadInProgress;
		if (isInitial) {
			this._onDidChangeTreeData.fire(undefined);
		}
		this._registryLoadIssue = null;
		const readStart = performance.now();
		const nextRegistry = this.readRegistry();
		defaultTimingRecorder.record(
			"tree.readRegistry",
			performance.now() - readStart,
		);
		if (generation !== this._reloadGeneration) {
			defaultTimingRecorder.record(
				"tree.reload",
				performance.now() - reloadStart,
			);
			return;
		}
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
		defaultTimingRecorder.record(
			"tree.reload",
			performance.now() - reloadStart,
		);
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
		// Task would be marked stale, but if it produced commits it's
		// more accurately "completed_dirty" — handled in toDisplayTask.
		if (this.hasCommitsSinceStart(task)) return null;
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
				if (
					!this.isTmuxWindowAlive(
						task.session_id,
						task.tmux_window_id,
						task.tmux_socket,
					)
				) {
					return true;
				}
			} else if (!this.isTmuxSessionAlive(task.session_id, task.tmux_socket)) {
				return true;
			}
			// Session/window alive but agent process may be gone.
			return !this.isTmuxPaneAgentHealthy(task);
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
			const intervalMs = config.get<number>("agentStatus.autoRefreshMs", 30000);
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
		const timingStart = performance.now();
		try {
			return this.getTreeItemImpl(element);
		} finally {
			defaultTimingRecorder.record(
				`tree.getTreeItem.${element.type}`,
				performance.now() - timingStart,
			);
		}
	}

	private getTreeItemImpl(element: AgentNode): vscode.TreeItem {
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
			item.contextValue = "taskFlowChild";
			return item;
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		const timingStart = performance.now();
		const label = `tree.getChildren.${element?.type ?? "root"}`;
		try {
			return this.getChildrenImpl(element);
		} finally {
			defaultTimingRecorder.record(label, performance.now() - timingStart);
		}
	}

	private getChildrenImpl(element?: AgentNode): AgentNode[] {
		if (!element) {
			let allTasks = this.getScopedLauncherTasks();
			let discovered = this.getScopedDiscoveredAgents();
			const openclawTasks = this.getVisibleOpenClawTasks();

			// Apply project filter before grouping (works for both flat and grouped modes)
			if (this._projectFilter) {
				const filterDir = this._projectFilter;
				allTasks = allTasks.filter(
					(t) =>
						t.project_dir === filterDir ||
						t.project_name === path.basename(filterDir),
				);
				discovered = discovered.filter(
					(a) => this.getDiscoveredProjectDir(a) === filterDir,
				);
			}
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
							label: "Scanning for agents...",
							description: "Checking processes, sessions, and tasks",
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
						label: "Waiting for agents...",
						description: "Start Claude Code, Codex, or Gemini in any terminal",
						icon: "search",
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

			// When grouped by project, replace summary node with view badge
			// (each project header already shows its own counts)
			if (groupedByProject && this._agentStatusView) {
				this._agentStatusView.badge = {
					value: agentCounts.total,
					tooltip: `${agentCounts.total} agents · ${counts.working} working`,
				};
			}

			const summaryNodes: AgentNode[] = groupedByProject
				? []
				: [
						{
							type: "summary" as const,
							label: summaryLabel,
							tooltip: summaryTooltip || undefined,
						},
					];

			return [
				...summaryNodes,
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
			return [
				...this.getTaskFlowDetailChildren(element.flow),
				...this.getTaskFlowChildNodes(element.flow),
			];
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
			const endCommit = this.getTaskDiffEndCommit(task);

			// Non-running task with no valid end boundary — no diff available.
			if (startCommit && !endCommit) return null;

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

	private getCompletedTaskLimit(): number {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const raw = config.get<number>(
			"agentStatus.completedTaskLimit",
			AgentStatusTreeProvider.COMPLETED_TASK_LIMIT_DEFAULT,
		);
		return Math.max(1, Math.floor(raw));
	}

	private formatSummaryCounts(counts: AgentCounts): string {
		const doneTotal = counts.done + counts.limbo;
		const parts = [
			counts.working > 0 ? `${counts.working} working` : null,
			counts.attention > 0 ? `${counts.attention} ⏹` : null,
			doneTotal > 0 ? `${doneTotal} ✓` : null,
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
		if (status === "completed") {
			if (
				node.type === "task" &&
				(node.task.review_status === "pending" ||
					node.task.review_status === "changes_requested")
			) {
				return "attention";
			}
			if (
				node.type === "task" &&
				this.getDeclaredHandoffState(node.task) === "missing"
			) {
				return "limbo";
			}
			return "done";
		}
		if (status === "completed_dirty" || status === "completed_stale") {
			return "limbo";
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

		return (["running", "attention", "limbo", "done"] as AgentStatusGroup[])
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
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
		},
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

				const groupNode: StatusTimeGroupNode = {
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

		return this.buildStatusTimeGroups(node.status, node.nodes, {
			parentProjectName: node.parentProjectName,
			parentProjectDir: node.parentProjectDir,
			parentGroupKey: node.parentGroupKey,
		});
	}

	private getProjectGroupChildren(node: ProjectGroupNode): AgentNode[] {
		const sorted = this.sortAgentNodes([
			...node.tasks.map(
				(task) => ({ type: "task" as const, task }) satisfies SortableAgentNode,
			),
			...(node.discoveredAgents ?? []).map(
				(agent) =>
					({
						type: "discovered" as const,
						agent,
					}) satisfies SortableAgentNode,
			),
		]);

		const parentOptions = {
			parentProjectName: node.projectName,
			parentProjectDir: node.projectDir,
			parentGroupKey: node.parentGroupKey,
		};

		// If ≤ 5 agents, show them flat (no sub-grouping needed)
		if (sorted.length <= 5) {
			return this.applyAgentVisibilityCap(sorted, parentOptions);
		}

		// > 5 agents: sub-group by status (like Git Sort's time-period groups)
		return this.buildStatusGroupNodes(sorted, parentOptions);
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

	/** Check if a node has a capped completed status (completed or completed_dirty). */
	private isCappedCompletedNode(node: SortableAgentNode): boolean {
		const status = this.getNodeStatus(node);
		return status === "completed" || status === "completed_dirty";
	}

	private applyAgentVisibilityCap(
		nodes: SortableAgentNode[],
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
		},
	): AgentNode[] {
		// Phase 1: Apply completed task cap — nodes are already sorted by recency.
		// Split into always-visible (running, stopped, failed, killed, completed_stale)
		// and capped (completed, completed_dirty — keep only the most recent N).
		const completedLimit = this.getCompletedTaskLimit();
		let completedSeen = 0;
		const cappedNodes: SortableAgentNode[] = [];
		const completedOverflow: SortableAgentNode[] = [];

		for (const node of nodes) {
			if (this.isCappedCompletedNode(node)) {
				completedSeen++;
				if (completedSeen <= completedLimit) {
					cappedNodes.push(node);
				} else {
					completedOverflow.push(node);
				}
			} else {
				cappedNodes.push(node);
			}
		}

		// Phase 2: Apply overall visibility cap on the remaining nodes.
		const cap = this.getMaxVisibleAgents();
		const visibleNodes: AgentNode[] = [];
		const hiddenNodes: SortableAgentNode[] = [];

		if (cappedNodes.length <= cap) {
			for (const node of cappedNodes) {
				visibleNodes.push(this.toAgentNode(node));
			}
		} else {
			for (const [index, node] of cappedNodes.entries()) {
				if (index < cap || this.isAlwaysVisibleAgentNode(node)) {
					visibleNodes.push(this.toAgentNode(node));
					continue;
				}
				hiddenNodes.push(node);
			}
		}

		// Merge both overflow sets — completed overflow first (already sorted),
		// then general overflow.
		const allHidden = [...completedOverflow, ...hiddenNodes];

		if (allHidden.length === 0) {
			return visibleNodes;
		}

		const label =
			allHidden.length === 1
				? "Show 1 older completed..."
				: `Show ${allHidden.length} older completed...`;
		return [
			...visibleNodes,
			{
				type: "olderRuns",
				label,
				hiddenNodes: allHidden,
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
		if (!parentInfo?.workspaceDirs.has(normalizedProjectDir)) {
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
		let projectNodes = this.buildProjectNodes(tasks, discoveredAgents);

		// Apply project filter if active
		if (this._projectFilter) {
			const filterDir = this._projectFilter;
			projectNodes = projectNodes.filter((node) => {
				const dir =
					node.projectDir || node.tasks[0]?.project_dir || node.projectName;
				return dir === filterDir;
			});
		}
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

		// ── 1. Result line — FIRST child, prominent ─────────────────────
		const duration = t.completed_at
			? formatDurationPrecise(t.started_at, t.completed_at)
			: null;
		const runningDuration = formatDurationPrecise(t.started_at);

		if (t.status === "failed" && t.exit_code != null) {
			const retrySuffix =
				t.attempts > 1 ? ` · Retry ${t.attempts}/${t.max_attempts}` : "";
			const durationSuffix = duration ? ` after ${duration}` : "";
			const errorMessage = t.error_message?.trim();
			details.push({
				type: "detail",
				label: `Failed (exit code ${t.exit_code})${durationSuffix}${retrySuffix}`,
				value: "",
				taskId: t.id,
				description:
					errorMessage && errorMessage.length > 0 ? errorMessage : undefined,
				icon: "error",
				iconColor: "charts.red",
			});
		} else if (
			t.exit_code != null &&
			(t.status === "completed" ||
				t.status === "completed_dirty" ||
				t.status === "stopped")
		) {
			const retrySuffix =
				t.attempts > 1 ? ` · Retry ${t.attempts}/${t.max_attempts}` : "";
			const durationSuffix = duration ? ` in ${duration}` : "";
			if (t.exit_code === 0) {
				details.push({
					type: "detail",
					label: `Completed${durationSuffix}${retrySuffix}`,
					value: "",
					taskId: t.id,
					icon: "pass",
					iconColor: "charts.green",
				});
			} else {
				details.push({
					type: "detail",
					label: `Failed (exit code ${t.exit_code})${durationSuffix}${retrySuffix}`,
					value: "",
					taskId: t.id,
					icon: "error",
					iconColor: "charts.red",
				});
			}
		} else if (t.status === "running") {
			details.push({
				type: "detail",
				label: `Running for ${runningDuration}`,
				value: "",
				taskId: t.id,
				icon: "sync~spin",
				iconColor: "charts.blue",
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
				label: "Stale — no completion signal",
				value: "",
				taskId: t.id,
				icon: "warning",
				iconColor: "charts.yellow",
			});
		}

		if (this.isAgentStuck(t)) {
			const thresholdMinutes = this.getStuckThresholdMinutes();
			if (this.hasPositiveLivenessEvidence(t)) {
				// Live launcher-managed lane: stream silence is most likely the
				// user composing input in an interactive REPL. Surface honestly
				// rather than warning them that their own session is stuck.
				details.push({
					type: "detail",
					label: `Interactive — no stream activity for ${thresholdMinutes} minutes`,
					value: "",
					taskId: t.id,
					icon: "comment-discussion",
					iconColor: "charts.blue",
				});
			} else {
				details.push({
					type: "detail",
					label: `No activity for ${thresholdMinutes} minutes`,
					value: "",
					taskId: t.id,
					icon: "alert",
					iconColor: "charts.yellow",
				});
			}
		}

		// ── 2. Prompt — smart truncation ────────────────────────────────
		const promptSummary = this.readPromptSummary(t.prompt_file);
		const isPromptFallback =
			!promptSummary || promptSummary === path.basename(t.prompt_file);
		const promptValue =
			isPromptFallback && t.prompt_summary ? t.prompt_summary : promptSummary;
		if (promptValue && promptValue !== "---" && !promptValue.endsWith(".md")) {
			const cleanedPrompt = this.cleanPromptForDisplay(promptValue);
			if (cleanedPrompt) {
				const truncatedPrompt =
					cleanedPrompt.length > 80
						? `${cleanedPrompt.slice(0, 79)}…`
						: cleanedPrompt;
				details.push({
					type: "detail",
					label: truncatedPrompt,
					value: "",
					taskId: t.id,
					icon: "comment",
				});
			}
		}

		// ── 3. Changes — inline file names when ≤3 files ────────────────
		const diffSummary = this.getCachedDiffSummaryForTask(t);
		if (diffSummary) {
			const changesLabel = this.formatSmartDiffLabel(t, diffSummary);
			details.push({
				type: "detail",
				label: changesLabel,
				value: "",
				taskId: t.id,
				icon: "files",
			});
		}
		// Omit diff loading placeholder — show nothing until ready

		// ── 4. Git info — branch + commit with click-to-copy ────────────
		const gitInfo = this.getGitInfo(t.project_dir);
		if (gitInfo) {
			const gitHash =
				t.status === "running"
					? this.extractCommitHash(gitInfo.lastCommit)
					: this.getTaskDiffEndCommit(t);
			const shortHash = gitHash ? this.shortenCommitHash(gitHash) : null;
			const gitLabel = shortHash
				? `${gitInfo.branch} · ${shortHash}`
				: gitInfo.branch;
			details.push({
				type: "detail",
				label: gitLabel,
				value: "",
				taskId: t.id,
				icon: "git-branch",
				command: gitHash
					? {
							command: "commandCentral.copyToClipboard",
							title: "Copy commit hash",
							arguments: [gitHash],
						}
					: undefined,
			});
		}

		// ── 5. Duration — only if not already shown in Result line ──────
		if (
			t.status === "running" &&
			!details.some((d) => d.icon === "sync~spin")
		) {
			details.push({
				type: "detail",
				label: runningDuration,
				value: "",
				taskId: t.id,
				icon: "clock",
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

		// ── 6. Model — clean alias format ───────────────────────────────
		const detailFallback = this.getTaskFallbackInfo(t);
		const modelDisplay = this.resolveTaskModelDisplay(t);
		if (detailFallback) {
			details.push({
				type: "detail",
				label: `${detailFallback.actualAlias} (fallback from ${detailFallback.requestedAlias})`,
				value: "",
				taskId: t.id,
				icon: "hubot",
			});
		} else if (modelDisplay) {
			details.push({
				type: "detail",
				label: modelDisplay.alias,
				value: "",
				taskId: t.id,
				icon: "hubot",
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
				// Suppress placeholder — row appears only after real ports are detected
			}
		}

		return details;
	}

	/**
	 * Strip boilerplate prefixes (ULTRATHINK, system-reminder lines, etc.)
	 * and return the first meaningful line, trimmed.
	 */
	private cleanPromptForDisplay(raw: string): string | null {
		const lines = raw.split("\n");
		const boilerplatePrefixes = [
			"ULTRATHINK",
			"<system-reminder>",
			"---",
			"##",
			"# Task",
			"task_id:",
		];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (boilerplatePrefixes.some((p) => trimmed.startsWith(p))) continue;
			return trimmed;
		}
		return null;
	}

	/**
	 * If ≤3 files changed, show file names inline; otherwise keep the count summary.
	 * Uses cached per-file data from getFileChangeChildren to avoid extra git spawns.
	 */
	private formatSmartDiffLabel(t: AgentTask, fallbackSummary: string): string {
		// Parse the file count from the cached summary (e.g. "3 files · +100 / -20")
		const countMatch = fallbackSummary.match(/^(\d+)\s+files?\s+·/);
		const fileCount = countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : 0;

		// Only attempt inline file names for ≤3 files in valid git repos
		if (fileCount < 1 || fileCount > 3) return fallbackSummary;
		if (!fs.existsSync(t.project_dir)) return fallbackSummary;

		try {
			const startCommit = this.getTaskDiffStartCommit(t);
			const endCommit = this.getTaskDiffEndCommit(t);
			const fileDiffs = this.getPerFileDiffs(
				t.project_dir,
				startCommit,
				endCommit,
			);
			if (fileDiffs.length === 0 || fileDiffs.length > 3)
				return fallbackSummary;

			const additions = fileDiffs.reduce(
				(total, d) => total + Math.max(d.additions, 0),
				0,
			);
			const deletions = fileDiffs.reduce(
				(total, d) => total + Math.max(d.deletions, 0),
				0,
			);
			const names = fileDiffs.map((d) => path.basename(d.filePath));
			return `${names.join(", ")} · +${additions} / -${deletions}`;
		} catch {
			return fallbackSummary;
		}
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
			projectName:
				t.project_name || path.basename(t.project_dir) || t.project_dir,
			filePath: diff.filePath,
			additions: diff.additions,
			deletions: diff.deletions,
			status: diff.status ?? this.deriveFallbackFileChangeStatus(diff),
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
		if (t.end_commit && t.end_commit !== "unknown") {
			return t.end_commit;
		}
		return undefined;
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
			const start = performance.now();
			return this.getLastOutputLine(element.task).then(
				(line) => {
					defaultTimingRecorder.record(
						"tree.resolveTreeItem.runningTask",
						performance.now() - start,
					);
					if (line) {
						item.description = `${item.description} | ${line}`;
					}
					return item;
				},
				(err) => {
					defaultTimingRecorder.record(
						"tree.resolveTreeItem.runningTask",
						performance.now() - start,
					);
					throw err;
				},
			);
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
			this.getPerFileNumstatDiffs(
				projectDir,
				this.getTaskDiffStartCommit(task),
				this.getTaskDiffEndCommit(task),
			),
		);
	}

	private parsePerFileStatusesFromNameStatus(
		output: string,
	): Map<string, FileChangeStatus> {
		const statuses = new Map<string, FileChangeStatus>();
		if (!output.trim()) return statuses;

		for (const line of output.split("\n")) {
			if (!line.trim()) continue;
			const [statusRaw, ...fileParts] = line.split("\t");
			if (!statusRaw || fileParts.length === 0) continue;
			const filePath = fileParts[fileParts.length - 1]?.trim();
			if (!filePath) continue;

			const normalizedStatus = statusRaw.startsWith("A")
				? "A"
				: statusRaw.startsWith("D")
					? "D"
					: "M";
			statuses.set(filePath, normalizedStatus);
		}

		return statuses;
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

	private buildGitDiffArgs(
		projectDir: string,
		diffFlag: "--name-status" | "--numstat",
		startCommit?: string,
		endCommit?: string,
	): string[] {
		if (!startCommit) {
			return ["-C", projectDir, "diff", diffFlag];
		}

		const resolvedEnd = endCommit ?? "HEAD";
		return [
			"-C",
			projectDir,
			"diff",
			diffFlag,
			`${startCommit}..${resolvedEnd}`,
		];
	}

	private runGitDiffOutput(
		projectDir: string,
		diffFlag: "--name-status" | "--numstat",
		startCommit?: string,
		endCommit?: string,
	): string {
		if (startCommit && !endCommit) return "";

		const run = (args: string[]): string =>
			execFileSync("git", args, {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
			}).trim();

		try {
			let output = "";
			try {
				output = run(
					this.buildGitDiffArgs(projectDir, diffFlag, startCommit, endCommit),
				);
			} catch {
				if (!startCommit) return "";
				output = run(["-C", projectDir, "diff", diffFlag, "HEAD~1..HEAD"]);
			}

			if (!output && startCommit) {
				output = run(["-C", projectDir, "diff", diffFlag, "HEAD~1..HEAD"]);
			}

			return output;
		} catch {
			return "";
		}
	}

	private getPerFileNumstatDiffs(
		projectDir: string,
		startCommit?: string,
		endCommit?: string,
	): PerFileDiff[] {
		const output = this.runGitDiffOutput(
			projectDir,
			"--numstat",
			startCommit,
			endCommit,
		);
		if (!output) return [];
		return this.parsePerFileDiffsFromNumstat(output);
	}

	private deriveFallbackFileChangeStatus(diff: PerFileDiff): FileChangeStatus {
		if (diff.additions === 0 && diff.deletions > 0) return "D";
		if (diff.deletions === 0 && diff.additions > 0) return "A";
		return "M";
	}

	/**
	 * Get per-file diff stats via `git diff --numstat`.
	 *
	 * - Running agents: compare working tree vs HEAD (`startCommit` and `endCommit` both undefined)
	 * - Completed/stopped/failed with commits: compare `startCommit..endCommit`
	 * - Terminal tasks without valid end boundary: `startCommit` set but `endCommit` undefined → empty
	 */
	getPerFileDiffs(
		projectDir: string,
		startCommit?: string,
		endCommit?: string,
	): PerFileDiff[] {
		const diffs = this.getPerFileNumstatDiffs(
			projectDir,
			startCommit,
			endCommit,
		);
		if (diffs.length === 0) return [];

		const statuses = this.parsePerFileStatusesFromNameStatus(
			this.runGitDiffOutput(
				projectDir,
				"--name-status",
				startCommit,
				endCommit,
			),
		);

		return diffs.map((diff) => ({
			...diff,
			status:
				statuses.get(diff.filePath) ??
				this.deriveFallbackFileChangeStatus(diff),
		}));
	}

	private extractCommitHash(value: string): string | undefined {
		const firstToken = value.trim().split(/\s+/)[0];
		return firstToken && /^[0-9a-f]{7,40}$/i.test(firstToken)
			? firstToken
			: undefined;
	}

	private shortenCommitHash(value: string): string {
		return value.slice(0, 7);
	}

	private getFileChangePathParts(filePath: string): {
		filename: string;
		directory?: string;
	} {
		const normalized = filePath.replace(/\\/g, "/");
		const segments = normalized.split("/").filter(Boolean);
		const filename = segments.pop() ?? normalized;
		return {
			filename,
			...(segments.length > 0 ? { directory: segments.join("/") } : {}),
		};
	}

	private formatFileChangeDescription(node: FileChangeNode): string {
		const { directory } = this.getFileChangePathParts(node.filePath);
		const stats =
			node.additions < 0 || node.deletions < 0
				? `${node.status} binary`
				: `${node.status} +${node.additions} -${node.deletions}`;
		return directory ? `${directory} · ${stats}` : stats;
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
			const timingLinesDisabled = defaultTimingRecorder.formatReportLines();
			if (timingLinesDisabled.length > 0) {
				lines.push("");
				for (const line of timingLinesDisabled) {
					lines.push(line);
				}
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

		const timingLines = defaultTimingRecorder.formatReportLines();
		if (timingLines.length > 0) {
			lines.push("");
			for (const line of timingLines) {
				lines.push(line);
			}
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

	private getTaskFlowChildNodes(flow: TaskFlow): AgentNode[] {
		const flowTasks = flow.tasks ?? [];
		if (flowTasks.length === 0) return [];

		const children: AgentNode[] = [];
		const seen = new Set<string>();
		for (const task of flowTasks) {
			const child = this.resolveTaskFlowChildNode(flow, task);
			const childKey = this.getTaskFlowChildNodeKey(child, task);
			if (seen.has(childKey)) continue;
			seen.add(childKey);
			children.push(child);
		}
		return children;
	}

	private resolveTaskFlowChildNode(
		flow: TaskFlow,
		task: TaskFlowTask,
	): AgentNode {
		const launcherTask = this.findLauncherTaskForFlowTask(task);
		if (launcherTask) {
			return { type: "task", task: launcherTask };
		}

		const discoveredAgent = this.findDiscoveredAgentForFlowTask(task);
		if (discoveredAgent) {
			return { type: "discovered", agent: discoveredAgent };
		}

		const openclawTask = this.findOpenClawTaskForFlowTask(task);
		if (openclawTask) {
			return { type: "openclawTask", task: openclawTask };
		}

		return {
			type: "taskFlowChild",
			taskId: task.taskId,
			flowId: flow.flowId,
			label: this.getOpenClawTaskDisplayTitle(task),
			status: openclawStatusToLabel(task.status),
		};
	}

	private getTaskFlowChildNodeKey(
		child: AgentNode,
		task: TaskFlowTask,
	): string {
		switch (child.type) {
			case "task":
				return `task:${child.task.id}`;
			case "discovered":
				return `discovered:${child.agent.pid}`;
			case "openclawTask":
				return `openclaw:${child.task.taskId}`;
			case "taskFlowChild":
				return `placeholder:${task.taskId}`;
			default:
				return `other:${task.taskId}`;
		}
	}

	private findLauncherTaskForFlowTask(task: TaskFlowTask): AgentTask | null {
		return (
			this.getLauncherTasks().find(
				(launcherTask) =>
					(task.childSessionKey != null &&
						launcherTask.session_id != null &&
						task.childSessionKey.includes(launcherTask.session_id)) ||
					launcherTask.id === task.taskId ||
					(task.label != null && launcherTask.id === task.label),
			) ?? null
		);
	}

	private findDiscoveredAgentForFlowTask(
		task: TaskFlowTask,
	): DiscoveredAgent | null {
		if (!task.childSessionKey) return null;
		const discoveredAgents =
			this._allDiscoveredAgents.length > 0
				? this._allDiscoveredAgents
				: this._discoveredAgents;
		return (
			discoveredAgents.find(
				(agent) => agent.sessionId === task.childSessionKey,
			) ?? null
		);
	}

	private findOpenClawTaskForFlowTask(task: TaskFlowTask): OpenClawTask | null {
		const allOpenClawTasks = this.getNonLauncherOpenClawTasks();
		return (
			allOpenClawTasks.find(
				(openclawTask) =>
					openclawTask.taskId === task.taskId ||
					(task.childSessionKey != null &&
						openclawTask.childSessionKey === task.childSessionKey),
			) ?? null
		);
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
		const discoveredCount = node.discoveredAgents?.length ?? 0;
		const counts = countAgentStatuses(node.tasks);
		counts.working += discoveredCount;
		counts.total += discoveredCount;
		const total = counts.total;

		// Uppercase name + ▼ + count in parens — mirrors Git Sort section headers
		const hasRunning = counts.working > 0;
		const collapseState = hasRunning
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(
			`${icon} ${node.projectName.toUpperCase()} \u25BC (${total})`,
			collapseState,
		);

		// Description: just the status summary, no relative time
		const description = formatCountSummary(counts, {
			includeAttention: true,
		});
		item.description = description;
		const latestActivity = this.getProjectGroupRelativeActivity(node);
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
		const collapsibleState =
			node.status !== "done" && this.statusGroupHasRecentItems(node)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(
			`${STATUS_GROUP_LABELS[node.status]} · ${count} ${count === 1 ? "agent" : "agents"}`,
			collapsibleState,
		);
		item.id = `status-group:${node.status}:${node.parentProjectDir ?? node.parentProjectName ?? ""}:${node.parentGroupKey ?? ""}`;
		item.contextValue = "statusGroup";
		item.iconPath = STATUS_GROUP_ICONS[node.status];
		item.tooltip = `${STATUS_GROUP_LABELS[node.status]} • ${count} ${count === 1 ? "agent" : "agents"}`;
		return item;
	}

	private createStatusTimeGroupItem(
		node: StatusTimeGroupNode,
	): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, node.collapsibleState);
		item.id = `status-time-group:${node.status}:${node.period}:${node.parentProjectDir ?? node.parentProjectName ?? ""}:${node.parentGroupKey ?? ""}`;
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
		const stuckRaw = this.isAgentStuck(task);
		const interactiveAwaiting =
			stuckRaw && this.hasPositiveLivenessEvidence(task);
		// Only surface "(possibly stuck)" when stuck heuristics fire AND we have
		// no positive liveness evidence. Live launcher-managed interactive
		// Claude lanes get the more honest "(interactive)" hint instead.
		const isStuck = stuckRaw && !interactiveAwaiting;
		const diffSummaryInline = this.getCachedDiffSummaryForTask(task);
		const descriptionParts: string[] = [];
		if (!this.isProjectGroupingEnabled()) {
			descriptionParts.push(task.project_name);
		}
		if (task.status === "completed_stale") {
			descriptionParts.push("stale");
		}
		const missingHandoffRelpath =
			task.status === "completed" &&
			task.review_status !== "pending" &&
			task.review_status !== "changes_requested" &&
			task.handoff_file &&
			this.getDeclaredHandoffState(task) === "missing"
				? task.handoff_file
				: null;
		if (missingHandoffRelpath) {
			descriptionParts.push(`missing handoff: ${missingHandoffRelpath}`);
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
			descriptionParts.push("✓");
		}
		const surfaceSummary = classifyTaskSurface(task);
		// Surface tags are the loudest signal for running tasks — a click
		// routes to a different strategy depending on kind. Skip for done
		// tasks: the click opens a QuickPick, not a focus, so the surface is
		// not the actionable fact. Launcher-bundle tasks get a null tag so
		// the common case stays clean.
		if (task.status === "running" && surfaceSummary.shortTag) {
			descriptionParts.push(surfaceSummary.shortTag);
		}
		const rawDescription = isStuck
			? `${descriptionParts.join(" · ")} (possibly stuck)`
			: interactiveAwaiting
				? `${descriptionParts.join(" · ")} (interactive)`
				: descriptionParts.join(" · ");
		const description =
			rawDescription.length > 80
				? `${rawDescription.slice(0, 79)}…`
				: rawDescription;
		const duration = this.getTaskDuration(task);
		const runtimeBreadcrumb = this.getTaskRuntimeIdentityBreadcrumb(task);
		const transcriptBreadcrumb = this.getTaskTranscriptBreadcrumb(task);

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
				task.started_at ? `Started: ${task.started_at}` : null,
				task.completed_at ? `Completed: ${task.completed_at}` : null,
				duration ? `Duration: ${duration}` : null,
				runtimeBreadcrumb ? `Runtime: ${runtimeBreadcrumb}` : null,
				transcriptBreadcrumb ? `Transcript: ${transcriptBreadcrumb}` : null,
				surfaceSummary.tooltipLine,
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
				: "commandCentral.resumeAgentSession",
			title: isRunning ? "Focus Terminal" : "Resume Session",
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
		item.iconPath = new vscode.ThemeIcon(
			"history",
			new vscode.ThemeColor("descriptionForeground"),
		);
		// Build a description from the hidden node statuses
		const hasCompleted = node.hiddenNodes.some(
			(n) =>
				n.type === "task" &&
				(n.task.status === "completed" ||
					n.task.status === "completed_dirty" ||
					n.task.status === "completed_stale"),
		);
		const hasStopped = node.hiddenNodes.some(
			(n) => n.type === "task" && n.task.status === "stopped",
		);
		const statusParts: string[] = [];
		if (hasCompleted) statusParts.push("completed");
		if (hasStopped) statusParts.push("stopped");
		if (statusParts.length > 0) {
			item.description = statusParts.join(" · ");
		}
		return item;
	}

	private createFileChangeItem(node: FileChangeNode): vscode.TreeItem {
		const { filename } = this.getFileChangePathParts(node.filePath);
		const item = new vscode.TreeItem(
			filename,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description = this.formatFileChangeDescription(node);
		item.tooltip = path.join(node.projectDir, node.filePath);
		item.resourceUri = vscode.Uri.file(
			path.join(node.projectDir, node.filePath),
		);
		item.contextValue = "agentFileChange";
		item.command = {
			command: "commandCentral.smartOpenFile",
			title: "Open File",
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
		if (node.command) {
			item.command = node.command;
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
