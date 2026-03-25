/**
 * AgentStatusBar — Shows agent count in the VS Code status bar
 *
 * Displays context-aware status with counts per state:
 * - Running: `$(pulse) 2 agents running`
 * - Mixed: `$(pulse) 1 running · 1 completed`
 * - All done: `$(check) 3 agents completed`
 * - Failed: `$(warning) 1 failed · 2 completed`
 *
 * Tooltip shows per-task markdown details. Clicking focuses the sidebar.
 */

import * as vscode from "vscode";
import type { AgentTask } from "../providers/agent-status-tree-provider.js";

const STATUS_ICON: Record<AgentTask["status"], string> = {
	running: "$(pulse)",
	completed: "$(check)",
	completed_stale: "$(check-all)",
	failed: "$(warning)",
	contract_failure: "$(alert)",
	stopped: "$(debug-stop)",
	killed: "$(close)",
};

function truncateForTooltip(value: string, max = 48): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export class AgentStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			50,
		);
		this.statusBarItem.command = "commandCentral.agentStatus.focus";
	}

	update(tasks: AgentTask[]): void {
		const total = tasks.length;

		if (total === 0) {
			this.statusBarItem.hide();
			return;
		}

		const running = tasks.filter((t) => t.status === "running").length;
		const completed = tasks.filter(
			(t) =>
				t.status === "completed" ||
				t.status === "completed_stale" ||
				t.status === "stopped",
		).length;
		const failed = tasks.filter(
			(t) =>
				t.status === "failed" ||
				t.status === "killed" ||
				t.status === "contract_failure",
		).length;

		// Determine icon and text
		if (running > 0) {
			const parts = [`${running} running`];
			if (completed > 0) parts.push(`${completed} completed`);
			if (failed > 0) parts.push(`${failed} failed`);
			this.statusBarItem.text = `$(pulse) ${parts.join(" · ")}`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else if (failed > 0) {
			const parts = [`${failed} failed`];
			if (completed > 0) parts.push(`${completed} completed`);
			this.statusBarItem.text = `$(warning) ${parts.join(" · ")}`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.errorBackground",
			);
		} else {
			this.statusBarItem.text = `$(check) ${total} agent${total !== 1 ? "s" : ""} completed`;
			this.statusBarItem.backgroundColor = undefined;
		}

		// Markdown tooltip with per-task details
		const lines = tasks.map((t) => {
			const project = truncateForTooltip(t.project_name || "(unknown project)");
			return `- **${t.id}** (${project}): ${STATUS_ICON[t.status] ?? "$(question)"} ${t.status}`;
		});
		this.statusBarItem.tooltip = new vscode.MarkdownString(lines.join("\n"));

		this.statusBarItem.show();
	}

	dispose(): void {
		this.statusBarItem.dispose();
	}
}
