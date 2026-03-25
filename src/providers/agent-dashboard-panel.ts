/**
 * AgentDashboardPanel — Rich webview dashboard for agent monitoring
 *
 * Shows a visual grid of agent cards with summary counts, status badges,
 * git branch info, elapsed time, and role icons. Auto-updates when
 * connected to the tree provider's refresh events.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { countAgentStatuses } from "../utils/agent-counts.js";
import type { AgentTask } from "./agent-status-tree-provider.js";

// ── Types ────────────────────────────────────────────────────────────

export interface GitInfo {
	branch: string;
	lastCommit: string;
}

export interface GitInfoProvider {
	getGitInfo(projectDir: string): GitInfo | null;
}

// ── Constants ────────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
	running: "🔄",
	completed: "✅",
	failed: "❌",
	stopped: "⏹️",
	killed: "💀",
};

const ROLE_ICONS: Record<string, string> = {
	planner: "🔬",
	developer: "🔨",
	reviewer: "🔍",
	test: "🧪",
};

// ── HTML Helpers ─────────────────────────────────────────────────────

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function formatElapsed(startedAt: string): string {
	const start = new Date(startedAt).getTime();
	const now = Date.now();
	const diffMs = now - start;
	const diffMin = Math.floor(diffMs / 60000);
	const diffHr = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHr / 24);

	if (diffDay > 0) return `${diffDay}d ${diffHr % 24}h`;
	if (diffHr > 0) return `${diffHr}h ${diffMin % 60}m`;
	return `${diffMin}m`;
}

// ── Panel ────────────────────────────────────────────────────────────

export class AgentDashboardPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private disposables: vscode.Disposable[] = [];
	private gitInfoProvider: GitInfoProvider | undefined;

	get isVisible(): boolean {
		return this.panel !== undefined;
	}

	setGitInfoProvider(provider: GitInfoProvider): void {
		this.gitInfoProvider = provider;
	}

	show(tasks: Record<string, AgentTask>): void {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				"agentDashboard",
				"Agent Dashboard",
				vscode.ViewColumn.One,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(
				() => {
					this.panel = undefined;
				},
				null,
				this.disposables,
			);
		}
		this.panel.webview.html = this.getHtml(tasks);
		this.panel.reveal();
	}

	update(tasks: Record<string, AgentTask>): void {
		if (this.panel) {
			this.panel.webview.html = this.getHtml(tasks);
		}
	}

	getHtml(tasks: Record<string, AgentTask>): string {
		const taskList = Object.values(tasks);
		const counts = countAgentStatuses(taskList);
		const running: AgentTask[] = [];
		const completed: AgentTask[] = [];
		const failed: AgentTask[] = [];
		const stopped: AgentTask[] = [];
		for (const task of taskList) {
			switch (task.status) {
				case "running":
					running.push(task);
					break;
				case "completed":
				case "completed_stale":
					completed.push(task);
					break;
				case "failed":
				case "killed":
				case "contract_failure":
					failed.push(task);
					break;
				case "stopped":
					stopped.push(task);
					break;
			}
		}

		const emptyMessage =
			taskList.length === 0
				? '<p class="empty">No agents tracked yet.</p>'
				: "";

		const summaryHtml =
			taskList.length > 0
				? `<div class="summary">
			<div class="summary-item"><div class="summary-count">${taskList.length}</div><div class="summary-label">Total</div></div>
			<div class="summary-item"><div class="summary-count" style="color:var(--vscode-charts-blue)">${counts.running}</div><div class="summary-label">Running</div></div>
			<div class="summary-item"><div class="summary-count" style="color:var(--vscode-charts-green)">${counts.completed}</div><div class="summary-label">Completed</div></div>
			<div class="summary-item"><div class="summary-count" style="color:var(--vscode-charts-red)">${counts.failed}</div><div class="summary-label">Failed</div></div>
			<div class="summary-item"><div class="summary-count" style="color:var(--vscode-charts-yellow)">${counts.stopped}</div><div class="summary-label">Stopped</div></div>
		</div>`
				: "";

		return `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
.card.running { border-left: 3px solid var(--vscode-charts-blue); }
.card.completed { border-left: 3px solid var(--vscode-charts-green); }
.card.failed { border-left: 3px solid var(--vscode-charts-red); }
.card.stopped, .card.killed { border-left: 3px solid var(--vscode-charts-yellow); }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.card-title { font-weight: bold; font-size: 14px; }
.status-badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; }
.status-badge.running { background: var(--vscode-charts-blue); color: white; }
.status-badge.completed { background: var(--vscode-charts-green); color: white; }
.status-badge.failed { background: var(--vscode-charts-red); color: white; }
.status-badge.stopped, .status-badge.killed { background: var(--vscode-charts-yellow); color: black; }
.detail { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 4px 0; }
.summary { display: flex; gap: 16px; margin-bottom: 16px; padding: 12px; background: var(--vscode-sideBar-background); border-radius: 6px; }
.summary-item { text-align: center; }
.summary-count { font-size: 24px; font-weight: bold; }
.summary-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
h1 { font-size: 20px; margin-bottom: 12px; }
h2 { font-size: 16px; margin: 16px 0 8px; }
</style>
</head>
<body>
<h1>Agent Dashboard</h1>
${summaryHtml}
${emptyMessage}
${running.length > 0 ? `<h2>Running</h2><div class="grid">${running.map((t) => this.renderCard(t)).join("")}</div>` : ""}
${completed.length > 0 ? `<h2>Completed</h2><div class="grid">${completed.map((t) => this.renderCard(t)).join("")}</div>` : ""}
${failed.length > 0 ? `<h2>Failed</h2><div class="grid">${failed.map((t) => this.renderCard(t)).join("")}</div>` : ""}
${stopped.length > 0 ? `<h2>Stopped</h2><div class="grid">${stopped.map((t) => this.renderCard(t)).join("")}</div>` : ""}
</body>
</html>`;
	}

	private renderCard(task: AgentTask): string {
		const statusIcon = STATUS_ICONS[task.status] ?? "❓";
		const roleIcon =
			task.role && ROLE_ICONS[task.role] ? `${ROLE_ICONS[task.role]} ` : "";
		const projectName = task.project_dir ? path.basename(task.project_dir) : "";
		const elapsed = task.started_at ? formatElapsed(task.started_at) : "";

		let gitHtml = "";
		if (this.gitInfoProvider && task.project_dir) {
			const gitInfo = this.gitInfoProvider.getGitInfo(task.project_dir);
			if (gitInfo) {
				gitHtml = `<div class="detail">Branch: ${escapeHtml(gitInfo.branch)}</div>`;
			}
		}

		return `<div class="card ${escapeHtml(task.status)}">
	<div class="card-header">
		<span class="card-title">${statusIcon} ${roleIcon}${escapeHtml(task.id)}</span>
		<span class="status-badge ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
	</div>
	${projectName ? `<div class="detail">Project: ${escapeHtml(projectName)}</div>` : ""}
	${elapsed ? `<div class="detail">Elapsed: ${escapeHtml(elapsed)}</div>` : ""}
	${gitHtml}
</div>`;
	}

	dispose(): void {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
