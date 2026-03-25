/**
 * AgentStatusTreeProvider - TreeView provider for Ghostty launcher agent status
 *
 * Reads a JSON task registry (tasks.json) and displays agent tasks in a tree:
 * - Root items: task ID + status + project name + time elapsed
 * - Child items: prompt file, worktree path, attempt count, PR info
 *
 * Watches the file for changes and auto-refreshes.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

export type AgentRole = "developer" | "planner" | "reviewer" | "test";

export interface AgentTask {
	id: string;
	status: "running" | "stopped" | "killed" | "completed" | "failed";
	project_dir: string;
	project_name: string;
	session_id: string;
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
	completed_at?: string | null;
}

// ── Tree node types ──────────────────────────────────────────────────

export type AgentNode = SummaryNode | TaskNode | DetailNode | DiscoveredNode;

export interface SummaryNode {
	type: "summary";
	label: string;
}

export interface TaskNode {
	type: "task";
	task: AgentTask;
}

export interface DetailNode {
	type: "detail";
	label: string;
	value: string;
	taskId: string;
}

export interface DiscoveredNode {
	type: "discovered";
	agent: DiscoveredAgent;
}

// ── Status icon mapping ──────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
	running: "🔄",
	completed: "✅",
	completed_stale: "✅",
	contract_failure: "⚠️",
	failed: "❌",
	stopped: "⏹️",
	killed: "💀",
};

// ── ThemeIcon + color for status (colored sidebar icons) ─────────────

export const STATUS_THEME_ICONS: Record<
	string,
	{ icon: string; color: string }
> = {
	running: { icon: "sync~spin", color: "charts.yellow" },
	completed: { icon: "check", color: "charts.green" },
	completed_stale: { icon: "check", color: "disabledForeground" },
	contract_failure: { icon: "warning", color: "charts.yellow" },
	failed: { icon: "error", color: "charts.red" },
	stopped: { icon: "debug-stop", color: "disabledForeground" },
	killed: { icon: "close", color: "charts.red" },
};

// ── Agent type detection for discovered agents ───────────────────────

export function getAgentTypeIcon(agent: DiscoveredAgent): vscode.ThemeIcon {
	const model = agent.model?.toLowerCase() ?? "";

	if (
		model.includes("claude") ||
		model.includes("anthropic") ||
		model.includes("sonnet") ||
		model.includes("opus") ||
		model.includes("haiku")
	) {
		return new vscode.ThemeIcon(
			"circle-filled",
			new vscode.ThemeColor("charts.purple"),
		);
	}
	if (
		model.includes("gpt") ||
		model.includes("codex") ||
		model.includes("openai") ||
		model.includes("o1") ||
		model.includes("o3") ||
		model.includes("o4")
	) {
		return new vscode.ThemeIcon(
			"circle-filled",
			new vscode.ThemeColor("charts.green"),
		);
	}
	if (model.includes("gemini") || model.includes("google")) {
		return new vscode.ThemeIcon(
			"circle-filled",
			new vscode.ThemeColor("charts.blue"),
		);
	}
	return new vscode.ThemeIcon("search");
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

function normalizeTask(raw: Record<string, unknown>): AgentTask | null {
	const sessionId = (raw["session_id"] ?? raw["tmux_session"]) as
		| string
		| undefined;
	if (!sessionId) return null;
	return {
		...raw,
		session_id: sessionId,
	} as AgentTask;
}

// ── Provider ─────────────────────────────────────────────────────────

export interface GitInfo {
	branch: string;
	lastCommit: string;
}

export class AgentStatusTreeProvider
	implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable
{
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

	constructor() {
		// Watch config changes for the tasks file path
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.agentTasksFile")) {
					this.setupFileWatch();
					this.reload();
				}
			}),
		);
		this.setupFileWatch();
		this.reload();
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
				this.reload();
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

	reload(): void {
		this.registry = this.readRegistry();
		this.checkCompletionNotifications();
		this.updateAutoRefreshTimer();
		// Clear port cache for tasks that are no longer running
		for (const [taskId, task] of Object.entries(this.registry.tasks)) {
			if (task.status !== "running") {
				this._portCache.delete(taskId);
				this._portDetecting.delete(taskId);
			}
		}
		// Set context key for welcome view
		vscode.commands.executeCommand(
			"setContext",
			"commandCentral.hasAgentTasks",
			Object.keys(this.registry.tasks).length > 0,
		);
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

		for (const task of Object.values(this.registry.tasks)) {
			const prev = this.previousStatuses.get(task.id);
			if (masterEnabled && prev === "running") {
				if (task.status === "completed" && onCompletion) {
					const elapsed = formatElapsed(task.started_at);
					const msg = `Agent ${task.id} completed (${elapsed})`;
					vscode.window
						.showInformationMessage(msg, "View Diff", "Show Output")
						.then((action) => {
							if (action === "View Diff") {
								vscode.commands.executeCommand("commandCentral.viewAgentDiff", {
									type: "task" as const,
									task,
								});
							} else if (action === "Show Output") {
								vscode.commands.executeCommand(
									"commandCentral.showAgentOutput",
									{ type: "task" as const, task },
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
					const msg = `Agent ${task.id} failed — check output`;
					vscode.window
						.showWarningMessage(msg, "Show Output", "View Diff")
						.then((action) => {
							if (action === "Show Output") {
								vscode.commands.executeCommand(
									"commandCentral.showAgentOutput",
									{ type: "task" as const, task },
								);
							} else if (action === "View Diff") {
								vscode.commands.executeCommand("commandCentral.viewAgentDiff", {
									type: "task" as const,
									task,
								});
							}
						});
					this._onAgentEvent.fire({
						type: "agent-failed",
						taskId: task.id,
						timestamp: new Date(),
						projectDir: task.project_dir,
					});
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
		if (!this._filePath) return { version: 2, tasks: {} };
		try {
			const content = fs.readFileSync(this._filePath, "utf-8");
			const parsed = JSON.parse(content) as TaskRegistry;
			if ((parsed.version === 1 || parsed.version === 2) && parsed.tasks) {
				const normalized: Record<string, AgentTask> = {};
				for (const [key, raw] of Object.entries(parsed.tasks)) {
					const task = normalizeTask(raw as unknown as Record<string, unknown>);
					if (task) normalized[key] = task;
				}
				return { version: 2, tasks: normalized };
			}
			return { version: 2, tasks: {} };
		} catch {
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
		if (element.type === "discovered") {
			return this.createDiscoveredItem(element);
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		if (!element) {
			const tasks = Object.values(this.registry.tasks);
			const discovered = this._discoveredAgents;
			if (tasks.length === 0 && discovered.length === 0) return [];

			// Launcher-managed tasks first, sorted by start time descending
			const taskNodes: AgentNode[] = tasks
				.sort(
					(a, b) =>
						new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
				)
				.map((task) => ({ type: "task" as const, task }));

			// Discovered agents second, sorted by start time descending
			const discoveredNodes: AgentNode[] = discovered
				.sort(
					(a, b) =>
						new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
				)
				.map((agent) => ({ type: "discovered" as const, agent }));

			// Build summary node
			const totalCount = tasks.length + discovered.length;
			const counts = { running: 0, completed: 0, failed: 0 };
			for (const task of tasks) {
				if (task.status in counts) counts[task.status as keyof typeof counts]++;
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
				...taskNodes,
				...discoveredNodes,
			];
		}

		if (element.type === "task") {
			const compact = this.isCompactMode();
			if (compact) {
				return this.getCompactChildren(element.task);
			}
			return this.getDetailChildren(element.task);
		}

		if (element.type === "discovered") {
			return this.getDiscoveredChildren(element.agent);
		}

		return [];
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
		const diffSummary = this.getDiffSummary(agent.projectDir, {
			status: "running",
		} as AgentTask);
		if (diffSummary) {
			details.push({
				type: "detail",
				label: "Changes",
				value: diffSummary,
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
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Prompt",
				value: this.readPromptSummary(t.prompt_file),
				taskId: t.id,
			},
		];

		// Diff summary
		const diffSummary = this.getDiffSummary(t.project_dir, t);
		if (diffSummary) {
			details.push({
				type: "detail",
				label: "Changes",
				value: diffSummary,
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
				t.status === "failed" ||
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
				{ encoding: "utf-8", timeout: 2000 },
			).trim();
			const lastCommit = execFileSync(
				"git",
				["-C", projectDir, "log", "-1", "--format=%h %s (%cr)"],
				{ encoding: "utf-8", timeout: 2000 },
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
				timeout: 2000,
			}).trim();

			if (!output) return null;

			// Parse the summary line: "N files changed, X insertions(+), Y deletions(-)"
			const summaryLine = output.split("\n").pop() ?? "";
			const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
			const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
			const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

			if (!filesMatch) return null;

			const files = filesMatch[1];
			const insertions = insertMatch?.[1] ?? "0";
			const deletions = deleteMatch?.[1] ?? "0";
			return `${files} files · +${insertions} / -${deletions}`;
		} catch {
			return null;
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

	/** Compute summary icon based on aggregate agent state */
	private getSummaryIcon(): vscode.ThemeIcon {
		const tasks = Object.values(this.registry.tasks);
		const discovered = this._discoveredAgents;

		const hasRunning =
			tasks.some((t) => t.status === "running") || discovered.length > 0;
		const hasFailed = tasks.some(
			(t) => t.status === "failed" || t.status === "killed",
		);

		if (hasRunning) {
			return new vscode.ThemeIcon(
				"sync~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		}
		if (hasFailed) {
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.red"),
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
				return `Completed in ${elapsed}`;
			case "failed":
				return `Failed after ${elapsed}`;
			default:
				return elapsed;
		}
	}

	private createTaskItem(task: AgentTask): vscode.TreeItem {
		const icon = STATUS_ICONS[task.status] || "❓";
		const roleIcon = task.role ? ROLE_ICONS[task.role] : null;
		const elapsedDesc = this.formatElapsedDescription(task);
		const prefix = roleIcon ? `${icon} ${roleIcon}` : icon;
		const projectEmoji = this.getProjectEmoji(task.project_dir);
		const label = projectEmoji
			? `${prefix} ${projectEmoji} ${task.id}`
			: `${prefix} ${task.id}`;
		const diffSummaryInline = this.getDiffSummary(task.project_dir, task);
		const description = diffSummaryInline
			? `${task.project_name} · ${elapsedDesc} · ${diffSummaryInline}`
			: `${task.project_name} · ${elapsedDesc}`;

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
		const statusTheme = STATUS_THEME_ICONS[task.status] ?? {
			icon: "question",
			color: "disabledForeground",
		};
		item.iconPath = new vscode.ThemeIcon(
			statusTheme.icon,
			new vscode.ThemeColor(statusTheme.color),
		);
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

	private createDetailItem(node: DetailNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			`${node.label}: ${node.value}`,
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "agentTaskDetail";
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
		const discoveredDiff = this.getDiffSummary(agent.projectDir, {
			status: "running",
		} as AgentTask);
		item.description = discoveredDiff
			? `PID ${agent.pid} · ${uptime} · ${discoveredDiff} ${sourceLabel}`
			: `PID ${agent.pid} · ${uptime} ${sourceLabel}`;
		item.iconPath = getAgentTypeIcon(agent);
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
