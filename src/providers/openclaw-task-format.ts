/**
 * Pure OpenClaw task projection + display helpers.
 *
 * These functions map an OpenClawTask into the agent-status model (status +
 * synthetic AgentTask), classify visibility/activity, and format the title,
 * duration, runtime icon, and audit labels shown in the tree. They were
 * extracted from AgentStatusTreeProvider, where they were stateless private
 * methods. No provider state is touched.
 */

import type { OpenClawTask } from "../types/openclaw-task-types.js";
import type {
	AgentTask,
	AgentTaskStatus,
} from "./agent-status-tree-provider.js";

export function mapOpenClawTaskToAgentStatus(
	task: OpenClawTask,
): AgentTaskStatus {
	switch (task.status) {
		case "queued":
		case "running":
			return "running";
		case "succeeded":
		case "cancelled":
			return "completed";
		case "blocked":
		case "failed":
		case "timed_out":
		case "lost":
			return "failed";
	}
}

export function toSyntheticOpenClawTask(task: OpenClawTask): AgentTask {
	const timestamp = task.startedAt ?? task.createdAt ?? Date.now();
	return {
		id: `openclaw-${task.taskId}`,
		status: mapOpenClawTaskToAgentStatus(task),
		project_dir: "",
		project_name: "Background Tasks",
		session_id: task.childSessionKey ?? task.taskId,
		bundle_path: "",
		prompt_file: "",
		started_at: new Date(timestamp).toISOString(),
		attempts: 0,
		max_attempts: 0,
		completed_at: task.endedAt ? new Date(task.endedAt).toISOString() : null,
		updated_at: task.lastEventAt
			? new Date(task.lastEventAt).toISOString()
			: null,
		error_message: task.error ?? null,
		prompt_summary: task.progressSummary ?? task.terminalSummary ?? null,
	};
}

export function isOpenClawTaskActive(task: OpenClawTask): boolean {
	return task.status === "queued" || task.status === "running";
}

export function isOpenClawTaskVisibleInRunningMode(
	task: OpenClawTask,
): boolean {
	return isOpenClawTaskActive(task);
}

export function getOpenClawTaskActivityTimeMs(task: OpenClawTask): number {
	return (
		task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt ?? 0
	);
}

export function getOpenClawTaskDisplayTitle(task: OpenClawTask): string {
	return task.label?.trim() || task.task.trim() || task.taskId;
}

export function formatOpenClawTaskDuration(task: OpenClawTask): string | null {
	const start = task.startedAt ?? task.createdAt;
	if (!start) return null;
	const end = task.endedAt ?? Date.now();
	const durationMs = Math.max(0, end - start);
	const totalMinutes = Math.floor(durationMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h`;
	return `${minutes}m`;
}

export function getOpenClawRuntimeIcon(
	runtime: OpenClawTask["runtime"],
): string {
	switch (runtime) {
		case "cron":
			return "clock";
		case "acp":
			return "hubot";
		case "subagent":
			return "organization";
		case "cli":
			return "terminal";
	}
}

export function formatOpenClawAuditStatusLabel(
	code: string,
	count: number,
): string {
	if (code === "stale_running") {
		return count === 1
			? "stale_running error detected"
			: "stale_running errors detected";
	}
	return count === 1 ? `${code} detected` : `${code} findings detected`;
}
