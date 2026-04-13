import type { AgentTask } from "../providers/agent-status-tree-provider.js";

type TaskTerminalRoutingTask = Pick<
	AgentTask,
	"session_id" | "tmux_conf" | "tmux_socket" | "tmux_window_id" | "tmux_pane_id"
>;

function normalizeTarget(value?: string | null): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function resolveTaskWindowTarget(
	task: TaskTerminalRoutingTask,
): string | null {
	return (
		normalizeTarget(task.tmux_window_id) ?? normalizeTarget(task.session_id)
	);
}

export function resolveTaskInputTarget(
	task: TaskTerminalRoutingTask,
): string | null {
	return normalizeTarget(task.tmux_pane_id) ?? resolveTaskWindowTarget(task);
}

export function buildTaskTmuxArgs(
	task: Pick<TaskTerminalRoutingTask, "tmux_conf" | "tmux_socket">,
	args: string[],
): string[] {
	const commandArgs: string[] = [];
	const tmuxConf = normalizeTarget(task.tmux_conf);
	const tmuxSocket = normalizeTarget(task.tmux_socket);

	if (tmuxConf) {
		commandArgs.push("-f", tmuxConf);
	}
	if (tmuxSocket) {
		commandArgs.push("-S", tmuxSocket);
	}

	commandArgs.push(...args);
	return commandArgs;
}

export function buildTaskTmuxAttachCommand(
	task: Pick<
		TaskTerminalRoutingTask,
		"session_id" | "tmux_conf" | "tmux_socket"
	>,
): string[] {
	return [
		"tmux",
		...buildTaskTmuxArgs(task, ["attach", "-t", task.session_id]),
	];
}
