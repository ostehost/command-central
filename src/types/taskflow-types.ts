import * as vscode from "vscode";

export interface TaskFlow {
	flowId: string;
	label?: string;
	status: TaskFlowStatus;
	agentId?: string;
	parentSessionKey?: string;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	taskCount: number;
	completedCount: number;
	failedCount: number;
	cancelIntent?: boolean;
	error?: string;
}

/**
 * Flow-level statuses derived from the CLI `--status` filter values.
 * The CLI accepts: queued, running, waiting, blocked, succeeded, failed, cancelled, lost.
 */
export type TaskFlowStatus =
	| "queued"
	| "running"
	| "waiting"
	| "blocked"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "lost";

export function taskflowStatusToIcon(status: TaskFlowStatus): vscode.ThemeIcon {
	switch (status) {
		case "queued":
			return new vscode.ThemeIcon(
				"loading~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "running":
			return new vscode.ThemeIcon(
				"pulse",
				new vscode.ThemeColor("charts.blue"),
			);
		case "waiting":
			return new vscode.ThemeIcon(
				"watch",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "blocked":
			return new vscode.ThemeIcon(
				"shield",
				new vscode.ThemeColor("charts.yellow"),
			);
		case "succeeded":
			return new vscode.ThemeIcon(
				"check",
				new vscode.ThemeColor("charts.green"),
			);
		case "failed":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		case "cancelled":
			return new vscode.ThemeIcon(
				"circle-slash",
				new vscode.ThemeColor("descriptionForeground"),
			);
		case "lost":
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.yellow"),
			);
	}
}

export function taskflowStatusToLabel(status: TaskFlowStatus): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "running":
			return "Running";
		case "waiting":
			return "Waiting";
		case "blocked":
			return "Blocked";
		case "succeeded":
			return "Succeeded";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
		case "lost":
			return "Lost";
	}
}

export function isTerminalFlowStatus(status: TaskFlowStatus): boolean {
	switch (status) {
		case "succeeded":
		case "failed":
		case "cancelled":
		case "lost":
			return true;
		default:
			return false;
	}
}
