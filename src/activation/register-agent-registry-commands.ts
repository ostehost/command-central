/**
 * Agent registry mutation command registration — the tasks.json lifecycle
 * surface: capture/kill a single agent, clear completed entries, mark/reap
 * stale entries, remove a task, and mark a task reviewed.
 *
 * AgentStatusTreeProvider and TerminalManager are resettable module state in
 * extension.ts (cleared in deactivate()), so they are injected as getters and
 * dereferenced at invocation time — never captured by value at registration
 * time. The output channel is an activate()-local const created before
 * registration, so it is safe to pass by value.
 *
 * Every registry write routes through writeRegistryWithBackup /
 * mutateAgentTaskRegistry: re-read tasks.json immediately before persisting so
 * a registry changed after the command was clicked is not clobbered, and keep
 * a .bak of the pre-write contents.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { TerminalManager } from "../ghostty/TerminalManager.js";
import {
	type AgentStatusTreeProvider,
	type AgentTask,
	isValidSessionId,
} from "../providers/agent-status-tree-provider.js";
import {
	clearCompletedAgentEntries,
	countClearableAgentEntries,
	markTaskFailedInRegistryMap,
	markTasksFailedInRegistryMap,
	parseTaskRegistry,
	removeTaskFromRegistryMap,
	STALE_AGENT_STATUS_DESCRIPTION,
	serializeTaskRegistry,
} from "../utils/agent-task-registry.js";

export interface AgentRegistryCommandDeps {
	getAgentStatusProvider: () =>
		| Pick<
				AgentStatusTreeProvider,
				"filePath" | "reload" | "getStaleLauncherTasks" | "markTaskReviewed"
		  >
		| undefined;
	getTerminalManager: () =>
		| Pick<TerminalManager, "resolveLauncherHelperScriptPath">
		| undefined;
	agentOutputChannel: Pick<
		vscode.OutputChannel,
		"clear" | "appendLine" | "show"
	>;
}

const writeRegistryWithBackup = async (
	tasksFilePath: string,
	latestRaw: string,
	registry: { version: number; tasks: Record<string, unknown> },
): Promise<void> => {
	const fs = await import("node:fs");
	fs.writeFileSync(`${tasksFilePath}.bak`, latestRaw, "utf-8");
	fs.writeFileSync(tasksFilePath, serializeTaskRegistry(registry), "utf-8");
};

const mutateAgentTaskRegistry = async (
	tasksFilePath: string,
	mutateTasks: (tasks: Record<string, unknown>) => number,
): Promise<number> => {
	const fs = await import("node:fs");
	const initialRaw = fs.readFileSync(tasksFilePath, "utf-8");
	const initialRegistry = parseTaskRegistry(initialRaw);
	const initialUpdatedCount = mutateTasks(initialRegistry.tasks);
	if (initialUpdatedCount === 0) {
		return 0;
	}

	const latestRaw = fs.readFileSync(tasksFilePath, "utf-8");
	let updatedCount = initialUpdatedCount;
	const registryToWrite =
		latestRaw === initialRaw
			? initialRegistry
			: (() => {
					const latestRegistry = parseTaskRegistry(latestRaw);
					const latestUpdatedCount = mutateTasks(latestRegistry.tasks);
					if (latestUpdatedCount === 0) {
						return null;
					}
					updatedCount = latestUpdatedCount;
					return latestRegistry;
				})();

	if (!registryToWrite) {
		return 0;
	}

	await writeRegistryWithBackup(tasksFilePath, latestRaw, registryToWrite);
	return updatedCount;
};

/**
 * Register the seven agent registry mutation commands. Returns one disposable
 * per command; the caller owns their lifecycle.
 */
export function registerAgentRegistryCommands(
	deps: AgentRegistryCommandDeps,
): vscode.Disposable[] {
	const { getAgentStatusProvider, getTerminalManager, agentOutputChannel } =
		deps;
	return [
		vscode.commands.registerCommand(
			"commandCentral.captureAgentOutput",
			async (node?: { type: string; task?: { session_id: string } }) => {
				const sessionId = node?.task?.session_id;
				if (!sessionId) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}
				if (!isValidSessionId(sessionId)) {
					vscode.window.showErrorMessage("Invalid session ID.");
					return;
				}
				const tasksFilePath = getAgentStatusProvider()?.filePath;
				if (!tasksFilePath) {
					vscode.window.showErrorMessage(
						"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
					);
					return;
				}
				try {
					const { execFileSync } = await import("node:child_process");
					const terminalManager = getTerminalManager();
					if (!terminalManager) {
						throw new Error("Terminal manager is not initialized.");
					}
					const scriptPath =
						await terminalManager.resolveLauncherHelperScriptPath(
							"oste-capture.sh",
						);
					const output = execFileSync("bash", [scriptPath, sessionId], {
						encoding: "utf-8",
						env: {
							...process.env,
							TASKS_FILE: tasksFilePath,
						},
						timeout: 10000,
					});
					agentOutputChannel.clear();
					agentOutputChannel.appendLine(`=== Output: ${sessionId} ===`);
					agentOutputChannel.appendLine(output);
					agentOutputChannel.show(true);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Failed to capture output: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.killAgent",
			async (node?: {
				type: string;
				task?: { id: string; session_id: string };
				agent?: { pid: number; projectDir: string };
			}) => {
				const task = node?.task;
				const agent = node?.agent;

				// Discovered agent: kill by PID
				if (agent) {
					const label = path.basename(agent.projectDir);
					const confirm = await vscode.window.showWarningMessage(
						`Kill discovered agent "${label}" (PID ${agent.pid})?`,
						{ modal: true },
						"Kill",
					);
					if (confirm !== "Kill") return;
					try {
						process.kill(agent.pid, "SIGTERM");
						getAgentStatusProvider()?.reload();
						vscode.window.showInformationMessage(
							`Agent "${label}" (PID ${agent.pid}) sent SIGTERM.`,
						);
					} catch (err) {
						vscode.window.showErrorMessage(
							`Failed to kill agent: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}

				// Launcher task: kill via oste-kill.sh script
				if (!task) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}
				if (!isValidSessionId(task.session_id)) {
					vscode.window.showErrorMessage("Invalid session ID.");
					return;
				}
				const tasksFilePath = getAgentStatusProvider()?.filePath;
				if (!tasksFilePath) {
					vscode.window.showErrorMessage(
						"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
					);
					return;
				}
				const confirm = await vscode.window.showWarningMessage(
					`Kill agent "${task.id}"?`,
					{ modal: true },
					"Kill",
				);
				if (confirm !== "Kill") return;
				try {
					const { execFileSync } = await import("node:child_process");
					const terminalManager = getTerminalManager();
					if (!terminalManager) {
						throw new Error("Terminal manager is not initialized.");
					}
					const scriptPath =
						await terminalManager.resolveLauncherHelperScriptPath(
							"oste-kill.sh",
						);
					execFileSync("bash", [scriptPath, task.session_id], {
						encoding: "utf-8",
						env: {
							...process.env,
							TASKS_FILE: tasksFilePath,
						},
						timeout: 10000,
					});
					getAgentStatusProvider()?.reload();
					vscode.window.showInformationMessage(`Agent "${task.id}" killed.`);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Failed to kill agent: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.clearCompletedAgents",
			async () => {
				const tasksFilePath = getAgentStatusProvider()?.filePath;
				if (!tasksFilePath) {
					vscode.window.showErrorMessage(
						"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
					);
					return;
				}

				try {
					const fs = await import("node:fs");
					const initialRaw = fs.readFileSync(tasksFilePath, "utf-8");
					const initialRegistry = parseTaskRegistry(initialRaw);
					const initialTerminalCount = countClearableAgentEntries(
						initialRegistry.tasks,
					);

					if (initialTerminalCount === 0) {
						vscode.window.showInformationMessage(
							"No completed agent entries to remove.",
						);
						return;
					}

					const confirm = await vscode.window.showWarningMessage(
						`Remove ${initialTerminalCount} completed agent ${initialTerminalCount === 1 ? "entry" : "entries"}?`,
						{ modal: true },
						"Remove",
					);
					if (confirm !== "Remove") return;

					const latestRaw = fs.readFileSync(tasksFilePath, "utf-8");
					const registryToWrite =
						latestRaw === initialRaw
							? initialRegistry
							: parseTaskRegistry(latestRaw);
					const removedCount = clearCompletedAgentEntries(
						registryToWrite.tasks,
					);

					if (removedCount === 0) {
						vscode.window.showInformationMessage(
							"No completed agent entries to remove.",
						);
						return;
					}

					await writeRegistryWithBackup(
						tasksFilePath,
						latestRaw,
						registryToWrite,
					);

					getAgentStatusProvider()?.reload();
					vscode.window.showInformationMessage(
						`Removed ${removedCount} completed agent ${removedCount === 1 ? "entry" : "entries"}.`,
					);
				} catch (err) {
					if (err instanceof SyntaxError) {
						vscode.window.showErrorMessage(
							"Failed to clear completed agents: tasks.json is malformed.",
						);
						return;
					}
					vscode.window.showErrorMessage(
						`Failed to clear completed agents: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.markStaleAgentFailed",
			async (node?: { type: string; task?: AgentTask }) => {
				const task = node?.task;
				if (!task) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}
				if (task.status !== "completed_stale") {
					vscode.window.showInformationMessage(
						`Agent "${task.id}" is not marked stale.`,
					);
					return;
				}

				const tasksFilePath = getAgentStatusProvider()?.filePath;
				if (!tasksFilePath) {
					vscode.window.showErrorMessage(
						"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
					);
					return;
				}

				try {
					const updatedCount = await mutateAgentTaskRegistry(
						tasksFilePath,
						(tasks) =>
							markTaskFailedInRegistryMap(
								tasks,
								task.id,
								STALE_AGENT_STATUS_DESCRIPTION,
							)
								? 1
								: 0,
					);

					if (updatedCount === 0) {
						vscode.window.showInformationMessage(
							`Agent "${task.id}" is already updated.`,
						);
						return;
					}

					getAgentStatusProvider()?.reload();
					vscode.window.showInformationMessage(
						`Marked stale agent "${task.id}" as failed.`,
					);
				} catch (err) {
					if (err instanceof SyntaxError) {
						vscode.window.showErrorMessage(
							"Failed to update stale agent: tasks.json is malformed.",
						);
						return;
					}
					vscode.window.showErrorMessage(
						`Failed to update stale agent: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.reapStaleAgents",
			async () => {
				const tasksFilePath = getAgentStatusProvider()?.filePath;
				if (!tasksFilePath) {
					vscode.window.showErrorMessage(
						"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
					);
					return;
				}

				const staleTasks =
					getAgentStatusProvider()?.getStaleLauncherTasks() ?? [];
				if (staleTasks.length === 0) {
					vscode.window.showInformationMessage("No stale agents found.");
					return;
				}

				const confirm = await vscode.window.showWarningMessage(
					`Found ${staleTasks.length} stale ${staleTasks.length === 1 ? "agent" : "agents"}. Mark as failed?`,
					{ modal: true },
					"Mark as Failed",
				);
				if (confirm !== "Mark as Failed") return;

				try {
					const staleTaskIds = staleTasks.map((task) => task.id);
					const updatedCount = await mutateAgentTaskRegistry(
						tasksFilePath,
						(tasks) =>
							markTasksFailedInRegistryMap(
								tasks,
								staleTaskIds,
								STALE_AGENT_STATUS_DESCRIPTION,
							),
					);

					if (updatedCount === 0) {
						vscode.window.showInformationMessage("No stale agents found.");
						return;
					}

					getAgentStatusProvider()?.reload();
					vscode.window.showInformationMessage(
						`Marked ${updatedCount} stale ${updatedCount === 1 ? "agent" : "agents"} as failed.`,
					);
				} catch (err) {
					if (err instanceof SyntaxError) {
						vscode.window.showErrorMessage(
							"Failed to reap stale agents: tasks.json is malformed.",
						);
						return;
					}
					vscode.window.showErrorMessage(
						`Failed to reap stale agents: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.removeAgentTask",
			async (node?: { type: string; task?: AgentTask }) => {
				const task = node?.task;
				if (!task) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}

				const tasksFilePath = getAgentStatusProvider()?.filePath;
				if (!tasksFilePath) {
					vscode.window.showErrorMessage(
						"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
					);
					return;
				}

				try {
					const fs = await import("node:fs");
					const initialRaw = fs.readFileSync(tasksFilePath, "utf-8");
					const initialRegistry = parseTaskRegistry(initialRaw);

					if (!removeTaskFromRegistryMap(initialRegistry.tasks, task.id)) {
						vscode.window.showInformationMessage(
							`Agent "${task.id}" is already removed.`,
						);
						return;
					}

					// Race-safe write: re-read before persisting to avoid clobbering
					// unrelated changes made after the command was clicked.
					const latestRaw = fs.readFileSync(tasksFilePath, "utf-8");
					const registryToWrite =
						latestRaw === initialRaw
							? initialRegistry
							: (() => {
									const latestRegistry = parseTaskRegistry(latestRaw);
									if (
										!removeTaskFromRegistryMap(latestRegistry.tasks, task.id)
									) {
										return null;
									}
									return latestRegistry;
								})();

					if (!registryToWrite) {
						vscode.window.showInformationMessage(
							`Agent "${task.id}" is already removed.`,
						);
						return;
					}

					await writeRegistryWithBackup(
						tasksFilePath,
						latestRaw,
						registryToWrite,
					);

					getAgentStatusProvider()?.reload();
					vscode.window.showInformationMessage(`Removed agent "${task.id}".`);
				} catch (err) {
					if (err instanceof SyntaxError) {
						vscode.window.showErrorMessage(
							"Failed to remove agent: tasks.json is malformed.",
						);
						return;
					}
					vscode.window.showErrorMessage(
						`Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.markAgentReviewed",
			(node?: { type: string; task?: AgentTask }) => {
				const task = node?.task;
				if (!task) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}
				getAgentStatusProvider()?.markTaskReviewed(task.id);
			},
		),
	];
}
