/**
 * Git Sort command registration — sort toggling, view refresh, file filter,
 * and the Explorer-like tree-view utility commands.
 *
 * Every dependency that lives as resettable module state in extension.ts
 * (gitSorter, projectViewManager, extensionFilterViewManager, and especially
 * the late-constructed terminalManager) is injected as a getter and
 * dereferenced at invocation time. Capturing terminalManager by value at
 * registration time would freeze it as undefined forever: it is constructed
 * long after these commands register, and openInIntegratedTerminal degrades
 * silently to the integrated terminal when the manager is missing.
 */

import * as vscode from "vscode";
import * as disableSortCommand from "../commands/disable-sort.js";
import * as enableSortCommand from "../commands/enable-sort.js";
import {
	compareWithSelected,
	copyPath,
	copyRelativePath,
	openInIntegratedTerminal,
	openPreview,
	openToSide,
	openWith,
	revealInExplorer,
	revealInFinder,
	selectForCompare,
} from "../commands/tree-view-utils.js";
import type { TerminalManager } from "../ghostty/TerminalManager.js";
import type { GitSorter } from "../git-sort/scm-sorter.js";
import type { SortedGitChangesProvider } from "../git-sort/sorted-changes-provider.js";
import type { ExtensionFilterViewManager } from "../providers/extension-filter-view-manager.js";
import type { ExtensionFilterState } from "../services/extension-filter-state.js";
import type { ProjectViewManager } from "../services/project-view-manager.js";
import type { ILoggerService } from "../types/service-interfaces.js";
import type { GitChangeItem } from "../types/tree-element.js";

export interface GitSortCommandDeps {
	getGitSorter: () => GitSorter | undefined;
	getProjectViewManager: () => ProjectViewManager | undefined;
	extensionFilterState: ExtensionFilterState;
	getExtensionFilterViewManager: () => ExtensionFilterViewManager | undefined;
	getTerminalManager: () => TerminalManager | undefined;
	logger: ILoggerService;
}

/**
 * Register the eighteen non-slot commandCentral.gitSort.* commands. Returns
 * one disposable per command; the caller owns their lifecycle. The slot
 * variants (gitSort.*.slotN[Panel]) are owned by ProjectViewManager.
 */
export function registerGitSortCommands(
	deps: GitSortCommandDeps,
): vscode.Disposable[] {
	const {
		getGitSorter,
		getProjectViewManager,
		extensionFilterState,
		getExtensionFilterViewManager,
		getTerminalManager,
		logger,
	} = deps;
	return [
		vscode.commands.registerCommand(
			"commandCentral.gitSort.enable",
			async () => {
				const gitSorter = getGitSorter();
				if (gitSorter) {
					await enableSortCommand.execute(gitSorter);
					await gitSorter.activate();
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.disable",
			async () => {
				const gitSorter = getGitSorter();
				if (gitSorter) {
					await disableSortCommand.execute(gitSorter);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.refreshView",
			(viewIdOrTreeView?: string | vscode.TreeView<unknown>) => {
				logger.info("🔄 Refresh view command invoked");

				const projectViewManager = getProjectViewManager();
				let provider: SortedGitChangesProvider | undefined;

				// Strategy 1: View ID passed as string
				if (typeof viewIdOrTreeView === "string" && projectViewManager) {
					provider = projectViewManager.getProviderByViewId(viewIdOrTreeView);
				}
				// Strategy 2: TreeView object passed
				else if (
					viewIdOrTreeView &&
					typeof viewIdOrTreeView === "object" &&
					projectViewManager
				) {
					provider =
						projectViewManager.getProviderForTreeView(viewIdOrTreeView);
				}
				// Strategy 3: Find any visible view provider
				else if (projectViewManager) {
					provider = projectViewManager.getAnyVisibleProvider();
				}

				if (!provider) {
					logger.error("❌ No provider found for refresh");
					return;
				}

				logger.debug("✅ Refreshing view");
				provider.refresh();
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.changeSortOrder",
			async (viewIdOrTreeView?: string | vscode.TreeView<unknown>) => {
				logger.info("🔄 Sort order command invoked");
				logger.debug(
					`Argument received - type: ${typeof viewIdOrTreeView}, value: ${JSON.stringify(viewIdOrTreeView)}`,
				);

				const projectViewManager = getProjectViewManager();
				let provider: SortedGitChangesProvider | undefined;

				// Strategy 1: View ID passed as string (from package.json args)
				if (typeof viewIdOrTreeView === "string" && projectViewManager) {
					logger.debug(`Using view ID: "${viewIdOrTreeView}"`);
					provider = projectViewManager.getProviderByViewId(viewIdOrTreeView);
				}
				// Strategy 2: TreeView object passed (VS Code View Actions)
				// Check if it's actually a TreeView by looking for expected properties
				else if (
					viewIdOrTreeView &&
					typeof viewIdOrTreeView === "object" &&
					"visible" in viewIdOrTreeView &&
					"title" in viewIdOrTreeView &&
					projectViewManager
				) {
					logger.debug(
						`TreeView object passed - visible: ${viewIdOrTreeView.visible}, title: ${viewIdOrTreeView.title}`,
					);
					provider =
						projectViewManager.getProviderForTreeView(viewIdOrTreeView);
				}
				// Strategy 3: Find any visible view provider (fallback)
				else if (projectViewManager) {
					logger.debug("No valid argument, searching for visible provider...");
					provider = projectViewManager.getAnyVisibleProvider();
				}

				if (!provider) {
					logger.error("❌ No provider found for sort order change");
					vscode.window.showErrorMessage(
						"Could not change sort order: No active view found",
					);
					return;
				}

				logger.debug("✅ Provider found");

				// Direct toggle - no dialog
				const currentOrder = provider.getSortOrder();
				const newOrder = currentOrder === "newest" ? "oldest" : "newest";

				logger.info(`Changing sort order: ${currentOrder} → ${newOrder}`);

				provider.setSortOrder(newOrder);
				// Title is updated automatically by refresh() in setSortOrder

				// Minimal status bar message with correct arrow convention
				const sortIcon = newOrder === "newest" ? "▼" : "▲";

				// Show brief notification
				vscode.window.setStatusBarMessage(`Sorted ${sortIcon}`, 2000);
				logger.info(`✅ Sort order changed to ${newOrder}`);
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.changeFileFilter",
			async () => {
				// Delegate to extension filter command module
				const filterCommand = await import(
					"../commands/filter-by-extension-command.js"
				);
				const extensionFilterViewManager = getExtensionFilterViewManager();
				if (!extensionFilterViewManager) {
					logger.error("Extension filter view manager not initialized");
					return;
				}
				await filterCommand.execute(
					getProjectViewManager(),
					extensionFilterState,
					logger,
					extensionFilterViewManager,
				);
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.openChange",
			async (item: GitChangeItem) => {
				// Validate item has URI
				if (!item?.uri) {
					logger.error("openChange called with invalid item (no URI)");
					return;
				}

				// Find provider for this file's workspace
				const provider = getProjectViewManager()?.getProviderForFile(item.uri);

				if (!provider) {
					logger.error(`No provider found for file: ${item.uri.fsPath}`);
					vscode.window.showErrorMessage(
						"Could not open file: No workspace found for this file",
					);
					return;
				}

				// Open change using the correct provider
				await provider.openChange(item);
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.openFile",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await vscode.commands.executeCommand("vscode.open", item.uri);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.openDiff",
			async (item: GitChangeItem) => {
				// Validate item has URI
				if (!item?.uri) {
					logger.error("openDiff called with invalid item (no URI)");
					return;
				}

				// Find provider for this file's workspace
				const provider = getProjectViewManager()?.getProviderForFile(item.uri);

				if (!provider) {
					logger.error(`No provider found for file: ${item.uri.fsPath}`);
					vscode.window.showErrorMessage(
						"Could not open diff: No workspace found for this file",
					);
					return;
				}

				// Delegate to the provider's openChange method
				// which has proper multi-root workspace git URI handling
				await provider.openChange(item);
			},
		),

		// Tree View Utility Commands (Explorer-like functionality)
		vscode.commands.registerCommand(
			"commandCentral.gitSort.revealInExplorer",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await revealInExplorer(item);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.copyPath",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await copyPath(item);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.copyRelativePath",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await copyRelativePath(item);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.openToSide",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await openToSide(item);
				}
			},
		),

		// File Comparison Commands (Explorer-like workflow)
		vscode.commands.registerCommand(
			"commandCentral.gitSort.selectForCompare",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await selectForCompare(item);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.compareWithSelected",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await compareWithSelected(item);
				}
			},
		),

		// OS File Manager Integration
		vscode.commands.registerCommand(
			"commandCentral.gitSort.revealInFinder",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await revealInFinder(item);
				}
			},
		),

		// Terminal Integration
		vscode.commands.registerCommand(
			"commandCentral.gitSort.openInIntegratedTerminal",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await openInIntegratedTerminal(item, getTerminalManager());
				}
			},
		),

		// Editor Selection Commands
		vscode.commands.registerCommand(
			"commandCentral.gitSort.openWith",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await openWith(item);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.gitSort.openPreview",
			async (item: GitChangeItem) => {
				if (item?.uri) {
					await openPreview(item);
				}
			},
		),
	];
}
