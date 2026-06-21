import type { AgentTask } from "../providers/agent-status-tree-provider.js";
import { hasFirstClassTerminalFocusSurface } from "../providers/agent-status-tree-provider.js";
import { buildTaskTmuxAttachCommand } from "./task-terminal-routing.js";

export type AgentActionKind =
	| "focusTerminal"
	| "viewTranscript"
	| "showOutput"
	| "viewDiff"
	| "resumeSession";

export type AgentActionSurface = "vscode" | "discord" | "chat" | "cli";
export type AgentActionMode = "execute" | "dryRun" | "command";

export interface AgentActionRequest {
	action: AgentActionKind;
	target: {
		taskId?: string;
		laneRef?: string;
		runId?: string;
		sessionId?: string;
		projectRef?: string;
		issueIdentifier?: string;
	};
	surface: AgentActionSurface;
	mode?: AgentActionMode;
	correlationId?: string;
}

export interface AgentActionResponse {
	ok: boolean;
	status: "wouldExecute" | "needsRemoteHost" | "ambiguous" | "unavailable";
	resolvedTarget?: {
		taskId: string;
		projectDir?: string;
		execHost?: string;
		execNode?: string;
	};
	terminal?: {
		backend?: string;
		sessionId?: string;
		tmuxSocket?: string;
		tmuxWindowId?: string;
		tmuxPaneId?: string;
		ghosttyBundleId?: string;
		bundlePath?: string;
		attachAvailable?: boolean | null;
		live?: boolean | null;
	};
	command?: {
		argv: string[];
		shell?: string;
		runOnHost?: string;
	};
	message: string;
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function taskMatchesRequest(
	task: AgentTask,
	request: AgentActionRequest,
): boolean {
	const target = request.target;
	const taskRecord = task as AgentTask & Record<string, unknown>;
	const provenance =
		typeof task.provenance === "object" && task.provenance !== null
			? (task.provenance as Record<string, unknown>)
			: {};
	return Boolean(
		(target.taskId && task.id === target.taskId) ||
			(target.sessionId && task.session_id === target.sessionId) ||
			(target.projectRef &&
				(task.project_ref?.id === target.projectRef ||
					task.project_id === target.projectRef ||
					task.project_dir === target.projectRef)) ||
			(target.laneRef &&
				(taskRecord["source_ref"] === target.laneRef ||
					provenance["source_ref"] === target.laneRef)) ||
			(target.issueIdentifier && task.work_item_ref === target.issueIdentifier),
	);
}

function resolveTask(
	request: AgentActionRequest,
	tasks: Record<string, AgentTask>,
): AgentTask[] {
	return Object.values(tasks).filter((task) =>
		taskMatchesRequest(task, request),
	);
}

function terminalEnvelope(task: AgentTask): AgentActionResponse["terminal"] {
	return {
		backend: nonEmpty(task.terminal_backend),
		sessionId: nonEmpty(task.session_id),
		tmuxSocket: nonEmpty(task.tmux_socket),
		tmuxWindowId: nonEmpty(task.tmux_window_id),
		tmuxPaneId: nonEmpty(task.tmux_pane_id),
		ghosttyBundleId: nonEmpty(task.ghostty_bundle_id),
		bundlePath: nonEmpty(task.bundle_path),
		attachAvailable:
			typeof task.launcher_attach_available === "boolean"
				? task.launcher_attach_available
				: null,
		live: typeof task.session_live === "boolean" ? task.session_live : null,
	};
}

function resolvedTarget(
	task: AgentTask,
): NonNullable<AgentActionResponse["resolvedTarget"]> {
	return {
		taskId: task.id,
		projectDir: nonEmpty(task.project_dir),
		execHost: nonEmpty(task.exec_host),
		execNode: nonEmpty(task.exec_node),
	};
}

export function resolveAgentActionRequest(
	request: AgentActionRequest,
	tasks: Record<string, AgentTask>,
): AgentActionResponse {
	const matches = resolveTask(request, tasks);
	if (matches.length === 0) {
		return {
			ok: false,
			status: "unavailable",
			message: "No matching agent task was found for that target.",
		};
	}
	if (matches.length > 1) {
		return {
			ok: false,
			status: "ambiguous",
			message: `Target matched ${matches.length} agent tasks; pass a taskId to disambiguate.`,
		};
	}

	const task = matches[0];
	if (!task) {
		return {
			ok: false,
			status: "unavailable",
			message: "No matching agent task was found for that target.",
		};
	}

	const base = {
		resolvedTarget: resolvedTarget(task),
		terminal: terminalEnvelope(task),
	};

	if (request.action !== "focusTerminal") {
		return {
			ok: true,
			status: "wouldExecute",
			...base,
			message: `${request.action} is resolvable for ${task.id}.`,
		};
	}

	if (!hasFirstClassTerminalFocusSurface(task)) {
		return {
			ok: false,
			status: "unavailable",
			...base,
			message: `Task ${task.id} does not expose focusable terminal state.`,
		};
	}

	const execHost = nonEmpty(task.exec_host);
	const localSurface =
		request.surface === "vscode" || request.surface === "cli";
	if (!localSurface && execHost && execHost !== "hub") {
		return {
			ok: false,
			status: "needsRemoteHost",
			...base,
			message: `Task ${task.id} runs on ${execHost}; ask that host to focus the terminal.`,
		};
	}

	const sessionId = nonEmpty(task.session_id);
	return {
		ok: true,
		status: "wouldExecute",
		...base,
		command: sessionId
			? {
					argv: buildTaskTmuxAttachCommand({
						session_id: sessionId,
						tmux_conf: task.tmux_conf,
						tmux_socket: task.tmux_socket,
					}),
					runOnHost: execHost,
				}
			: undefined,
		message: sessionId
			? `Focus terminal for ${task.id}.`
			: `Focus terminal for ${task.id} via available bundle/window metadata.`,
	};
}
