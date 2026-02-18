/**
 * Extension-Based File Filter Command Handler
 *
 * This module implements the command handler for filtering Git changes by file extension.
 * Uses TreeView with hierarchical checkboxes for proper parent-child state management.
 *
 * Architecture:
 * - FilterStateManager: Event-driven state management
 * - ExtensionFilterTreeProvider: Hierarchical tree with checkboxes
 * - TreeView API: Native VS Code hierarchy support
 *
 * Usage: This is integrated into extension.ts as the commandCentral.gitSort.changeFileFilter command.
 */

import * as vscode from "vscode";
import { FilterStateManager } from "../state/filter-state-manager.js";
import type {
	IExtensionFilterState,
	IExtensionFilterViewManager,
	ILoggerService,
	IProjectViewManager,
} from "../types/service-interfaces.js";

/**
 * Executes the extension filter command
 *
 * Shows a TreeView with hierarchical checkboxes for filtering Git changes by extension:
 * - Parent nodes: Extensions (e.g., ".ts (TypeScript)")
 * - Child nodes: Workspaces (e.g., "Frontend — 10 files")
 * - Semantic correctness: Parent checked = ALL children checked
 *
 * Note: TreeView is persistent and registered at activation time. This command
 * populates it with current extension data and reveals it to the user.
 *
 * @param projectViewManager - View manager providing access to providers
 * @param extensionFilterState - Filter state manager (persistence layer)
 * @param logger - Logger for command execution
 * @param viewManager - Extension filter view manager (manages TreeView lifecycle)
 */
export async function execute(
	projectViewManager: IProjectViewManager | undefined,
	extensionFilterState: IExtensionFilterState | undefined,
	logger: ILoggerService,
	viewManager: IExtensionFilterViewManager,
): Promise<void> {
	logger.info("🔍 Extension filter command invoked");

	try {
		// FEATURE: Toggle view if already visible and populated
		if (viewManager.isVisible() && viewManager.hasDataPopulated()) {
			logger.info("Toggling extension filter view (hide)");
			await viewManager.toggle();
			return;
		}

		// Guard: Reload race condition
		if (projectViewManager?.isReloading()) {
			vscode.window.showWarningMessage(
				"Command Central is reloading. Please try again in a moment.",
			);
			return;
		}

		// Step 1: Get ALL providers (including collapsed/hidden workspaces)
		// CRITICAL: We collect extensions from ALL workspaces, not just visible ones.
		// This ensures collapsed TreeViews are included in the filter.
		// Users expect to see ALL extensions regardless of TreeView expansion state.
		const allProviders = projectViewManager?.getAllProviders() || [];

		if (allProviders.length === 0) {
			vscode.window.showWarningMessage(
				"No workspace providers found. Ensure workspaces are loaded.",
			);
			return;
		}

		logger.debug(
			`Collecting extensions from ${allProviders.length} workspace(s)`,
		);

		// Get clean workspace display names (without sort indicators or file counts)
		const workspaceDisplayNames =
			projectViewManager?.getAllWorkspaceDisplayNames() ||
			new Map<string, string>();

		// Step 2: Discover extensions from ALL workspaces
		const { countExtensionsByWorkspace, buildExtensionMetadata } = await import(
			"../utils/extension-discovery.js"
		);

		// Collect all changes from ALL providers (not just visible ones)
		const workspaceData = allProviders
			.map(({ provider, slotId }) => {
				try {
					const changes = provider.getCurrentChanges();
					return { workspace: slotId, changes };
				} catch (error) {
					logger.error(`Failed to get changes for ${slotId}:`, error);
					return { workspace: slotId, changes: [] };
				}
			})
			.filter((ws) => ws.changes.length > 0);

		// Guard: No Git changes
		if (workspaceData.length === 0) {
			vscode.window.showInformationMessage(
				"No Git changes found. Make some changes to filter by extension.",
			);
			return;
		}

		logger.debug(`Collected changes from ${workspaceData.length} workspace(s)`);

		// Step 3: Build extension metadata
		const extensionCounts = countExtensionsByWorkspace(workspaceData);
		let extensionData = buildExtensionMetadata(extensionCounts);

		// Performance limit: Show top N extensions if too many
		const config = vscode.workspace.getConfiguration(
			"commandCentral.fileFilter",
		);
		const maxExtensions = config.get<number>("maxExtensions", 50);

		if (extensionData.length > maxExtensions) {
			extensionData = extensionData
				.sort((a, b) => b.totalCount - a.totalCount)
				.slice(0, maxExtensions);

			logger.warn(
				`Showing top ${maxExtensions} extensions (${extensionCounts.size} total)`,
			);
		}

		if (extensionData.length === 0) {
			vscode.window.showInformationMessage(
				"No file extensions detected in Git changes.",
			);
			return;
		}

		logger.debug(
			`Built extension metadata for ${extensionData.length} extensions`,
		);

		// Step 4: Create FilterStateManager (event-driven wrapper)
		if (!extensionFilterState) {
			vscode.window.showErrorMessage("Extension filter state not initialized");
			return;
		}

		// Use ALL workspace IDs (not just visible ones) for state management
		const workspaceIds = allProviders.map(({ slotId }) => slotId);
		const stateManager = new FilterStateManager(
			extensionFilterState,
			workspaceIds,
		);

		// Step 5: Update TreeView with new data
		// The view manager was already created at activation with an empty provider
		// Now we populate it with real extension data
		await viewManager.updateData(
			extensionData,
			stateManager,
			workspaceDisplayNames,
			(event) => {
				// Handle checkbox state changes by updating the state directly
				//
				// CRITICAL FIX: VS Code sends different events for parent vs child clicks:
				// - Parent click: event.items contains parent + all children
				// - Child click: event.items contains only the clicked child
				//
				// We must detect which case we're in to avoid resetting all state

				// DEBUG LOGGING
				logger.info("=== CHECKBOX EVENT ===");
				logger.info(`Event items count: ${event.items.length}`);
				const eventDetails = Array.from(event.items).map(([node, state]) => ({
					type: node.type,
					extension: node.extension,
					workspace: node.type === "workspace" ? node.workspace : undefined,
					state:
						state === vscode.TreeItemCheckboxState.Checked
							? "checked"
							: "unchecked",
				}));
				logger.info(`Event details: ${JSON.stringify(eventDetails, null, 2)}`);

				// CRITICAL FIX: Detect child-triggered parent updates
				// When user clicks a CHILD, VS Code sends: [child, parent]
				// When user clicks a PARENT, VS Code sends: [parent, child1, child2, ...]
				const itemsArray = Array.from(event.items);
				const hasParentNode = itemsArray.some(
					([node, _state]) => node.type === "extension",
				);
				const firstItemIsChild =
					itemsArray[0] && itemsArray[0][0].type === "workspace";
				const isChildTriggeredUpdate = hasParentNode && firstItemIsChild;

				logger.info(`Has parent node: ${hasParentNode}`);
				logger.info(`First item is child: ${firstItemIsChild}`);
				logger.info(`Child-triggered update: ${isChildTriggeredUpdate}`);

				if (isChildTriggeredUpdate) {
					// Child checkbox was clicked, parent updated automatically
					// Process ONLY the child, ignore the auto-updated parent
					logger.info("Processing child-triggered update (ignoring parent)");
					for (const [element, state] of event.items) {
						if (element.type === "workspace") {
							const enabled = state === vscode.TreeItemCheckboxState.Checked;
							logger.info(
								`Calling setEnabled("${element.extension}", "${element.workspace}", ${enabled})`,
							);
							stateManager.setEnabled(
								element.extension,
								element.workspace,
								enabled,
							);
							break; // Only process the first child (the one user clicked)
						}
					}
				} else if (hasParentNode) {
					// Parent checkbox was clicked directly by user
					// Process ONLY the parent (affects all workspaces)
					logger.info("Processing parent-triggered update");
					for (const [element, state] of event.items) {
						if (element.type === "extension") {
							const enabled = state === vscode.TreeItemCheckboxState.Checked;
							logger.info(
								`Calling setAllWorkspaces("${element.extension}", ${enabled})`,
							);
							stateManager.setAllWorkspaces(element.extension, enabled);
							break; // Only one parent in the event
						}
					}
				} else {
					// Only workspace nodes, no parent (shouldn't happen, but handle it)
					logger.info("Processing workspace-only update");
					for (const [element, state] of event.items) {
						const enabled = state === vscode.TreeItemCheckboxState.Checked;
						if (element.type === "workspace") {
							logger.info(
								`Calling setEnabled("${element.extension}", "${element.workspace}", ${enabled})`,
							);
							stateManager.setEnabled(
								element.extension,
								element.workspace,
								enabled,
							);
						}
					}
				}

				// DEBUG: Log state after update
				logger.info("=== STATE AFTER UPDATE ===");
				for (const workspaceId of workspaceIds) {
					const enabled =
						extensionFilterState?.getEnabledExtensions(workspaceId);
					logger.info(
						`Workspace ${workspaceId}: ${JSON.stringify(Array.from(enabled || []))}`,
					);
				}

				// Refresh ALL providers when filter state changes (not just visible ones)
				// This ensures collapsed workspaces also respect the filter changes
				for (const { provider } of allProviders) {
					provider.refresh();
				}

				// Status bar feedback
				const enabledExtensions = new Set<string>();
				for (const workspaceId of workspaceIds) {
					const enabled =
						extensionFilterState.getEnabledExtensions(workspaceId);
					for (const ext of enabled) {
						enabledExtensions.add(ext);
					}
				}

				if (enabledExtensions.size === 0) {
					vscode.window.setStatusBarMessage("✓ Showing all files", 2000);
				} else {
					const extensions = Array.from(enabledExtensions).sort().join(", ");
					vscode.window.setStatusBarMessage(`✓ Filtering: ${extensions}`, 2000);
				}

				logger.info(
					`Filter updated: ${Array.from(enabledExtensions).join(", ") || "none"}`,
				);
			},
		);

		// Step 6: Subscribe to ALL provider events for automatic refresh
		// CRITICAL FIX: Subscribe to ALL providers (not just visible ones)
		// This ensures filter updates when user switches workspaces.
		//
		// Why ALL providers?
		// - User opens filter viewing workspace A (subscribes to A only - WRONG!)
		// - User clicks workspace B (B loads data, but we're not subscribed)
		// - Filter doesn't update (BUG!)
		// - User must hide/show filter (press 'f' twice) to refresh
		//
		// Fix: Subscribe to ALL providers from ProjectViewManager
		// - Any workspace that loads data triggers refresh
		// - Workspace switches handled automatically
		// - No special visibility tracking needed
		//
		// Uses VS Code native Event<T> pattern - subscribes to onDidChangeTreeData
		// from ALL providers. When ANY provider fires event (Git changes update),
		// the filter automatically refreshes to show new/updated extensions.
		//
		// Best Practices:
		// - Subscribe to all data sources (VS Code pattern)
		// - Filter display by visibility in UI layer
		// - VS Code native Disposable[] for cleanup
		// - Debounced (500ms) to prevent excessive refreshes
		// - Preserves checkbox state via FilterStateManager
		// NOTE: allProviders was already declared at the top of this function
		viewManager.subscribeToProviders(allProviders, workspaceDisplayNames);

		logger.info(
			`Extension filter TreeView updated and subscribed to ${allProviders.length} provider events`,
		);
	} catch (error) {
		logger.error("Extension filter command failed:", error);
		vscode.window.showErrorMessage(
			`Failed to show extension filter: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
