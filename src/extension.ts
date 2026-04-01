/**
 * Command Central Extension — Code changes, sorted by time
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
	getAgentQuickActions,
	getOpenClawTaskQuickActions,
} from "./commands/agent-quick-actions.js";
import * as disableSortCommand from "./commands/disable-sort.js";
import * as enableSortCommand from "./commands/enable-sort.js";
import {
	buildResumeCommand,
	canShowResumeAction,
	resolveResumeBackend,
	resolveTaskTranscriptPath,
	supportsInteractiveResume,
} from "./commands/resume-session.js";
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
import { resolveClaudeSessionId } from "./discovery/session-resolver.js";
import { parseWorktreeListPorcelain } from "./discovery/worktree-list.js";
import { BinaryManager } from "./ghostty/BinaryManager.js";
import { refreshGhosttyBundleAfterProjectIconChange } from "./ghostty/project-icon-bundle-refresh.js";
import { TerminalManager } from "./ghostty/TerminalManager.js";
import {
	focusGhosttyWindow,
	lookupGhosttyTerminal,
} from "./ghostty/window-focus.js";
import { GitSorter } from "./git-sort/scm-sorter.js";
import type { SortedGitChangesProvider } from "./git-sort/sorted-changes-provider.js";
import { AgentDashboardPanel } from "./providers/agent-dashboard-panel.js";
import { AgentDecorationProvider } from "./providers/agent-decoration-provider.js";
import {
	type AgentStatusSortMode,
	AgentStatusTreeProvider,
	type AgentTask,
	getNextAgentStatusSortMode,
	isValidSessionId,
	type ProjectGroupNode,
	resolveAgentStatusSortMode,
} from "./providers/agent-status-tree-provider.js";
import { ExtensionFilterViewManager } from "./providers/extension-filter-view-manager.js";
import { AgentBackendSwitcher } from "./services/agent-backend-switcher.js";
import { AgentOutputChannels } from "./services/agent-output-channels.js";
import { AgentStatusBar } from "./services/agent-status-bar.js";
import { GroupingStateManager } from "./services/grouping-state-manager.js";
import { LoggerService, LogLevel } from "./services/logger-service.js";
import { OpenClawConfigService } from "./services/openclaw-config-service.js";
import { ProjectIconManager } from "./services/project-icon-manager.js";
import { ProjectIconService } from "./services/project-icon-service.js";
import { ProjectViewManager } from "./services/project-view-manager.js";
import { SessionStore } from "./services/session-store.js";
import { TelemetryService } from "./services/telemetry-service.js";
import type { OpenClawTask } from "./types/openclaw-task-types.js";
import type { GitChangeItem } from "./types/tree-element.js";
import { GroupingViewManager } from "./ui/grouping-view-manager.js";
import { buildOsteSpawnCommand, shellQuote } from "./utils/shell-command.js";

let gitSorter: GitSorter | undefined;
let projectViewManager: ProjectViewManager | undefined;
let projectIconService: ProjectIconService | undefined;
let extensionFilterViewManager: ExtensionFilterViewManager | undefined;
let groupingStateManager: GroupingStateManager | undefined;
let groupingViewManager: GroupingViewManager | undefined;
let agentStatusProvider: AgentStatusTreeProvider | undefined;
let terminalManager: TerminalManager | undefined;
let binaryManager: BinaryManager | undefined;
let testCountStatusBar:
	| import("./services/test-count-status-bar.js").TestCountStatusBar
	| undefined;
let mainLogger: LoggerService;
let gitSortLogger: LoggerService;

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

		// Initialize Telemetry (lightweight — no SDK, no deps)
		const telemetry = TelemetryService.getInstance(version);

		// Track first-ever activation via globalState flag
		const hasActivatedBefore = context.globalState.get<boolean>(
			"commandCentral.hasActivatedBefore",
			false,
		);
		if (!hasActivatedBefore) {
			telemetry.track("cc_extension_first_activation");
			context.globalState.update("commandCentral.hasActivatedBefore", true);
		}

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

						// Track grouping mode change
						telemetry.track("cc_agent_status_group_toggled", {
							grouped: optionId === "gitStatus",
						});

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
						await openInIntegratedTerminal(item, terminalManager);
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
			telemetry.track("cc_git_sort_activated");
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

		// ============================================================================
		// Cron Jobs View
		// ============================================================================
		const { CronService } = await import("./services/cron-service.js");
		const { CronTreeProvider } = await import(
			"./providers/cron-tree-provider.js"
		);

		const cronService = new CronService();
		const cronTreeProvider = new CronTreeProvider(cronService);
		const cronView = vscode.window.createTreeView("commandCentral.cronJobs", {
			treeDataProvider: cronTreeProvider,
			showCollapseAll: true,
		});
		context.subscriptions.push(cronService, cronTreeProvider, cronView);
		cronService.start(() => cronTreeProvider.refresh());

		context.subscriptions.push(
			vscode.commands.registerCommand("commandCentral.cron.refresh", () =>
				cronTreeProvider.refresh(),
			),
			vscode.commands.registerCommand(
				"commandCentral.cron.runNow",
				async (node?: { kind: string; job?: { id: string } }) => {
					if (node?.kind === "job" && node.job) {
						await cronService.runJob(node.job.id);
					}
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.cron.enable",
				async (node?: { kind: string; job?: { id: string } }) => {
					if (node?.kind === "job" && node.job) {
						await cronService.enableJob(node.job.id);
					}
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.cron.disable",
				async (node?: { kind: string; job?: { id: string } }) => {
					if (node?.kind === "job" && node.job) {
						await cronService.disableJob(node.job.id);
					}
				},
			),
			vscode.commands.registerCommand("commandCentral.cron.create", () =>
				vscode.window.showInformationMessage(
					"Create Cron Job — coming in Phase 2",
				),
			),
			vscode.commands.registerCommand("commandCentral.cron.edit", () =>
				vscode.window.showInformationMessage(
					"Edit Cron Job — coming in Phase 2",
				),
			),
			vscode.commands.registerCommand("commandCentral.cron.delete", () =>
				vscode.window.showInformationMessage(
					"Delete Cron Job — coming in Phase 2",
				),
			),
			vscode.commands.registerCommand("commandCentral.cron.viewHistory", () =>
				vscode.window.showInformationMessage(
					"View Run History — coming in Phase 2",
				),
			),
		);

		mainLogger.info("Cron Jobs view initialized");

		// ============================================================================
		// Agent Status Panel
		// ============================================================================
		const sessionStore = new SessionStore();
		const projectIconManagerForAgents = new ProjectIconManager();
		agentStatusProvider = new AgentStatusTreeProvider(
			projectIconManagerForAgents,
		);
		const agentStatusView = vscode.window.createTreeView(
			"commandCentral.agentStatus",
			{ treeDataProvider: agentStatusProvider, showCollapseAll: true },
		);
		agentStatusProvider.setTreeView(agentStatusView);

		// OpenClaw model policy visibility
		const openclawConfigService = new OpenClawConfigService();
		openclawConfigService.start(() => {
			agentStatusProvider?.reload();
		});
		agentStatusProvider.setOpenClawConfigService(openclawConfigService);
		context.subscriptions.push(openclawConfigService);

		const { OpenClawTaskService } = await import(
			"./services/openclaw-task-service.js"
		);
		const openclawTaskService = new OpenClawTaskService();
		openclawTaskService.start(() => {
			agentStatusProvider?.reload();
		});
		agentStatusProvider.setOpenClawTaskService(openclawTaskService);
		context.subscriptions.push(openclawTaskService);

		const syncAgentStatusViewContexts = async (): Promise<void> => {
			const config = vscode.workspace.getConfiguration("commandCentral");
			const showOnlyRunning = config.get<boolean>(
				"agentStatus.showOnlyRunning",
				false,
			);
			const scope = config.get<"all" | "currentProject">(
				"agentStatus.scope",
				"all",
			);
			const groupByProject = config.get<boolean>(
				"agentStatus.groupByProject",
				false,
			);
			const sortMode = resolveAgentStatusSortMode(config);
			await vscode.commands.executeCommand(
				"setContext",
				"commandCentral.agentStatus.showOnlyRunning",
				showOnlyRunning,
			);
			await vscode.commands.executeCommand(
				"setContext",
				"commandCentral.agentStatus.scopeCurrentProject",
				scope === "currentProject",
			);
			await vscode.commands.executeCommand(
				"setContext",
				"commandCentral.agentStatus.groupByProject",
				groupByProject,
			);
			await vscode.commands.executeCommand(
				"setContext",
				"commandCentral.agentStatus.sortMode",
				sortMode,
			);
			await context.workspaceState.update(
				"commandCentral.agentStatus.sortMode",
				sortMode,
			);
		};
		const setAgentStatusSortMode = async (
			sortMode: AgentStatusSortMode,
			target = vscode.ConfigurationTarget.Global,
		): Promise<void> => {
			const config = vscode.workspace.getConfiguration("commandCentral");
			await config.update("agentStatus.sortMode", sortMode, target);
			await context.workspaceState.update(
				"commandCentral.agentStatus.sortMode",
				sortMode,
			);
			await syncAgentStatusViewContexts();
			agentStatusProvider?.reload();
		};
		await syncAgentStatusViewContexts();
		context.subscriptions.push(agentStatusView);
		context.subscriptions.push(agentStatusProvider);
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration(
						"commandCentral.agentStatus.showOnlyRunning",
					) ||
					e.affectsConfiguration("commandCentral.agentStatus.scope") ||
					e.affectsConfiguration("commandCentral.agentStatus.groupByProject") ||
					e.affectsConfiguration("commandCentral.agentStatus.sortMode") ||
					e.affectsConfiguration("commandCentral.agentStatus.sortByStatus")
				) {
					void syncAgentStatusViewContexts();
				}
				if (
					e.affectsConfiguration("commandCentral.project.group") ||
					e.affectsConfiguration("commandCentral.project.icon") ||
					e.affectsConfiguration("commandCentral.projects")
				) {
					void agentStatusProvider?.reload();
				}
			}),
		);

		// Track agent panel visibility
		agentStatusView.onDidChangeVisibility((e) => {
			if (e.visible) {
				telemetry.track("cc_agent_panel_opened", {
					agent_count: agentStatusProvider?.getTasks().length ?? 0,
				});
			}
		});

		// Agent Status Bar — shows running/total count
		const agentStatusBar = new AgentStatusBar();
		context.subscriptions.push(agentStatusBar);
		const agentBackendSwitcher = new AgentBackendSwitcher();
		context.subscriptions.push(agentBackendSwitcher);

		// Update status bar + session store on tree data changes
		agentStatusProvider.onDidChangeTreeData(() => {
			agentStatusBar.update(agentStatusProvider?.getTasks() ?? []);
			// Populate session store from launcher tasks with bundle info
			for (const task of agentStatusProvider?.getTasks() ?? []) {
				if (
					task.bundle_path &&
					task.ghostty_bundle_id &&
					task.bundle_path !== "(test-mode)" &&
					task.bundle_path !== "(tmux-mode)"
				) {
					sessionStore.register(
						task.project_dir,
						task.bundle_path,
						task.ghostty_bundle_id,
					);
				}
			}
			sessionStore.save();
		});
		// Initial update
		agentStatusBar.update(agentStatusProvider.getTasks());

		// Agent Dashboard Panel — rich webview dashboard
		const agentDashboardPanel = new AgentDashboardPanel();
		agentDashboardPanel.setGitInfoProvider(agentStatusProvider);
		context.subscriptions.push(agentDashboardPanel);
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.openAgentDashboard",
				() => {
					agentDashboardPanel.show(
						agentStatusProvider?.getDisplayRegistryTasks() ?? {},
					);
				},
			),
		);
		agentStatusProvider.onDidChangeTreeData(() => {
			agentDashboardPanel.update(
				agentStatusProvider?.getDisplayRegistryTasks() ?? {},
			);
		});

		// Agent Decoration Provider — highlights recently changed tasks
		const agentDecorationProvider = new AgentDecorationProvider();
		context.subscriptions.push(agentDecorationProvider);
		context.subscriptions.push(
			vscode.window.registerFileDecorationProvider(agentDecorationProvider),
		);

		// Track status transitions for decoration badges
		const previousStatusesForDecoration = new Map<string, string>();
		agentStatusProvider.onDidChangeTreeData(() => {
			for (const task of agentStatusProvider?.getTasks() ?? []) {
				const prev = previousStatusesForDecoration.get(task.id);
				if (prev && prev !== task.status) {
					agentDecorationProvider.markChanged(task.id);
				}
				previousStatusesForDecoration.set(task.id, task.status);
			}
		});

		// Agent Output Channel Streaming
		const agentOutputChannels = new AgentOutputChannels();
		context.subscriptions.push(agentOutputChannels);

		const agentOutputChannel =
			vscode.window.createOutputChannel("Agent Output");
		context.subscriptions.push(agentOutputChannel);
		const openclawTaskOutputChannel =
			vscode.window.createOutputChannel("OpenClaw Tasks");
		context.subscriptions.push(openclawTaskOutputChannel);
		const discoveryDiagnosticsChannel = vscode.window.createOutputChannel(
			"Agent Discovery Diagnostics",
		);
		context.subscriptions.push(discoveryDiagnosticsChannel);

		const getConfiguredAgentBackend = (): "codex" | "gemini" => {
			const configured = vscode.workspace
				.getConfiguration("commandCentral.agentStatus")
				.get<string>("defaultBackend", "codex");
			return configured === "gemini" ? "gemini" : "codex";
		};
		const isValidProjectIconInput = (value: string): boolean => {
			const trimmed = value.trim();
			if (!trimmed) return false;
			if (/\p{Extended_Pictographic}/u.test(trimmed)) return true;
			const length = [...trimmed].length;
			return length >= 1 && length <= 2;
		};

		const TERMINAL_TASK_STATUSES = new Set([
			"completed",
			"completed_dirty",
			"failed",
			"stopped",
			"killed",
			"completed_stale",
			"contract_failure",
		]);

		const execFileAsync = async (
			command: string,
			args: string[],
			timeout = 4000,
		): Promise<{ stdout: string; stderr: string }> => {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			return promisify(execFile)(command, args, { timeout });
		};

		const isTaskTmuxSessionAlive = async (
			task: AgentTask,
		): Promise<boolean> => {
			if (!task.session_id || !isValidSessionId(task.session_id)) {
				return false;
			}
			try {
				await execFileAsync("tmux", ["has-session", "-t", task.session_id]);
				return true;
			} catch {
				return false;
			}
		};

		const openTranscriptInEditor = async (
			transcriptPath: string,
		): Promise<void> => {
			await vscode.commands.executeCommand(
				"vscode.open",
				vscode.Uri.file(transcriptPath),
			);
		};

		const openIntegratedTerminal = (
			name: string,
			cwd: string,
			command?: string,
		): void => {
			const terminal = vscode.window.createTerminal({ name, cwd });
			terminal.show();
			if (command) {
				terminal.sendText(command);
			}
		};

		const runCommandInProjectTerminalWithFallback = async (
			projectDir: string,
			command: string,
			terminalName: string,
			cwd?: string,
		): Promise<void> => {
			if (!terminalManager) {
				openIntegratedTerminal(terminalName, cwd ?? projectDir, command);
				return;
			}
			try {
				await terminalManager.runInProjectTerminal(projectDir, command, cwd);
			} catch {
				openIntegratedTerminal(terminalName, cwd ?? projectDir, command);
			}
		};

		const openGhosttyTmuxAttach = async (
			sessionId: string,
		): Promise<boolean> => {
			try {
				await execFileAsync("tmux", ["has-session", "-t", sessionId]);
			} catch {
				return false;
			}

			try {
				await execFileAsync("open", [
					"-a",
					"Ghostty",
					"--args",
					"-e",
					`tmux attach -t ${sessionId}`,
				]);
				return true;
			} catch {
				return false;
			}
		};

		const focusExistingTaskTerminal = async (
			task: AgentTask,
		): Promise<void> => {
			await vscode.commands.executeCommand(
				"commandCentral.focusAgentTerminal",
				{
					type: "task",
					task,
				},
			);
		};

		const runResumeInTaskTerminal = async (
			task: AgentTask,
			command: string,
		): Promise<void> => {
			if (await isTaskTmuxSessionAlive(task)) {
				await focusExistingTaskTerminal(task);
				try {
					const steerScript =
						await terminalManager?.resolveLauncherHelperScriptPath(
							"oste-steer.sh",
						);
					if (steerScript) {
						await execFileAsync(steerScript, [
							task.session_id,
							"--raw",
							command,
						]);
						return;
					}
				} catch {
					// Fall back to opening the project terminal and sending the command there.
				}
			}

			if (
				task.bundle_path &&
				task.bundle_path !== "(test-mode)" &&
				task.bundle_path !== "(tmux-mode)"
			) {
				try {
					await execFileAsync("open", [task.bundle_path], 5000);
					return;
				} catch {
					// Fall through to tmux attach or integrated terminal resume.
				}
			}

			if (
				task.session_id &&
				isValidSessionId(task.session_id) &&
				(await openGhosttyTmuxAttach(task.session_id))
			) {
				return;
			}

			await runCommandInProjectTerminalWithFallback(
				task.project_dir,
				command,
				`Resume: ${task.id}`,
			);
		};

		const parseRegistry = (rawRegistry: string) => {
			const parsed = JSON.parse(rawRegistry) as {
				version?: number;
				tasks?: Record<string, unknown>;
			};
			const version =
				parsed.version === 1 || parsed.version === 2 ? parsed.version : 2;
			const tasks =
				parsed.tasks && typeof parsed.tasks === "object"
					? { ...parsed.tasks }
					: {};
			return { version, tasks };
		};

		const removeTaskFromMap = (
			tasks: Record<string, unknown>,
			taskId: string,
		): boolean => {
			if (taskId in tasks) {
				delete tasks[taskId];
				return true;
			}
			for (const [key, value] of Object.entries(tasks)) {
				const valueId =
					typeof value === "object" && value
						? (value as { id?: unknown }).id
						: undefined;
				if (
					typeof value === "object" &&
					value &&
					"id" in value &&
					valueId === taskId
				) {
					delete tasks[key];
					return true;
				}
			}
			return false;
		};

		const removeTerminalTasksFromMap = (
			tasks: Record<string, unknown>,
		): number => {
			let removed = 0;
			for (const [key, value] of Object.entries(tasks)) {
				const status =
					typeof value === "object" && value
						? (value as { status?: unknown }).status
						: undefined;
				if (typeof status === "string" && TERMINAL_TASK_STATUSES.has(status)) {
					delete tasks[key];
					removed += 1;
				}
			}
			return removed;
		};

		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.focusAgentTerminal",
				async (node?: {
					type: string;
					task?: AgentTask;
					agent?: { projectDir: string; sessionId?: string };
				}) => {
					// Support both launcher tasks and discovered agents
					const task = node?.task;
					const discovered = node?.agent;
					const projectDir = task?.project_dir ?? discovered?.projectDir;
					const sessionId = task?.session_id ?? discovered?.sessionId;

					if (!task && !discovered) {
						vscode.window.showInformationMessage(
							"No terminal available for this agent.",
						);
						return;
					}
					telemetry.track("cc_agent_focused");
					const { execFile } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const execFileAsync = promisify(execFile);
					const runExec = (
						command: string,
						args: string[],
						timeout = 4000,
					): Promise<{ stdout: string; stderr: string }> =>
						execFileAsync(command, args, { timeout });

					// Strategy 0: Session store lookup (works for discovered agents too)
					if (projectDir) {
						const mapping = sessionStore.lookup(projectDir);
						if (mapping) {
							try {
								await focusGhosttyWindow(mapping.bundlePath, sessionId);
								if (sessionId && isValidSessionId(sessionId)) {
									try {
										await runExec("tmux", ["select-window", "-t", sessionId]);
									} catch {
										// Window selection failed — app still opened
									}
								}
								return;
							} catch {
								// Bundle not running — fall through
							}
						}
					}

					// Discovered agents only use Strategy 0 — no task-specific strategies
					if (!task) {
						vscode.window.showInformationMessage(
							"No Ghostty bundle found for this discovered agent.",
						);
						return;
					}

					// Strategy 1: tmux backend with ghostty bundle
					if (task.terminal_backend === "tmux" && task.ghostty_bundle_id) {
						try {
							await focusGhosttyWindow(task.ghostty_bundle_id, task.session_id);
							// M1-8: select the correct tmux window/tab after bringing Ghostty to front
							if (task.session_id && isValidSessionId(task.session_id)) {
								try {
									await runExec("tmux", [
										"select-window",
										"-t",
										task.session_id,
									]);
								} catch {
									// Window selection failed — app still opened
								}
							}
							return;
						} catch {
							// Fall through to next strategy
						}
					}

					// Strategy 2: Direct bundle path
					if (
						task.bundle_path &&
						task.bundle_path !== "(test-mode)" &&
						task.bundle_path !== "(tmux-mode)"
					) {
						try {
							const fsModule = await import("node:fs");
							if (fsModule.existsSync(task.bundle_path)) {
								await focusGhosttyWindow(task.bundle_path, task.session_id);
								// M1-8: select the correct tmux window/tab after bringing Ghostty to front
								if (task.session_id && isValidSessionId(task.session_id)) {
									try {
										await runExec("tmux", [
											"select-window",
											"-t",
											task.session_id,
										]);
									} catch {
										// Window selection failed — app still opened
									}
								}
								return;
							}
						} catch {
							// Fall through to next strategy
						}
					}

					// Strategy 3: tmux-only — open Ghostty with tmux attach (REQUIRES live session)
					let hasLiveTmuxSession = false;
					if (
						task.terminal_backend === "tmux" &&
						task.session_id &&
						isValidSessionId(task.session_id)
					) {
						hasLiveTmuxSession = await isTaskTmuxSessionAlive(task);
						if (
							hasLiveTmuxSession &&
							(await openGhosttyTmuxAttach(task.session_id))
						) {
							return;
						}
					}

					if (
						task.terminal_backend === "tmux" &&
						task.session_id &&
						isValidSessionId(task.session_id) &&
						!hasLiveTmuxSession
					) {
						vscode.window.showInformationMessage(
							"Terminal session ended. Use Resume Session to start a new one.",
						);
						return;
					}

					vscode.window.showInformationMessage(
						"No terminal available for this agent.",
					);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.agentQuickActions",
				async (node?: { type: string; task?: AgentTask | OpenClawTask }) => {
					if (!node?.task) {
						vscode.window.showWarningMessage(
							"No agent selected. Right-click an agent in the tree.",
						);
						return;
					}
					if (node.type === "openclawTask") {
						const task = node.task as OpenClawTask;
						const actions = getOpenClawTaskQuickActions(task.status);
						const selected = await vscode.window.showQuickPick(
							actions.map((action) => ({
								label: action.label,
								actionId: action.id,
							})),
							{ placeHolder: `Actions for ${task.taskId}` },
						);
						const picked = actions.find(
							(action) => action.id === selected?.actionId,
						);
						if (picked)
							await vscode.commands.executeCommand(picked.command, node);
						return;
					}
					const task = node.task as AgentTask;
					if (task.status === "running") {
						await vscode.commands.executeCommand(
							"commandCentral.focusAgentTerminal",
							node,
						);
						return;
					}

					const hasResumeSession = canShowResumeAction(task);
					const actions = getAgentQuickActions(task.status, hasResumeSession);
					if (actions.length === 0) {
						await vscode.commands.executeCommand(
							"commandCentral.focusAgentTerminal",
							node,
						);
						return;
					}

					type AgentQuickPickItem = vscode.QuickPickItem & {
						actionId: string;
					};
					const selected =
						await vscode.window.showQuickPick<AgentQuickPickItem>(
							actions.map((action) => ({
								label: action.label,
								actionId: action.id,
							})),
							{
								placeHolder: `Actions for ${task.id}`,
							},
						);
					if (!selected) return;

					const picked = actions.find(
						(action) => action.id === selected.actionId,
					);
					if (!picked) return;

					await vscode.commands.executeCommand(picked.command, node);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.agentStatus.focus",
				() => {
					// Focus the agent status tree view by focusing its container
					vscode.commands.executeCommand(
						"workbench.view.extension.commandCentral",
					);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.refreshAgentStatus",
				() => {
					agentStatusProvider?.reload();
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.showDiscoveryDiagnostics",
				() => {
					if (!agentStatusProvider) return;
					discoveryDiagnosticsChannel.clear();
					discoveryDiagnosticsChannel.appendLine(
						agentStatusProvider.getDiscoveryDiagnosticsReport(),
					);
					discoveryDiagnosticsChannel.show(true);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.cycleSortMode",
				async () => {
					const config = vscode.workspace.getConfiguration("commandCentral");
					const currentSortMode = resolveAgentStatusSortMode(config);
					const nextSortMode = getNextAgentStatusSortMode(currentSortMode);
					await setAgentStatusSortMode(nextSortMode);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.setSortMode",
				async () => {
					const config = vscode.workspace.getConfiguration("commandCentral");
					const currentSortMode = resolveAgentStatusSortMode(config);
					type SortModeQuickPickItem = vscode.QuickPickItem & {
						sortMode: AgentStatusSortMode;
					};
					const baseSortModeItems: Array<
						Omit<SortModeQuickPickItem, "detail">
					> = [
						{
							label: "Recent",
							description: "Newest activity first",
							sortMode: "recency",
						},
						{
							label: "Status",
							description: "Running, then completed, then failed",
							sortMode: "status",
						},
						{
							label: "Status + Recent",
							description: "Status groups with recency inside each group",
							sortMode: "status-recency",
						},
					];
					const sortModeItems: SortModeQuickPickItem[] = baseSortModeItems.map(
						(item): SortModeQuickPickItem => ({
							...item,
							detail:
								item.sortMode === currentSortMode ? "Current mode" : undefined,
						}),
					);
					const selection =
						await vscode.window.showQuickPick<SortModeQuickPickItem>(
							sortModeItems,
							{
								placeHolder: "Select Agent Status sort mode",
							},
						);
					if (!selection || selection.sortMode === currentSortMode) {
						return;
					}

					await setAgentStatusSortMode(selection.sortMode);
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

					const currentIcon =
						projectIconManagerForAgents.getIconForProject(projectDir);
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

					await projectIconManagerForAgents.setCustomIcon(projectDir, nextIcon);
					await refreshGhosttyBundleAfterProjectIconChange(projectDir, {
						terminalManager,
						logger: mainLogger,
						showWarningMessage: (message) =>
							vscode.window.showWarningMessage(message),
					});
					await agentStatusProvider?.reload();
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.switchAgentBackend",
				async () => {
					const selection = await vscode.window.showQuickPick(
						["codex", "gemini"] as const,
						{
							placeHolder: "Select default backend for launched agents",
						},
					);
					if (!selection) return;
					await vscode.workspace
						.getConfiguration("commandCentral.agentStatus")
						.update(
							"defaultBackend",
							selection,
							vscode.ConfigurationTarget.Global,
						);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.toggleRunningFilter",
				async () => {
					const config = vscode.workspace.getConfiguration("commandCentral");
					const current = config.get<boolean>(
						"agentStatus.showOnlyRunning",
						false,
					);
					await config.update(
						"agentStatus.showOnlyRunning",
						!current,
						vscode.ConfigurationTarget.Global,
					);
					await syncAgentStatusViewContexts();
					agentStatusProvider?.reload();
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.toggleRunningFilterActive",
				async () => {
					await vscode.commands.executeCommand(
						"commandCentral.toggleRunningFilter",
					);
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.toggleProjectGrouping",
				async () => {
					const config = vscode.workspace.getConfiguration("commandCentral");
					const current = config.get<boolean>(
						"agentStatus.groupByProject",
						false,
					);
					await config.update(
						"agentStatus.groupByProject",
						!current,
						vscode.ConfigurationTarget.Global,
					);
					await syncAgentStatusViewContexts();
					agentStatusProvider?.reload();
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
				"commandCentral.toggleAgentScopeCurrentProject",
				async () => {
					const config = vscode.workspace.getConfiguration("commandCentral");
					await config.update(
						"agentStatus.scope",
						"currentProject",
						vscode.ConfigurationTarget.Workspace,
					);
					await syncAgentStatusViewContexts();
					agentStatusProvider?.reload();
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.toggleAgentScopeAll",
				async () => {
					const config = vscode.workspace.getConfiguration("commandCentral");
					await config.update(
						"agentStatus.scope",
						"all",
						vscode.ConfigurationTarget.Workspace,
					);
					await syncAgentStatusViewContexts();
					agentStatusProvider?.reload();
				},
			),
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
					const tasksFilePath = agentStatusProvider?.filePath;
					if (!tasksFilePath) {
						vscode.window.showErrorMessage(
							"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
						);
						return;
					}
					try {
						const { execFileSync } = await import("node:child_process");
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
							agentStatusProvider?.reload();
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
					const tasksFilePath = agentStatusProvider?.filePath;
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
						agentStatusProvider?.reload();
						vscode.window.showInformationMessage(`Agent "${task.id}" killed.`);
					} catch (err) {
						vscode.window.showErrorMessage(
							`Failed to kill agent: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				},
			),
			vscode.commands.registerCommand(
				"commandCentral.clearTerminalTasks",
				async () => {
					const tasksFilePath = agentStatusProvider?.filePath;
					if (!tasksFilePath) {
						vscode.window.showErrorMessage(
							"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
						);
						return;
					}

					try {
						const fs = await import("node:fs");
						const initialRaw = fs.readFileSync(tasksFilePath, "utf-8");
						const initialRegistry = parseRegistry(initialRaw);
						const initialTerminalCount = Object.values(
							initialRegistry.tasks,
						).filter((entry) => {
							const status =
								typeof entry === "object" && entry
									? (entry as { status?: unknown }).status
									: undefined;
							return (
								typeof status === "string" && TERMINAL_TASK_STATUSES.has(status)
							);
						}).length;

						if (initialTerminalCount === 0) {
							vscode.window.showInformationMessage(
								"No completed, failed, or stopped agents to remove.",
							);
							return;
						}

						const confirm = await vscode.window.showWarningMessage(
							`Remove ${initialTerminalCount} completed/failed/stopped agents?`,
							{ modal: true },
							"Remove",
						);
						if (confirm !== "Remove") return;

						const latestRaw = fs.readFileSync(tasksFilePath, "utf-8");
						const registryToWrite =
							latestRaw === initialRaw
								? initialRegistry
								: parseRegistry(latestRaw);
						const removedCount = removeTerminalTasksFromMap(
							registryToWrite.tasks,
						);

						if (removedCount === 0) {
							vscode.window.showInformationMessage(
								"No completed, failed, or stopped agents to remove.",
							);
							return;
						}

						fs.writeFileSync(
							tasksFilePath,
							`${JSON.stringify(
								{
									version: registryToWrite.version,
									tasks: registryToWrite.tasks,
								},
								null,
								2,
							)}\n`,
							"utf-8",
						);

						agentStatusProvider?.reload();
						vscode.window.showInformationMessage(
							`Removed ${removedCount} completed/failed/stopped agents.`,
						);
					} catch (err) {
						if (err instanceof SyntaxError) {
							vscode.window.showErrorMessage(
								"Failed to clear agents: tasks.json is malformed.",
							);
							return;
						}
						vscode.window.showErrorMessage(
							`Failed to clear agents: ${err instanceof Error ? err.message : String(err)}`,
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

					const tasksFilePath = agentStatusProvider?.filePath;
					if (!tasksFilePath) {
						vscode.window.showErrorMessage(
							"Agent tasks file not configured. Set commandCentral.agentTasksFile in settings.",
						);
						return;
					}

					try {
						const fs = await import("node:fs");
						const initialRaw = fs.readFileSync(tasksFilePath, "utf-8");
						const initialRegistry = parseRegistry(initialRaw);

						if (!removeTaskFromMap(initialRegistry.tasks, task.id)) {
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
										const latestRegistry = parseRegistry(latestRaw);
										if (!removeTaskFromMap(latestRegistry.tasks, task.id)) {
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

						fs.writeFileSync(
							tasksFilePath,
							`${JSON.stringify(
								{
									version: registryToWrite.version,
									tasks: registryToWrite.tasks,
								},
								null,
								2,
							)}\n`,
							"utf-8",
						);

						agentStatusProvider?.reload();
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
		);
		// Jump to Next Running Agent
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.focusNextRunningAgent",
				async () => {
					const tasks = agentStatusProvider?.getTasks() ?? [];
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
		);

		// Resume Agent Session — backend-aware, task-specific resume flow
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.resumeAgentSession",
				async (node?: {
					type: string;
					task?: AgentTask;
					agent?: { projectDir: string };
				}) => {
					const task = node?.task;
					const projectDir = task?.project_dir ?? node?.agent?.projectDir;
					if (!projectDir) {
						vscode.window.showWarningMessage(
							"No project directory found for this agent.",
						);
						return;
					}

					// Discovered agents keep the simpler Claude fallback behavior.
					if (!task) {
						const claudeSessionId = await resolveClaudeSessionId(projectDir);
						const command = claudeSessionId
							? `claude --resume ${shellQuote(claudeSessionId)}`
							: "claude --continue";
						try {
							await runCommandInProjectTerminalWithFallback(
								projectDir,
								command,
								`Resume: ${path.basename(projectDir)}`,
							);
						} catch {
							vscode.window.showErrorMessage(
								"Failed to open the terminal with the resumed session.",
							);
						}
						return;
					}

					if (task.status === "running") {
						await focusExistingTaskTerminal(task);
						return;
					}

					const backend = resolveResumeBackend(task);
					if (backend === "acp") {
						vscode.window.showInformationMessage(
							"ACP sessions cannot be resumed interactively.",
						);
						return;
					}

					const resumeCommand = supportsInteractiveResume(task)
						? await buildResumeCommand(task)
						: null;
					const transcriptPath = await resolveTaskTranscriptPath(task);
					const hasLiveTmuxSession = await isTaskTmuxSessionAlive(task);
					const hasGhosttyMapping = Boolean(
						task.session_id && (await lookupGhosttyTerminal(task.session_id)),
					);

					type ResumeQuickPickItem = vscode.QuickPickItem & {
						action: "resume" | "focus" | "transcript";
					};
					const items: ResumeQuickPickItem[] = [];
					if (resumeCommand) {
						items.push({
							label: "Resume in Interactive Mode",
							description:
								backend === "codex"
									? "Run `codex resume --last` in the project terminal"
									: backend === "gemini"
										? "Run `gemini -p --resume latest` in the project terminal"
										: "Run `claude --resume` for this task, or `claude --continue` as fallback",
							action: "resume",
						});
					}
					if (hasLiveTmuxSession || hasGhosttyMapping) {
						items.push({
							label: "Focus Existing Terminal",
							description: "Bring the project terminal to the front",
							action: "focus",
						});
					}
					if (transcriptPath) {
						items.push({
							label: "View Session Transcript",
							description: path.basename(transcriptPath),
							action: "transcript",
						});
					}

					if (items.length === 0) {
						vscode.window.showInformationMessage(
							"No interactive resume data found for this task — showing diff instead.",
						);
						await vscode.commands.executeCommand(
							"commandCentral.viewAgentDiff",
							node,
						);
						return;
					}

					const selected =
						await vscode.window.showQuickPick<ResumeQuickPickItem>(items, {
							placeHolder: `Resume options for ${task.id}`,
						});
					if (!selected) {
						return;
					}

					try {
						if (selected.action === "focus") {
							await focusExistingTaskTerminal(task);
							return;
						}
						if (selected.action === "transcript") {
							if (!transcriptPath) {
								vscode.window.showWarningMessage(
									"No transcript file found for this task.",
								);
								return;
							}
							await openTranscriptInEditor(transcriptPath);
							return;
						}
						if (!resumeCommand) {
							vscode.window.showInformationMessage(
								"No interactive resume command is available for this task.",
							);
							return;
						}
						await runResumeInTaskTerminal(task, resumeCommand);
					} catch {
						vscode.window.showErrorMessage(
							"Failed to open the terminal with the resumed session.",
						);
					}
				},
			),
		);

		// Show Agent Output (streaming OutputChannel)
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.showAgentOutput",
				async (node?: {
					type: string;
					task?: AgentTask;
					agent?: { pid: number; projectDir: string; sessionId?: string };
				}) => {
					const task = node?.task;
					const agent = node?.agent;

					// Discovered agent: open JSONL session transcript in editor
					if (agent) {
						const os = await import("node:os");
						const fs = await import("node:fs");
						// Hash the project dir the same way Claude CLI does (URL-encoded path)
						const projectHash = agent.projectDir
							.replaceAll("/", "-")
							.replace(/^-/, "");
						const sessionsDir = path.join(
							os.homedir(),
							".claude",
							"projects",
							projectHash,
						);
						if (!fs.existsSync(sessionsDir)) {
							vscode.window.showWarningMessage(
								`No Claude session directory found at: ${sessionsDir}`,
							);
							return;
						}
						// Find the most recent JSONL session file
						const files = fs
							.readdirSync(sessionsDir)
							.filter((f: string) => f.endsWith(".jsonl"))
							.map((f: string) => ({
								name: f,
								mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
							}))
							.sort(
								(
									a: { name: string; mtime: number },
									b: { name: string; mtime: number },
								) => b.mtime - a.mtime,
							);
						if (files.length === 0) {
							vscode.window.showWarningMessage(
								`No session files found in: ${sessionsDir}`,
							);
							return;
						}
						const latestFile = path.join(
							sessionsDir,
							(files[0] as { name: string; mtime: number }).name,
						);
						const uri = vscode.Uri.file(latestFile);
						await vscode.commands.executeCommand("vscode.open", uri);
						return;
					}

					// Launcher task: stream via tmux OutputChannel
					if (!task) {
						vscode.window.showWarningMessage(
							"No agent selected. Right-click an agent in the tree.",
						);
						return;
					}
					agentOutputChannels.show(task.id, task.session_id);
				},
			),
		);

		context.subscriptions.push(
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
						agentStatusProvider?.reload();
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
		);

		// View Agent Diff — opens git diff since agent started
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.viewAgentDiff",
				async (node?: {
					type: string;
					task?: AgentTask;
					agent?: { pid: number; projectDir: string; startTime?: Date };
				}) => {
					const task = node?.task;
					const agent = node?.agent;

					// Discovered agent: diff working tree vs HEAD
					if (agent) {
						const projectDir = agent.projectDir;
						let sinceRef = "HEAD";
						if (agent.startTime) {
							try {
								const { execFileSync } = await import("node:child_process");
								const commitHash = execFileSync(
									"git",
									[
										"-C",
										projectDir,
										"log",
										`--before=${agent.startTime.toISOString()}`,
										"-1",
										"--format=%H",
									],
									{ encoding: "utf-8", timeout: 3000 },
								).trim();
								if (commitHash) sinceRef = commitHash;
							} catch {
								/* fallback to HEAD */
							}
						}
						await runCommandInProjectTerminalWithFallback(
							projectDir,
							`git diff ${sinceRef} --stat && echo "---" && git diff ${sinceRef}`,
							`Diff: ${path.basename(projectDir)}`,
						);
						return;
					}

					// Launcher task: diff since started_at
					if (!task?.project_dir) {
						vscode.window.showWarningMessage(
							"No agent selected. Right-click an agent in the tree.",
						);
						return;
					}

					// Find commit closest to started_at for a precise diff
					let sinceRef = "HEAD~5";
					if (task.started_at) {
						try {
							const { execFileSync } = await import("node:child_process");
							const commitHash = execFileSync(
								"git",
								[
									"-C",
									task.project_dir,
									"log",
									`--before=${task.started_at}`,
									"-1",
									"--format=%H",
								],
								{ encoding: "utf-8", timeout: 3000 },
							).trim();
							if (commitHash) sinceRef = commitHash;
						} catch {
							/* fallback to HEAD~5 */
						}
					}

					await runCommandInProjectTerminalWithFallback(
						task.project_dir,
						`git diff ${sinceRef}..HEAD --stat && echo "---" && git diff ${sinceRef}..HEAD`,
						`Diff: ${task.id}`,
					);
				},
			),
		);

		// Open File Diff — opens a focused diff for a specific changed file
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.openFileDiff",
				async (node?: {
					projectDir?: string;
					filePath?: string;
					taskStatus?: AgentTask["status"];
					startCommit?: string;
					additions?: number;
					deletions?: number;
				}) => {
					if (!node?.projectDir || !node.filePath) {
						vscode.window.showWarningMessage("No file change selected.");
						return;
					}

					const projectDir = node.projectDir;
					const absolutePath = path.isAbsolute(node.filePath)
						? node.filePath
						: path.join(projectDir, node.filePath);
					const relativePath = path
						.relative(projectDir, absolutePath)
						.split(path.sep)
						.join("/");

					const beforeRef =
						node.taskStatus === "running"
							? "HEAD"
							: (node.startCommit ?? "HEAD~1");
					const afterRef =
						node.taskStatus === "running" ? "Working Tree" : "HEAD";

					try {
						const fs = await import("node:fs");
						const os = await import("node:os");
						const { execFileSync } = await import("node:child_process");

						const openFileIfPresent = async (): Promise<boolean> => {
							if (!fs.existsSync(absolutePath)) return false;
							await vscode.commands.executeCommand(
								"vscode.open",
								vscode.Uri.file(absolutePath),
							);
							return true;
						};

						if (
							typeof node.additions === "number" &&
							typeof node.deletions === "number" &&
							(node.additions < 0 || node.deletions < 0)
						) {
							const opened = await openFileIfPresent();
							vscode.window.showInformationMessage(
								opened
									? "Binary file detected — opened file directly."
									: "Binary file detected — no text diff is available.",
							);
							return;
						}

						type GitFileReadResult =
							| { kind: "text"; content: string }
							| { kind: "missing" }
							| { kind: "binary" };

						const readFileAtRef = (ref: string): GitFileReadResult => {
							try {
								const content = execFileSync(
									"git",
									["-C", projectDir, "show", `${ref}:${relativePath}`],
									{ timeout: 3000 },
								);
								const asBuffer = Buffer.isBuffer(content)
									? content
									: Buffer.from(String(content));
								if (asBuffer.includes(0x00)) return { kind: "binary" };
								return { kind: "text", content: asBuffer.toString("utf-8") };
							} catch {
								return { kind: "missing" };
							}
						};

						const beforeFile = readFileAtRef(beforeRef);
						const afterFile =
							node.taskStatus === "running"
								? fs.existsSync(absolutePath)
									? ({
											kind: "text",
											content: fs.readFileSync(absolutePath, "utf-8"),
										} as const)
									: ({ kind: "missing" } as const)
								: readFileAtRef("HEAD");

						if (beforeFile.kind === "binary" || afterFile.kind === "binary") {
							const opened = await openFileIfPresent();
							vscode.window.showInformationMessage(
								opened
									? "Binary content detected — opened file directly."
									: "Binary content detected — no text diff is available.",
							);
							return;
						}

						if (beforeFile.kind === "missing" && afterFile.kind === "missing") {
							vscode.window.showInformationMessage(
								"File does not exist in the selected revisions.",
							);
							return;
						}

						const tempDir = fs.mkdtempSync(
							path.join(os.tmpdir(), "command-central-file-diff-"),
						);
						const beforePath = path.join(
							tempDir,
							`before-${path.basename(relativePath)}`,
						);
						fs.writeFileSync(
							beforePath,
							beforeFile.kind === "text" ? beforeFile.content : "",
							"utf-8",
						);
						const beforeUri = vscode.Uri.file(beforePath);

						const afterPath = path.join(
							tempDir,
							`after-${path.basename(relativePath)}`,
						);
						fs.writeFileSync(
							afterPath,
							afterFile.kind === "text" ? afterFile.content : "",
							"utf-8",
						);
						const afterUri = vscode.Uri.file(afterPath);

						const changeHint =
							beforeFile.kind === "missing" && afterFile.kind === "text"
								? " · added"
								: beforeFile.kind === "text" && afterFile.kind === "missing"
									? " · deleted"
									: "";

						await vscode.commands.executeCommand(
							"vscode.diff",
							beforeUri,
							afterUri,
							`${path.basename(relativePath)} (${beforeRef} ↔ ${afterRef}${changeHint})`,
						);
					} catch (err) {
						vscode.window.showErrorMessage(
							`Failed to open file diff: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				},
			),
		);

		// Open Agent Directory — reveals project dir in OS file manager
		context.subscriptions.push(
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
		);

		context.subscriptions.push(
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
		);

		// Restart Agent — kill and re-spawn with same task config
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.restartAgent",
				async (node?: { type: string; task?: AgentTask }) => {
					const task = node?.task;
					if (!task) {
						vscode.window.showWarningMessage(
							"No agent selected. Right-click an agent in the tree.",
						);
						return;
					}

					const confirm = await vscode.window.showWarningMessage(
						`Restart agent ${task.id}?`,
						{ modal: false },
						"Restart",
					);
					if (confirm !== "Restart") return;

					// Kill if still running
					if (
						task.status === "running" &&
						task.session_id &&
						isValidSessionId(task.session_id)
					) {
						try {
							const { execFileSync } = await import("node:child_process");
							execFileSync("tmux", ["kill-session", "-t", task.session_id], {
								timeout: 5000,
							});
						} catch {
							/* session may already be dead */
						}
					}

					// Re-spawn via launcher if prompt_file exists
					if (task.prompt_file) {
						const backend =
							task.agent_backend === "codex" || task.agent_backend === "gemini"
								? task.agent_backend
								: getConfiguredAgentBackend();
						const command = buildOsteSpawnCommand({
							projectDir: task.project_dir,
							promptFile: task.prompt_file,
							taskId: task.id,
							backend,
						});
						await terminalManager?.runInProjectTerminal(
							task.project_dir,
							command,
						);
						agentStatusProvider?.reload();
					} else {
						vscode.window.showWarningMessage(
							`Cannot restart ${task.id}: no prompt file recorded`,
						);
					}
				},
			),
		);

		// Launch Agent — spawn new Ghostty terminal from sidebar
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.launchAgent",
				async () => {
					// Step 1: Pick workspace folder
					let projectDir: string;
					const folders = vscode.workspace.workspaceFolders;
					if (!folders || folders.length === 0) {
						vscode.window.showWarningMessage("No workspace folder open.");
						return;
					}
					if (folders.length === 1) {
						const first = folders[0];
						if (!first) return;
						projectDir = first.uri.fsPath;
					} else {
						const picked = await vscode.window.showWorkspaceFolderPick({
							placeHolder: "Select project for agent",
						});
						if (!picked) return;
						projectDir = picked.uri.fsPath;
					}

					// Step 2: Get task description
					const description = await vscode.window.showInputBox({
						prompt: "What should the agent do?",
						placeHolder: "e.g., Add unit tests for the auth module",
					});
					if (!description) return;

					// Step 3: Write prompt file
					const fs = await import("node:fs");
					const timestamp = Date.now().toString(36);
					const promptFile = `/tmp/cc-launch-${timestamp}.md`;
					fs.writeFileSync(promptFile, `# Task\n\n${description}\n`);

					// Step 4: Generate task ID and spawn
					const path = await import("node:path");
					const dirName = path.basename(projectDir);
					const taskId = `cc-${dirName}-${timestamp}`;
					const backend = getConfiguredAgentBackend();

					try {
						const command = buildOsteSpawnCommand({
							projectDir,
							promptFile,
							taskId,
							backend,
							role: "developer",
						});
						await terminalManager?.runInProjectTerminal(projectDir, command);

						telemetry.track("cc_agent_launched");
						vscode.window.showInformationMessage(
							`Agent launched for ${dirName}`,
						);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Failed to launch agent: ${msg}`);
					}

					// Step 5: Reload tree after delay
					setTimeout(() => {
						agentStatusProvider?.reload();
					}, 2000);
				},
			),
		);

		mainLogger.info("Agent Status panel initialized");

		// ============================================================================
		// Ghostty Integration — TerminalManager + BinaryManager
		// ============================================================================
		terminalManager = new TerminalManager(mainLogger);
		binaryManager = new BinaryManager(mainLogger);

		// Set hasLauncher context for menu visibility
		terminalManager.isLauncherInstalled().then((installed) => {
			vscode.commands.executeCommand(
				"setContext",
				"commandCentral.hasLauncher",
				installed,
			);
		});

		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.ghostty.createTerminal",
				async () => {
					const folders = vscode.workspace.workspaceFolders;
					if (!folders || folders.length === 0) {
						vscode.window.showErrorMessage(
							"Command Central: No workspace folder open.",
						);
						return;
					}

					// Multi-root workspace: show picker to choose which folder
					let selectedFolder: vscode.WorkspaceFolder;
					if (folders.length > 1) {
						const folderItems = folders.map((folder) => ({
							label: folder.name,
							description: folder.uri.fsPath,
							folder: folder,
						}));

						const selectedItem = await vscode.window.showQuickPick(
							folderItems,
							{
								placeHolder: "Select workspace folder for terminal",
								canPickMany: false,
							},
						);

						if (!selectedItem) {
							// User cancelled the picker
							return;
						}

						selectedFolder = selectedItem.folder;
					} else {
						// Single workspace folder: use it directly
						selectedFolder = folders[0] as vscode.WorkspaceFolder;
					}

					try {
						await terminalManager?.runInProjectTerminal(
							selectedFolder.uri.fsPath,
						);
						vscode.window.showInformationMessage(
							`Command Central: Project terminal opened for ${selectedFolder.name}.`,
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						mainLogger.error("Failed to open project terminal", err as Error);
						vscode.window.showErrorMessage(
							`Command Central: Failed to open terminal — ${msg}`,
						);
					}
				},
			),

			vscode.commands.registerCommand(
				"commandCentral.ghostty.checkBinary",
				async () => {
					try {
						const isInstalled = await binaryManager?.isInstalled();

						if (isInstalled) {
							const versionInfo = await binaryManager?.getVersion();
							if (!versionInfo) return;
							const versionStr = versionInfo.bundleVersion ?? "unknown";
							const hashStr = versionInfo.commitHash
								? ` (${versionInfo.commitHash.slice(0, 8)})`
								: "";

							const choice = await vscode.window.showInformationMessage(
								`Command Central: Ghostty CC ${versionStr}${hashStr} is installed.`,
								"Check for Updates",
								"OK",
							);

							if (choice !== "Check for Updates") return;
						}

						await vscode.window.withProgress(
							{
								location: vscode.ProgressLocation.Notification,
								title: "Command Central: Checking for Ghostty updates…",
								cancellable: false,
							},
							async () => {
								const release = await binaryManager?.getLatestRelease();
								if (!release) return;

								const versionInfo = isInstalled
									? await binaryManager?.getVersion()
									: { bundleVersion: null, commitHash: null };
								if (!versionInfo) return;

								const alreadyLatest =
									versionInfo.bundleVersion === release.tag_name;

								if (alreadyLatest) {
									vscode.window.showInformationMessage(
										`Command Central: Ghostty is already up to date (${release.tag_name}).`,
									);
									return;
								}

								const action = await vscode.window.showInformationMessage(
									`Command Central: Ghostty ${release.tag_name} is available.${versionInfo.bundleVersion ? ` (current: ${versionInfo.bundleVersion})` : ""}`,
									"Install",
									"Cancel",
								);

								if (action !== "Install") return;

								await vscode.window.withProgress(
									{
										location: vscode.ProgressLocation.Notification,
										title: `Command Central: Installing Ghostty ${release.tag_name}…`,
										cancellable: false,
									},
									async () => {
										await binaryManager?.downloadRelease(release.tag_name);
									},
								);

								vscode.window.showInformationMessage(
									`Command Central: Ghostty ${release.tag_name} installed successfully.`,
								);
							},
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						mainLogger.error("Ghostty binary check failed", err as Error);
						vscode.window.showErrorMessage(
							`Command Central: Ghostty check failed — ${msg}`,
						);
					}
				},
			),
		);
		mainLogger.info("Ghostty integration initialized");

		// ============================================================================
		// Test Count Status Bar
		// ============================================================================
		const { TestCountStatusBar } = await import(
			"./services/test-count-status-bar.js"
		);
		testCountStatusBar = new TestCountStatusBar();
		context.subscriptions.push(testCountStatusBar);

		// Auto-refresh test count on activation (fire-and-forget)
		testCountStatusBar.refreshCount().catch(() => {
			// Silently ignore — status bar already shows error state
		});

		context.subscriptions.push(
			vscode.commands.registerCommand(
				"command-central.showTestCount",
				async () => {
					try {
						const count = await testCountStatusBar?.refreshCount();
						if (count !== undefined) {
							vscode.window.setStatusBarMessage(
								`CC: ${count} tests passed`,
								3000,
							);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						mainLogger.error("Failed to refresh test count", err as Error);
						vscode.window.showErrorMessage(
							`Command Central: Failed to run tests — ${msg}`,
						);
					}
				},
			),
		);
		mainLogger.info("Test count status bar initialized");

		const activationTime = performance.now() - start;
		telemetry.track("cc_extension_activated", {
			activation_time_ms: Math.round(activationTime),
		});
		mainLogger.info(`✅ Extension activated in ${activationTime.toFixed(0)}ms`);
		mainLogger.info(`📦 Command Central v${version} ready`);
		mainLogger.info("📝 Git Sort + Project Views ready");
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

	// Note: agentStatusProvider disposal handled by context.subscriptions
	// Note: terminalManager and binaryManager have no disposable resources
	// Note: testCountStatusBar disposal handled by context.subscriptions

	// Clean up Grouping State Manager
	if (groupingStateManager) {
		groupingStateManager.dispose();
	}

	// Clean up loggers
	mainLogger?.dispose();
	gitSortLogger?.dispose();

	// Flush telemetry before shutdown
	try {
		await TelemetryService.getInstance().flush();
	} catch {
		// Silent — telemetry must never block deactivation
	}

	mainLogger?.info("Extension deactivated");
}
