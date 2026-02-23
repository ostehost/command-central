/**
 * Project View Manager
 *
 * Manages dynamic registration and lifecycle of project views.
 * Uses dependency injection for source-agnostic, testable architecture.
 *
 * Requirements:
 * - REQ-AR-001: Manager pattern for view registration
 * - REQ-VR-002: Dynamic view activation
 * - REQ-VR-003: Dual container support (Activity Bar + Panel)
 * - REQ-DI-001: Dependency injection for abstractions
 * - REQ-LG-001: Registration logging
 *
 * Architecture:
 * - Depends on ProjectConfigSource (where projects come from)
 * - Depends on ProviderFactory (how providers are created)
 * - Pure orchestration: No business logic, only view registration
 */

import * as vscode from "vscode";
import type { ProjectConfigSource } from "../config/project-config-source.js";
import type { ProjectViewConfig } from "../config/project-views.js";
import type { ProviderFactory } from "../factories/provider-factory.js";
import type { SortedGitChangesProvider } from "../git-sort/sorted-changes-provider.js";
import type { LoggerService } from "./logger-service.js";

/**
 * Manages dynamic registration of project views
 *
 * Lifecycle:
 * 1. registerAllProjects() - Load config, create providers, register views
 * 2. dispose() - Clean up views (factory cleanup handled separately)
 *
 * Design Philosophy:
 * - Manager orchestrates, doesn't create
 * - All creation delegated to factories
 * - All configuration delegated to sources
 * - Pure view registration logic only
 */
export class ProjectViewManager {
	private registeredViews = new Map<string, vscode.TreeView<unknown>>();
	// Changed from WeakMap to Map to allow iteration for active file tracking
	private treeViewProviders = new Map<
		vscode.TreeView<unknown>,
		SortedGitChangesProvider
	>();
	private reloadInProgress = false;

	private providerSlotMap = new Map<SortedGitChangesProvider, string>();

	// Per-view command disposables — disposed on reload to prevent "already exists" errors
	private perViewCommandDisposables: vscode.Disposable[] = [];

	// Clean workspace display names (for filter UI)
	// Maps slotId -> original displayName (without dynamic decorations like ▼, file counts)
	private slotDisplayNames = new Map<string, string>();

	// Providers ready event - fires once after all providers are registered
	// Critical for extension filter auto-population when view is already visible at startup
	private readonly _onProvidersReady = new vscode.EventEmitter<void>();
	readonly onProvidersReady: vscode.Event<void> = this._onProvidersReady.event;

	constructor(
		private context: vscode.ExtensionContext,
		private logger: LoggerService,
		private configSource: ProjectConfigSource,
		private providerFactory: ProviderFactory,
	) {
		// Set up active file tracking on construction
		this.setupActiveFileTracking();
	}

	/**
	 * Set up active file tracking
	 *
	 * Listens to editor changes and reveals the active file in the tree view,
	 * matching VS Code Explorer's "Reveal Active File" behavior.
	 *
	 * Behavior:
	 * - When editor changes, find file in tree
	 * - Reveal with highlight (select: true)
	 * - Don't steal focus (focus: false)
	 * - Expand parent groups (expand: true)
	 * - Respects commandCentral.trackActiveFile setting
	 *
	 * Performance:
	 * - O(n) search through current changes
	 * - Cached changes, fast lookup
	 * - No-op if file not in git changes
	 */
	private setupActiveFileTracking(): void {
		console.log("🔍 [ACTIVE FILE TRACKING] Setting up active file tracking...");
		this.logger.info("🔍 Setting up active file tracking...");

		this.context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(async (editor) => {
				console.log(
					`📝 [ACTIVE FILE TRACKING] Editor changed: ${editor ? editor.document.uri.fsPath : "undefined"}`,
				);
				this.logger.debug(
					`📝 Editor changed: ${editor ? editor.document.uri.fsPath : "undefined"}`,
				);

				// Check setting first (user can disable)
				const config = vscode.workspace.getConfiguration("commandCentral");
				const trackingEnabled = config.get("trackActiveFile", true);
				this.logger.debug(`⚙️  trackActiveFile setting: ${trackingEnabled}`);

				if (!trackingEnabled) {
					this.logger.debug("⏭️  Tracking disabled by setting");
					return;
				}

				// No-op if no active editor
				if (!editor) {
					this.logger.debug("⏭️  No active editor");
					return;
				}

				const fileUri = editor.document.uri;
				console.log(
					`🎯 [ACTIVE FILE TRACKING] Attempting to reveal: ${fileUri.fsPath}`,
				);
				console.log(
					`📊 [ACTIVE FILE TRACKING] Registered views count: ${this.registeredViews.size}`,
				);
				console.log(
					`📊 [ACTIVE FILE TRACKING] TreeView providers count: ${this.treeViewProviders.size}`,
				);
				this.logger.info(`🎯 Attempting to reveal: ${fileUri.fsPath}`);
				this.logger.debug(
					`📊 Registered views count: ${this.registeredViews.size}`,
				);
				this.logger.debug(
					`📊 TreeView providers count: ${this.treeViewProviders.size}`,
				);

				let viewsChecked = 0;
				let providersWithMethod = 0;
				let itemsFound = 0;

				// Find file in all registered tree views
				for (const [_viewId, treeView] of this.registeredViews) {
					viewsChecked++;

					// CRITICAL: Only reveal in views that are currently visible.
					// Without this check, reveal() forces hidden panels to open,
					// causing the cross-panel force-open bug (e.g., clicking a file
					// in the bottom panel forces the sidebar to open, and vice versa).
					if (!treeView.visible) {
						this.logger.debug(
							`⏭️  View ${viewsChecked} (${_viewId}): Skipping — not visible`,
						);
						continue;
					}

					const provider = this.treeViewProviders.get(treeView);
					if (!provider) {
						this.logger.debug(`⚠️  View ${viewsChecked}: No provider`);
						continue;
					}

					// Check if provider has findItemByUri method
					if (typeof provider.findItemByUri !== "function") {
						this.logger.debug(
							`⚠️  View ${viewsChecked}: Provider missing findItemByUri`,
						);
						continue;
					}

					providersWithMethod++;
					this.logger.debug(`🔎 View ${viewsChecked}: Searching for file...`);

					const item = provider.findItemByUri(fileUri);
					if (item) {
						itemsFound++;
						console.log(`[ACTIVE FILE] Revealing in view ID: ${_viewId}`);
						this.logger.info(
							`✅ View ${viewsChecked}: Found item! Revealing...`,
						);

						try {
							// Clean, native VS Code API approach
							// With getParent() implemented, reveal should work immediately
							await treeView.reveal(item, {
								select: true,
								focus: false, // Don't steal focus from editor
								expand: true, // Expand parent time groups
							});

							this.logger.info(`✅ Revealed: ${fileUri.fsPath}`);
						} catch (error) {
							this.logger.error(
								`❌ Reveal failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					} else {
						this.logger.debug(`⏭️  View ${viewsChecked}: Item not found`);
					}
				}

				this.logger.debug(
					`📊 Summary: Checked ${viewsChecked} views, ${providersWithMethod} with findItemByUri, found ${itemsFound} matches`,
				);
			}),
		);

		this.logger.info("✅ Active file tracking enabled");
	}

	/**
	 * Register all project views
	 *
	 * Requirements:
	 * - REQ-VR-002: Dynamic view activation
	 * - REQ-LG-001: Registration logging (INFO level)
	 *
	 * This is the main entry point called from extension.activate()
	 *
	 * Flow:
	 * 1. Load projects from configSource
	 * 2. For each project: create provider, register views
	 * 3. Log success
	 */
	async registerAllProjects(): Promise<void> {
		// Delegate to config source (abstraction)
		const projects = await this.configSource.loadProjects();

		this.logger.info(
			`Registering ${projects.length} project views in Activity Bar and Panel...`,
		);

		for (const project of projects) {
			await this.registerProjectView(project);
		}

		this.logger.info(
			`✅ Successfully registered ${projects.length} project views (${this.registeredViews.size} total view instances)`,
		);

		// Fire event to notify consumers (like extension filter) that providers are ready
		// This is critical for auto-population when filter view is already visible at startup
		this._onProvidersReady.fire();
		this.logger.debug("Fired onProvidersReady event");
	}

	/**
	 * Reload all project views
	 *
	 * Requirements:
	 * - REQ-RELOAD-001: Dispose views before reloading
	 * - REQ-RELOAD-002: Dispose providers via factory
	 * - REQ-RELOAD-003: Prevent concurrent reloads
	 * - REQ-RELOAD-004: Handle errors gracefully
	 *
	 * Called when workspace folders change (add/remove folders).
	 *
	 * Flow:
	 * 1. Check guard flag (prevent concurrent reloads)
	 * 2. Dispose all registered views
	 * 3. Clear view Map
	 * 4. Dispose providers via factory
	 * 5. Re-register all projects
	 * 6. Reset guard flag
	 *
	 * Performance: 500-750ms for 10 folders (realistic target)
	 */
	async reload(): Promise<void> {
		if (this.reloadInProgress) {
			this.logger.debug("Reload already in progress");
			return;
		}

		this.reloadInProgress = true;
		const startTime = performance.now();

		try {
			this.logger.info("Reloading project views...");

			// Dispose per-view commands first (prevents "already exists" on re-register)
			for (const d of this.perViewCommandDisposables) {
				d?.dispose();
			}
			this.perViewCommandDisposables = [];

			// Dispose all views
			for (const view of this.registeredViews.values()) {
				view.dispose();
			}
			this.registeredViews.clear();

			// Clear display names (will be repopulated during re-registration)
			this.slotDisplayNames.clear();

			// Note: treeViewProviders WeakMap auto-cleans when TreeViews are disposed

			// Dispose providers (factory stays alive)
			await this.providerFactory.dispose();

			// Re-register all projects
			await this.registerAllProjects();

			const duration = performance.now() - startTime;
			this.logger.info(`Views reloaded in ${duration.toFixed(0)}ms`);
		} catch (error) {
			this.logger.error("Failed to reload:", error);
			vscode.window.showErrorMessage("Failed to reload project views");
		} finally {
			this.reloadInProgress = false;
		}
	}

	/**
	 * Check if reload is currently in progress
	 * Used by keybinding commands to prevent crashes during reload
	 *
	 * @returns True if reload is in progress
	 */
	isReloading(): boolean {
		return this.reloadInProgress;
	}

	/**
	 * Get provider for a TreeView
	 * Used by View Action commands (VS Code passes TreeView as first argument)
	 *
	 * @param treeView - The TreeView object passed by VS Code to view/title commands
	 * @returns The provider associated with this TreeView, or undefined
	 */
	getProviderForTreeView(
		treeView: vscode.TreeView<unknown>,
	): SortedGitChangesProvider | undefined {
		if (!treeView) {
			this.logger.warn("getProviderForTreeView called with null/undefined");
			return undefined;
		}

		const provider = this.treeViewProviders.get(treeView);
		this.logger.debug(
			`getProviderForTreeView called for "${treeView.title}": ${!!provider}`,
		);
		if (!provider) {
			this.logger.warn(
				`No provider found for TreeView "${treeView.title}" (visible: ${treeView.visible})`,
			);
			this.logger.debug(`Total registered views: ${this.registeredViews.size}`);
		}
		return provider;
	}

	/**
	 * Get ALL providers (visible or not) with their slot information
	 *
	 * Used by extension filter to subscribe to ALL workspace providers.
	 * This ensures filter updates when ANY workspace loads data,
	 * regardless of current visibility state.
	 *
	 * Best Practice: Subscribe to all data sources, filter display by visibility in UI.
	 *
	 * @returns Array of all registered providers with slot IDs
	 */
	getAllProviders(): Array<{
		provider: SortedGitChangesProvider;
		slotId: string;
	}> {
		const allProviders: Array<{
			provider: SortedGitChangesProvider;
			slotId: string;
		}> = [];

		// providerSlotMap contains ALL registered providers
		for (const [provider, slotId] of this.providerSlotMap.entries()) {
			allProviders.push({
				provider,
				slotId,
			});
		}

		return allProviders;
	}

	/**
	 * Get provider for any visible view
	 * Fallback when TreeView is not passed by VS Code
	 *
	 * Logs a warning if multiple views are visible (ambiguous which to use)
	 *
	 * @returns The provider for the first visible view, or undefined
	 */
	getAnyVisibleProvider(): SortedGitChangesProvider | undefined {
		this.logger.debug("Searching for visible view provider...");

		const visibleProviders: Array<{
			viewId: string;
			provider: SortedGitChangesProvider;
			title: string;
		}> = [];

		for (const [viewId, treeView] of this.registeredViews.entries()) {
			if (treeView.visible) {
				const provider = this.treeViewProviders.get(treeView);
				if (provider) {
					visibleProviders.push({
						viewId,
						provider,
						title: treeView.title || viewId,
					});
				}
			}
		}

		if (visibleProviders.length === 0) {
			this.logger.warn("No visible view provider found");
			return undefined;
		}

		const first = visibleProviders[0];
		if (!first) {
			this.logger.error("Internal error: visibleProviders array is empty");
			return undefined;
		}

		if (visibleProviders.length === 1) {
			this.logger.info(
				`Found visible provider: "${first.title}" (${first.viewId})`,
			);
			return first.provider;
		}

		// Multiple visible - return first but warn user to click a view first
		this.logger.warn(
			`⚠️  Multiple views visible (${visibleProviders.length}), using first: "${first.title}". Click a view before pressing 'f' for better targeting.`,
		);
		this.logger.debug(
			`Visible views: ${visibleProviders.map((v) => v.title).join(", ")}`,
		);

		return first.provider;
	}

	/**
	 * Get provider for a specific file
	 *
	 * Delegates to factory's workspace lookup logic to find the provider
	 * responsible for the workspace containing the given file.
	 *
	 * Uses longest-match strategy for nested workspaces.
	 *
	 * @param fileUri - The file URI to find provider for
	 * @returns Provider for the workspace containing this file, or undefined
	 */
	getProviderForFile(
		fileUri: vscode.Uri,
	): SortedGitChangesProvider | undefined {
		return this.providerFactory.getProviderForFile(fileUri);
	}

	/**
	 * Get provider by view ID
	 * Used when VS Code passes view ID as string argument
	 *
	 * @param viewId - The view ID (e.g., "commandCentral.project.slot1")
	 * @returns The provider associated with this view ID, or undefined
	 */
	getProviderByViewId(viewId: string): SortedGitChangesProvider | undefined {
		this.logger.debug(`Looking up provider for view ID: "${viewId}"`);

		const treeView = this.registeredViews.get(viewId);
		if (!treeView) {
			this.logger.warn(`No TreeView found for view ID: "${viewId}"`);
			this.logger.debug(
				`Available view IDs: ${Array.from(this.registeredViews.keys()).join(", ")}`,
			);
			return undefined;
		}

		const provider = this.treeViewProviders.get(treeView);
		if (provider) {
			this.logger.info(
				`Found provider for view ID "${viewId}" (title: "${treeView.title}")`,
			);
		} else {
			this.logger.warn(
				`TreeView found but no provider for view ID: "${viewId}"`,
			);
		}

		return provider;
	}

	/**
	 * Register a single project view in both containers
	 *
	 * @private
	 */
	private async registerProjectView(config: ProjectViewConfig): Promise<void> {
		// Delegate to provider factory (abstraction)
		const provider = await this.providerFactory.createProvider(config);

		// Store clean display name BEFORE provider can modify it
		// This is used by filter UI to show workspace names without decorations
		this.slotDisplayNames.set(config.id, config.displayName);

		// Extract emoji from displayName (e.g., "🚀 Project Alpha" → "🚀")
		// Emoji are typically 1-2 characters (some are grapheme clusters)
		const emojiMatch = config.displayName.match(/^(\p{Emoji}+)\s/u);
		const emoji = emojiMatch ? emojiMatch[1] : undefined;

		// Set project icon on provider (dynamic TreeItem icon)
		// This allows per-user icon configuration without package.json changes
		if (typeof provider.setProjectIcon === "function") {
			provider.setProjectIcon(config.iconPath, this.context, emoji);
			this.logger.debug(
				`Set icon for ${config.displayName}: ${config.iconPath}${emoji ? ` (emoji: ${emoji})` : ""}`,
			);
		}

		// Register per-view commands (solves multi-view sort toggle bug)
		this.registerPerViewCommands(config, provider);

		// Register in both Activity Bar and Panel
		await this.registerInActivityBar(config, provider);
		await this.registerInPanel(config, provider);

		this.logger.debug(`Registered project view: ${config.displayName}`);
	}

	/**
	 * Register view-specific commands for this project
	 *
	 * Solves the multi-workspace bug where clicking sort in any view
	 * would only affect the first visible view.
	 *
	 * Registers commands like:
	 * - commandCentral.gitSort.changeSortOrder.slot1
	 * - commandCentral.gitSort.refreshView.slot2Panel
	 *
	 * These are called from package.json view/title menus with
	 * `when` clauses that match specific views.
	 */
	private registerPerViewCommands(
		config: ProjectViewConfig,
		provider: SortedGitChangesProvider,
	): void {
		const slotId = config.id; // e.g., "slot1", "slot2"

		// Register sort order toggle for both Activity Bar and Panel views
		this.perViewCommandDisposables.push(
			vscode.commands.registerCommand(
				`commandCentral.gitSort.changeSortOrder.${slotId}`,
				() => {
					this.logger.info(
						`🔄 Sort order toggle for ${slotId} (${config.displayName})`,
					);

					const currentOrder = provider.getSortOrder();
					const newOrder = currentOrder === "newest" ? "oldest" : "newest";

					this.logger.info(
						`Changing sort order: ${currentOrder} → ${newOrder}`,
					);

					provider.setSortOrder(newOrder);

					vscode.window.setStatusBarMessage(
						`${config.displayName}: Sorted ${newOrder === "newest" ? "▼" : "▲"}`,
						2000,
					);
				},
			),
		);

		this.perViewCommandDisposables.push(
			vscode.commands.registerCommand(
				`commandCentral.gitSort.changeSortOrder.${slotId}Panel`,
				() => {
					this.logger.info(
						`🔄 Sort order toggle for ${slotId}Panel (${config.displayName})`,
					);

					const currentOrder = provider.getSortOrder();
					const newOrder = currentOrder === "newest" ? "oldest" : "newest";

					provider.setSortOrder(newOrder);

					vscode.window.setStatusBarMessage(
						`${config.displayName}: Sorted ${newOrder === "newest" ? "▼" : "▲"}`,
						2000,
					);
				},
			),
		);

		// Register refresh commands
		this.perViewCommandDisposables.push(
			vscode.commands.registerCommand(
				`commandCentral.gitSort.refreshView.${slotId}`,
				() => {
					this.logger.info(`🔄 Refresh view ${slotId}`);
					provider.refresh();
				},
			),
		);

		this.perViewCommandDisposables.push(
			vscode.commands.registerCommand(
				`commandCentral.gitSort.refreshView.${slotId}Panel`,
				() => {
					this.logger.info(`🔄 Refresh view ${slotId}Panel`);
					provider.refresh();
				},
			),
		);

		// Register file filter commands
		this.perViewCommandDisposables.push(
			vscode.commands.registerCommand(
				`commandCentral.gitSort.changeFileFilter.${slotId}`,
				async () => {
					await this.showFileFilterPicker(provider);
				},
			),
		);

		this.perViewCommandDisposables.push(
			vscode.commands.registerCommand(
				`commandCentral.gitSort.changeFileFilter.${slotId}Panel`,
				async () => {
					await this.showFileFilterPicker(provider);
				},
			),
		);

		this.logger.debug(
			`Registered per-view commands for ${slotId} (Activity Bar + Panel)`,
		);
	}

	/**
	 * Show file filter quick pick
	 */
	private async showFileFilterPicker(
		provider: SortedGitChangesProvider,
	): Promise<void> {
		const choices = [
			{ label: "All Files", value: "all" },
			{ label: "Code Files", value: "code" },
			{ label: "Config Files", value: "config" },
			{ label: "Documentation", value: "docs" },
			{ label: "Images", value: "images" },
			{ label: "Test Files", value: "tests" },
			{ label: "Custom Extensions", value: "custom" },
		];

		const choice = await vscode.window.showQuickPick(choices, {
			placeHolder: "Select file type filter",
		});

		if (choice) {
			provider.setFileTypeFilter(
				choice.value as
					| "all"
					| "code"
					| "config"
					| "docs"
					| "images"
					| "tests"
					| "custom",
			);
		}
	}

	/**
	 * Register view in Activity Bar container
	 *
	 * Requirements:
	 * - REQ-VR-003: Dual container support
	 * - REQ-LG-001: Debug-level logging
	 */
	private async registerInActivityBar(
		config: ProjectViewConfig,
		provider: SortedGitChangesProvider,
	): Promise<void> {
		const viewId = `commandCentral.project.${config.id}`;

		const treeView = vscode.window.createTreeView(viewId, {
			treeDataProvider: provider,
			canSelectMany: true,
			showCollapseAll: true,
		});

		// Associate TreeView with provider for View Action commands
		// VS Code passes TreeView as first argument to view/title commands
		this.treeViewProviders.set(treeView, provider);

		// Track provider-slot relationship for persistence
		this.providerSlotMap.set(provider, config.id);

		// IMPORTANT: Set static title BEFORE giving TreeView to provider
		// This prevents overwriting provider's dynamic title (e.g., "Sorted Changes ▼ (5)")
		// Note: treeView.title sets a subtitle shown below the main container name
		// VS Code Activity Bar automatically uppercases the main container title
		treeView.title = config.displayName;
		if (config.description) {
			treeView.description = config.description;
		}

		// Give provider a reference to its TreeView so it can update title dynamically
		// Provider will now override the static title with dynamic content
		if (typeof provider.setActivityBarTreeView === "function") {
			provider.setActivityBarTreeView(treeView);
		} else if (typeof provider.setTreeView === "function") {
			// Backward compatibility for providers without dual TreeView support
			provider.setTreeView(treeView);
		}

		this.logger.debug(
			`Associated Activity Bar TreeView "${viewId}" with provider for "${config.displayName}"`,
		);

		this.registeredViews.set(viewId, treeView);
		this.context.subscriptions.push(treeView);

		this.logger.debug(`  → Activity Bar: ${viewId}`);
	}

	/**
	 * Register view in Panel container
	 *
	 * Requirements:
	 * - REQ-VR-003: Dual container support
	 * - REQ-LG-001: Debug-level logging
	 */
	private async registerInPanel(
		config: ProjectViewConfig,
		provider: SortedGitChangesProvider,
	): Promise<void> {
		const viewId = `commandCentral.project.${config.id}Panel`;

		const treeView = vscode.window.createTreeView(viewId, {
			treeDataProvider: provider,
			canSelectMany: true,
			showCollapseAll: true,
		});

		// Associate TreeView with provider for View Action commands
		// VS Code passes TreeView as first argument to view/title commands
		this.treeViewProviders.set(treeView, provider);

		// IMPORTANT: Set static title BEFORE giving TreeView to provider
		treeView.title = config.displayName;
		if (config.description) {
			treeView.description = config.description;
		}

		// Give provider reference to Panel TreeView for dual-view title synchronization
		// Both Activity Bar and Panel views share the same provider instance
		if (typeof provider.setPanelTreeView === "function") {
			provider.setPanelTreeView(treeView);
		}
		// Note: If provider doesn't support dual TreeViews, panel title stays static

		this.logger.debug(
			`Associated Panel TreeView "${viewId}" with provider for "${config.displayName}"`,
		);

		this.registeredViews.set(viewId, treeView);
		this.context.subscriptions.push(treeView);

		this.logger.debug(`  → Panel: ${viewId}`);
	}

	/**
	 * Get clean workspace display names for all registered slots
	 *
	 * Returns the ORIGINAL displayName from config (e.g., "vs-code-extension-bun", "⚙️ .config")
	 * WITHOUT dynamic decorations like sort indicators (▼, ▲) or file counts (19).
	 *
	 * This is used by the filter UI to show readable workspace names.
	 *
	 * @returns Map of slotId -> clean display name
	 *
	 * @example
	 * ```typescript
	 * const names = manager.getAllWorkspaceDisplayNames();
	 * // Returns: Map { "slot1" => "vs-code-extension-bun", "slot2" => "⚙️ .config" }
	 * // NOT:     Map { "slot1" => "Sorted Changes ▼ (19)" }
	 * ```
	 */
	getAllWorkspaceDisplayNames(): Map<string, string> {
		return new Map(this.slotDisplayNames);
	}

	/**
	 * Cleanup all registered views
	 *
	 * Requirements:
	 * - REQ-AR-001: Proper disposal pattern
	 *
	 * Called from extension.deactivate()
	 *
	 * Note: ProviderFactory cleanup is handled separately via factory.dispose()
	 * This method only cleans up view registrations.
	 */
	dispose(): void {
		this.logger.info("Disposing project view manager...");

		// Dispose per-view commands
		for (const d of this.perViewCommandDisposables) {
			d?.dispose();
		}
		this.perViewCommandDisposables = [];

		// Dispose event emitter
		this._onProvidersReady.dispose();

		// Clear registered views (already disposed via context.subscriptions)
		this.registeredViews.clear();
		// Note: treeViewProviders WeakMap auto-cleans, no manual clear needed

		this.logger.info("Project view manager disposed");
	}
}
