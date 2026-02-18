/**
 * Command Central Extension - Mission Control for AI
 * A Swiss Army knife VS Code extension with multiple features
 */

import * as vscode from "vscode";
import * as configureProjectCommand from "./commands/configure-project-command.js";
import * as disableSortCommand from "./commands/disable-sort.js";
import * as enableSortCommand from "./commands/enable-sort.js";
import * as launchCommand from "./commands/launch-command.js";
import * as launchHereCommand from "./commands/launch-here-command.js";
import * as launchTerminalCommand from "./commands/launch-terminal-command.js";
import * as launchWorkspaceCommand from "./commands/launch-workspace-command.js";
import * as listLaunchersCommand from "./commands/list-launchers-command.js";
import * as removeAllLaunchersCommand from "./commands/remove-all-launchers-command.js";
import * as removeLauncherCommand from "./commands/remove-launcher-command.js";
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
} from "./commands/tree-view-utils.js";
import { GitSorter } from "./git-sort/scm-sorter.js";
import type { SortedGitChangesProvider } from "./git-sort/sorted-changes-provider.js";
import { ExtensionFilterViewManager } from "./providers/extension-filter-view-manager.js";
import { GroupingStateManager } from "./services/grouping-state-manager.js";
import { LoggerService, LogLevel } from "./services/logger-service.js";
import { ProjectIconService } from "./services/project-icon-service.js";
import { ProjectViewManager } from "./services/project-view-manager.js";
import { TerminalLauncherService } from "./services/terminal-launcher-service.js";
import { CommandCentralTerminalLinkProvider } from "./terminal/terminal-link-provider.js";
import type { GitChangeItem } from "./types/tree-element.js";
import { GroupingViewManager } from "./ui/grouping-view-manager.js";

let gitSorter: GitSorter | undefined;
let projectViewManager: ProjectViewManager | undefined;
let terminalService: TerminalLauncherService | undefined;
let projectIconService: ProjectIconService | undefined;
let extensionFilterViewManager: ExtensionFilterViewManager | undefined;
let groupingStateManager: GroupingStateManager | undefined;
let groupingViewManager: GroupingViewManager | undefined;
let mainLogger: LoggerService;
let gitSortLogger: LoggerService;
let terminalLogger: LoggerService;

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	const start = performance.now();

	try {
		// Create output channels for different features
		mainLogger = new LoggerService("Command Central", LogLevel.INFO);
		gitSortLogger = new LoggerService(
			"Command Central: Git Sort",
			LogLevel.INFO,
		);
		terminalLogger = new LoggerService(
			"Command Central: Terminal",
			LogLevel.INFO,
		);

		// Enable DEBUG logging for extension filter if requested
		// Set via: DEBUG_FILTER=1 bun run scripts-v2/dev.ts
		// Or use: just debug-filter
		if (process.env["DEBUG_FILTER"] === "1") {
			mainLogger.setLogLevel(LogLevel.DEBUG);
			mainLogger.info(
				"🔍 DEBUG_FILTER enabled - verbose filter logging active",
			);
		}

		// Get version from package.json
		const packageJson = context.extension.packageJSON;
		const version = packageJson?.version || "unknown";

		mainLogger.info(`Extension starting... (v${version})`);
		mainLogger.info(`Command Central v${version}`);

		// Initialize Terminal Service
		// We need to create SecurityService and ProcessManager for TerminalLauncherService
		const { SecurityService } = await import("./security/security-service.js");
		const { ProcessManager } = await import("./utils/process-manager.js");

		const securityService = new SecurityService(
			vscode.workspace,
			vscode.window,
			terminalLogger.getOutputChannel(),
		);
		const processManager = new ProcessManager();

		terminalService = new TerminalLauncherService(
			securityService,
			processManager,
			vscode.workspace,
			vscode.window,
			context.extensionPath, // For bundled launcher resources
		);

		// Initialize Project Icon Service
		projectIconService = new ProjectIconService(mainLogger, context);
		mainLogger.info("Project icon service initialized");

		// Initialize Git Sorter
		gitSorter = new GitSorter(gitSortLogger);

		// Storage now created per-provider in ProjectProviderFactory (Phase 2)

		// ============================================================================
		// ARCHITECTURE: Dependency Injection Composition Root
		// ============================================================================
		//
		// Workspace-driven project views with dynamic auto-discovery
		// Each workspace folder automatically gets its own view
		//
		// Future Phase 2: Per-project providers with separate git repositories
		// ============================================================================

		// Layer 1: Configuration Source (workspace folder auto-discovery)
		const { WorkspaceProjectSource } = await import(
			"./config/workspace-project-source.js"
		);
		const configSource = new WorkspaceProjectSource(gitSortLogger);

		// Layer 2: Provider Factory (per-project providers with isolated storage)
		const { ProjectProviderFactory } = await import(
			"./factories/provider-factory.js"
		);
		// Initialize Extension Filter State with persistence
		const { ExtensionFilterState } = await import(
			"./services/extension-filter-state.js"
		);
		const filterConfig = vscode.workspace.getConfiguration(
			"commandCentral.fileFilter",
		);
		const persistenceMode = filterConfig.get<"workspace" | "global" | "none">(
			"persistence",
			"workspace",
		);
		const extensionFilterState = new ExtensionFilterState(
			context,
			persistenceMode,
			mainLogger,
		);
		mainLogger.info(
			`Extension filter state initialized (persistence: ${persistenceMode})`,
		);

		// Initialize Grouping State Manager (BEFORE creating providers)
		groupingStateManager = new GroupingStateManager(vscode.workspace);
		mainLogger.info("Grouping state manager initialized");

		const providerFactory = new ProjectProviderFactory(
			gitSortLogger,
			context,
			extensionFilterState,
			groupingStateManager,
		);

		// Layer 3: View Manager (orchestrates view registration)
		projectViewManager = new ProjectViewManager(
			context,
			gitSortLogger,
			configSource,
			providerFactory,
		);

		// Register all project views (Activity Bar + Panel)
		await projectViewManager.registerAllProjects();

		// Initialize Extension Filter View Manager (persistent TreeView)
		// CRITICAL: Must be initialized AFTER projectViewManager so it can subscribe to workspace changes
		// CRITICAL: Pass the SAME extensionFilterState instance that providers use (created above)
		extensionFilterViewManager = new ExtensionFilterViewManager(
			context,
			projectViewManager,
			mainLogger,
			extensionFilterState, // Share state with providers
		);
		mainLogger.info("Extension filter view manager initialized");

		// Sync TreeView checkbox state with loaded filter state
		// This prevents VS Code's persisted checkbox state from conflicting with application state
		extensionFilterViewManager.syncTreeWithLoadedState();

		// Extension filter auto-populates when:
		// 1. Providers ready (onProvidersReady) + view visible = auto-init
		// 2. View opened by user (onDidChangeVisibility) = populate on demand
		// Direct discovery in view manager - no command indirection needed

		// Initialize Grouping View Manager (gitStatusCache and groupingStateManager already initialized above)
		groupingViewManager = new GroupingViewManager(
			context,
			groupingStateManager,
			mainLogger,
		);
		mainLogger.info("Grouping view manager initialized");

		// Watch for workspace folder changes with debouncing
		let reloadTimeout: NodeJS.Timeout | undefined;

		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				gitSortLogger.info("Workspace folders changed, reloading views...");

				// Debounce: wait 300ms for rapid changes to settle
				if (reloadTimeout) clearTimeout(reloadTimeout);
				reloadTimeout = setTimeout(() => {
					projectViewManager?.reload();
				}, 300);
			}),
		);

		mainLogger.info("✅ Dynamic project views registered successfully");

		// CRITICAL: Register factory disposal
		// Factory handles disposal of all per-project storage instances
		context.subscriptions.push({
			dispose: async () => {
				await providerFactory.dispose();
			},
		});

		// Register Terminal Commands
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.terminal.launch",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await launchCommand.execute(terminalService);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.terminal.launchHere",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await launchHereCommand.execute(terminalService);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.terminal.launchWorkspace",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await launchWorkspaceCommand.execute(terminalService);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.terminal.configure",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await configureProjectCommand.execute(terminalService);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.terminal.listLaunchers",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await listLaunchersCommand.execute(terminalService);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.terminal.removeLauncher",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await removeLauncherCommand.execute(terminalService);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.terminal.removeAllLaunchers",
				async () => {
					if (!terminalService) return;
					const trusted = await terminalService
						.getSecurityService()
						.checkWorkspaceTrust();
					if (!trusted) return;
					await removeAllLaunchersCommand.execute(terminalService);
				},
			),
		);

		// Register Launch Terminal Command (Phase 1)
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.launchTerminal",
				async () => {
					await launchTerminalCommand.execute();
				},
			),
		);

		// Register Terminal Link Provider (Phase 3)
		context.subscriptions.push(
			vscode.window.registerTerminalLinkProvider(
				new CommandCentralTerminalLinkProvider(),
			),
		);

		// Register Grouping Commands
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.grouping.toggle",
				async () => {
					if (!groupingViewManager) {
						mainLogger.error("Grouping view manager not initialized");
						return;
					}
					await groupingViewManager.toggle();
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.grouping.selectOption",
				async (optionId: "none" | "gitStatus") => {
					if (!groupingViewManager) {
						mainLogger.error("Grouping view manager not initialized");
						vscode.window.showErrorMessage(
							"Command Central: Grouping feature not available",
						);
						return;
					}

					try {
						await groupingViewManager.selectOption(optionId);

						// Provide user feedback on success
						const message =
							optionId === "gitStatus"
								? "Grouping enabled: Files grouped by Git status"
								: "Grouping disabled: Files sorted by time only";
						vscode.window.setStatusBarMessage(`✓ ${message}`, 2000);
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : "Unknown error";
						mainLogger.error("Failed to change grouping mode", error as Error);
						vscode.window.showErrorMessage(
							`Command Central: Failed to change grouping - ${errorMessage}`,
						);
					}
				},
			),
		);

		// Register Git Sort Commands
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.gitSort.enable",
				async () => {
					if (gitSorter) {
						await enableSortCommand.execute(gitSorter);
						await gitSorter.activate();
					}
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.gitSort.disable",
				async () => {
					if (gitSorter) {
						await disableSortCommand.execute(gitSorter);
					}
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.gitSort.refreshView",
				(viewIdOrTreeView?: string | vscode.TreeView<unknown>) => {
					gitSortLogger.info("🔄 Refresh view command invoked");

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
						gitSortLogger.error("❌ No provider found for refresh");
						return;
					}

					gitSortLogger.debug("✅ Refreshing view");
					provider.refresh();
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.gitSort.changeSortOrder",
				async (viewIdOrTreeView?: string | vscode.TreeView<unknown>) => {
					gitSortLogger.info("🔄 Sort order command invoked");
					gitSortLogger.debug(
						`Argument received - type: ${typeof viewIdOrTreeView}, value: ${JSON.stringify(viewIdOrTreeView)}`,
					);

					let provider: SortedGitChangesProvider | undefined;

					// Strategy 1: View ID passed as string (from package.json args)
					if (typeof viewIdOrTreeView === "string" && projectViewManager) {
						gitSortLogger.debug(`Using view ID: "${viewIdOrTreeView}"`);
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
						gitSortLogger.debug(
							`TreeView object passed - visible: ${viewIdOrTreeView.visible}, title: ${viewIdOrTreeView.title}`,
						);
						provider =
							projectViewManager.getProviderForTreeView(viewIdOrTreeView);
					}
					// Strategy 3: Find any visible view provider (fallback)
					else if (projectViewManager) {
						gitSortLogger.debug(
							"No valid argument, searching for visible provider...",
						);
						provider = projectViewManager.getAnyVisibleProvider();
					}

					if (!provider) {
						gitSortLogger.error("❌ No provider found for sort order change");
						vscode.window.showErrorMessage(
							"Could not change sort order: No active view found",
						);
						return;
					}

					gitSortLogger.debug("✅ Provider found");

					// Direct toggle - no dialog
					const currentOrder = provider.getSortOrder();
					const newOrder = currentOrder === "newest" ? "oldest" : "newest";

					gitSortLogger.info(
						`Changing sort order: ${currentOrder} → ${newOrder}`,
					);

					provider.setSortOrder(newOrder);
					// Title is updated automatically by refresh() in setSortOrder

					// Minimal status bar message with correct arrow convention
					const sortIcon = newOrder === "newest" ? "▼" : "▲";

					// Show brief notification
					vscode.window.setStatusBarMessage(`Sorted ${sortIcon}`, 2000);
					gitSortLogger.info(`✅ Sort order changed to ${newOrder}`);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.gitSort.changeFileFilter",
				async () => {
					// Delegate to extension filter command module
					const filterCommand = await import(
						"./commands/filter-by-extension-command.js"
					);
					if (!extensionFilterViewManager) {
						gitSortLogger.error(
							"Extension filter view manager not initialized",
						);
						return;
					}
					await filterCommand.execute(
						projectViewManager,
						extensionFilterState,
						gitSortLogger,
						extensionFilterViewManager,
					);
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.gitSort.openChange",
				async (item: GitChangeItem) => {
					// Validate item has URI
					if (!item?.uri) {
						gitSortLogger.error("openChange called with invalid item (no URI)");
						return;
					}

					// Find provider for this file's workspace
					const provider = projectViewManager?.getProviderForFile(item.uri);

					if (!provider) {
						gitSortLogger.error(
							`No provider found for file: ${item.uri.fsPath}`,
						);
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
						gitSortLogger.error("openDiff called with invalid item (no URI)");
						return;
					}

					// Find provider for this file's workspace
					const provider = projectViewManager?.getProviderForFile(item.uri);

					if (!provider) {
						gitSortLogger.error(
							`No provider found for file: ${item.uri.fsPath}`,
						);
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
						await openInIntegratedTerminal(item);
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
		);

		// Check if Git Sort is enabled and activate
		const isGitSortEnabled = vscode.workspace
			.getConfiguration("commandCentral.gitSort")
			.get("enabled", false);
		if (isGitSortEnabled) {
			await gitSorter.activate();
			gitSortLogger.info("Git Sort initialized and activated");
		} else {
			gitSortLogger.info("Git Sort initialized (disabled in settings)");
		}

		// Listen for configuration changes
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(async (e) => {
				if (e.affectsConfiguration("commandCentral.gitSort.enabled")) {
					const nowEnabled = vscode.workspace
						.getConfiguration("commandCentral.gitSort")
						.get("enabled", false);
					if (nowEnabled && gitSorter && !gitSorter.isEnabled()) {
						gitSorter.enable();
						await gitSorter.activate();
					} else if (!nowEnabled && gitSorter && gitSorter.isEnabled()) {
						gitSorter.disable();
					}
				}
			}),
		);

		const activationTime = performance.now() - start;
		mainLogger.info(`✅ Extension activated in ${activationTime.toFixed(0)}ms`);
		mainLogger.info(`📦 Command Central v${version} ready`);
		mainLogger.info("📝 Available features:");
		mainLogger.info(
			"  - Terminal Launcher: Launch and manage terminal sessions",
		);
		mainLogger.info("  - Git Sort: Sort git changes by modification time");
		mainLogger.info(
			"  - Project Icons: Display project-specific icons in status bar",
		);
	} catch (error) {
		mainLogger.error("Failed to activate", error as Error);
		vscode.window.showErrorMessage(
			`Failed to activate Command Central: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

export async function deactivate(): Promise<void> {
	// Clean up Git Sorter
	if (gitSorter) {
		gitSorter.disable();
	}

	// Note: Provider disposal now handled by ProviderFactory via context.subscriptions
	// The factory.dispose() is automatically called during extension deactivation

	// Clean up Project View Manager
	if (projectViewManager) {
		projectViewManager.dispose();
	}

	// Clean up Terminal Service
	if (terminalService) {
		terminalService.dispose();
	}

	// Clean up Project Icon Service
	if (projectIconService) {
		projectIconService.dispose();
	}

	// Clean up Extension Filter View Manager
	if (extensionFilterViewManager) {
		extensionFilterViewManager.dispose();
	}

	// Clean up Grouping View Manager
	if (groupingViewManager) {
		groupingViewManager.dispose();
	}

	// Clean up Grouping State Manager
	if (groupingStateManager) {
		groupingStateManager.dispose();
	}

	// Clean up loggers
	mainLogger?.dispose();
	gitSortLogger?.dispose();
	terminalLogger?.dispose();

	mainLogger?.info("Extension deactivated");
}
