import type { AgentTaskStatus } from "../providers/agent-status-tree-provider.js";
import type { OpenClawTaskStatus } from "../types/openclaw-task-types.js";

export type AgentQuickActionId =
	| "resumeSession"
	| "viewTranscript"
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

export interface AgentQuickActionOptions {
	hasResumeSession?: boolean;
	hasTerminalFocusSurface?: boolean;
	includeAdvancedActions?: boolean;
}

export type OpenClawQuickActionId = "cancel" | "showDetails";

const QUICK_ACTIONS: Record<AgentQuickActionId, AgentQuickActionDefinition> = {
	resumeSession: {
		id: "resumeSession",
		label: "Resume Claude Session…",
		command: "commandCentral.resumeAgentSession",
	},
	viewTranscript: {
		id: "viewTranscript",
		label: "View Conversation Transcript",
		command: "commandCentral.viewAgentTranscript",
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
	completed: ["viewTranscript", "viewDiff", "showOutput"],
	completed_dirty: ["viewTranscript", "viewDiff", "showOutput"],
	completed_stale: ["viewTranscript", "viewDiff", "showOutput", "markFailed"],
	failed: ["viewTranscript", "showOutput", "viewDiff", "remove"],
	contract_failure: ["viewTranscript", "showOutput", "viewDiff", "remove"],
	stopped: ["viewTranscript", "showOutput", "viewDiff", "remove"],
	killed: ["viewTranscript", "showOutput", "viewDiff", "remove"],
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
	options: AgentQuickActionOptions | boolean,
): AgentQuickActionDefinition[] {
	const normalizedOptions: AgentQuickActionOptions =
		typeof options === "boolean" ? { hasResumeSession: options } : options;
	const base = STATUS_ACTIONS[status] ?? [];
	const ids: AgentQuickActionId[] = [];
	if (normalizedOptions.hasTerminalFocusSurface && status !== "running") {
		ids.push("focusTerminal");
	}
	ids.push(...base);
	if (normalizedOptions.includeAdvancedActions && status !== "running") {
		if (normalizedOptions.hasResumeSession) ids.push("resumeSession");
		if (STATUS_ACTIONS[status]) ids.push("restart");
	}
	return ids.map((id) => QUICK_ACTIONS[id]);
}

export function getOpenClawTaskQuickActions(
	status: OpenClawTaskStatus,
): AgentQuickActionDefinition[] {
	return OPENCLAW_STATUS_ACTIONS[status].map(
		(id) => OPENCLAW_QUICK_ACTIONS[id],
	);
}
