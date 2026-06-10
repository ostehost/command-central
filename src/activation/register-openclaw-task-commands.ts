/**
 * OpenClaw background task command registration — cancel a task via the
 * OpenClawTaskService and show a task's full detail JSON (fetched from the
 * `openclaw` CLI) in a dedicated output channel.
 *
 * The task service and output channel are activate()-local consts created
 * before registration, so they are safe to pass by value. The
 * AgentStatusTreeProvider is resettable module state in extension.ts (cleared
 * in deactivate()), so it is injected as a getter and dereferenced at
 * invocation time.
 */

import * as vscode from "vscode";
import type { AgentStatusTreeProvider } from "../providers/agent-status-tree-provider.js";
import type { OpenClawTaskService } from "../services/openclaw-task-service.js";

export interface OpenClawTaskCommandDeps {
	openclawTaskService: Pick<OpenClawTaskService, "cancelTask">;
	getAgentStatusProvider: () =>
		| Pick<AgentStatusTreeProvider, "reload">
		| undefined;
	openclawTaskOutputChannel: Pick<
		vscode.OutputChannel,
		"clear" | "appendLine" | "show"
	>;
}

// Lazy dynamic imports keep node:child_process off the activation path; never
// promisify(execFile) at module scope (process-global bun mock hazard).
const execFileAsync = async (
	command: string,
	args: string[],
	timeout = 4000,
): Promise<{ stdout: string; stderr: string }> => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	return promisify(execFile)(command, args, { timeout });
};

/**
 * Register the two OpenClaw background task commands. Returns one disposable
 * per command; the caller owns their lifecycle.
 */
export function registerOpenClawTaskCommands(
	deps: OpenClawTaskCommandDeps,
): vscode.Disposable[] {
	const {
		openclawTaskService,
		getAgentStatusProvider,
		openclawTaskOutputChannel,
	} = deps;
	return [
		vscode.commands.registerCommand(
			"commandCentral.cancelOpenClawTask",
			async (node?: {
				type: string;
				task?: { taskId: string; label?: string; status: string };
			}) => {
				const task = node?.task;
				if (!task) {
					vscode.window.showWarningMessage(
						"No background task selected. Right-click a task in the tree.",
					);
					return;
				}

				try {
					await openclawTaskService.cancelTask(task.taskId);
					getAgentStatusProvider()?.reload();
					vscode.window.showInformationMessage(
						`Cancelled background task ${task.label ?? task.taskId}.`,
					);
				} catch (error) {
					vscode.window.showErrorMessage(
						`Failed to cancel background task: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.showOpenClawTaskDetail",
			async (node?: { type: string; task?: { taskId: string } }) => {
				const task = node?.task;
				if (!task) {
					vscode.window.showWarningMessage(
						"No background task selected. Right-click a task in the tree.",
					);
					return;
				}

				try {
					const { stdout } = await execFileAsync("openclaw", [
						"tasks",
						"show",
						task.taskId,
						"--json",
					]);
					let formatted = stdout.trim();
					try {
						formatted = JSON.stringify(JSON.parse(stdout), null, 2);
					} catch {
						// Show raw stdout if the CLI returns non-JSON text.
					}
					openclawTaskOutputChannel.clear();
					openclawTaskOutputChannel.appendLine(formatted);
					openclawTaskOutputChannel.show(true);
				} catch (error) {
					vscode.window.showErrorMessage(
						`Failed to load background task details: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			},
		),
	];
}
