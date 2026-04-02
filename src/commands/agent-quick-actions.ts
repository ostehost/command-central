import type { AgentTaskStatus } from "../providers/agent-status-tree-provider.js";
import type { OpenClawTaskStatus } from "../types/openclaw-task-types.js";

export type AgentQuickActionId =
	| "resumeSession"
	| "viewDiff"
	| "showOutput"
	| "focusTerminal"
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
	completed_stale: ["viewDiff", "showOutput", "focusTerminal", "restart"],
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
