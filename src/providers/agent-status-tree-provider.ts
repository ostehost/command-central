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
import type { DiscoveredAgent } from "../discovery/types.js";
import type { AgentEvent } from "../events/agent-events.js";
import { detectListeningPorts } from "../utils/port-detector.js";
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

const STATUS_ICONS: Record<AgentTask["status"], string> = {
	running: "🔄",
	completed: "✅",
	failed: "❌",
	stopped: "⏹️",
	killed: "💀",
};

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
						.showInformationMessage(msg, "Focus Terminal")
						.then((action) => {
							if (action === "Focus Terminal") {
								vscode.commands.executeCommand(
									"commandCentral.focusAgentTerminal",
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
						.showWarningMessage(msg, "Focus Terminal")
						.then((action) => {
							if (action === "Focus Terminal") {
								vscode.commands.executeCommand(
									"commandCentral.focusAgentTerminal",
									{ type: "task" as const, task },
								);
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
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		if (!element) {
			const tasks = Object.values(this.registry.tasks);
			if (tasks.length === 0) return [];

			const taskNodes: AgentNode[] = tasks
				.sort(
					(a, b) =>
						new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
				)
				.map((task) => ({ type: "task" as const, task }));

			// Build summary node
			const counts = { running: 0, completed: 0, failed: 0 };
			for (const task of tasks) {
				if (task.status in counts) counts[task.status as keyof typeof counts]++;
			}
			const summaryParts: string[] = [];
			if (counts.running > 0) summaryParts.push(`${counts.running} running`);
			if (counts.completed > 0)
				summaryParts.push(`${counts.completed} completed`);
			if (counts.failed > 0) summaryParts.push(`${counts.failed} failed`);
			const summaryLabel =
				summaryParts.length > 0
					? summaryParts.join(" · ")
					: `${tasks.length} agents`;

			return [{ type: "summary" as const, label: summaryLabel }, ...taskNodes];
		}

		if (element.type === "task") {
			const compact = this.isCompactMode();
			if (compact) {
				return this.getCompactChildren(element.task);
			}
			return this.getDetailChildren(element.task);
		}

		return [];
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
				value: t.prompt_file,
				taskId: t.id,
			},
			{
				type: "detail",
				label: "Worktree",
				value: t.project_dir,
				taskId: t.id,
			},
			{
				type: "detail",
				label: "Attempts",
				value: `${t.attempts} / ${t.max_attempts}`,
				taskId: t.id,
			},
			{
				type: "detail",
				label: "Session",
				value: t.session_id,
				taskId: t.id,
			},
		];
		if (t.exit_code != null) {
			details.push({
				type: "detail",
				label: "Exit Code",
				value: `${t.exit_code}`,
				taskId: t.id,
			});
		}
		if (t.pr_number) {
			details.push({
				type: "detail",
				label: "PR",
				value: `#${t.pr_number}${t.review_status ? ` (${t.review_status})` : ""}`,
				taskId: t.id,
			});
		}
		// Port detection — only for running tasks (expensive operation)
		if (t.status === "running") {
			const ports = detectListeningPorts(t.project_dir);
			if (ports.length > 0) {
				details.push({
					type: "detail",
					label: "Ports",
					value: ports.map((p) => `${p.port} (${p.process})`).join(", "),
					taskId: t.id,
				});
			}
		}
		const gitInfo = this.getGitInfo(t.project_dir);
		if (gitInfo) {
			details.push({
				type: "detail",
				label: "Branch",
				value: gitInfo.branch,
				taskId: t.id,
			});
			details.push({
				type: "detail",
				label: "Last Commit",
				value: gitInfo.lastCommit,
				taskId: t.id,
			});
		}
		return details;
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

	private async getLastOutputLine(
		task: AgentTask,
	): Promise<string | undefined> {
		if (task.status !== "running") return undefined;
		if (!task.session_id || !isValidSessionId(task.session_id))
			return undefined;
		try {
			const { execFileSync } = await import("node:child_process");
			const output = execFileSync(
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
			const task = this.registry.tasks[element.taskId];
			if (task) return { type: "task", task };
		}
		// summary nodes are root-level, no parent
		return undefined;
	}

	/** Get the full task registry */
	getRegistry(): TaskRegistry {
		return this.registry;
	}

	/** Get tasks (for command handlers) */
	getTasks(): AgentTask[] {
		return Object.values(this.registry.tasks);
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
		item.iconPath = new vscode.ThemeIcon("info");
		item.contextValue = "agentSummary";
		return item;
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
		const description = `${task.project_name} · ${elapsedDesc}`;

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
		item.contextValue = `agentTask.${task.status}`;
		item.resourceUri = vscode.Uri.parse(`agent-task:${task.id}`);
		item.command = {
			command: "commandCentral.focusAgentTerminal",
			title: "Focus Terminal",
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
		for (const d of this.disposables) d.dispose();
	}
}
