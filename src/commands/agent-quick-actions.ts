import { execFileSync } from "node:child_process";
import type { AgentTaskStatus } from "../providers/agent-status-tree-provider.js";
import type { OpenClawTaskStatus } from "../types/openclaw-task-types.js";

export type AgentQuickActionId =
	| "resumeSession"
	| "viewDiff"
	| "showOutput"
	| "focusTerminal"
	| "markFailed"
	| "restart"
	| "remove";

export interface AgentQuickActionDefinition {
	id: string;
	label: string;
	command: string;
}

export type OpenClawQuickActionId = "cancel" | "showDetails";

const QUICK_ACTIONS: Record<AgentQuickActionId, AgentQuickActionDefinition> = {
	resumeSession: {
		id: "resumeSession",
		label: "Resume Session",
		command: "commandCentral.resumeAgentSession",
	},
	viewDiff: {
		id: "viewDiff",
		label: "View Diff",
		command: "commandCentral.viewAgentDiff",
	},
	showOutput: {
		id: "showOutput",
		label: "Show Output",
		command: "commandCentral.showAgentOutput",
	},
	focusTerminal: {
		id: "focusTerminal",
		label: "Focus Terminal",
		command: "commandCentral.focusAgentTerminal",
	},
	markFailed: {
		id: "markFailed",
		label: "Mark as Failed",
		command: "commandCentral.markStaleAgentFailed",
	},
	restart: {
		id: "restart",
		label: "Restart",
		command: "commandCentral.restartAgent",
	},
	remove: {
		id: "remove",
		label: "Remove",
		command: "commandCentral.removeAgentTask",
	},
};

const STATUS_ACTIONS: Partial<Record<AgentTaskStatus, AgentQuickActionId[]>> = {
	completed: ["viewDiff", "showOutput", "focusTerminal", "restart"],
	completed_dirty: ["viewDiff", "showOutput", "focusTerminal", "restart"],
	completed_stale: [
		"viewDiff",
		"showOutput",
		"focusTerminal",
		"markFailed",
		"restart",
	],
	failed: ["showOutput", "viewDiff", "restart", "remove"],
	contract_failure: ["showOutput", "viewDiff", "restart", "remove"],
	stopped: ["showOutput", "viewDiff", "restart", "remove"],
	killed: ["showOutput", "viewDiff", "restart", "remove"],
};

const OPENCLAW_QUICK_ACTIONS: Record<
	OpenClawQuickActionId,
	AgentQuickActionDefinition
> = {
	cancel: {
		id: "cancel",
		label: "Cancel Task",
		command: "commandCentral.cancelOpenClawTask",
	},
	showDetails: {
		id: "showDetails",
		label: "Show Details",
		command: "commandCentral.showOpenClawTaskDetail",
	},
};

const OPENCLAW_STATUS_ACTIONS: Record<
	OpenClawTaskStatus,
	OpenClawQuickActionId[]
> = {
	queued: ["cancel", "showDetails"],
	running: ["cancel", "showDetails"],
	succeeded: ["showDetails"],
	failed: ["showDetails"],
	timed_out: ["showDetails"],
	cancelled: ["showDetails"],
	lost: ["showDetails"],
	blocked: ["showDetails"],
};

export function getAgentQuickActions(
	status: AgentTaskStatus,
	hasResumeSession: boolean,
): AgentQuickActionDefinition[] {
	const base = STATUS_ACTIONS[status] ?? [];
	const ids =
		hasResumeSession && status !== "running"
			? (["resumeSession", ...base] as AgentQuickActionId[])
			: base;
	return ids.map((id) => QUICK_ACTIONS[id]);
}

export function getOpenClawTaskQuickActions(
	status: OpenClawTaskStatus,
): AgentQuickActionDefinition[] {
	return OPENCLAW_STATUS_ACTIONS[status].map(
		(id) => OPENCLAW_QUICK_ACTIONS[id],
	);
}

// ── ACP task quick actions ────────────────────────────────────────────

export type AcpQuickActionId = "cancelAcp" | "showDetails";

const ACP_QUICK_ACTIONS: Record<AcpQuickActionId, AgentQuickActionDefinition> =
	{
		cancelAcp: {
			id: "cancelAcp",
			label: "Cancel Task",
			command: "commandCentral.cancelAcpTask",
		},
		showDetails: {
			id: "showDetails",
			label: "Show Details",
			command: "commandCentral.showOpenClawTaskDetail",
		},
	};

const ACP_STATUS_ACTIONS: Partial<
	Record<OpenClawTaskStatus, AcpQuickActionId[]>
> = {
	queued: ["cancelAcp", "showDetails"],
	running: ["cancelAcp", "showDetails"],
	succeeded: ["showDetails"],
	failed: ["showDetails"],
	timed_out: ["showDetails"],
	cancelled: ["showDetails"],
	lost: ["showDetails"],
	blocked: ["showDetails"],
};

/**
 * Get quick actions for an ACP-runtime OpenClaw task.
 * Cancel is only offered for active (queued/running) tasks.
 *
 * @param runtime - Must be "acp"; returns empty array for other runtimes.
 */
export function getAcpTaskQuickActions(
	status: OpenClawTaskStatus,
	runtime: string,
): AgentQuickActionDefinition[] {
	if (runtime !== "acp") return [];
	const ids = ACP_STATUS_ACTIONS[status] ?? ["showDetails"];
	return ids.map((id) => ACP_QUICK_ACTIONS[id]);
}

/**
 * Synchronously cancel an ACP task.
 * Only call this when `runtime === "acp"`.
 */
export function cancelAcpTask(taskId: string): void {
	execFileSync("openclaw", ["tasks", "cancel", taskId]);
}
