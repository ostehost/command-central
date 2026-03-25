/**
 * AgentStatusBar — Shows agent count in the VS Code status bar
 *
 * Displays context-aware status with counts per state:
 * - Running: `$(pulse) 2 agents running`
 * - Mixed: `$(pulse) 1 running · 1 completed`
 * - All done: `$(check) 3 completed`
 * - Failed: `$(warning) 1 failed · 2 completed`
 *
 * Tooltip shows per-task markdown details. Clicking focuses the sidebar.
 */

import * as vscode from "vscode";
import type { AgentTask } from "../providers/agent-status-tree-provider.js";
import {
	countAgentStatuses,
	formatCountSummary,
} from "../utils/agent-counts.js";

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
		if (tasks.length === 0) {
			this.statusBarItem.hide();
			return;
		}

		const counts = countAgentStatuses(tasks);
		const summary = formatCountSummary(counts);

		// Determine icon and text
		if (counts.running > 0) {
			this.statusBarItem.text = `$(pulse) ${summary}`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else if (counts.failed > 0) {
			this.statusBarItem.text = `$(warning) ${summary}`;
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.errorBackground",
			);
		} else if (counts.stopped > 0) {
			this.statusBarItem.text = `$(debug-stop) ${summary}`;
			this.statusBarItem.backgroundColor = undefined;
		} else {
			this.statusBarItem.text = `$(check) ${summary}`;
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
