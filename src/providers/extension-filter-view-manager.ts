/**
 * Extension Filter View Manager
 *
 * Manages the persistent Extension Filter TreeView that's registered at activation time.
 * The view starts empty and is populated when the filter command is invoked.
 *
 * Architecture:
 * - Registered at extension activation (provider always available)
 * - Updated by filter command with current extension data
 * - Disposed when extension deactivates
 *
 * CRITICAL: Uses persistent provider pattern to avoid "no data provider" error.
 * The TreeView and provider are created at construction and persist across
 * command invocations. Data is updated via updateData(), not by recreating the provider.
 */

import * as vscode from "vscode";
import type { SortedGitChangesProvider } from "../git-sort/sorted-changes-provider.js";
import type { ExtensionFilterState } from "../services/extension-filter-state.js";
import type { LoggerService } from "../services/logger-service.js";
import type { ProjectViewManager } from "../services/project-view-manager.js";
import { FilterStateManager } from "../state/filter-state-manager.js";
import type { FileExtensionInfo } from "../utils/extension-discovery.js";
import type { FilterNode } from "./extension-filter-tree-provider.js";
import { ExtensionFilterTreeProvider } from "./extension-filter-tree-provider.js";

/**
 * Manages the Extension Filter TreeView lifecycle
 *
 * Handles:
 * - View registration at activation with empty provider
 * - Provider data updates from command
 * - Checkbox change events
 * - Proper disposal
 */
export class ExtensionFilterViewManager implements vscode.Disposable {
	// State machine: Simple 3-state lifecycle
	private state: "uninitialized" | "loading" | "ready" = "uninitialized";

	// Core components
	private treeView: vscode.TreeView<FilterNode>;
	private provider: ExtensionFilterTreeProvider;
	private filterState: ExtensionFilterState;
	private stateManager: FilterStateManager;
	private logger: LoggerService;
	private projectViewManager: ProjectViewManager | undefined;

	// Visibility tracking
	private isViewVisible: boolean;

	// Debounce timer for population (batch rapid events)
	private debounceTimer: NodeJS.Timeout | undefined;
	private static readonly DEBOUNCE_DELAY_MS = 100;

	// Auto-refresh: Provider subscriptions
	private providerSubscriptions: vscode.Disposable[] = [];
	private refreshTimer: NodeJS.Timeout | undefined;
	private currentProviders:
		| Array<{ provider: SortedGitChangesProvider; slotId: string }>
		| undefined;
	private currentWorkspaceDisplayNames: Map<string, string> | undefined;

	// Workspace folder change handling
	private workspaceFolderChangeSubscription: vscode.Disposable | undefined;
	private workspaceFolderChangeTimer: NodeJS.Timeout | undefined;

	// Checkbox handling
	private checkboxDisposable: vscode.Disposable | undefined;

	private static readonly VISIBILITY_KEY =
		"commandCentral.extensionFilter.visible";
	private static readonly VISIBILITY_CONTEXT =
		"commandCentral.extensionFilter.visible";

	constructor(
		private context: vscode.ExtensionContext,
		projectViewManager: ProjectViewManager | undefined,
		logger: LoggerService,
		filterState: ExtensionFilterState,
	) {
		this.logger = logger;
		this.projectViewManager = projectViewManager;

		// Restore visibility state from persistent storage
		this.isViewVisible = context.globalState.get(
			ExtensionFilterViewManager.VISIBILITY_KEY,
			true, // Default to visible
		);

		// CRITICAL: Use the SHARED ExtensionFilterState instance
		// This instance is also used by Git change providers via ProjectProviderFactory
		// When checkboxes update this state, providers see the changes immediately
		this.filterState = filterState;
		this.stateManager = new FilterStateManager(this.filterState, []);

		// Create provider with empty data (will be populated later)
		this.provider = new ExtensionFilterTreeProvider(
			[], // No extensions initially
			this.stateManager,
			new Map(), // No workspace names initially
		);

		// Register TreeView immediately (required by VS Code)
		// CRITICAL: manageCheckboxStateManually ensures we control checkbox state
		// Without this, VS Code auto-toggles checkboxes and state gets out of sync
		this.treeView = vscode.window.createTreeView(
			"commandCentral.extensionFilter",
			{
				treeDataProvider: this.provider,
				canSelectMany: false,
				showCollapseAll: true,
				manageCheckboxStateManually: true, // State-driven checkbox management
			},
		);

		this.context.subscriptions.push(this.treeView);

		// Apply initial visibility state
		void vscode.commands.executeCommand(
			"setContext",
			ExtensionFilterViewManager.VISIBILITY_CONTEXT,
			this.isViewVisible,
		);

		// Subscribe to providers ready event (fires after ALL providers registered)
		// CRITICAL: This handles the "view already visible at startup" case
		// onDidChangeVisibility only fires on CHANGES, not initial state
		if (projectViewManager) {
			this.context.subscriptions.push(
				projectViewManager.onProvidersReady(() => {
					this.logger.debug(
						"Received onProvidersReady event - checking if population needed",
					);
					this.debouncedCheckAndPopulate();
				}),
			);
		}

		// Subscribe to TreeView visibility changes
		// Handles normal open/close by user after startup
		this.context.subscriptions.push(
			this.treeView.onDidChangeVisibility((e) => {
				this.logger.debug(`TreeView visibility changed: ${e.visible}`);
				if (e.visible) {
					this.debouncedCheckAndPopulate();
				}
			}),
		);

		// Subscribe to workspace folder changes to automatically refresh filter
		// when user adds/removes workspace folders (File > Add Folder to Workspace)
		this.workspaceFolderChangeSubscription =
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.scheduleWorkspaceFolderChangeRefresh();
			});
	}

	/**
	 * Debounced check and populate
	 *
	 * Batches rapid events (onProvidersReady + onDidChangeVisibility)
	 * into a single population attempt after 100ms delay.
	 *
	 * @private
	 */
	private debouncedCheckAndPopulate(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			void this.checkAndPopulate();
		}, ExtensionFilterViewManager.DEBOUNCE_DELAY_MS);
	}

	/**
	 * Check conditions and populate if needed
	 *
	 * Guards prevent duplicate work:
	 * - Skip if already loading or ready
	 * - Skip if view not visible
	 * - Skip if no providers available
	 *
	 * @private
	 */
	private async checkAndPopulate(): Promise<void> {
		// Guard: Already loading or ready
		if (this.state !== "uninitialized") {
			this.logger.debug(`Population skipped: state is ${this.state}`);
			return;
		}

		// Guard: View not visible
		if (!this.treeView.visible) {
			this.logger.debug("Population skipped: view not visible");
			return;
		}

		// Guard: No providers
		if (!this.projectViewManager) {
			this.logger.debug("Population skipped: no project view manager");
			return;
		}

		const providers = this.projectViewManager.getAllProviders();
		if (providers.length === 0) {
			this.logger.debug("Population skipped: no providers available");
			return;
		}

		// All guards passed - populate!
		this.logger.info("Populating extension filter view");
		await this.populate();
	}

	/**
	 * Populate filter view with current extension data
	 *
	 * Orchestrates the full population flow:
	 * 1. Set state to loading
	 * 2. Discover extensions from providers
	 * 3. Update state manager with workspace IDs
	 * 4. Update view with data
	 * 5. Setup auto-refresh subscriptions
	 * 6. Set state to ready
	 *
	 * Error recovery: Reset to uninitialized (allows retry)
	 *
	 * @private
	 */
	private async populate(): Promise<void> {
		const startTime = Date.now();
		this.state = "loading";

		try {
			// Step 1: Discover extensions from all providers
			const { extensionData, workspaceDisplayNames } =
				await this.discoverExtensions();

			if (extensionData.length === 0) {
				this.handleNoExtensions();
				return;
			}

			// Step 2: Update state manager with workspace IDs and initialize extensions
			this.updateStateManager(extensionData);

			// Step 3: Update view with discovered data
			await this.updateViewWithData(extensionData, workspaceDisplayNames);

			// Step 4: Setup auto-refresh (subscribe to provider events)
			this.setupAutoRefresh(workspaceDisplayNames);

			// Success!
			this.state = "ready";
			const elapsed = Date.now() - startTime;
			this.logger.info(
				`Filter populated with ${extensionData.length} extensions in ${elapsed}ms`,
			);
		} catch (error) {
			this.handlePopulationError(error);
		}
	}

	/**
	 * Discover extensions from all providers
	 *
	 * Direct implementation - no command indirection.
	 * Reads current Git changes from providers and builds extension metadata.
	 *
	 * @returns Extension data and workspace display names
	 * @private
	 */
	private async discoverExtensions(): Promise<{
		extensionData: FileExtensionInfo[];
		workspaceDisplayNames: Map<string, string>;
	}> {
		// Import discovery utilities
		const { countExtensionsByWorkspace, buildExtensionMetadata } = await import(
			"../utils/extension-discovery.js"
		);

		// Get all providers and workspace names
		const allProviders = this.projectViewManager?.getAllProviders() || [];
		const workspaceDisplayNames =
			this.projectViewManager?.getAllWorkspaceDisplayNames() ||
			new Map<string, string>();

		this.logger.debug(
			`Discovering extensions from ${allProviders.length} providers`,
		);

		// Collect current changes from all providers
		// CRITICAL: Use getCurrentChangesUnfiltered() to discover ALL extensions in Git
		// regardless of current filter state. This prevents the catch-22 where we only
		// discover extensions from already-filtered files.
		const workspaceData = allProviders
			.map(({ provider, slotId }) => {
				try {
					// Use unfiltered method to get ALL Git changes
					const changes = provider.getCurrentChangesUnfiltered();

					// DEBUG: Log what we're getting from each provider
					const extensions = new Set(
						changes.map((c) => {
							const ext =
								c.uri.fsPath.match(/\.([^.]+)$/)?.[0] || "(no extension)";
							return ext;
						}),
					);
					this.logger.debug(
						`Provider ${slotId}: ${changes.length} files, extensions: ${Array.from(extensions).join(", ")}`,
					);

					return { workspace: slotId, changes };
				} catch (error) {
					this.logger.error(
						`Provider ${slotId} error:`,
						error instanceof Error ? error : undefined,
					);
					return { workspace: slotId, changes: [] };
				}
			})
			.filter((ws) => ws.changes.length > 0);

		if (workspaceData.length === 0) {
			this.logger.debug("No Git changes found in any workspace");
			return { extensionData: [], workspaceDisplayNames };
		}

		// Build extension metadata
		const extensionCounts = countExtensionsByWorkspace(workspaceData);
		const extensionData = buildExtensionMetadata(extensionCounts);

		// DEBUG: Log discovered extensions
		const discoveredExts = extensionData.map((e) => e.extension).join(", ");
		this.logger.debug(
			`Discovered ${extensionData.length} unique extensions: ${discoveredExts}`,
		);

		// DEBUG: Log current filter state for comparison
		for (const { slotId } of allProviders) {
			const enabledExts = this.filterState.getEnabledExtensions(slotId);
			if (enabledExts.size > 0) {
				this.logger.debug(
					`Active filter for ${slotId}: ${Array.from(enabledExts).join(", ")}`,
				);
			}
		}

		return { extensionData, workspaceDisplayNames };
	}

	/**
	 * Update state manager with current workspace IDs and discovered extensions
	 *
	 * StateManager needs to know which workspaces exist so it can
	 * properly manage per-workspace checkbox state.
	 *
	 * CRITICAL: Ensure newly discovered extensions are enabled by default.
	 * Empty set (no checkboxes) = show ALL files (semantic correctness).
	 *
	 * @param extensionData - Discovered extensions to initialize
	 * @private
	 */
	private updateStateManager(extensionData: FileExtensionInfo[]): void {
		const allProviders = this.projectViewManager?.getAllProviders() || [];
		const workspaceIds = allProviders.map(({ slotId }) => slotId);

		// Update state manager with current workspace IDs
		this.stateManager.setWorkspaces(workspaceIds);

		// No initialization needed for newly discovered extensions!
		// Extensions not in filter state automatically render as unchecked.
		// This gives us the correct UX:
		// - All unchecked = show ALL files (no workspace entry in filters map)
		// - Check some = show only those (workspace entry created with enabled extensions)
		// User choices are already preserved in filterState (persisted to storage)

		this.logger.debug(
			`State manager updated: ${workspaceIds.length} workspaces, ${extensionData.length} extensions`,
		);
	}

	/**
	 * Update view with discovered extension data
	 *
	 * Calls existing updateData() method which:
	 * - Updates provider's extension list
	 * - Sets up checkbox handler
	 * - Shows view if hidden
	 *
	 * @private
	 */
	private async updateViewWithData(
		extensionData: FileExtensionInfo[],
		workspaceDisplayNames: Map<string, string>,
	): Promise<void> {
		// Get checkbox handler for state updates
		const onCheckboxChange = (
			event: vscode.TreeCheckboxChangeEvent<FilterNode>,
		) => {
			this.logger.info("=== CHECKBOX CLICKED ===");
			this.logger.info(`Event items: ${event.items.length}`);

			// Handle checkbox state changes
			// VS Code sends different events for parent vs child clicks
			for (const [node, state] of event.items) {
				const checked = state === vscode.TreeItemCheckboxState.Checked;

				if (node.type === "extension") {
					// Parent clicked: Set all workspaces for this extension
					this.logger.info(
						`Setting extension ${node.extension} to ${checked} for ALL workspaces`,
					);
					this.stateManager.setAllWorkspaces(node.extension, checked);
				} else if (node.type === "workspace") {
					// Child clicked: Set single workspace for this extension
					this.logger.info(
						`Setting extension ${node.extension} to ${checked} for workspace ${node.workspace}`,
					);
					this.stateManager.setEnabled(node.extension, node.workspace, checked);
				}
			}

			// CRITICAL: Directly refresh TreeView to update checkboxes
			// This ensures UI updates immediately instead of relying on event subscriptions
			this.logger.info("Triggering direct TreeView refresh");
			this.provider.forceRefresh();

			// CRITICAL DEBUGGING: Log current filter state for ALL workspaces
			const allProviders = this.projectViewManager?.getAllProviders() || [];
			this.logger.info("=== CURRENT FILTER STATE ===");
			for (const { slotId } of allProviders) {
				const enabledExts = this.filterState.getEnabledExtensions(slotId);
				const isFiltered = this.filterState.isFiltered(slotId);
				this.logger.info(
					`Workspace ${slotId}: filtered=${isFiltered}, enabled=[${Array.from(enabledExts).join(", ")}]`,
				);
			}

			// Refresh all Git change providers to apply new filter
			for (const { provider, slotId } of allProviders) {
				this.logger.info(`Refreshing provider: ${slotId}`);
				provider.refresh();
				this.logger.info(`Provider ${slotId} refresh() called`);
			}

			this.logger.info("Checkbox handler complete - UI refreshed");
		};

		// Update view via existing method
		await this.updateData(
			extensionData,
			this.stateManager,
			workspaceDisplayNames,
			onCheckboxChange,
		);

		this.logger.debug("View updated with extension data");
	}

	/**
	 * Setup auto-refresh by subscribing to provider events
	 *
	 * When Git changes update, filter auto-refreshes to stay in sync.
	 * Uses existing subscribeToProviders() method.
	 *
	 * NOTE: Checkbox changes now use direct refresh (see updateViewWithData)
	 * instead of event subscriptions to avoid complex event chain issues.
	 *
	 * @private
	 */
	private setupAutoRefresh(workspaceDisplayNames: Map<string, string>): void {
		const allProviders = this.projectViewManager?.getAllProviders() || [];

		// Subscribe to provider events (Git changes)
		this.subscribeToProviders(allProviders, workspaceDisplayNames);

		this.logger.debug(
			"Auto-refresh subscriptions established (Git changes only)",
		);
	}

	/**
	 * Handle no extensions found
	 *
	 * Reset to uninitialized so user can retry when changes are made.
	 *
	 * @private
	 */
	private handleNoExtensions(): void {
		this.state = "uninitialized";
		this.logger.info("No extensions found - filter remains empty");
	}

	/**
	 * Handle population error
	 *
	 * Reset to uninitialized (allows retry).
	 * Log error for debugging.
	 *
	 * @private
	 */
	private handlePopulationError(error: unknown): void {
		this.state = "uninitialized";
		this.logger.error(
			"Failed to populate extension filter",
			error instanceof Error ? error : undefined,
		);
	}

	/**
	 * Check if view has been populated with data
	 *
	 * Used by command to determine toggle behavior.
	 */
	hasDataPopulated(): boolean {
		return this.state === "ready";
	}

	/**
	 * Update the tree provider with new data
	 *
	 * Called by the filter command when user invokes it.
	 * Updates the existing provider WITHOUT recreating TreeView or provider.
	 *
	 * CRITICAL: Keeps same TreeView and provider instances - just updates their data!
	 *
	 * @param extensionData - New extension metadata
	 * @param stateManager - State manager for filter state
	 * @param workspaceDisplayNames - Workspace display names
	 * @param onCheckboxChange - Optional callback for checkbox state changes
	 */
	async updateData(
		extensionData: FileExtensionInfo[],
		stateManager: FilterStateManager,
		workspaceDisplayNames: Map<string, string>,
		onCheckboxChange?: (
			event: vscode.TreeCheckboxChangeEvent<FilterNode>,
		) => void,
	): Promise<void> {
		// Note: stateManager is now created once in constructor and reused
		// This method just updates its data, no disposal needed

		// Update the provider's data (provider handles state manager updates internally)
		this.provider.updateData(
			extensionData,
			workspaceDisplayNames,
			stateManager,
		);

		// Note: Population state managed via state machine, not boolean flags

		// Wire up checkbox handler if provided
		if (onCheckboxChange) {
			// Dispose old checkbox handler if exists
			if (this.checkboxDisposable) {
				this.checkboxDisposable.dispose();
			}

			this.checkboxDisposable =
				this.treeView.onDidChangeCheckboxState(onCheckboxChange);
			this.context.subscriptions.push(this.checkboxDisposable);
		}

		// Ensure view is visible when populated with data
		if (extensionData.length > 0 && !this.isViewVisible) {
			await this.toggle(); // Show the view
		}

		// TreeView will automatically refresh via provider's onDidChangeTreeData event
	}

	/**
	 * Toggle TreeView visibility
	 *
	 * Toggles the view between visible and hidden states.
	 * Persists the state across extension reloads.
	 *
	 * @returns Promise that resolves when toggle is complete
	 */
	async toggle(): Promise<void> {
		this.isViewVisible = !this.isViewVisible;

		// Save state to persistent storage
		await this.context.globalState.update(
			ExtensionFilterViewManager.VISIBILITY_KEY,
			this.isViewVisible,
		);

		// Update VS Code context to show/hide view
		await vscode.commands.executeCommand(
			"setContext",
			ExtensionFilterViewManager.VISIBILITY_CONTEXT,
			this.isViewVisible,
		);
	}

	/**
	 * Check if TreeView is currently visible
	 */
	isVisible(): boolean {
		return this.isViewVisible;
	}

	/**
	 * Subscribe to provider refresh events for automatic extension discovery
	 *
	 * Uses VS Code native Event<T> pattern - subscribes to each provider's
	 * onDidChangeTreeData event and calls refreshExtensions() when Git changes update.
	 *
	 * Best Practices:
	 * - Uses vscode.Disposable[] for proper cleanup
	 * - Disposes old subscriptions before creating new ones (prevent memory leaks)
	 * - Debounces refresh calls for performance
	 *
	 * @param providers - Array of providers with their slot IDs
	 * @param workspaceDisplayNames - Map of workspace IDs to display names
	 */
	subscribeToProviders(
		providers: Array<{ provider: SortedGitChangesProvider; slotId: string }>,
		workspaceDisplayNames: Map<string, string>,
	): void {
		// Store for refresh mechanism
		this.currentProviders = providers;
		this.currentWorkspaceDisplayNames = workspaceDisplayNames;

		// Dispose old subscriptions (prevents memory leaks)
		for (const disposable of this.providerSubscriptions) {
			disposable.dispose();
		}
		this.providerSubscriptions = [];

		// Subscribe to each provider's onDidChangeTreeData event (VS Code native Event)
		for (const { provider } of providers) {
			// VS Code native pattern: Event<T> returns Disposable
			const subscription = provider.onDidChangeTreeData(() => {
				// Debounce: multiple providers might fire at once
				this.scheduleRefresh();
			});
			this.providerSubscriptions.push(subscription);
		}
	}

	/**
	 * Schedule a debounced refresh
	 *
	 * Uses native setTimeout for debouncing - waits 500ms after last event
	 * before executing refresh. This prevents excessive re-discovery when
	 * multiple providers fire events rapidly (e.g., file system watcher).
	 *
	 * Performance:
	 * - Multiple events within 500ms → Single refresh
	 * - Typical scenario: 5 events → 1 refresh (5x improvement)
	 *
	 * @private
	 */
	private scheduleRefresh(): void {
		// Clear existing timer (debounce)
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}

		// Schedule refresh after 500ms (allows multiple events to settle)
		this.refreshTimer = setTimeout(() => {
			void this.refreshExtensions();
		}, 500);
	}

	/**
	 * Refresh extension list by re-discovering from all providers
	 *
	 * Called automatically when Git changes update (via subscribeToProviders).
	 * Re-discovers extensions and updates TreeView while preserving filter state.
	 *
	 * Architecture:
	 * - Re-collects Git changes from providers (getCurrentChanges)
	 * - Re-discovers extensions (buildExtensionMetadata)
	 * - Updates TreeView via provider.updateData()
	 * - FilterStateManager preserves checkbox state (source of truth)
	 *
	 * Error Handling:
	 * - Gracefully handles providers that throw errors
	 * - Continues with remaining providers
	 * - Shows empty state if all providers fail
	 *
	 * @private
	 */
	private async refreshExtensions(): Promise<void> {
		if (!this.currentProviders || !this.currentWorkspaceDisplayNames) {
			return; // Not initialized yet
		}

		try {
			// Import extension discovery utilities
			const { countExtensionsByWorkspace, buildExtensionMetadata } =
				await import("../utils/extension-discovery.js");

			// Collect current Git changes from all providers
			const workspaceData = this.currentProviders
				.map(({ provider, slotId }) => {
					try {
						// VS Code native: providers expose getCurrentChanges()
						const changes = provider.getCurrentChanges();
						return { workspace: slotId, changes };
					} catch (error) {
						// Graceful degradation: skip providers that error
						console.error(
							`Extension filter refresh: Provider ${slotId} error:`,
							error,
						);
						return { workspace: slotId, changes: [] };
					}
				})
				.filter((ws) => ws.changes.length > 0);

			// Handle empty state (all changes committed/discarded)
			if (workspaceData.length === 0) {
				// Update TreeView to show empty state
				this.provider.updateData(
					[],
					this.currentWorkspaceDisplayNames,
					this.stateManager,
				);
				return;
			}

			// Re-discover extensions from current Git changes
			const extensionCounts = countExtensionsByWorkspace(workspaceData);
			const extensionData = buildExtensionMetadata(extensionCounts);

			// Update TreeView with new data
			// IMPORTANT: FilterStateManager preserves checkbox state (source of truth)
			this.provider.updateData(
				extensionData,
				this.currentWorkspaceDisplayNames,
				this.stateManager,
			);

			// Note: State management now uses state machine, not boolean flags
		} catch (error) {
			// Non-fatal: log error but don't crash extension
			console.error("Extension filter refresh failed:", error);
		}
	}

	/**
	 * Schedule a debounced refresh when workspace folders change
	 *
	 * Uses native setTimeout for debouncing - waits 500ms after last event
	 * before executing re-subscription. This prevents excessive refreshes when
	 * multiple workspace folders are added/removed rapidly.
	 *
	 * Performance:
	 * - Multiple workspace folder changes within 500ms → Single refresh
	 * - Typical scenario: Add 3 folders → 1 refresh (3x improvement)
	 *
	 * @private
	 */
	private scheduleWorkspaceFolderChangeRefresh(): void {
		// Clear existing timer (debounce)
		if (this.workspaceFolderChangeTimer) {
			clearTimeout(this.workspaceFolderChangeTimer);
		}

		// Schedule refresh after 500ms (allows multiple events to settle)
		this.workspaceFolderChangeTimer = setTimeout(() => {
			void this.resubscribeToProviders();
		}, 500);
	}

	/**
	 * Re-subscribe to all providers when workspace folders change
	 *
	 * Called automatically when workspace folders are added/removed.
	 * Gets updated provider list from ProjectViewManager and re-subscribes
	 * to ensure new workspace providers are included.
	 *
	 * Architecture:
	 * - Queries ProjectViewManager.getAllProviders() for current providers
	 * - Calls subscribeToProviders() to re-subscribe (disposes old subscriptions)
	 * - WAITS for provider events (does NOT call refreshExtensions immediately)
	 *
	 * Why We Don't Refresh Immediately:
	 * When a new workspace folder is added, the provider is created and initialized
	 * but Git data (repo.state.workingTreeChanges) is loaded ASYNCHRONOUSLY.
	 * Calling refreshExtensions() immediately would read empty data and show
	 * incomplete extensions to the user.
	 *
	 * Instead, we rely on the event-driven architecture:
	 * 1. Provider loads Git data asynchronously
	 * 2. Provider fires onDidChangeTreeData when data is ready
	 * 3. Our subscription (above) receives the event
	 * 4. scheduleRefresh() is called automatically
	 * 5. refreshExtensions() runs with ACTUAL data
	 *
	 * This prevents race conditions and ensures users see correct data.
	 *
	 * Use Cases:
	 * - User adds workspace folder: New provider is created, filter waits for Git data
	 * - User removes workspace folder: Filter unsubscribes from removed provider
	 *
	 * Best Practices:
	 * - Uses VS Code native workspace.onDidChangeWorkspaceFolders event
	 * - Properly disposes old subscriptions (subscribeToProviders handles this)
	 * - Debounced to prevent excessive refreshes
	 * - Event-driven: No premature data reads
	 *
	 * @private
	 */
	private async resubscribeToProviders(): Promise<void> {
		if (!this.projectViewManager) {
			return; // No project view manager, can't get updated providers
		}

		if (!this.currentWorkspaceDisplayNames) {
			return; // Not initialized yet
		}

		try {
			// Get ALL providers (includes newly added workspace providers)
			const allProviders = this.projectViewManager.getAllProviders();

			// Re-subscribe to all providers (disposes old subscriptions first)
			// This ensures we're subscribed to any new providers that were created
			// when workspace folders were added.
			//
			// When the provider finishes loading Git data, it will fire onDidChangeTreeData,
			// which triggers scheduleRefresh() → refreshExtensions() automatically.
			// This ensures we read actual data, not empty arrays from unloaded providers.
			this.subscribeToProviders(
				allProviders,
				this.currentWorkspaceDisplayNames,
			);

			// NOTE: We do NOT call refreshExtensions() here (removed to fix race condition)
			// Provider events will trigger refresh when Git data is ready
		} catch (error) {
			// Non-fatal: log error but don't crash extension
			console.error("Extension filter re-subscription failed:", error);
		}
	}

	/**
	 * Sync TreeView checkbox state with loaded filter state
	 *
	 * Call this immediately after construction to ensure checkbox state
	 * reflects the loaded application state instead of VS Code's persisted UI state.
	 *
	 * CRITICAL: Must be called BEFORE view becomes visible to prevent flashing
	 */
	syncTreeWithLoadedState(): void {
		this.logger.debug("Syncing TreeView with loaded filter state");

		// Force provider to refresh tree
		// This re-queries getTreeItem() which computes checkbox state from filterState
		this.provider.forceRefresh();

		this.logger.info(
			"TreeView checkbox state synced with loaded application state",
		);
	}

	/**
	 * Dispose of all resources
	 *
	 * VS Code best practice: Properly dispose all subscriptions and timers
	 * to prevent memory leaks.
	 */
	dispose(): void {
		// Clear debounce timer (population)
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}

		// Dispose provider subscriptions (VS Code native Disposable[])
		for (const disposable of this.providerSubscriptions) {
			disposable.dispose();
		}
		this.providerSubscriptions = [];

		// Clear pending refresh timer (native setTimeout cleanup)
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}

		// Clear pending workspace folder change timer (native setTimeout cleanup)
		if (this.workspaceFolderChangeTimer) {
			clearTimeout(this.workspaceFolderChangeTimer);
			this.workspaceFolderChangeTimer = undefined;
		}

		// Dispose workspace folder change subscription (VS Code native Disposable)
		if (this.workspaceFolderChangeSubscription) {
			this.workspaceFolderChangeSubscription.dispose();
			this.workspaceFolderChangeSubscription = undefined;
		}

		// Dispose state manager
		if (this.stateManager) {
			this.stateManager.dispose();
		}

		// Dispose provider
		if (this.provider) {
			this.provider.dispose();
		}

		// Dispose checkbox handler
		if (this.checkboxDisposable) {
			this.checkboxDisposable.dispose();
		}

		// Dispose TreeView
		if (this.treeView) {
			this.treeView.dispose();
		}
	}
}
