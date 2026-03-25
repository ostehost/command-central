/**
 * Command Central Extension — Code changes, sorted by time
 */

import * as path from "node:path";
import * as vscode from "vscode";
import * as disableSortCommand from "./commands/disable-sort.js";
import * as enableSortCommand from "./commands/enable-sort.js";
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
import { BinaryManager } from "./ghostty/BinaryManager.js";
import { TerminalManager } from "./ghostty/TerminalManager.js";
import { focusGhosttyWindow } from "./ghostty/window-focus.js";
import { GitSorter } from "./git-sort/scm-sorter.js";
import type { SortedGitChangesProvider } from "./git-sort/sorted-changes-provider.js";
import { AgentDashboardPanel } from "./providers/agent-dashboard-panel.js";
import { AgentDecorationProvider } from "./providers/agent-decoration-provider.js";
import {
	AgentStatusTreeProvider,
	type AgentTask,
	isValidSessionId,
} from "./providers/agent-status-tree-provider.js";
import { ExtensionFilterViewManager } from "./providers/extension-filter-view-manager.js";
import { AgentBackendSwitcher } from "./services/agent-backend-switcher.js";
import { AgentOutputChannels } from "./services/agent-output-channels.js";
import { AgentStatusBar } from "./services/agent-status-bar.js";
import { GroupingStateManager } from "./services/grouping-state-manager.js";
import { LoggerService, LogLevel } from "./services/logger-service.js";
import { ProjectIconService } from "./services/project-icon-service.js";
import { ProjectViewManager } from "./services/project-view-manager.js";
import { SessionStore } from "./services/session-store.js";
import { TelemetryService } from "./services/telemetry-service.js";
import type { GitChangeItem } from "./types/tree-element.js";
import { GroupingViewManager } from "./ui/grouping-view-manager.js";

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
		// Agent Status Panel
		// ============================================================================
		const sessionStore = new SessionStore();
		agentStatusProvider = new AgentStatusTreeProvider();
		const agentStatusView = vscode.window.createTreeView(
			"commandCentral.agentStatus",
			{ treeDataProvider: agentStatusProvider, showCollapseAll: true },
		);
		const syncAgentStatusViewContexts = async (): Promise<void> => {
			const config = vscode.workspace.getConfiguration("commandCentral");
			const showOnlyRunning = config.get<boolean>(
				"agentStatus.showOnlyRunning",
				false,
			);
			const groupByProject = config.get<boolean>(
				"agentStatus.groupByProject",
				true,
			);
			await vscode.commands.executeCommand(
				"setContext",
				"commandCentral.agentStatus.showOnlyRunning",
				showOnlyRunning,
			);
			await vscode.commands.executeCommand(
				"setContext",
				"commandCentral.agentStatus.groupByProject",
				groupByProject,
			);
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
					e.affectsConfiguration("commandCentral.agentStatus.groupByProject")
				) {
					void syncAgentStatusViewContexts();
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
						agentStatusProvider?.getRegistry().tasks ?? {},
					);
				},
			),
		);
		agentStatusProvider.onDidChangeTreeData(() => {
			agentDashboardPanel.update(
				agentStatusProvider?.getRegistry().tasks ?? {},
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

		const getConfiguredAgentBackend = (): "codex" | "gemini" => {
			const configured = vscode.workspace
				.getConfiguration("commandCentral.agentStatus")
				.get<string>("defaultBackend", "codex");
			return configured === "gemini" ? "gemini" : "codex";
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

					// Strategy 0: Session store lookup (works for discovered agents too)
					if (projectDir) {
						const mapping = sessionStore.lookup(projectDir);
						if (mapping) {
							try {
								await focusGhosttyWindow(mapping.bundlePath, sessionId);
								if (sessionId && isValidSessionId(sessionId)) {
									try {
										await execFileAsync("tmux", [
											"select-window",
											"-t",
											sessionId,
										]);
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
									await execFileAsync("tmux", [
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
										await execFileAsync("tmux", [
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
					if (
						task.terminal_backend === "tmux" &&
						task.session_id &&
						isValidSessionId(task.session_id)
					) {
						try {
							// Guard: check if tmux session is still alive before attempting attach
							await execFileAsync("tmux", [
								"has-session",
								"-t",
								task.session_id,
							]);
							await execFileAsync("open", [
								"-a",
								"Ghostty",
								"--args",
								"-e",
								`tmux attach -t ${task.session_id}`,
							]);
							return;
						} catch {
							// Session ended or Ghostty failed — fall through
						}
					}

					vscode.window.showInformationMessage(
						"No terminal available for this agent.",
					);
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
						vscode.ConfigurationTarget.Workspace,
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
						true,
					);
					await config.update(
						"agentStatus.groupByProject",
						!current,
						vscode.ConfigurationTarget.Workspace,
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
						const scriptPath = path.join(
							path.dirname(tasksFilePath),
							"oste-capture.sh",
						);
						const output = execFileSync("bash", [scriptPath, sessionId], {
							encoding: "utf-8",
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
						const scriptPath = path.join(
							path.dirname(tasksFilePath),
							"oste-kill.sh",
						);
						execFileSync("bash", [scriptPath, task.session_id], {
							encoding: "utf-8",
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
						const raw = fs.readFileSync(tasksFilePath, "utf-8");
						const parsed = JSON.parse(raw) as {
							version?: number;
							tasks?: Record<string, unknown>;
						};
						const tasks =
							parsed.tasks && typeof parsed.tasks === "object"
								? parsed.tasks
								: {};

						let removed = false;
						if (task.id in tasks) {
							delete tasks[task.id];
							removed = true;
						} else {
							for (const [key, value] of Object.entries(tasks)) {
								const valueId =
									typeof value === "object" && value
										? (value as { id?: unknown }).id
										: undefined;
								if (
									typeof value === "object" &&
									value &&
									"id" in value &&
									valueId === task.id
								) {
									delete tasks[key];
									removed = true;
									break;
								}
							}
						}

						if (!removed) {
							vscode.window.showInformationMessage(
								`Agent "${task.id}" is already removed.`,
							);
							return;
						}

						const version =
							parsed.version === 1 || parsed.version === 2 ? parsed.version : 2;
						fs.writeFileSync(
							tasksFilePath,
							`${JSON.stringify({ version, tasks }, null, 2)}\n`,
							"utf-8",
						);

						agentStatusProvider?.reload();
						vscode.window.showInformationMessage(`Removed agent "${task.id}".`);
					} catch (err) {
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

		// Resume Agent Session — opens Ghostty with `claude --resume`
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"commandCentral.resumeAgentSession",
				async (node?: {
					type: string;
					task?: AgentTask;
					agent?: { projectDir: string };
				}) => {
					const projectDir = node?.task?.project_dir ?? node?.agent?.projectDir;
					if (!projectDir) {
						vscode.window.showWarningMessage(
							"No project directory found for this agent.",
						);
						return;
					}
					const claudeSessionId = await resolveClaudeSessionId(projectDir);
					if (!claudeSessionId) {
						vscode.window.showInformationMessage(
							"No Claude Code session found — showing diff instead.",
						);
						vscode.commands.executeCommand(
							"commandCentral.viewAgentDiff",
							node,
						);
						return;
					}
					try {
						const { execFile } = await import("node:child_process");
						const { promisify } = await import("node:util");
						const execFileAsync = promisify(execFile);
						await execFileAsync("open", [
							"-a",
							"Ghostty",
							"--args",
							"-e",
							`cd ${JSON.stringify(projectDir)} && claude --resume ${claudeSessionId}`,
						]);
					} catch {
						vscode.window.showErrorMessage(
							"Failed to open Ghostty with resumed session.",
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
						await terminalManager?.runInProjectTerminal(
							projectDir,
							`git diff ${sinceRef} --stat && echo "---" && git diff ${sinceRef}`,
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

					await terminalManager?.runInProjectTerminal(
						task.project_dir,
						`git diff ${sinceRef}..HEAD --stat && echo "---" && git diff ${sinceRef}..HEAD`,
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

						const readFileAtRef = (ref: string): string | null => {
							try {
								return execFileSync(
									"git",
									["-C", projectDir, "show", `${ref}:${relativePath}`],
									{ encoding: "utf-8", timeout: 3000 },
								);
							} catch {
								return null;
							}
						};

						const tempDir = fs.mkdtempSync(
							path.join(os.tmpdir(), "command-central-file-diff-"),
						);
						const beforePath = path.join(
							tempDir,
							`before-${path.basename(relativePath)}`,
						);
						fs.writeFileSync(
							beforePath,
							readFileAtRef(beforeRef) ?? "",
							"utf-8",
						);
						const beforeUri = vscode.Uri.file(beforePath);

						let afterUri: vscode.Uri;
						if (node.taskStatus === "running" && fs.existsSync(absolutePath)) {
							afterUri = vscode.Uri.file(absolutePath);
						} else {
							const afterPath = path.join(
								tempDir,
								`after-${path.basename(relativePath)}`,
							);
							const content =
								node.taskStatus === "running" && !fs.existsSync(absolutePath)
									? ""
									: (readFileAtRef("HEAD") ?? "");
							fs.writeFileSync(afterPath, content, "utf-8");
							afterUri = vscode.Uri.file(afterPath);
						}

						await vscode.commands.executeCommand(
							"vscode.diff",
							beforeUri,
							afterUri,
							`${path.basename(relativePath)} (${beforeRef} ↔ ${afterRef})`,
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
						await terminalManager?.runInProjectTerminal(
							task.project_dir,
							`oste-spawn.sh "${task.project_dir}" "${task.prompt_file}" --task-id "${task.id}" --agent "${backend}"`,
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

					const { execFile } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const execFileAsync = promisify(execFile);
					const backend = getConfiguredAgentBackend();

					try {
						await execFileAsync(
							"oste-spawn.sh",
							[
								projectDir,
								promptFile,
								"--task-id",
								taskId,
								"--role",
								"developer",
								"--no-bundle",
								"--agent",
								backend,
								"--json",
							],
							{ timeout: 15000 },
						);

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

					const installed = await terminalManager?.isLauncherInstalled();
					if (!installed) {
						vscode.window.showErrorMessage(
							"Command Central: ghostty-launcher not found. " +
								"Set commandCentral.ghostty.launcherPath or install launcher to PATH.",
						);
						return;
					}

					try {
						await terminalManager?.createProjectTerminal(
							selectedFolder.uri.fsPath,
						);
						vscode.window.showInformationMessage(
							`Command Central: Project terminal created for ${selectedFolder.name}.`,
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						mainLogger.error("Failed to create project terminal", err as Error);
						vscode.window.showErrorMessage(
							`Command Central: Failed to create terminal — ${msg}`,
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
