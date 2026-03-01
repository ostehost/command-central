/**
 * AgentStatusTreeProvider - TreeView provider for Ghostty launcher agent status
 *
 * Reads a JSON task registry (tasks.json) and displays agent tasks in a tree:
 * - Root items: task ID + status + project name + time elapsed
 * - Child items: prompt file, worktree path, attempt count, PR info
 *
 * Watches the file for changes and auto-refreshes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/** Validate tmux session name to prevent shell injection */
export function isValidTmuxSession(name: string): boolean {
	return /^[a-zA-Z0-9._-]+$/.test(name);
}

// ── Task registry types ──────────────────────────────────────────────

export interface TaskRegistry {
	version: number;
	tasks: Record<string, AgentTask>;
}

export interface AgentTask {
	id: string;
	status: "running" | "stopped" | "killed" | "completed" | "failed";
	project_dir: string;
	project_name: string;
	tmux_session: string;
	bundle_path: string;
	prompt_file: string;
	started_at: string;
	attempts: number;
	max_attempts: number;
	pr_number?: number | null;
	review_status?: "pending" | "approved" | "changes_requested" | null;
}

// ── Tree node types ──────────────────────────────────────────────────

export type AgentNode = TaskNode | DetailNode;

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

// ── Status icon mapping ──────────────────────────────────────────────

const STATUS_ICONS: Record<AgentTask["status"], string> = {
	running: "🔄",
	completed: "✅",
	failed: "❌",
	stopped: "⏹️",
	killed: "💀",
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

// ── Provider ─────────────────────────────────────────────────────────

export class AgentStatusTreeProvider
	implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<
		AgentNode | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private registry: TaskRegistry = { version: 1, tasks: {} };
	private fileWatcher: vscode.FileSystemWatcher | null = null;
	private _filePath: string | null = null;
	private disposables: vscode.Disposable[] = [];
	private debounceTimer: NodeJS.Timeout | null = null;

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
		const p = config.get<string>("agentTasksFile");
		if (!p) return null;
		// Expand ~ to home dir
		if (p.startsWith("~")) {
			const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
			return path.join(home, p.slice(1));
		}
		return p;
	}

	private setupFileWatch(): void {
		if (this.fileWatcher) {
			this.fileWatcher.dispose();
			this.fileWatcher = null;
		}

		// Clear existing debounce timer before setting up new watcher
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		const filePath = this.getConfiguredPath();
		this._filePath = filePath;
		if (!filePath) return;

		// Use vscode.workspace.createFileSystemWatcher — handles create/change/delete natively
		const pattern = new vscode.RelativePattern(
			vscode.Uri.file(path.dirname(filePath)),
			path.basename(filePath),
		);
		this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

		const debouncedReload = () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				this.reload();
			}, 150);
		};

		this.disposables.push(
			this.fileWatcher.onDidChange(debouncedReload),
			this.fileWatcher.onDidCreate(debouncedReload),
			this.fileWatcher.onDidDelete(debouncedReload),
		);
	}

	reload(): void {
		this.registry = this.readRegistry();
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Exposed for testing — override to inject mock data */
	readRegistry(): TaskRegistry {
		if (!this._filePath) return { version: 1, tasks: {} };
		try {
			const content = fs.readFileSync(this._filePath, "utf-8");
			const parsed = JSON.parse(content) as TaskRegistry;
			if (parsed.version === 1 && parsed.tasks) return parsed;
			return { version: 1, tasks: {} };
		} catch {
			return { version: 1, tasks: {} };
		}
	}

	getTreeItem(element: AgentNode): vscode.TreeItem {
		if (element.type === "task") {
			return this.createTaskItem(element.task);
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		if (!element) {
			// Root level: all tasks sorted by started_at desc
			return Object.values(this.registry.tasks)
				.sort(
					(a, b) =>
						new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
				)
				.map((task) => ({ type: "task" as const, task }));
		}

		if (element.type === "task") {
			const t = element.task;
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
					label: "tmux",
					value: t.tmux_session,
					taskId: t.id,
				},
			];
			if (t.pr_number) {
				details.push({
					type: "detail",
					label: "PR",
					value: `#${t.pr_number}${t.review_status ? ` (${t.review_status})` : ""}`,
					taskId: t.id,
				});
			}
			return details;
		}

		return [];
	}

	getParent(element: AgentNode): AgentNode | undefined {
		if (element.type === "detail") {
			const task = this.registry.tasks[element.taskId];
			if (task) return { type: "task", task };
		}
		return undefined;
	}

	/** Get tasks (for command handlers) */
	getTasks(): AgentTask[] {
		return Object.values(this.registry.tasks);
	}

	private createTaskItem(task: AgentTask): vscode.TreeItem {
		const icon = STATUS_ICONS[task.status] || "❓";
		const elapsed = formatElapsed(task.started_at);
		const label = `${icon} ${task.id}`;
		const description = `${task.project_name} · ${task.status} · ${elapsed}`;

		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = description;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${task.id}** — ${task.status}`,
				`Project: ${task.project_name}`,
				`Dir: \`${task.project_dir}\``,
				`Started: ${task.started_at}`,
				`Attempts: ${task.attempts}/${task.max_attempts}`,
				task.pr_number ? `PR: #${task.pr_number}` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.contextValue = `agentTask.${task.status}`;
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
		if (this.fileWatcher) this.fileWatcher.dispose();
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		for (const d of this.disposables) d.dispose();
	}
}
