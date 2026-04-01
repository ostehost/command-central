import * as vscode from "vscode";

export interface OpenClawTask {
	taskId: string;
	runtime: "acp" | "subagent" | "cron" | "cli";
	sourceId?: string;
	ownerKey: string;
	scopeKind: string;
	childSessionKey?: string;
	parentTaskId?: string;
	agentId?: string;
	runId?: string;
	label?: string;
	task: string;
	status:
		| "queued"
		| "running"
		| "succeeded"
		| "failed"
		| "timed_out"
		| "cancelled"
		| "lost"
		| "blocked";
	deliveryStatus: string;
	notifyPolicy: string;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	lastEventAt?: number;
	cleanupAfter?: number;
	error?: string;
	progressSummary?: string;
	terminalSummary?: string;
	terminalOutcome?: string;
}

export type OpenClawTaskStatus = OpenClawTask["status"];

export function isTerminalStatus(status: OpenClawTaskStatus): boolean {
	switch (status) {
		case "succeeded":
		case "failed":
		case "timed_out":
		case "cancelled":
		case "lost":
		case "blocked":
			return true;
		default:
			return false;
	}
}

export function openclawStatusToIcon(
	status: OpenClawTaskStatus,
): vscode.ThemeIcon {
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
		case "succeeded":
			return new vscode.ThemeIcon(
				"check",
				new vscode.ThemeColor("charts.green"),
			);
		case "failed":
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		case "timed_out":
			return new vscode.ThemeIcon("watch", new vscode.ThemeColor("charts.red"));
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
		case "blocked":
			return new vscode.ThemeIcon(
				"shield",
				new vscode.ThemeColor("charts.yellow"),
			);
	}
}

export function openclawStatusToLabel(status: OpenClawTaskStatus): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "running":
			return "Running";
		case "succeeded":
			return "Done";
		case "failed":
			return "Failed";
		case "timed_out":
			return "Timed Out";
		case "cancelled":
			return "Cancelled";
		case "lost":
			return "Lost";
		case "blocked":
			return "Needs Approval";
	}
}
