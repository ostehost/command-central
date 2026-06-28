import * as vscode from "vscode";
import type {
	AgentRole,
	AgentTask,
	AgentTaskStatus,
} from "../types/agent-task.js";

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
		case "paused":
			return new vscode.ThemeIcon(
				"debug-pause",
				new vscode.ThemeColor("charts.blue"),
			);
		default:
			return new vscode.ThemeIcon("circle-outline");
	}
}

export function getStatusDisplayLabel(status: AgentTaskStatus): string {
	switch (status) {
		case "completed_dirty":
			return "completed (dirty)";
		case "completed_stale":
			return "completed (stale)";
		case "contract_failure":
			return "contract failure";
		case "paused":
			return "paused";
		default:
			return status;
	}
}

export const ROLE_ICONS: Record<AgentRole, string> = {
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
export function formatDurationPrecise(
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
	// `paused` is non-terminal (no completed_at), so measure elapsed from the
	// original start, the same as `running`.
	if (task.status === "running" || task.status === "paused") {
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
		case "paused":
			// Non-terminal: parked and still ticking, like `running`. The
			// liveness-aware "parked" vs "ended" qualifier is layered on at the
			// tree-item level where the process-liveness probe is available.
			return `Paused for ${elapsed}`;
		default:
			return `Failed ${elapsed} ago`;
	}
}
