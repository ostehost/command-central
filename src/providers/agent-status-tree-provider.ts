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
	| "completed_stale"
	| "failed"
	| "contract_failure";

export type AgentRole = "developer" | "planner" | "reviewer" | "test";

export interface AgentTask {
	id: string;
	status: AgentTaskStatus;
	project_dir: string;
	project_name: string;
	session_id: string;
	agent_backend?: string | null;
	cli_name?: string | null;
	tmux_session?: string;
	bundle_path: string;
	prompt_file: string;
	started_at: string;
	attempts: number;
	max_attempts: number;
	pr_number?: number | null;
	review_status?: "pending" | "approved" | "changes_requested" | null;
	role?: AgentRole | null;
	terminal_backend?: "tmux" | "applescript";
	ghostty_bundle_id?: string | null;
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
	| StateNode;

export interface SummaryNode {
	type: "summary";
	label: string;
}

export interface TaskNode {
	type: "task";
	task: AgentTask;
}

export interface ProjectGroupNode {
	type: "projectGroup";
	projectName: string;
	tasks: AgentTask[];
}

export type TreeElement = TaskNode | ProjectGroupNode;

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

export interface StateNode {
	type: "state";
	label: string;
	description?: string;
	icon?: string;
}

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
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

// ── Task normalization (v1 → v2) ─────────────────────────────────────

const VALID_TASK_STATUSES = new Set<AgentTaskStatus>([
	"running",
	"stopped",
	"killed",
	"completed",
	"completed_stale",
	"failed",
	"contract_failure",
]);

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
	const status: AgentTaskStatus = VALID_TASK_STATUSES.has(
		(statusRaw ?? "running") as AgentTaskStatus,
	)
		? ((statusRaw ?? "running") as AgentTaskStatus)
		: "running";
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
		agent_backend: asString(raw["agent_backend"]) ?? null,
		cli_name: asString(raw["cli_name"]) ?? null,
		tmux_session: asString(raw["tmux_session"]),
		bundle_path: bundlePath,
		prompt_file: promptFile,
		started_at: asString(raw["started_at"]) ?? new Date().toISOString(),
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
			raw["terminal_backend"] === "applescript"
				? raw["terminal_backend"]
				: undefined,
		ghostty_bundle_id: asString(raw["ghostty_bundle_id"]) ?? null,
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

	constructor() {
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
					e.affectsConfiguration("commandCentral.agentStatus.groupByProject")
				) {
					this._onDidChangeTreeData.fire(undefined);
				}
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

		// Refresh tree when discovered agents change
		this.disposables.push(
			this._agentRegistry.onDidChangeAgents(() => {
				this._discoveredAgents = this._agentRegistry
					? this._agentRegistry.getDiscoveredAgents(this.getLauncherTasks())
					: [];
				this.setHasAgentsContext();
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
	}

	findTaskElement(taskId: string): TreeElement | undefined {
		const task = this.registry.tasks[taskId];
		if (!task) return undefined;
		const visibleTasks = this.isRunningOnlyFilterEnabled()
			? Object.values(this.registry.tasks).filter((t) => t.status === "running")
			: Object.values(this.registry.tasks);
		if (!visibleTasks.some((t) => t.id === taskId)) return undefined;
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

	private setHasAgentsContext(): void {
		const hasAgents =
			Object.keys(this.registry.tasks).length > 0 ||
			this._discoveredAgents.length > 0;
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.hasAgentTasks",
			hasAgents,
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
		this._diffSummaryCache.clear();
		this._diffSummaryDetecting.clear();
		this.checkCompletionNotifications();
		this.updateAutoRefreshTimer();
		// Clear port cache for tasks that are no longer running
		for (const [taskId, task] of Object.entries(this.registry.tasks)) {
			if (task.status !== "running") {
				this._portCache.delete(taskId);
				this._portDetecting.delete(taskId);
			}
		}
		this.setHasAgentsContext();
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Check for running→completed/failed transitions and fire notifications */
	private checkCompletionNotifications(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const masterEnabled = config.get<boolean>(
			"agentStatus.notifications",
			true,
		);
		const notifConfig = vscode.workspace.getConfiguration(
			"commandCentral.notifications",
		);
		const onCompletion = notifConfig.get<boolean>("onCompletion", true);
		const onFailure = notifConfig.get<boolean>("onFailure", true);
		const soundEnabled = notifConfig.get<boolean>("sound", false);
		const messageOptions = soundEnabled ? { modal: false } : undefined;

		for (const task of Object.values(this.registry.tasks)) {
			const prev = this.previousStatuses.get(task.id);
			if (masterEnabled && prev === "running") {
				const elapsed = formatElapsed(task.started_at);
				const backend = this.getBackendLabel(task);

				if (task.status === "completed" && onCompletion) {
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
						"Review Diff",
						"Show Output",
						"Focus Terminal",
					).then((action) => {
						if (action === "Review Diff") {
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
						"Review Diff",
						"Restart",
					).then((action) => {
						if (action === "Show Output") {
							this.executeTaskCommand("commandCentral.showAgentOutput", task);
						} else if (action === "Review Diff") {
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
					const msg = `⏹️ ${task.id} stopped (${elapsed}) [${backend}]`;
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

	private revealTaskInSidebar(taskId: string): void {
		if (!this._agentStatusView) return;
		const taskElement = this.findTaskElement(taskId);
		if (!taskElement) return;
		void this._agentStatusView
			.reveal(taskElement, { select: true, focus: false })
			.catch(() => {
				// Reveal failures are non-fatal (e.g., filtered-out task).
			});
	}

	/** Start or stop auto-refresh timer based on whether any tasks are running */
	private updateAutoRefreshTimer(): void {
		const hasRunning = Object.values(this.registry.tasks).some(
			(t) => t.status === "running",
		);

		if (hasRunning && !this.autoRefreshTimer) {
			const config = vscode.workspace.getConfiguration("commandCentral");
			const intervalMs = config.get<number>("agentStatus.autoRefreshMs", 5000);
			this.autoRefreshTimer = setInterval(() => {
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
		if (element.type === "fileChange") {
			return this.createFileChangeItem(element);
		}
		if (element.type === "discovered") {
			return this.createDiscoveredItem(element);
		}
		if (element.type === "state") {
			return this.createStateItem(element);
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		if (!element) {
			const allTasks = Object.values(this.registry.tasks);
			const discovered = this._discoveredAgents;
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
				return [];
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

			// Launcher-managed tasks
			const taskNodes: AgentNode[] = this.sortTasksByStartedAtDesc(tasks).map(
				(task) => ({ type: "task" as const, task }),
			);
			const projectGroupNodes: AgentNode[] = groupedByProject
				? this.groupTasksByProject(tasks).map((group) => ({
						type: "projectGroup" as const,
						projectName: group.projectName,
						tasks: group.tasks,
					}))
				: [];

			// Discovered agents second, sorted by start time descending
			const discoveredNodes: AgentNode[] = [...discovered]
				.sort(
					(a, b) =>
						new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
				)
				.map((agent) => ({ type: "discovered" as const, agent }));

			// Build summary node
			const totalCount = tasks.length + discovered.length;
			const counts = { running: 0, completed: 0, failed: 0 };
			for (const task of tasks) {
				if (task.status === "running") counts.running++;
				if (task.status === "completed" || task.status === "completed_stale") {
					counts.completed++;
				}
				if (
					task.status === "failed" ||
					task.status === "killed" ||
					task.status === "contract_failure"
				) {
					counts.failed++;
				}
			}
			// Discovered agents are always running (they're live processes)
			counts.running += discovered.length;
			const summaryParts: string[] = [];
			if (counts.running > 0) summaryParts.push(`${counts.running} running`);
			if (counts.completed > 0)
				summaryParts.push(`${counts.completed} completed`);
			if (counts.failed > 0) summaryParts.push(`${counts.failed} failed`);
			const summaryLabel =
				summaryParts.length > 0
					? summaryParts.join(" · ")
					: `${totalCount} agents`;

			return [
				{ type: "summary" as const, label: summaryLabel },
				...(groupedByProject ? projectGroupNodes : taskNodes),
				...discoveredNodes,
			];
		}

		if (element.type === "projectGroup") {
			return this.sortTasksByStartedAtDesc(element.tasks).map((task) => ({
				type: "task" as const,
				task,
			}));
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

	private parseDiffSummary(output: string): string | null {
		const trimmed = output.trim();
		if (!trimmed) return null;

		const summaryLine = trimmed.split("\n").pop() ?? "";
		const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
		const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
		const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);
		if (!filesMatch) return null;

		const files = filesMatch[1];
		const fileLabel = files === "1" ? "1 file" : `${files} files`;
		const insertions = insertMatch?.[1] ?? "0";
		const deletions = deleteMatch?.[1] ?? "0";
		return `${fileLabel} · +${insertions} / -${deletions}`;
	}

	private async computeDiffSummaryAsync(
		projectDir: string,
		task: AgentTask,
	): Promise<string | null> {
		try {
			const args =
				task.status === "running"
					? ["-C", projectDir, "diff", "--stat"]
					: ["-C", projectDir, "diff", "--stat", "HEAD~1"];
			const execFileAsync = promisify(execFile);
			const { stdout } = await execFileAsync("git", args, {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
			});
			return this.parseDiffSummary(stdout);
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
		return config.get<boolean>("agentStatus.groupByProject", true);
	}

	private sortTasksByStartedAtDesc(tasks: AgentTask[]): AgentTask[] {
		return [...tasks].sort(
			(a, b) =>
				new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
		);
	}

	private groupTasksByProject(
		tasks: AgentTask[],
	): Array<{ projectName: string; tasks: AgentTask[] }> {
		const grouped = new Map<string, AgentTask[]>();
		for (const task of tasks) {
			const projectName = task.project_name || "(unknown project)";
			const existing = grouped.get(projectName);
			if (existing) {
				existing.push(task);
			} else {
				grouped.set(projectName, [task]);
			}
		}
		return Array.from(grouped.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([projectName, projectTasks]) => ({
				projectName,
				tasks: this.sortTasksByStartedAtDesc(projectTasks),
			}));
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

		if (this.isAgentStuck(t)) {
			const thresholdMinutes = this.getStuckThresholdMinutes();
			details.push({
				type: "detail",
				label: `⚠️ No activity for ${thresholdMinutes} minutes`,
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
			(t.status === "completed" || t.status === "stopped")
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

		const explicitStartCommit = (
			t as AgentTask & { start_commit?: string | null }
		).start_commit;
		if (explicitStartCommit) return explicitStartCommit;

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

	/** Read the first meaningful line from a prompt file as a summary */
	readPromptSummary(promptFile: string): string {
		const cached = this._promptCache.get(promptFile);
		if (cached !== undefined) return cached;

		try {
			const content = fs.readFileSync(promptFile, "utf-8");
			const lines = content.split("\n");

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
					const result =
						trimmed.length > 80 ? `${trimmed.substring(0, 80)}…` : trimmed;
					this._promptCache.set(promptFile, result);
					return result;
				}
			}

			// Fallback: first non-empty, non-heading, non-frontmatter line
			let inFrontmatter = false;
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === "---") {
					inFrontmatter = !inFrontmatter;
					continue;
				}
				if (inFrontmatter) continue;
				if (trimmed.length === 0) continue;
				if (trimmed.startsWith("#")) continue;
				const result =
					trimmed.length > 80 ? `${trimmed.substring(0, 80)}…` : trimmed;
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
		try {
			// For completed/failed/stopped tasks, diff HEAD~1; for running, diff working tree
			const args =
				task.status === "running"
					? ["-C", projectDir, "diff", "--stat"]
					: ["-C", projectDir, "diff", "--stat", "HEAD~1"];

			const output = execFileSync("git", args, {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
			});
			return this.parseDiffSummary(output);
		} catch {
			return null;
		}
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
		if (element.type === "task" && this.isProjectGroupingEnabled()) {
			const allTasks = Object.values(this.registry.tasks);
			const visibleTasks = this.isRunningOnlyFilterEnabled()
				? allTasks.filter((task) => task.status === "running")
				: allTasks;
			const groupTasks = visibleTasks.filter(
				(task) => task.project_name === element.task.project_name,
			);
			if (groupTasks.some((task) => task.id === element.task.id)) {
				return {
					type: "projectGroup",
					projectName: element.task.project_name,
					tasks: this.sortTasksByStartedAtDesc(groupTasks),
				};
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
			const task = this.registry.tasks[element.taskId];
			if (task) return { type: "task", task };
		}
		if (element.type === "fileChange") {
			const task = this.registry.tasks[element.taskId];
			if (task) return { type: "task", task };
		}
		// summary and root-level nodes have no parent
		return undefined;
	}

	/** Get the full task registry */
	getRegistry(): TaskRegistry {
		return this.registry;
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
		const launcherTasks = Object.values(this.registry.tasks);
		const syntheticDiscovered: AgentTask[] = this._discoveredAgents.map(
			(agent) => ({
				id: `discovered-${agent.pid}`,
				status: "running" as const,
				project_dir: agent.projectDir,
				project_name: agent.projectDir.split("/").pop() ?? agent.projectDir,
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

	private getProjectEmoji(projectDir: string): string | null {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const projects = config.get<Array<{ name: string; emoji: string }>>(
			"projects",
			[],
		);
		const dirName = path.basename(projectDir);
		const match = projects.find((p) => p.name === dirName);
		return match?.emoji ?? null;
	}

	private createSummaryItem(node: SummaryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.iconPath = this.getSummaryIcon();
		item.contextValue = "agentSummary";
		return item;
	}

	private createProjectGroupItem(node: ProjectGroupNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.projectName,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		item.description = `${node.tasks.length} agents`;
		item.iconPath = new vscode.ThemeIcon("folder");
		item.contextValue = "projectGroup";
		return item;
	}

	/** Compute summary icon based on aggregate agent state */
	private getSummaryIcon(): vscode.ThemeIcon {
		const tasks = Object.values(this.registry.tasks);
		const discovered = this._discoveredAgents;

		const hasRunning =
			tasks.some((t) => t.status === "running") || discovered.length > 0;
		const hasFailed = tasks.some(
			(t) => t.status === "failed" || t.status === "killed",
		);
		const hasContractFailure = tasks.some(
			(t) => t.status === "contract_failure",
		);

		if (hasFailed) {
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		}
		if (hasRunning) {
			return new vscode.ThemeIcon(
				"sync~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		}
		if (hasContractFailure) {
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.orange"),
			);
		}
		return new vscode.ThemeIcon(
			"check-all",
			new vscode.ThemeColor("charts.green"),
		);
	}

	private formatElapsedDescription(task: AgentTask): string {
		const elapsed = formatElapsed(task.started_at);
		switch (task.status) {
			case "running":
				return `Running for ${elapsed}`;
			case "completed":
			case "completed_stale":
				return `Completed in ${elapsed}`;
			case "failed":
				return `Failed after ${elapsed}`;
			case "contract_failure":
				return `Contract failure after ${elapsed}`;
			case "stopped":
				return `Stopped after ${elapsed}`;
			case "killed":
				return `Killed after ${elapsed}`;
			default:
				return `Failed after ${elapsed}`;
		}
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
		const projectEmoji = this.getProjectEmoji(task.project_dir);
		const labelParts = [roleIcon, projectEmoji, task.id].filter(Boolean);
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
				`**${task.id}** — ${task.status}`,
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
				: "commandCentral.resumeAgentSession",
			title: isRunning ? "Focus Terminal" : "Resume Session",
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
		const projectName = path.basename(agent.projectDir);
		const uptime = formatElapsed(agent.startTime.toISOString());
		const sourceLabel =
			agent.source === "process"
				? "(discovered via ps)"
				: "(discovered via session file)";
		const label = `🔄 ${projectName}`;
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		const discoveredDiff = this.getCachedDiffSummaryForDiscovered(agent);
		const discoveredDiffLoading =
			!discoveredDiff && this.isDiscoveredDiffSummaryLoading(agent);
		item.description = discoveredDiff
			? `PID ${agent.pid} · ${uptime} · ${discoveredDiff} ${sourceLabel}`
			: discoveredDiffLoading
				? `PID ${agent.pid} · ${uptime} · loading diff... ${sourceLabel}`
				: `PID ${agent.pid} · ${uptime} ${sourceLabel}`;
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
		for (const d of this.disposables) d.dispose();
	}
}
