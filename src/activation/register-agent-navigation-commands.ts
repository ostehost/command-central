/**
 * Agent navigation / filter / info command registration — the read-mostly
 * Agent Status surface: dashboard, single-click default action, tree focus +
 * refresh, discovery diagnostics, project icon, grouping toggles, project
 * filters, next-running jump, directory reveal, and worktree listing.
 *
 * AgentStatusTreeProvider and TerminalManager are resettable module state in
 * extension.ts (cleared in deactivate()), so they are injected as getters and
 * dereferenced at invocation time — never captured by value at registration
 * time. The dashboard panel, icon manager, diagnostics channel, and context
 * sync closure are activate()-local consts created before registration, so
 * they are safe to pass by value.
 *
 * Terminal focus / resume core (focusAgentTerminal, resumeAgentSession,
 * agentQuickActions, showAgentOutput, restartAgent, launchAgent) stays in
 * extension.ts; the commands here only route to it via executeCommand.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { parseWorktreeListPorcelain } from "../discovery/worktree-list.js";
import { refreshGhosttyBundleAfterProjectIconChange } from "../ghostty/project-icon-bundle-refresh.js";
import type { TerminalManager } from "../ghostty/TerminalManager.js";
import type { AgentDashboardPanel } from "../providers/agent-dashboard-panel.js";
import type {
	AgentStatusTreeProvider,
	AgentTask,
	ProjectGroupNode,
} from "../providers/agent-status-tree-provider.js";
import { hasFirstClassTerminalFocusSurface } from "../providers/agent-status-tree-provider.js";
import type { LoggerService } from "../services/logger-service.js";
import type { ProjectIconManager } from "../services/project-icon-manager.js";

export interface AgentNavigationCommandDeps {
	getAgentStatusProvider: () =>
		| Pick<
				AgentStatusTreeProvider,
				| "getDisplayRegistryTasks"
				| "getTasks"
				| "reload"
				| "getDiscoveryDiagnosticsReport"
				| "projectFilter"
				| "filterToProject"
				| "filterToCurrentProject"
				| "getKnownProjectDirs"
		  >
		| undefined;
	getTerminalManager: () =>
		| Pick<TerminalManager, "isLauncherInstalled" | "createProjectTerminal">
		| undefined;
	projectIconManager: Pick<
		ProjectIconManager,
		"getIconForProject" | "setCustomIcon"
	>;
	agentDashboardPanel: Pick<AgentDashboardPanel, "show">;
	discoveryDiagnosticsChannel: Pick<
		vscode.OutputChannel,
		"clear" | "appendLine" | "show"
	>;
	syncAgentStatusViewContexts: () => Promise<void>;
	logger: Pick<LoggerService, "warn">;
}

const isValidProjectIconInput = (value: string): boolean => {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (/\p{Extended_Pictographic}/u.test(trimmed)) return true;
	const length = [...trimmed].length;
	return length >= 1 && length <= 2;
};

/**
 * Register the fifteen agent navigation / filter / info commands. Returns one
 * disposable per command; the caller owns their lifecycle.
 */
export function registerAgentNavigationCommands(
	deps: AgentNavigationCommandDeps,
): vscode.Disposable[] {
	const {
		getAgentStatusProvider,
		getTerminalManager,
		projectIconManager,
		agentDashboardPanel,
		discoveryDiagnosticsChannel,
		syncAgentStatusViewContexts,
		logger,
	} = deps;
	return [
		vscode.commands.registerCommand("commandCentral.openAgentDashboard", () => {
			agentDashboardPanel.show(
				getAgentStatusProvider()?.getDisplayRegistryTasks() ?? {},
			);
		}),
		// Default single-click action for agent tree items.
		// Focus terminal is first-class whenever the row carries authoritative
		// terminal surface metadata; rows without a focusable surface still open
		// diff/review rather than rattling a stale History entry.
		vscode.commands.registerCommand(
			"commandCentral.defaultAgentAction",
			async (node?: {
				type: string;
				task?: AgentTask;
				agent?: { projectDir: string; sessionId?: string };
			}) => {
				const task = node?.task;
				if (!task) {
					if (node?.agent) {
						await vscode.commands.executeCommand(
							"commandCentral.focusAgentTerminal",
							node,
						);
					}
					return;
				}

				if (
					task.status === "running" ||
					hasFirstClassTerminalFocusSurface(task)
				) {
					await vscode.commands.executeCommand(
						"commandCentral.focusAgentTerminal",
						node,
					);
					return;
				}

				// Non-running without focusable terminal truth: show diff/review.
				await vscode.commands.executeCommand(
					"commandCentral.viewAgentDiff",
					node,
				);
			},
		),
		vscode.commands.registerCommand("commandCentral.agentStatus.focus", () => {
			// Focus the agent status tree view by focusing its container
			vscode.commands.executeCommand("workbench.view.extension.commandCentral");
		}),
		vscode.commands.registerCommand("commandCentral.refreshAgentStatus", () => {
			getAgentStatusProvider()?.reload();
		}),
		vscode.commands.registerCommand(
			"commandCentral.showDiscoveryDiagnostics",
			() => {
				const agentStatusProvider = getAgentStatusProvider();
				if (!agentStatusProvider) return;
				discoveryDiagnosticsChannel.clear();
				discoveryDiagnosticsChannel.appendLine(
					agentStatusProvider.getDiscoveryDiagnosticsReport(),
				);
				discoveryDiagnosticsChannel.show(true);
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.changeProjectIcon",
			async (node?: ProjectGroupNode) => {
				if (!node) {
					vscode.window.showWarningMessage(
						"No project selected. Right-click a project group in the tree.",
					);
					return;
				}

				const projectDir = node.projectDir || node.tasks[0]?.project_dir;
				if (!projectDir) {
					vscode.window.showErrorMessage(
						"Unable to determine project directory for this group.",
					);
					return;
				}

				const currentIcon = projectIconManager.getIconForProject(projectDir);
				const input = await vscode.window.showInputBox({
					title: "Change Project Icon",
					prompt: `Set icon for ${node.projectName}`,
					placeHolder: "e.g. 🚀 or AI",
					value: currentIcon,
					validateInput: (value) =>
						isValidProjectIconInput(value)
							? undefined
							: "Enter an emoji, or a 1-2 character short icon.",
				});
				if (input == null) return;

				const nextIcon = input.trim();
				if (!isValidProjectIconInput(nextIcon)) {
					vscode.window.showErrorMessage(
						"Icon must be an emoji, or a 1-2 character short icon.",
					);
					return;
				}

				await projectIconManager.setCustomIcon(projectDir, nextIcon);
				await refreshGhosttyBundleAfterProjectIconChange(projectDir, {
					terminalManager: getTerminalManager(),
					logger,
					showWarningMessage: (message) =>
						vscode.window.showWarningMessage(message),
				});
				await getAgentStatusProvider()?.reload();
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.toggleProjectGrouping",
			async () => {
				const config = vscode.workspace.getConfiguration("commandCentral");
				const current = config.get<boolean>("agentStatus.groupByProject", true);
				await config.update(
					"agentStatus.groupByProject",
					!current,
					vscode.ConfigurationTarget.Global,
				);
				await syncAgentStatusViewContexts();
				getAgentStatusProvider()?.reload();
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.toggleProjectGroupingFlat",
			async () => {
				await vscode.commands.executeCommand(
					"commandCentral.toggleProjectGrouping",
				);
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.filterToProject",
			(node?: ProjectGroupNode) => {
				const agentStatusProvider = getAgentStatusProvider();
				if (!node || !agentStatusProvider) return;
				const projectDir =
					node.projectDir || node.tasks[0]?.project_dir || node.projectName;
				// Toggle: if already filtering this project, clear the filter
				if (agentStatusProvider.projectFilter === projectDir) {
					agentStatusProvider.filterToProject(null);
				} else {
					agentStatusProvider.filterToProject(projectDir);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.filterCurrentProject",
			() => {
				getAgentStatusProvider()?.filterToCurrentProject();
			},
		),
		vscode.commands.registerCommand("commandCentral.clearProjectFilter", () => {
			getAgentStatusProvider()?.filterToProject(null);
		}),
		vscode.commands.registerCommand(
			"commandCentral.selectProjectFilter",
			async () => {
				const agentStatusProvider = getAgentStatusProvider();
				if (!agentStatusProvider) return;
				const projectDirs = agentStatusProvider.getKnownProjectDirs();
				if (projectDirs.length === 0) {
					vscode.window.showInformationMessage("No agent projects found.");
					return;
				}
				const items = [
					{
						label: "$(close) Show All Projects",
						projectDir: null as string | null,
					},
					...projectDirs.map((dir) => ({
						label: `$(folder) ${path.basename(dir)}`,
						description: dir,
						projectDir: dir as string | null,
					})),
				];
				const pick = await vscode.window.showQuickPick(items, {
					placeHolder: "Select a project to filter by",
				});
				if (pick) {
					agentStatusProvider.filterToProject(pick.projectDir);
				}
			},
		),
		// Jump to Next Running Agent
		vscode.commands.registerCommand(
			"commandCentral.focusNextRunningAgent",
			async () => {
				const tasks = getAgentStatusProvider()?.getTasks() ?? [];
				const running = tasks.find((t) => t.status === "running");
				if (running) {
					await vscode.commands.executeCommand(
						"commandCentral.focusAgentTerminal",
						{ type: "task" as const, task: running },
					);
				} else {
					vscode.window.showInformationMessage("No running agents");
				}
			},
		),
		// Open Agent Directory — reveals project dir in OS file manager
		vscode.commands.registerCommand(
			"commandCentral.openAgentDirectory",
			async (node?: { type: string; task?: AgentTask }) => {
				const task = node?.task;
				if (!task?.project_dir) {
					vscode.window.showWarningMessage(
						"No agent selected. Right-click an agent in the tree.",
					);
					return;
				}
				const uri = vscode.Uri.file(task.project_dir);
				await vscode.commands.executeCommand("revealFileInOS", uri);
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.listWorktrees",
			async () => {
				const folders = vscode.workspace.workspaceFolders;
				if (!folders || folders.length === 0) {
					vscode.window.showWarningMessage("No workspace folder open.");
					return;
				}

				let workspaceFolder: vscode.WorkspaceFolder | undefined;
				const activeUri = vscode.window.activeTextEditor?.document.uri;
				if (activeUri) {
					workspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
				}
				if (!workspaceFolder && folders.length === 1) {
					workspaceFolder = folders[0];
				}
				if (!workspaceFolder && folders.length > 1) {
					workspaceFolder = await vscode.window.showWorkspaceFolderPick({
						placeHolder: "Select a workspace to list git worktrees",
					});
				}
				if (!workspaceFolder) return;

				try {
					const { execFile } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const execFileAsync = promisify(execFile);
					const { stdout } = await execFileAsync(
						"git",
						[
							"-C",
							workspaceFolder.uri.fsPath,
							"worktree",
							"list",
							"--porcelain",
						],
						{
							encoding: "utf-8",
							timeout: 3_000,
						},
					);
					const worktrees = parseWorktreeListPorcelain(stdout);
					if (worktrees.length === 0) {
						vscode.window.showInformationMessage(
							"No git worktrees found for this workspace.",
						);
						return;
					}

					const picked = await vscode.window.showQuickPick(
						worktrees.map((worktree) => ({
							label: worktree.branch,
							description: worktree.path,
							worktree,
						})),
						{
							placeHolder: "Select a worktree to open",
						},
					);
					if (!picked) return;

					await vscode.commands.executeCommand(
						"vscode.openFolder",
						vscode.Uri.file(picked.worktree.path),
						true,
					);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Failed to list git worktrees: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		),
	];
}
