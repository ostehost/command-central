/**
 * TreeDataProvider for displaying sorted Git changes
 * This provides a custom view that we can fully control
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionFilterState } from "../services/extension-filter-state.js";
import type { GroupingStateManager } from "../services/grouping-state-manager.js";
import type { LoggerService } from "../services/logger-service.js";
import {
	type Change,
	type GitAPI,
	type GitExtensionAPI,
	type Repository,
	Status,
} from "../types/git-extension.types.js";
import type {
	GitChangeItem,
	GitStatusGroup,
	TimeGroup,
	TreeElement,
} from "../types/tree-element.js";
import { findRepositoryForFile as findRepoForFile } from "../utils/git-repo-utils.js";
import { formatRelativeTime } from "../utils/relative-time.js";
import { DeletedFileTracker } from "./deleted-file-tracker.js";
import { getGitAwareTimestamps } from "./git-timestamps.js";
import type { StorageAdapter } from "./storage/storage-adapter.js";

// Time period constants (in milliseconds)
const TIME_PERIODS = {
	DAY: 24 * 60 * 60 * 1000,
	WEEK: 7 * 24 * 60 * 60 * 1000,
	MONTH: 30 * 24 * 60 * 60 * 1000,
} as const;

export class SortedGitChangesProvider
	implements vscode.TreeDataProvider<TreeElement>
{
	// Lazy initialization pattern - EventEmitter created on first access
	// This allows provider to be instantiated before vscode mock is set up in tests
	private _onDidChangeTreeData?: vscode.EventEmitter<
		TreeElement | undefined | null | undefined
	>;

	// Getter ensures EventEmitter exists before use
	private get eventEmitter(): vscode.EventEmitter<
		TreeElement | undefined | null | undefined
	> {
		if (!this._onDidChangeTreeData) {
			this._onDidChangeTreeData = new vscode.EventEmitter<
				TreeElement | undefined | null | undefined
			>();
		}
		return this._onDidChangeTreeData;
	}

	// Public event property - VS Code TreeDataProvider interface requirement
	// Lazy getter pattern ensures EventEmitter is created on first access
	get onDidChangeTreeData(): vscode.Event<
		TreeElement | undefined | null | undefined
	> {
		return this.eventEmitter.event;
	}

	private gitApi: GitAPI | undefined;
	private sortOrder: "newest" | "oldest" = "newest";
	private fileTypeFilter:
		| "all"
		| "code"
		| "config"
		| "docs"
		| "images"
		| "tests"
		| "custom" = "all";
	private customFileTypes: string[] = [];
	private refreshTimer: NodeJS.Timeout | undefined;
	private refreshAbortController?: AbortController;
	private lastKnownFileCount = 0;
	private disposables: vscode.Disposable[] = [];

	// Dual TreeView Support: Track both Activity Bar and Panel views
	// Each workspace has TWO TreeViews that share ONE provider instance
	private activityBarTreeView: vscode.TreeView<TreeElement> | undefined;
	private panelTreeView: vscode.TreeView<TreeElement> | undefined;

	// Workspace-specific base title (e.g., "ghostty", "my-project")
	// Captured from TreeView.title when registered, then augmented with arrow + count
	private baseTitle = "Sorted Changes"; // Fallback default

	// Legacy property for backward compatibility
	private get treeView(): vscode.TreeView<TreeElement> | undefined {
		return this.activityBarTreeView;
	}

	private deletedFileTracker: DeletedFileTracker;
	private storage?: StorageAdapter;
	private trackerInitialized = false;

	// Parent tracking for TreeView.reveal() support
	// CRITICAL: TreeView.reveal() requires getParent() to work
	// Maps file items to their parent TimeGroup for tree navigation
	private parentMap = new Map<TreeElement, TimeGroup | undefined>();

	// Cache of the current tree structure for findItemByUri lookups
	// CRITICAL: Must be the exact same object instances as in the tree
	// This enables reveal() to work with collapsed time groups
	// Without this, reveal() gets different object instances and getParent() returns undefined
	// Can contain TimeGroup[] (when grouping disabled) or GitStatusGroup[] (when grouping enabled)
	private cachedTreeStructure: (TimeGroup | GitStatusGroup)[] = [];

	constructor(
		private logger: LoggerService,
		private context: vscode.ExtensionContext,
		storage?: StorageAdapter,
		public workspaceRootUri?: vscode.Uri,
		private extensionFilterState?: ExtensionFilterState,
		private workspaceId?: string,
		private groupingStateManager?: GroupingStateManager,
	) {
		// EventEmitter and onDidChangeTreeData use lazy getters
		// No initialization needed here - deferred until first access
		// This allows tests to set up vscode mocks before provider instantiation

		// Store storage for lazy initialization
		this.storage = storage;

		// Initialize deleted file tracker (will be re-initialized with workspace root later if storage provided)
		this.deletedFileTracker = new DeletedFileTracker();

		// Load configuration
		this.loadConfiguration();

		// Listen for configuration changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.gitSort")) {
					this.loadConfiguration();
					// Always refresh on config change - VS Code expects this
					this.refresh();
				}
			}),
		);

		// Listen for grouping state changes (from GROUPING OPTIONS UI)
		// CRITICAL: When user toggles grouping, ALL providers must refresh
		// This ensures multi-workspace scenarios work correctly
		// The groupingStateManager is shared across all providers (from factory)
		// so one state change triggers all workspace trees to update
		if (this.groupingStateManager) {
			this.disposables.push(
				this.groupingStateManager.onDidChangeGrouping((enabled) => {
					this.logger.info(
						`Grouping state changed to: ${enabled ? "enabled (Git Status)" : "disabled (No Grouping)"}, refreshing tree`,
					);
					// Refresh tree with new grouping mode
					// getChildren() will read isGroupingEnabled() and build appropriate structure
					this.refresh();
				}),
			);
		}
	}

	private loadConfiguration(): void {
		const config = vscode.workspace.getConfiguration("commandCentral.gitSort");
		this.fileTypeFilter = config.get("fileTypeFilter", "all") as
			| "all"
			| "code"
			| "config"
			| "docs"
			| "images"
			| "tests"
			| "custom";
		this.customFileTypes = config.get("customFileTypes", []);
		this.logger.debug(
			`Configuration loaded - filter: ${this.fileTypeFilter}, custom types: ${this.customFileTypes.join(", ")}`,
		);
	}

	async initialize(): Promise<void> {
		try {
			// Get git extension
			const gitExtension =
				vscode.extensions.getExtension<GitExtensionAPI>("vscode.git");
			if (!gitExtension) {
				this.logger.error("Git extension not found");
				return;
			}

			// Activate and get API
			const git = await gitExtension.activate();
			if (!git || !git.getAPI) {
				this.logger.error("Cannot access Git API");
				return;
			}

			this.gitApi = git.getAPI(1);

			// NOTE: We don't listen to gitApi.onDidChangeState() here
			// That would duplicate events from repo.state.onDidChange()
			// Repository-specific listeners are sufficient

			// Setup listeners for existing repositories
			this.gitApi.repositories.forEach((repo: Repository) => {
				this.setupRepositoryListener(repo);
			});

			// Listen for repository open/close
			this.disposables.push(
				this.gitApi.onDidOpenRepository((repo: Repository) => {
					this.setupRepositoryListener(repo);
					// Trigger refresh when a new repository is discovered.
					// Without this, if the Git extension initializes after CC,
					// the tree stays empty until the user makes a change.
					this.debounceRefresh();
				}),
			);

			this.disposables.push(
				this.gitApi.onDidCloseRepository(() => {
					// Refresh when repository closes to clear the view
					this.debounceRefresh();
				}),
			);

			// Trigger initial refresh if repositories already exist.
			// When the Git extension discovers repos before Command Central activates,
			// onDidOpenRepository won't fire for those repos. Without this, the tree
			// stays empty until the user makes a change.
			if (this.gitApi.repositories.length > 0) {
				this.debounceRefresh();
			}

			this.logger.info("SortedGitChangesProvider initialized");
		} catch (error) {
			this.logger.error("Failed to initialize SortedGitChangesProvider", error);
		}
	}

	/**
	 * Set project icon for TreeItem display
	 *
	 * Reserved for future custom icon support.
	 * Currently uses VS Code standard calendar ThemeIcon for time groups.
	 *
	 * @param _iconPath - Relative path to SVG icon from extension root (reserved for future use)
	 * @param _context - Extension context for path resolution (reserved for future use)
	 * @param _emoji - Optional emoji parameter (reserved for future use)
	 */
	setProjectIcon(
		_iconPath: string,
		_context: vscode.ExtensionContext,
		_emoji?: string,
	): void {
		// Reserved for future custom icon implementation
		// Currently using standard VS Code calendar ThemeIcon
		this.logger.debug(
			"Project icon configuration (using standard calendar icon)",
		);
	}

	/**
	 * Get themed icon path for git status group indicators
	 *
	 * Returns light/dark SVG variants for automatic VS Code theme switching.
	 * Staged: crosshair/brackets (green) — files locked and ready to commit
	 * Working: radar sweep (amber) — files being actively modified
	 *
	 * @param iconName - Status type ('staged' | 'working')
	 * @returns Theme-aware icon path with light and dark variants
	 */
	private getGitStatusIcon(iconName: "staged" | "working"): {
		light: vscode.Uri;
		dark: vscode.Uri;
	} {
		return {
			light: vscode.Uri.joinPath(
				this.context.extensionUri,
				"resources",
				"icons",
				"git-status",
				"light",
				`${iconName}.svg`,
			),
			dark: vscode.Uri.joinPath(
				this.context.extensionUri,
				"resources",
				"icons",
				"git-status",
				"dark",
				`${iconName}.svg`,
			),
		};
	}

	private setupRepositoryListener(repo: Repository): void {
		// Listen for state changes on this repository
		// The Git extension fires multiple events during discovery and file changes
		// We debounce all changes to batch them efficiently
		this.disposables.push(
			repo.state.onDidChange(() => {
				this.debounceRefresh();
			}),
		);
	}

	private debounceRefresh(): void {
		// Abort any pending refresh
		if (this.refreshAbortController) {
			this.refreshAbortController.abort();
		}

		// Clear existing timer
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}

		// Create new abort controller for this refresh
		this.refreshAbortController = new AbortController();
		const currentController = this.refreshAbortController;

		// Standard debounce pattern - 300ms delay to batch rapid events
		this.refreshTimer = setTimeout(() => {
			// Check if aborted before executing
			if (!currentController.signal.aborted) {
				this.refresh();
			}
			this.refreshTimer = undefined;
		}, 300);
	}

	refresh(): void {
		// Abort any pending debounced refresh
		if (this.refreshAbortController) {
			this.refreshAbortController.abort();
			this.refreshAbortController = undefined;
		}

		// Cancel any pending debounced refresh since we're refreshing now
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}

		// CRITICAL: Always fire refresh when called from checkbox handler
		// The filter might have changed even if count stays the same
		this.logger.info(
			`[${this.workspaceId}] refresh() called - forcing TreeView update`,
		);

		// Clear the last known count to force re-rendering
		const previousCount = this.lastKnownFileCount;
		this.lastKnownFileCount = -1; // Force refresh

		// Fire change event to trigger tree update
		this.eventEmitter.fire(undefined);

		this.logger.info(
			`[${this.workspaceId}] TreeView refresh event fired (prev count: ${previousCount})`,
		);
	}

	/**
	 * Set Activity Bar TreeView reference
	 * @param treeView - The Activity Bar TreeView instance
	 */
	setActivityBarTreeView(treeView: vscode.TreeView<TreeElement>): void {
		this.activityBarTreeView = treeView;

		// CRITICAL: Capture the workspace-specific title before we modify it
		// ProjectViewManager sets this to config.displayName (e.g., "ghostty")
		// We'll append arrow + count to preserve the workspace identity
		if (treeView.title?.trim()) {
			this.baseTitle = treeView.title;
			this.logger.debug(
				`Activity Bar TreeView registered with base title: "${this.baseTitle}"`,
			);
		} else {
			this.logger.warn(
				`Activity Bar TreeView has no title, using default: "${this.baseTitle}"`,
			);
		}

		// Immediately update title with arrow and count (if available)
		this.updateAllTreeViewTitles();
	}

	/**
	 * Set Panel TreeView reference
	 * @param treeView - The Panel TreeView instance
	 */
	setPanelTreeView(treeView: vscode.TreeView<TreeElement>): void {
		this.panelTreeView = treeView;
		this.logger.debug(`Panel TreeView registered for "${this.baseTitle}"`);

		// Update title immediately (baseTitle already captured from Activity Bar)
		this.updateAllTreeViewTitles();
	}

	/**
	 * Legacy method for backward compatibility
	 * Delegates to setActivityBarTreeView()
	 * @param treeView - The TreeView instance (assumed to be Activity Bar)
	 */
	setTreeView(treeView: vscode.TreeView<TreeElement>): void {
		this.setActivityBarTreeView(treeView);
		this.logger.debug(
			`TreeView reference set for "${treeView.title}" (legacy method)`,
		);
	}

	/**
	 * Update titles for ALL registered TreeViews (Activity Bar + Panel)
	 * This ensures both views stay synchronized when sort order or count changes
	 * @private
	 */
	private updateAllTreeViewTitles(): void {
		const newTitle = this.getViewTitle();

		if (this.activityBarTreeView) {
			this.activityBarTreeView.title = newTitle;
			this.logger.debug(`Updated Activity Bar title: "${newTitle}"`);
		}

		if (this.panelTreeView) {
			this.panelTreeView.title = newTitle;
			this.logger.debug(`Updated Panel title: "${newTitle}"`);
		}
	}

	/**
	 * Resets file count to 0 and updates all TreeView titles.
	 *
	 * CRITICAL: Must be called on every early-return path in getChildren()
	 * that returns an empty array. Without this, the title shows a stale
	 * count (e.g., "(20)") while the tree is empty.
	 *
	 * This fixes the badge/title desync bug where file renames or deletions
	 * cause the tree to be empty but the count remains from the previous state.
	 */
	private resetCountAndTitles(): void {
		if (this.lastKnownFileCount !== 0) {
			this.logger.info(
				`[${this.workspaceId}] Resetting stale file count: ${this.lastKnownFileCount} → 0`,
			);
			this.lastKnownFileCount = 0;
			this.updateAllTreeViewTitles();
		}
	}

	/**
	 * Sets the empty state message on both TreeViews.
	 *
	 * When hasRepo is true (repo exists but no changes), displays
	 * "No changes to display." which takes PRIORITY over viewsWelcome.
	 *
	 * When hasRepo is false (no repo), sets message to undefined so the
	 * viewsWelcome content ("Open a Git repository...") shows instead.
	 */
	private setEmptyStateMessage(hasRepo: boolean): void {
		const message = hasRepo ? "No changes to display." : undefined;
		if (this.activityBarTreeView) {
			this.activityBarTreeView.message = message;
		}
		if (this.panelTreeView) {
			this.panelTreeView.message = message;
		}
	}

	/**
	 * Updates TreeView.message based on filter state and results.
	 *
	 * - Filter active + zero matches → informational message
	 * - Filter active + some matches → clear message
	 * - No filter → clear message
	 *
	 * Uses TreeView.message API which renders above tree content or alone if empty.
	 */
	private updateTreeViewMessage(
		unfilteredCount: number,
		filteredCount: number,
	): void {
		const isFiltered =
			this.extensionFilterState?.isFiltered(this.workspaceId ?? "") ?? false;

		let message: string | undefined;

		if (isFiltered && filteredCount === 0 && unfilteredCount > 0) {
			const extensions = Array.from(
				this.extensionFilterState?.getEnabledExtensions(
					this.workspaceId ?? "",
				) ?? [],
			)
				.sort()
				.join(", ");
			message = `No files match the current filter (${extensions}). Use the Extension Filter to adjust.`;
		}

		// Set message on all registered tree views
		if (this.activityBarTreeView) {
			this.activityBarTreeView.message = message;
		}
		if (this.panelTreeView) {
			this.panelTreeView.message = message;
		}
	}

	setSortOrder(order: "newest" | "oldest"): void {
		this.logger.info(`Setting sort order to: ${order}`);
		this.sortOrder = order;

		// Update titles for ALL TreeViews (Activity Bar + Panel)
		this.updateAllTreeViewTitles();

		this.logger.debug("Calling refresh() to update view");
		this.refresh();
	}

	getSortOrder(): "newest" | "oldest" {
		return this.sortOrder;
	}

	getViewTitle(): string {
		// Use workspace-specific base title (captured from TreeView during registration)
		// This preserves workspace identity: "ghostty ▼ (208)" instead of "SORTED CHANGES ▼ (208)"
		const baseTitle = this.baseTitle;

		// Fixed arrow convention: ▼ for recent first (descending), ▲ for older first (ascending)
		const sortIndicator = this.sortOrder === "newest" ? "▼" : "▲";

		// Extension-based filter indicator (new system)
		let filterText = "";
		if (this.extensionFilterState && this.workspaceId) {
			const enabledExtensions = this.extensionFilterState.getEnabledExtensions(
				this.workspaceId,
			);
			if (enabledExtensions.size > 0) {
				const extensions = Array.from(enabledExtensions).sort().join(", ");
				filterText = ` [${extensions}]`;
			}
		}
		// Fallback: Legacy file type filter indicator
		else if (this.fileTypeFilter !== "all") {
			const filterNames: Record<string, string> = {
				code: "Code",
				config: "Config",
				docs: "Docs",
				images: "Images",
				tests: "Tests",
				custom: "Custom",
			};
			const filterName =
				filterNames[this.fileTypeFilter] || this.fileTypeFilter;
			filterText = ` [${filterName}]`;
		}

		// UX Decision: Hide count in git status grouping mode (see DUAL_STATE_FILES_UX_DECISION.md)
		// Rationale: Dual-state files (MM/AM) appear in both staged and unstaged groups,
		// making the total count confusing (e.g., 233 + 369 = 602 instances, but only 576 unique files).
		// Native VS Code Source Control doesn't show total in grouped view, and individual group
		// counts provide sufficient detail without confusion.
		const isGroupingEnabled =
			this.groupingStateManager?.isGroupingEnabled() ?? false;

		if (isGroupingEnabled) {
			// Git status mode: omit count (matches native Source Control behavior)
			return `${baseTitle} ${sortIndicator}${filterText}`;
		}

		// Time grouping mode: include count for quick visibility
		const countText =
			this.lastKnownFileCount > 0 ? ` (${this.lastKnownFileCount})` : "";
		return `${baseTitle} ${sortIndicator}${countText}${filterText}`;
	}

	setFileTypeFilter(
		filter: "all" | "code" | "config" | "docs" | "images" | "tests" | "custom",
	): void {
		this.fileTypeFilter = filter;

		// Update title when user changes filter
		if (this.treeView) {
			this.treeView.title = this.getViewTitle();
		}

		this.refresh();
	}

	/**
	 * Gets current Git changes for extension discovery
	 *
	 * Used by extension filter command to discover available extensions.
	 * Returns changes from the current repository state for performance.
	 *
	 * @returns Array of current Git changes (working tree + index changes)
	 */
	getCurrentChanges(): GitChangeItem[] {
		if (!this.gitApi) {
			return [];
		}

		// Get repository for this provider's workspace
		const repo = this.getRepository();
		if (!repo) {
			return [];
		}

		const changes: GitChangeItem[] = [];

		try {
			// Collect working tree changes (modified, new files)
			for (const change of repo.state.workingTreeChanges) {
				if (!change.uri) continue;
				changes.push({
					type: "gitChangeItem" as const,
					uri: change.uri,
					status: this.getStatusLabel(change),
					isStaged: false,
					parentType: "unstaged" as const,
				});
			}

			// Collect index changes (staged files)
			for (const change of repo.state.indexChanges) {
				if (!change.uri) continue;
				// Skip if already in working tree changes
				const changeUri = change.uri;
				const alreadyAdded = changes.some(
					(c) => c.uri.fsPath === changeUri.fsPath,
				);
				if (!alreadyAdded) {
					changes.push({
						type: "gitChangeItem" as const,
						uri: changeUri,
						status: this.getStatusLabel(change),
						isStaged: true,
						parentType: "staged" as const,
					});
				}
			}
		} catch (error) {
			this.logger.error("Failed to get current changes:", error);
			return [];
		}

		return changes;
	}

	/**
	 * Gets current Git changes WITHOUT any filtering applied
	 *
	 * CRITICAL: Used exclusively for Extension Filter discovery to ensure
	 * we discover ALL extensions present in Git, regardless of current filter state.
	 *
	 * This method guarantees unfiltered results by accessing Git state directly
	 * and bypassing sortAndFilter() which applies extension filtering.
	 *
	 * @returns Array of ALL Git changes (working tree + index), no filtering applied
	 */
	getCurrentChangesUnfiltered(): GitChangeItem[] {
		// This is currently identical to getCurrentChanges() because that method
		// already returns unfiltered data. However, we create this separate method
		// to make the intent explicit and ensure future changes don't break discovery.
		return this.getCurrentChanges();
	}

	/**
	 * Gets the repository for this provider's workspace
	 * @private
	 * @returns Repository instance or undefined
	 */
	private getRepository(): Repository | undefined {
		if (!this.gitApi) return undefined;

		// Use workspace-specific repository if available
		const targetUri =
			this.workspaceRootUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;

		return targetUri
			? this.findRepositoryForFile(targetUri)
			: this.gitApi.repositories[0];
	}

	/**
	 * Constructs a proper git URI for diff viewing
	 * Based on VS Code's internal toGitUri function
	 * @param uri - The file URI
	 * @param ref - Git reference: "HEAD", "", "~", etc.
	 * @returns Git-scheme URI with proper query format
	 */
	private toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
		return uri.with({
			scheme: "git",
			path: uri.path,
			query: JSON.stringify({
				path: uri.fsPath,
				ref: ref,
			}),
		});
	}

	/**
	 * Opens a change in diff view or as a file.
	 *
	 * Behavior:
	 * - Untracked/Added files: Opens file directly (no HEAD version to compare)
	 * - Modified files: Opens diff view comparing HEAD to working tree
	 * - Deleted files: Attempts to open diff, falls back to file if unavailable
	 *
	 * Multi-root workspace support:
	 * - Uses the repository containing the file (longest-match strategy)
	 * - Properly handles git URIs via Git extension API's originalUri
	 *
	 * Error handling:
	 * - Gracefully falls back to opening file if diff unavailable
	 * - Logs warnings for expected failures (no git API, no repo)
	 * - Logs errors for unexpected exceptions
	 *
	 * @param item - The git change item to open
	 */
	async openChange(item: GitChangeItem): Promise<void> {
		// Validate input
		if (!item || !item.uri) {
			this.logger.error("openChange called with invalid item", { item });
			vscode.window.showErrorMessage("Cannot open change: Invalid item");
			return;
		}

		this.logger.info(`Opening change for: ${item.uri.fsPath}`);

		// For untracked or newly added files, just open the file
		// since there's no HEAD version to compare against
		const isUntracked =
			item.status === "Untracked" ||
			item.status === "U" ||
			item.status === "?" ||
			item.status === "7";

		const isAdded =
			item.status === "Added" || item.status === "A" || item.status === "1";

		if (isUntracked || isAdded) {
			await vscode.commands.executeCommand("vscode.open", item.uri);
			vscode.window.showInformationMessage(
				"This file has no previous version to compare",
			);
			return;
		}

		try {
			// Find the Change object from Git API which has the correct originalUri
			if (!this.gitApi) {
				this.logger.warn("Git API not available, opening file directly");
				await vscode.commands.executeCommand("vscode.open", item.uri);
				return;
			}

			// Find repository containing this file
			const repo = this.findRepositoryForFile(item.uri);

			if (!repo) {
				this.logger.warn(
					`No repository found for ${item.uri.fsPath}, opening file directly`,
				);
				await vscode.commands.executeCommand("vscode.open", item.uri);
				return;
			}

			// CRITICAL: Use parentType to determine which section was clicked
			// This is set by buildStatusGroup() when creating the tree structure
			// - parentType === "staged" → user clicked in Staged section → show HEAD ↔ Index
			// - parentType === "unstaged" → user clicked in Working section → show Index ↔ Working
			//
			// For MM files (in both native arrays), parentType is the ONLY reliable way
			// to know which diff the user wants to see.
			let isStaged = item.parentType === "staged";

			// Defensive: parentType should always be set by buildStatusGroup()
			// If missing, fall back to checking native arrays (less efficient but safe)
			if (item.parentType === undefined) {
				const inIndexChanges = repo.state.indexChanges.some(
					(c) => c.uri?.fsPath === item.uri.fsPath,
				);
				const inWorkingTreeChanges = repo.state.workingTreeChanges.some(
					(c) => c.uri?.fsPath === item.uri.fsPath,
				);

				// Handle MM files (files in both arrays) correctly
				if (item.isStaged !== undefined) {
					// Trust the isStaged property if set
					isStaged = item.isStaged;
				} else if (inIndexChanges && inWorkingTreeChanges) {
					// MM file - both staged and unstaged
					// Without parentType, we can't know user intent
					// Default to staged (more conservative - shows what will be committed)
					isStaged = true;
					this.logger.warn(
						`MM file ${item.uri.fsPath} without parentType - defaulting to staged diff`,
					);
				} else {
					// Simple case: file in one array only
					isStaged = inIndexChanges && !inWorkingTreeChanges;
				}

				this.logger.warn(
					`parentType missing for ${item.uri.fsPath}! Using fallback: item.isStaged=${item.isStaged}, inIndex=${inIndexChanges}, inWorking=${inWorkingTreeChanges}, decided isStaged=${isStaged}`,
				);
			} else {
				this.logger.info(
					`File: ${item.uri.fsPath}, parentType=${item.parentType}, → showing ${isStaged ? "STAGED" : "UNSTAGED"} diff`,
				);
			}

			// State-aware diff behavior using manual URI construction
			// - Staged files: Show HEAD ↔ Index (what will be committed)
			// - Unstaged files: Show Index ↔ Working Tree (what's not staged yet)
			if (isStaged) {
				// STAGED FILE: Open HEAD ↔ Index diff
				this.logger.info(`Opening staged diff: ${item.uri.fsPath}`);

				// Manually construct proper git URIs
				const headUri = this.toGitUri(item.uri, "HEAD");
				const indexUri = this.toGitUri(item.uri, "");

				// Open diff: HEAD (left) vs Index/Staged (right)
				await vscode.commands.executeCommand(
					"vscode.diff",
					headUri,
					indexUri,
					`${path.basename(item.uri.fsPath)} (Staged Changes)`,
				);
			} else {
				// UNSTAGED FILE: Open Index ↔ Working Tree diff
				this.logger.info(`Opening unstaged diff: ${item.uri.fsPath}`);

				// For unstaged: Index (left) vs Working Tree (right)
				const indexUri = this.toGitUri(item.uri, "");
				const workingUri = item.uri; // Regular file:// URI for working tree

				await vscode.commands.executeCommand(
					"vscode.diff",
					indexUri,
					workingUri,
					`${path.basename(item.uri.fsPath)} (Unstaged Changes)`,
				);
			}
		} catch (error) {
			this.logger.error(`Failed to open diff for ${item.uri.fsPath}:`, error);
			await vscode.commands.executeCommand("vscode.open", item.uri);
		}
	}

	/**
	 * NEW: Extension-based filtering using ExtensionFilterState
	 * Filters changes based on enabled extensions for this workspace
	 *
	 * @param changes - Array of Git changes to filter
	 * @returns Filtered changes (all changes if no filter active)
	 */
	private filterByExtensions(changes: GitChangeItem[]): GitChangeItem[] {
		// If no extension filter state, show all files
		if (!this.extensionFilterState || !this.workspaceId) {
			return changes;
		}

		// Check if workspace is in filtered mode
		// No filter entry = show all files (default state)
		const isFiltered = this.extensionFilterState.isFiltered(this.workspaceId);
		this.logger.info(
			`[${this.workspaceId}] filterByExtensions: ${changes.length} files, isFiltered=${isFiltered}`,
		);

		if (!isFiltered) {
			this.logger.info(
				`[${this.workspaceId}] No filter active, returning all ${changes.length} files`,
			);
			return changes;
		}

		// Get enabled extensions for this workspace
		const enabledExtensions = this.extensionFilterState.getEnabledExtensions(
			this.workspaceId,
		);
		this.logger.info(
			`[${this.workspaceId}] Filter active, enabled extensions: [${Array.from(enabledExtensions).join(", ")}]`,
		);

		// SAFETY BELT: Empty Set should never happen (state management deletes empty Sets)
		// But if it does happen, gracefully degrade to "show all" instead of breaking UX
		// This provides defense-in-depth: even if state management has a bug, UX stays functional
		if (enabledExtensions.size === 0) {
			this.logger.warn(
				`[${this.workspaceId}] Empty extension Set with isFiltered=true (state bug?), showing all files for graceful degradation`,
			);
			return changes; // Changed from: return [] (show all instead of none)
		}

		// Show only files matching enabled extensions
		const filtered = changes.filter((change) => {
			const ext = path.extname(change.uri.fsPath).toLowerCase();
			return enabledExtensions.has(ext);
		});

		this.logger.info(
			`[${this.workspaceId}] Filtered ${changes.length} files → ${filtered.length} files matching filter`,
		);

		// Safety: warn when filter hides ALL files
		if (filtered.length === 0 && changes.length > 0) {
			this.logger.warn(
				`[${this.workspaceId}] Extension filter hides ALL ${changes.length} files! ` +
					`Filter: [${Array.from(enabledExtensions).join(", ")}]`,
			);
		}

		return filtered;
	}

	/**
	 * LEGACY: File type filtering using hardcoded groups
	 */
	private filterByFileType(changes: GitChangeItem[]): GitChangeItem[] {
		if (this.fileTypeFilter === "all") {
			return changes;
		}

		const fileTypePatterns: Record<string, string[]> = {
			code: [
				".ts",
				".tsx",
				".js",
				".jsx",
				".py",
				".java",
				".cpp",
				".c",
				".cs",
				".go",
				".rs",
				".swift",
				".kt",
				".rb",
				".php",
			],
			config: [
				".json",
				".yaml",
				".yml",
				".toml",
				".ini",
				".env",
				".config",
				".conf",
				".xml",
			],
			docs: [".md", ".txt", ".rst", ".pdf", ".doc", ".docx"],
			images: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp"],
			tests: [
				".test.ts",
				".test.tsx",
				".test.js",
				".spec.ts",
				".spec.tsx",
				".spec.js",
				"_test.go",
				"_test.py",
				".test.py",
			],
			custom: this.customFileTypes,
		};

		const extensions = fileTypePatterns[this.fileTypeFilter] || [];
		if (extensions.length === 0) {
			return changes;
		}

		// Special handling for test files
		if (this.fileTypeFilter === "tests") {
			return changes.filter((change) => {
				const fileName = path.basename(change.uri.fsPath);
				return extensions.some((ext) => fileName.includes(ext));
			});
		}

		return changes.filter((change) => {
			const ext = path.extname(change.uri.fsPath).toLowerCase();
			return extensions.includes(ext);
		});
	}

	getTreeItem(element: TreeElement): vscode.TreeItem {
		// Handle GitStatusGroup (Level 1: Staged/Unstaged)
		if ("type" in element && element.type === "gitStatusGroup") {
			const item = new vscode.TreeItem(element.label, element.collapsibleState);
			item.contextValue = element.contextValue;

			// CRITICAL: Set stable ID for state persistence and reveal
			item.id = `git-status-group-${element.statusType}`;

			// Custom Radar B icons for groups (same as individual files)
			// Use same icons for visual consistency: radar sweep (working) vs target lock (staged)
			item.iconPath = this.getGitStatusIcon(
				element.statusType === "staged" ? "staged" : "working",
			);

			// Rich tooltip with contextual help
			const statusEmoji = element.statusType === "staged" ? "✓" : "○";
			const statusDescription =
				element.statusType === "staged" ? "ready to commit" : "files changed";
			item.tooltip = new vscode.MarkdownString(
				`**${element.statusType === "staged" ? "Staged" : "Working"} Changes**\n\n` +
					`${statusEmoji} ${element.totalCount} ${statusDescription}\n\n` +
					`*Click to expand • Right-click for actions*`,
			);

			return item;
		}

		// Handle TimeGroup (Level 2: Today/Yesterday/etc.)
		if ("timePeriod" in element) {
			// Use clean label without emoji (emoji already in project title)
			const item = new vscode.TreeItem(element.label, element.collapsibleState);
			item.contextValue = element.contextValue;

			// CRITICAL: Set stable ID for state persistence and reveal
			// ID must be unique and consistent across refreshes
			// Include parentType prefix for git status grouping (staged-time-group-today, unstaged-time-group-today)
			const prefix = element.parentType ? `${element.parentType}-` : "";
			item.id = `${prefix}time-group-${element.timePeriod}`;

			// Always use VS Code standard calendar icon (reliable, theme-aware)
			item.iconPath = new vscode.ThemeIcon("calendar");

			return item;
		}

		// Guard against malformed elements (missing uri)
		// This can happen due to bugs in data processing or race conditions
		if (!element.uri) {
			this.logger.warn(
				`Malformed GitChangeItem (missing uri): ${JSON.stringify(element)}`,
			);
			return new vscode.TreeItem(
				"(Invalid Item)",
				vscode.TreeItemCollapsibleState.None,
			);
		}

		// Handle GitChangeItem (existing code)
		const fileName = path.basename(element.uri.fsPath);
		const relativePath = vscode.workspace.asRelativePath(element.uri);
		const dirName = path.dirname(relativePath);

		const isDeleted = this.isDeletedFile(element);

		// Show relative path if not in root
		const label = dirName === "." ? fileName : `${fileName}`;

		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.None,
		);

		// CRITICAL: Set stable ID for state persistence and reveal
		// ID must be unique and consistent across refreshes
		// Include parent context for git status grouping to avoid duplicate IDs
		// (same file can appear in both staged and unstaged groups for MM status)
		const prefix = element.parentType ? `${element.parentType}-` : "";
		item.id = `${prefix}${element.uri.fsPath}`;

		// Set the resource URI for opening diffs
		item.resourceUri = element.uri;

		// Special handling for deleted files
		if (isDeleted) {
			// Add deletion indicator to description
			const timeAgo = formatRelativeTime(element.timestamp);

			const description = dirName === "." ? timeAgo : `${timeAgo} • ${dirName}`;

			// Use trash icon for deleted files
			item.iconPath = new vscode.ThemeIcon("trash");

			// Still set resourceUri for file association
			item.resourceUri = element.uri;

			// Add trash decorator through description for backward compatibility
			item.description = `🗑️ ${description}`;

			// Set special context value for deleted files
			item.contextValue = element.isStaged
				? "staged-deleted"
				: "unstaged-deleted";

			// Enhanced tooltip for deleted files
			const tooltipLines = [
				`File: ${relativePath}`,
				`Status: Deleted (${element.isStaged ? "Staged" : "Unstaged"})`,
				`Changed: ${timeAgo}`,
			];

			if (element.timestamp) {
				const date = new Date(element.timestamp);
				tooltipLines.push(`Exact time: ${date.toLocaleString()}`);
			}

			// Add order information to tooltip
			if (element.order !== undefined) {
				tooltipLines.push(`Order: ${element.order}`);
			}

			item.tooltip = tooltipLines.join("\n");
		} else {
			// Regular file handling (non-deleted)
			let statusText = element.status || "Modified";

			// Check if file has both staged and unstaged changes
			if (statusText.includes("(staged+unstaged)")) {
				statusText = statusText.replace(" (staged+unstaged)", "");
				// Respect element.isStaged even for MM files to show correct diff
				// - In Staged section: show HEAD ↔ Index (staged changes)
				// - In Working section: show Index ↔ Working (unstaged changes)
				item.contextValue = element.isStaged ? "staged" : "staged-and-unstaged";
			} else {
				item.contextValue = element.isStaged ? "staged" : "unstaged";
			}

			// Use relative time instead of status text
			const timeAgo = formatRelativeTime(element.timestamp);

			const description = dirName === "." ? timeAgo : `${timeAgo} • ${dirName}`;
			item.description = description;

			// Add enhanced tooltip with full path, timestamp, and status
			const tooltipLines = [`File: ${relativePath}`];

			if (
				statusText !== element.status &&
				element.status?.includes("(staged+unstaged)")
			) {
				tooltipLines.push(
					`Status: ${statusText} (Staged and Unstaged changes)`,
				);
			} else {
				tooltipLines.push(
					`Status: ${statusText} (${element.isStaged ? "Staged" : "Unstaged"})`,
				);
			}

			tooltipLines.push(`Changed: ${timeAgo}`);

			if (element.timestamp) {
				const date = new Date(element.timestamp);
				tooltipLines.push(`Exact time: ${date.toLocaleString()}`);
			}

			item.tooltip = tooltipLines.join("\n");

			// Use VS Code's native file icon theme
			item.resourceUri = element.uri;
		}

		// Individual files use native file type icons (via resourceUri set above)
		// Custom icons are ONLY for group headers (GitStatusGroup)
		// resourceUri provides automatic theme-aware file type icons

		// CHANGED: Use native Git extension behavior - open diff on click
		// This matches native Source Control view behavior by calling our openChange()
		// method, which delegates to git.openChange for consistent diff display
		item.command = {
			command: "commandCentral.gitSort.openChange",
			title: "Open Changes",
			arguments: [element],
		};

		return item;
	}

	/**
	 * Collects working tree (unstaged) changes from repository
	 */
	private collectWorkingTreeChanges(repo: Repository): GitChangeItem[] {
		const changes: GitChangeItem[] = [];

		if (!repo.state.workingTreeChanges) {
			this.logger.warn("workingTreeChanges not available in repository state");
			return changes;
		}

		const workingChanges = repo.state.workingTreeChanges;

		// Log first change to verify direct access works
		if (workingChanges.length > 0) {
			const firstChange = workingChanges[0];
			if (firstChange) {
				const uri = firstChange.uri;
				const status = firstChange.status;
				this.logger.debug(
					`First change via direct access: path=${uri?.fsPath}, status=${status}`,
				);
			}
		}

		for (const change of workingChanges) {
			const changeUri = change.uri;
			if (!changeUri) {
				this.logger.warn("Change has no URI");
				continue;
			}

			changes.push({
				type: "gitChangeItem" as const,
				uri: changeUri,
				status: this.getStatusLabel(change),
				isStaged: false,
				parentType: "unstaged" as const,
			});
		}

		return changes;
	}

	/**
	 * Collects index (staged) changes from repository
	 */
	private collectIndexChanges(repo: Repository): GitChangeItem[] {
		const changes: GitChangeItem[] = [];

		if (!repo.state.indexChanges) {
			return changes;
		}

		const indexChanges = repo.state.indexChanges;
		this.logger.debug(`Found ${indexChanges.length} index changes`);

		for (const change of indexChanges) {
			const changeUri = change.uri;
			if (!changeUri) {
				this.logger.warn("Index change has no URI");
				continue;
			}

			changes.push({
				type: "gitChangeItem" as const,
				uri: changeUri,
				status: this.getStatusLabel(change),
				isStaged: true,
				parentType: "staged" as const,
			});
		}

		return changes;
	}

	/**
	 * Fallback method using diffWithHEAD when working tree changes unavailable
	 */
	private async collectFallbackChanges(
		repo: Repository,
		existingChanges: GitChangeItem[],
	): Promise<GitChangeItem[]> {
		const changes: GitChangeItem[] = [];

		try {
			const allDiffs = await repo.diffWithHEAD();
			if (!allDiffs || allDiffs.length === 0) {
				this.logger.debug("No changes found via diffWithHEAD");
				return changes;
			}

			this.logger.debug(`Found ${allDiffs.length} changes using diffWithHEAD`);

			for (const change of allDiffs) {
				const changeUri = change.uri;
				if (!changeUri) {
					this.logger.warn("Diff change has no URI");
					continue;
				}

				// Avoid duplicates with existing changes
				const exists = existingChanges.find(
					(c) => c.uri.fsPath === changeUri.fsPath,
				);
				if (!exists) {
					changes.push({
						type: "gitChangeItem" as const,
						uri: changeUri,
						status: this.getStatusLabel(change),
						isStaged: false,
						parentType: "unstaged" as const,
					});
				}
			}
		} catch (error) {
			this.logger.error("Failed to get changes via diffWithHEAD", error);
			// Log available properties for debugging
			this.logger.debug("Available state properties:");
			for (const key in repo.state) {
				const value = repo.state[key];
				if (Array.isArray(value)) {
					this.logger.debug(`  ${key}: Array[${value.length}]`);
				} else {
					this.logger.debug(`  ${key}: ${typeof value}`);
				}
			}
		}

		return changes;
	}

	/**
	 * Attempts to recover a missing timestamp using alternative strategies
	 * @returns true if timestamp was successfully recovered
	 */
	private async tryRecoverTimestamp(
		change: GitChangeItem,
		existingTimestamps: Map<string, number>,
	): Promise<boolean> {
		// Strategy 1: Try normalized path
		const normalizedPath = path.normalize(change.uri.fsPath);
		if (normalizedPath !== change.uri.fsPath) {
			const altTimestamp = existingTimestamps.get(normalizedPath);
			if (altTimestamp !== undefined) {
				change.timestamp = altTimestamp;
				this.logger.warn(
					`Recovered timestamp using normalized path for: ${change.uri.fsPath}`,
				);
				return true;
			}
		}

		// Strategy 2: Try direct stat as last resort (but not for deleted files)
		if (this.isDeletedFile(change)) {
			this.logger.debug(`Skipping stat for deleted file: ${change.uri.fsPath}`);
			return false;
		}

		try {
			const stat = await fs.stat(change.uri.fsPath);
			change.timestamp = stat.mtime.getTime();
			this.logger.warn(
				`Recovered timestamp using direct stat for: ${change.uri.fsPath}`,
			);
			return true;
		} catch (error) {
			this.logger.error(
				`Failed to stat file directly: ${change.uri.fsPath}`,
				error,
			);
		}

		// Strategy 3: Try with resolved symlinks
		try {
			const realPath = await fs.realpath(change.uri.fsPath);
			if (realPath !== change.uri.fsPath) {
				const realTimestamp = existingTimestamps.get(realPath);
				if (realTimestamp !== undefined) {
					change.timestamp = realTimestamp;
					this.logger.warn(
						`Recovered timestamp using resolved path for: ${change.uri.fsPath}`,
					);
					return true;
				}
			}
		} catch {
			// Path doesn't exist or can't be resolved
		}

		return false;
	}

	/**
	 * Enriches existing files with timestamps from filesystem
	 * @returns Array of file paths that couldn't get timestamps
	 */
	private async enrichExistingFiles(
		existingFiles: GitChangeItem[],
		workspaceRoot: string,
	): Promise<string[]> {
		if (existingFiles.length === 0) {
			return [];
		}

		const existingPaths = existingFiles.map((c) => c.uri.fsPath);
		this.logger.debug(
			`Getting timestamps for ${existingPaths.length} existing files`,
		);
		const existingTimestamps = await getGitAwareTimestamps(
			workspaceRoot,
			existingPaths,
		);

		// Add timestamps to existing files with self-healing strategies
		const missingExistingTimestamps: string[] = [];
		for (const change of existingFiles) {
			const timestamp = existingTimestamps.get(change.uri.fsPath);

			if (timestamp === undefined) {
				// Try alternative strategies to recover the timestamp
				const recovered = await this.tryRecoverTimestamp(
					change,
					existingTimestamps,
				);

				if (!recovered) {
					// Only mark as missing if file didn't already have a timestamp
					if (change.timestamp === undefined) {
						missingExistingTimestamps.push(change.uri.fsPath);
					}
				}
			} else {
				change.timestamp = timestamp;
			}
		}

		// Log errors for existing files that couldn't get timestamps
		if (missingExistingTimestamps.length > 0) {
			for (const filePath of missingExistingTimestamps) {
				this.logger.error(
					`❌ ERROR Failed to get timestamp for existing file: ${filePath}`,
				);
			}
		}

		return missingExistingTimestamps;
	}

	/**
	 * Enriches deleted files with timestamps and orders.
	 * Uses Date.now() as snapshot time for newly deleted files.
	 * Preserves existing timestamps for files already tracked.
	 * @returns Array of file paths that couldn't get timestamps
	 */
	private async enrichDeletedFiles(
		deletedFiles: GitChangeItem[],
	): Promise<string[]> {
		// Process all deleted files in parallel
		await Promise.all(
			deletedFiles.map(async (change) => {
				// Check if file is already tracked
				const existingOrder = this.deletedFileTracker.getOrder(
					change.uri.fsPath,
				);
				const existingFile =
					existingOrder !== undefined
						? this.deletedFileTracker
								.getAllDeletedFiles()
								.find((f) => f.filePath === change.uri.fsPath)
						: undefined;

				// Determine timestamp: existing or current time
				const timestamp = existingFile?.timestamp ?? Date.now();

				// Log appropriately (using timestamp number for performance)
				if (existingOrder !== undefined) {
					this.logger.debug(
						`Deleted file ${change.uri.fsPath} already tracked with timestamp: ${timestamp}`,
					);
				} else {
					this.logger.info(
						`New deletion detected: ${change.uri.fsPath}, timestamp: ${timestamp}`,
					);
				}

				// Enrich change object (mutation required for interface compatibility)
				change.timestamp = timestamp;
				change.order = this.deletedFileTracker.markAsDeleted(
					change.uri.fsPath,
					timestamp,
				);

				this.logger.debug(
					`Deleted file ${change.uri.fsPath}: timestamp=${timestamp}, order=${change.order}`,
				);
			}),
		);

		return [];
	}

	/**
	 * Handles error logging and user notifications for missing timestamps
	 * @returns false if no valid changes exist (caller should return empty array)
	 */
	private handleMissingTimestamps(
		missingExistingTimestamps: string[],
		allChangesWithTimestamps: GitChangeItem[],
	): boolean {
		// Only log errors for existing files (deleted files get fallback timestamp of 0)
		if (missingExistingTimestamps.length > 0) {
			this.logger.error(
				`Failed to get timestamps for ${missingExistingTimestamps.length} existing file(s)`,
			);
		}

		// Check if we have no valid changes at all
		if (allChangesWithTimestamps.length === 0) {
			this.logger.error(
				`No files with valid timestamps - returning empty list`,
			);
			vscode.window.showErrorMessage(
				`Git Sort: Failed to get timestamps for all files. Check Output > Command Central for details.`,
			);
			return false;
		}

		return true;
	}

	/**
	 * Enriches all changes with timestamps using filesystem and git history
	 * @returns Array of changes with timestamps, or empty array if critical failure
	 */
	private async enrichWithTimestamps(
		allChanges: GitChangeItem[],
		workspaceRoot: string,
	): Promise<GitChangeItem[]> {
		// Empty input is a normal case (e.g., no staged files when grouping enabled)
		// Return early without logging errors
		if (allChanges.length === 0) {
			return [];
		}

		// Separate deleted and existing files for different timestamp handling
		const deletedFiles: GitChangeItem[] = [];
		const existingFiles: GitChangeItem[] = [];

		for (const change of allChanges) {
			if (this.isDeletedFile(change)) {
				deletedFiles.push(change);
			} else {
				existingFiles.push(change);
			}
		}

		// Hide previously deleted files that are no longer in the deleted list
		const currentDeletedPaths = new Set(deletedFiles.map((f) => f.uri.fsPath));
		const previouslyDeletedFiles =
			this.deletedFileTracker.getVisibleDeletedFiles();

		for (const prevDeleted of previouslyDeletedFiles) {
			if (!currentDeletedPaths.has(prevDeleted.filePath)) {
				// File was deleted before but is not in current deleted list (restored)
				this.deletedFileTracker.hideFromView(prevDeleted.filePath);
				this.logger.debug(
					`Hiding restored file from view: ${prevDeleted.filePath}`,
				);
			}
		}

		// Get timestamps for existing files using filesystem
		const missingExistingTimestamps = await this.enrichExistingFiles(
			existingFiles,
			workspaceRoot,
		);

		// Get timestamps for deleted files using git history (fallback to 0 if unavailable)
		await this.enrichDeletedFiles(deletedFiles);

		// Combine only files that have timestamps
		const allChangesWithTimestamps = [...existingFiles, ...deletedFiles].filter(
			(c) => c.timestamp !== undefined,
		);

		// Handle files with missing timestamps
		const shouldContinue = this.handleMissingTimestamps(
			missingExistingTimestamps,
			allChangesWithTimestamps,
		);

		if (!shouldContinue) {
			return [];
		}

		return allChangesWithTimestamps;
	}

	/**
	 * Builds git status groups (3-level hierarchy)
	 *
	 * Creates GitStatusGroup → TimeGroup → GitChangeItem structure
	 * when git status grouping is enabled.
	 *
	 * @param allChanges - All git changes with timestamps
	 * @param repoUri - Repository URI for git status queries
	 * @returns Array of GitStatusGroup elements (Staged + Unstaged)
	 */
	/**
	 * Builds a single GitStatusGroup from native Git API array
	 *
	 * This method uses VS Code's native Git extension arrays directly:
	 * - repo.state.indexChanges → staged group (HEAD ↔ Index)
	 * - repo.state.workingTreeChanges → unstaged group (Index ↔ Working Tree)
	 *
	 * MM files (Modified-Modified) naturally appear in BOTH arrays, which is CORRECT
	 * behavior matching VS Code's native Source Control.
	 *
	 * @param type - "staged" or "unstaged" - which group to build
	 * @param changes - Native array from repo.state.indexChanges or workingTreeChanges
	 * @param parentType - For unique tree item IDs
	 * @returns GitStatusGroup with time-grouped children
	 */
	private buildStatusGroup(
		type: "staged" | "unstaged",
		changes: GitChangeItem[],
		parentType: "staged" | "unstaged",
	): GitStatusGroup {
		// Apply filters
		const filteredChanges =
			this.extensionFilterState && this.workspaceId
				? this.filterByExtensions(changes)
				: this.filterByFileType(changes);

		// CRITICAL: Add parentType to EACH change item for unique tree IDs
		// This prevents "already registered" errors when MM files appear in both sections
		const changesWithParent = filteredChanges.map((change) => ({
			...change,
			parentType,
		}));

		// Sort by timestamp
		const sortedChanges = changesWithParent.sort((a, b) => {
			const aTime = a.timestamp || 0;
			const bTime = b.timestamp || 0;
			return this.sortOrder === "newest" ? bTime - aTime : aTime - bTime;
		});

		// Group by time (changes already have parentType set)
		const timeGroups = this.groupChangesByTime(sortedChanges).map((group) => ({
			...group,
			parentType,
		}));

		// Build status group
		const group: GitStatusGroup = {
			type: "gitStatusGroup",
			statusType: type,
			label:
				type === "staged"
					? `Staged • ${filteredChanges.length} ready to commit`
					: `Working • ${filteredChanges.length} ${filteredChanges.length === 1 ? "file" : "files"} changed`,
			totalCount: filteredChanges.length,
			timeGroups: timeGroups,
			collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
			contextValue: "gitStatusGroup",
		};

		this.logger.info(
			`Built ${type} group: ${filteredChanges.length} ${type} files`,
		);

		return group;
	}

	/**
	 * Filters and sorts changes, then groups them by time period
	 * @returns Array of time groups containing the sorted and filtered changes
	 */
	private sortAndFilter(allChanges: GitChangeItem[]): TimeGroup[] {
		// Apply file type filter (new system with fallback to legacy)
		const filteredChanges =
			this.extensionFilterState && this.workspaceId
				? this.filterByExtensions(allChanges)
				: this.filterByFileType(allChanges);

		// Sort by timestamp
		filteredChanges.sort((a, b) => {
			const aTime = a.timestamp || 0;
			const bTime = b.timestamp || 0;

			if (this.sortOrder === "newest") {
				return bTime - aTime; // Newest first
			}
			return aTime - bTime; // Oldest first
		});

		// Smart logging: Only log at INFO when file count changes
		const previousCount = this.lastKnownFileCount;
		this.lastKnownFileCount = filteredChanges.length;

		if (filteredChanges.length !== previousCount) {
			this.logger.info(
				`Git changes: ${filteredChanges.length} files (${this.fileTypeFilter} filter, ${this.sortOrder} first)`,
			);
		} else {
			this.logger.debug(
				`Git changes: ${filteredChanges.length} files (unchanged count)`,
			);
		}

		// ALWAYS update title to ensure sort arrow is in sync
		// This fixes the issue where toggling sort wouldn't update title
		// because file count didn't change (only sort order changed)
		this.updateAllTreeViewTitles();

		// Group changes by time periods
		return this.groupChangesByTime(filteredChanges);
	}

	/**
	 * Logs timestamps for debugging purposes (samples first 10 files)
	 */
	private logTimestamps(allChanges: GitChangeItem[]): void {
		this.logger.debug("File timestamps:");
		const samplesToLog = Math.min(allChanges.length, 10);
		for (let i = 0; i < samplesToLog; i++) {
			const change = allChanges[i];
			if (change?.timestamp) {
				const date = new Date(change.timestamp);
				this.logger.debug(`  ${change.uri.fsPath}: ${date.toISOString()}`);
			}
		}
		if (allChanges.length > 10) {
			this.logger.debug(`  ... and ${allChanges.length - 10} more files`);
		}
	}

	/**
	 * Ensures the deleted file tracker is initialized with storage before first use.
	 * This is called lazily when we have access to the workspace root.
	 *
	 * @param workspaceRoot - The workspace root path from the repository
	 */
	private async ensureTrackerInitialized(workspaceRoot: string): Promise<void> {
		if (this.trackerInitialized) {
			return; // Already initialized
		}

		// Re-create tracker with storage and workspace root if storage provided
		if (this.storage) {
			this.deletedFileTracker = new DeletedFileTracker({
				storage: this.storage,
				workspaceRoot,
				logger: this.logger,
			});
		}

		try {
			await this.deletedFileTracker.initialize();
			this.trackerInitialized = true;
			this.logger.info(
				`Deleted file tracker initialized for workspace: ${workspaceRoot}`,
			);
		} catch (error) {
			this.logger.error("Failed to initialize deleted file tracker:", error);
			// Continue with in-memory only (tracker already has fallback logic)
			this.trackerInitialized = true;
		}
	}

	/**
	 * Gets children for the tree view.
	 *
	 * Multi-root workspace behavior:
	 * - Currently displays changes from the first workspace folder only
	 * - Future enhancement: Support aggregating changes from all workspace folders
	 *
	 * @param element - Tree element to get children for (undefined = root level)
	 * @returns Array of child elements (TimeGroups at root, GitChangeItems under groups)
	 */
	async getChildren(element?: TreeElement): Promise<TreeElement[]> {
		// If element is a GitStatusGroup, return its time groups
		if (element && "statusType" in element) {
			return element.timeGroups;
		}

		// If element is a TimeGroup, return its children
		if (element && "timePeriod" in element) {
			return element.children;
		}

		// If element is a GitChangeItem, it has no children
		if (element) {
			return [];
		}

		// Root level - return time groups
		if (!this.gitApi || !this.gitApi.repositories.length) {
			this.setEmptyStateMessage(false);
			this.resetCountAndTitles();
			return [];
		}

		try {
			// Find the repository for THIS provider's workspace folder
			// Falls back to first workspace folder for backward compatibility
			const targetUri =
				this.workspaceRootUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
			const repo = targetUri
				? this.findRepositoryForFile(targetUri)
				: this.gitApi.repositories[0];

			if (!repo) {
				this.setEmptyStateMessage(false);
				this.resetCountAndTitles();
				return [];
			}
			const workspaceRoot = repo.rootUri.fsPath;
			this.logger.debug(`Using repository: ${workspaceRoot}`);

			// Ensure deleted file tracker is initialized with storage (lazy initialization)
			await this.ensureTrackerInitialized(workspaceRoot);

			// Check if git status grouping is enabled
			const isGroupingEnabled =
				this.groupingStateManager?.isGroupingEnabled() ?? false;

			// Build tree structure based on grouping mode
			let rootElements: (TimeGroup | GitStatusGroup)[];

			if (isGroupingEnabled) {
				// NATIVE APPROACH: Use VS Code's Git API arrays directly
				// Do NOT merge, do NOT deduplicate - they're already correctly separated!

				// Collect native arrays separately (NO MERGING!)
				const stagedChanges = this.collectIndexChanges(repo);
				const workingChanges = this.collectWorkingTreeChanges(repo);

				// Use fallback only for working changes if needed
				const fallbackChanges =
					workingChanges.length === 0
						? await this.collectFallbackChanges(repo, [])
						: [];
				const allWorkingChanges = [...workingChanges, ...fallbackChanges];

				// Enrich EACH array separately (important for timestamps)
				const enrichedStaged = await this.enrichWithTimestamps(
					stagedChanges,
					workspaceRoot,
				);
				const enrichedWorking = await this.enrichWithTimestamps(
					allWorkingChanges,
					workspaceRoot,
				);

				// Log timestamps for debugging
				this.logTimestamps([...enrichedStaged, ...enrichedWorking]);

				// Validate filter state against actual files
				// Combine both arrays just for validation (not for processing!)
				const allChangesForValidation = [...enrichedStaged, ...enrichedWorking];
				if (
					this.extensionFilterState &&
					this.workspaceId &&
					allChangesForValidation.length > 0
				) {
					const filePaths = allChangesForValidation.map((c) => c.uri.fsPath);
					const filterModified =
						this.extensionFilterState.validateAndCleanFilter(
							this.workspaceId,
							filePaths,
						);

					if (filterModified) {
						this.logger.info(
							`[${this.workspaceId}] Filter cleaned, updating title to reflect actual files`,
						);
						this.updateAllTreeViewTitles();
					}
				}

				// Build groups directly from native arrays (NO DEDUPLICATION!)
				// MM files will naturally appear in BOTH groups - this is CORRECT!
				const stagedGroup = this.buildStatusGroup(
					"staged",
					enrichedStaged,
					"staged",
				);
				const unstagedGroup = this.buildStatusGroup(
					"unstaged",
					enrichedWorking,
					"unstaged",
				);

				// Only include groups that have files (avoid empty headers)
				rootElements = [stagedGroup, unstagedGroup].filter(
					(g) => g.totalCount > 0,
				);

				// Update tree view message for filter feedback
				const totalFilteredCount =
					stagedGroup.totalCount + unstagedGroup.totalCount;
				const totalUnfilteredCount =
					enrichedStaged.length + enrichedWorking.length;
				this.updateTreeViewMessage(totalUnfilteredCount, totalFilteredCount);

				// Set empty state message when repo exists but has no changes
				if (totalUnfilteredCount === 0) {
					this.setEmptyStateMessage(true);
				}

				// Update cached count (sum of both groups)
				const totalCount = stagedGroup.totalCount + unstagedGroup.totalCount;
				const previousCount = this.lastKnownFileCount;
				this.lastKnownFileCount = totalCount;

				if (previousCount !== this.lastKnownFileCount) {
					this.logger.info(
						`File count changed: ${previousCount} → ${this.lastKnownFileCount}`,
					);
				}

				// Update title to reflect current state
				this.updateAllTreeViewTitles();

				this.logger.info(
					`Git status grouping enabled: ${stagedGroup.totalCount} staged, ${unstagedGroup.totalCount} unstaged`,
				);
			} else {
				// Non-grouping mode: use old logic (merge is ok here since no deduplication)
				let allChanges: GitChangeItem[] = [];

				// Collect working tree (unstaged) changes
				const workingTreeChanges = this.collectWorkingTreeChanges(repo);
				allChanges.push(...workingTreeChanges);

				// Use fallback if no working tree changes found
				if (workingTreeChanges.length === 0) {
					const fallbackChanges = await this.collectFallbackChanges(
						repo,
						allChanges,
					);
					allChanges.push(...fallbackChanges);
				}

				// Collect index (staged) changes
				const indexChanges = this.collectIndexChanges(repo);
				allChanges.push(...indexChanges);

				// Enrich all changes with timestamps
				allChanges = await this.enrichWithTimestamps(allChanges, workspaceRoot);

				// Return early if enrichment failed or no changes remain
				if (allChanges.length === 0) {
					this.setEmptyStateMessage(true);
					this.resetCountAndTitles();
					return [];
				}

				// Log timestamps for debugging
				this.logTimestamps(allChanges);

				// Validate filter state
				if (
					this.extensionFilterState &&
					this.workspaceId &&
					allChanges.length > 0
				) {
					const filePaths = allChanges.map((c) => c.uri.fsPath);
					const filterModified =
						this.extensionFilterState.validateAndCleanFilter(
							this.workspaceId,
							filePaths,
						);

					if (filterModified) {
						this.logger.info(
							`[${this.workspaceId}] Filter cleaned, updating title to reflect actual files`,
						);
						this.updateAllTreeViewTitles();
					}
				}

				// Build 2-level hierarchy: TimeGroup → GitChangeItem
				const timeGroups = this.sortAndFilter(allChanges);
				rootElements = timeGroups;

				// Update tree view message for filter feedback
				const filteredCount = timeGroups.reduce(
					(sum, g) => sum + g.children.length,
					0,
				);
				this.updateTreeViewMessage(allChanges.length, filteredCount);
			}

			// CRITICAL: Populate parent map for getParent() and reveal()
			// Must happen AFTER grouping, BEFORE returning to VS Code
			// This enables TreeView.reveal() to navigate the tree structure
			if (isGroupingEnabled) {
				// For git status grouping: populate from GitStatusGroup → TimeGroup → GitChangeItem
				this.populateParentMapFromGitStatusGroups(
					rootElements as GitStatusGroup[],
				);
			} else {
				// For time grouping: populate from TimeGroup → GitChangeItem
				this.populateParentMap(rootElements as TimeGroup[]);
			}

			return rootElements;
		} catch (error) {
			this.logger.error("Failed to get sorted changes", error);
			// CRITICAL: Clear both parent map and tree cache to prevent stale data
			// If tree is empty (error case), both should be empty
			this.parentMap.clear();
			this.cachedTreeStructure = [];
			// BUG FIX: We already confirmed a repo exists (passed the repo check above),
			// so use hasRepo=true to show "No changes to display." instead of letting
			// viewsWelcome show "Open a Git repository..." which is misleading.
			this.setEmptyStateMessage(true);
			this.resetCountAndTitles();
			return [];
		}
	}

	/**
	 * Groups changes by time period (Today, Yesterday, Last 7 days, etc.)
	 * Only returns groups that contain files.
	 * @param changes - Array of Git changes to group
	 * @returns Array of time groups with their associated changes
	 */
	private groupChangesByTime(changes: GitChangeItem[]): TimeGroup[] {
		const now = new Date();
		const todayStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
		).getTime();
		const yesterdayStart = todayStart - TIME_PERIODS.DAY;
		const last7DaysStart = todayStart - TIME_PERIODS.WEEK;
		const last30DaysStart = todayStart - TIME_PERIODS.MONTH;

		// Get month boundaries
		const currentMonth = new Date(
			now.getFullYear(),
			now.getMonth(),
			1,
		).getTime();
		const lastMonth = new Date(
			now.getFullYear(),
			now.getMonth() - 1,
			1,
		).getTime();

		// Initialize file groups
		const today: GitChangeItem[] = [];
		const yesterday: GitChangeItem[] = [];
		const last7Days: GitChangeItem[] = [];
		const last30Days: GitChangeItem[] = [];
		const thisMonth: GitChangeItem[] = [];
		const lastMonthFiles: GitChangeItem[] = [];
		const older: GitChangeItem[] = [];

		// Categorize files
		for (const change of changes) {
			// Validate timestamp
			const timestamp =
				change.timestamp &&
				!Number.isNaN(change.timestamp) &&
				change.timestamp > 0
					? change.timestamp
					: 0;

			if (timestamp === 0) {
				// Files with invalid timestamps go to older
				older.push(change);
			} else if (timestamp >= todayStart) {
				today.push(change);
			} else if (timestamp >= yesterdayStart) {
				yesterday.push(change);
			} else if (timestamp >= currentMonth) {
				thisMonth.push(change);
			} else if (timestamp >= lastMonth) {
				lastMonthFiles.push(change);
			} else if (timestamp >= last7DaysStart) {
				last7Days.push(change);
			} else if (timestamp >= last30DaysStart) {
				last30Days.push(change);
			} else {
				older.push(change);
			}
		}

		// Create groups (only if they have files)
		const groups: TimeGroup[] = [];

		if (today.length > 0) {
			groups.push({
				type: "timeGroup",
				label: `Today (${today.length} file${today.length !== 1 ? "s" : ""})`,
				timePeriod: "today",
				children: today,
				collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
				contextValue: "timeGroup",
			});
		}

		if (yesterday.length > 0) {
			groups.push({
				type: "timeGroup",
				label: `Yesterday (${yesterday.length} file${yesterday.length !== 1 ? "s" : ""})`,
				timePeriod: "yesterday",
				children: yesterday,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			});
		}

		if (last7Days.length > 0) {
			groups.push({
				type: "timeGroup",
				label: `Last 7 days (${last7Days.length} file${last7Days.length !== 1 ? "s" : ""})`,
				timePeriod: "last7days",
				children: last7Days,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			});
		}

		if (last30Days.length > 0) {
			groups.push({
				type: "timeGroup",
				label: `Last 30 days (${last30Days.length} file${last30Days.length !== 1 ? "s" : ""})`,
				timePeriod: "last30days",
				children: last30Days,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			});
		}

		// Add month groups if needed
		if (thisMonth.length > 0) {
			const monthName = now.toLocaleString("default", { month: "long" });
			groups.push({
				type: "timeGroup",
				label: `${monthName} (${thisMonth.length} file${thisMonth.length !== 1 ? "s" : ""})`,
				timePeriod: "thisMonth",
				children: thisMonth,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			});
		}

		if (lastMonthFiles.length > 0) {
			const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			const monthName = lastMonthDate.toLocaleString("default", {
				month: "long",
			});
			groups.push({
				type: "timeGroup",
				label: `${monthName} (${lastMonthFiles.length} file${lastMonthFiles.length !== 1 ? "s" : ""})`,
				timePeriod: "lastMonth",
				children: lastMonthFiles,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			});
		}

		if (older.length > 0) {
			// Sort deleted files by order, non-deleted files by timestamp
			const sortedOlder = older.sort((a, b) => {
				const aIsDeleted = this.isDeletedFile(a);
				const bIsDeleted = this.isDeletedFile(b);

				// Both deleted: sort by order
				if (aIsDeleted && bIsDeleted) {
					const aOrder = a.order ?? Number.MAX_SAFE_INTEGER;
					const bOrder = b.order ?? Number.MAX_SAFE_INTEGER;
					return aOrder - bOrder;
				}

				// One deleted, one not: deleted files first
				if (aIsDeleted) return -1;
				if (bIsDeleted) return 1;

				// Neither deleted: sort by timestamp
				const aTime = a.timestamp || 0;
				const bTime = b.timestamp || 0;
				return this.sortOrder === "newest" ? bTime - aTime : aTime - bTime;
			});

			groups.push({
				type: "timeGroup",
				label: `Older (${older.length} file${older.length !== 1 ? "s" : ""})`,
				timePeriod: "older",
				children: sortedOlder,
				collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
				contextValue: "timeGroup",
			});
		}

		return groups;
	}

	/**
	 * Populates the parent map with child-to-parent relationships
	 * AND caches the tree structure for findItemByUri lookups
	 *
	 * CRITICAL: Must be called after grouping, before returning tree to VS Code
	 *
	 * This enables TreeView.reveal() to work by allowing getParent() lookups.
	 * Without this, reveal() will silently fail because VS Code can't navigate
	 * the tree structure to find where to highlight items.
	 *
	 * The cached tree structure ensures findItemByUri() returns the EXACT SAME
	 * object instances that exist in the tree, which is required for getParent()
	 * to work (Map.get() requires === comparison).
	 *
	 * Performance: O(n) where n is total number of file items
	 * Memory: O(n) to store parent references + O(1) for tree reference
	 *
	 * Called by: getChildren() after sortAndFilter() creates groups
	 *
	 * @param groups - Array of TimeGroups with their children
	 */
	private populateParentMap(groups: TimeGroup[]): void {
		// Clear existing mappings (important for refresh scenarios)
		this.parentMap.clear();

		// CRITICAL: Cache the tree structure for findItemByUri
		// This ensures we search the same object instances that VS Code has in the tree
		// Without this, reveal() fails with collapsed time groups because we return
		// different object instances and getParent() returns undefined
		this.cachedTreeStructure = groups;

		// For each TimeGroup, map all children to their parent
		for (const group of groups) {
			for (const child of group.children) {
				this.parentMap.set(child, group);
			}
		}

		this.logger.debug(
			`Parent map populated: ${this.parentMap.size} file items tracked across ${groups.length} time groups`,
		);
	}

	/**
	 * Populates parent map for 3-level hierarchy (GitStatusGroup → TimeGroup → GitChangeItem)
	 *
	 * Similar to populateParentMap but handles git status grouping structure.
	 * Maps both TimeGroup → GitStatusGroup and GitChangeItem → TimeGroup relationships.
	 *
	 * @param gitStatusGroups - Array of GitStatusGroups with nested TimeGroups
	 */
	private populateParentMapFromGitStatusGroups(
		gitStatusGroups: GitStatusGroup[],
	): void {
		// Clear existing mappings
		this.parentMap.clear();

		// Cache the tree structure (root level is GitStatusGroup[])
		this.cachedTreeStructure = gitStatusGroups;

		// For each GitStatusGroup
		for (const statusGroup of gitStatusGroups) {
			// Map each TimeGroup to its parent GitStatusGroup
			for (const timeGroup of statusGroup.timeGroups) {
				// Note: parentMap expects TimeGroup parent, but for 3-level we'd need to track GitStatusGroup too
				// For now, map files directly to their TimeGroup parent (getParent will need updating)
				for (const child of timeGroup.children) {
					this.parentMap.set(child, timeGroup);
				}
			}
		}

		this.logger.debug(
			`Parent map populated (3-level): ${this.parentMap.size} file items across ${gitStatusGroups.length} status groups`,
		);
	}

	private getStatusLabel(change: Change | GitChangeItem): string {
		// Handle numeric Status enum values from VS Code Git API
		if ("status" in change && typeof change.status === "number") {
			// Following VS Code's repository.ts pattern
			switch (change.status) {
				// Modified statuses
				case Status.INDEX_MODIFIED:
				case Status.MODIFIED:
				case Status.BOTH_MODIFIED:
					return "Modified";

				// Added statuses
				case Status.INDEX_ADDED:
				case Status.ADDED_BY_US:
				case Status.ADDED_BY_THEM:
				case Status.BOTH_ADDED:
					return "Added";

				// Deleted statuses
				case Status.INDEX_DELETED:
				case Status.DELETED:
				case Status.DELETED_BY_US:
				case Status.DELETED_BY_THEM:
				case Status.BOTH_DELETED:
					return "Deleted";

				// Other statuses
				case Status.INDEX_RENAMED:
					return "Renamed";
				case Status.INDEX_COPIED:
					return "Copied";
				case Status.UNTRACKED:
					return "Untracked";
				case Status.IGNORED:
					return "Ignored";

				default:
					// Log unexpected status for debugging
					this.logger.warn(
						`Unknown numeric status value: ${(change as Change).status}`,
					);
					return "Unknown";
			}
		}

		// Handle string status (if it's already converted)
		if ("status" in change && typeof change.status === "string") {
			// If it's already a label like "Modified", return as-is
			// If it's a letter code, convert it
			const statusMap: Record<string, string> = {
				M: "Modified",
				A: "Added",
				D: "Deleted",
				R: "Renamed",
				C: "Copied",
				U: "Untracked",
				"?": "Untracked",
				"!": "Ignored",
			};
			return statusMap[change.status] || change.status;
		}

		// Default fallback
		return "Unknown";
	}

	/**
	 * Finds a GitChangeItem by its URI
	 * Used for active file tracking - reveals item when file is opened in editor
	 *
	 * CRITICAL: Searches through CACHED tree structure, not getCurrentChanges()
	 * This ensures we return the exact same object instances that VS Code has in the tree.
	 * Without this, getParent() returns undefined and reveal() can't expand collapsed groups.
	 *
	 * Supports both 2-level (TimeGroup → GitChangeItem) and 3-level (GitStatusGroup → TimeGroup → GitChangeItem) hierarchies.
	 *
	 * @param uri - File URI to search for
	 * @returns GitChangeItem if found in cached tree, undefined otherwise
	 *
	 * Search Strategy:
	 * 1. Search through cached structure (TimeGroup[] or GitStatusGroup[])
	 * 2. Return the exact object instance from the tree
	 * 3. This enables getParent() to work (Map.get requires ===)
	 */
	public findItemByUri(uri: vscode.Uri): GitChangeItem | undefined {
		if (!uri) {
			this.logger.warn("findItemByUri called with invalid uri");
			return undefined;
		}

		this.logger.debug(`🔎 findItemByUri: Searching for ${uri.fsPath}`);

		// CRITICAL: Search through CACHED tree structure, not getCurrentChanges()
		// This ensures we return the exact same object instances that VS Code has in the tree
		// Without this, getParent() returns undefined and reveal() can't expand collapsed groups
		if (!this.cachedTreeStructure || this.cachedTreeStructure.length === 0) {
			this.logger.debug("⚠️  findItemByUri: No cached tree structure");
			return undefined;
		}

		this.logger.debug(
			`📊 findItemByUri: Searching through ${this.cachedTreeStructure.length} root elements`,
		);

		// Search through cached structure (handles both TimeGroup[] and GitStatusGroup[])
		for (const rootElement of this.cachedTreeStructure) {
			// Check if root element is GitStatusGroup (3-level hierarchy)
			if ("statusType" in rootElement) {
				// Search through nested time groups
				for (const timeGroup of rootElement.timeGroups) {
					for (const item of timeGroup.children) {
						if (item.uri.fsPath === uri.fsPath) {
							this.logger.debug(
								`✅ findItemByUri: Found in "${rootElement.label}" → "${timeGroup.label}": ${item.uri.fsPath}`,
							);
							return item; // Return the exact object instance from the tree
						}
					}
				}
			}
			// Root element is TimeGroup (2-level hierarchy)
			else if ("timePeriod" in rootElement) {
				for (const item of rootElement.children) {
					if (item.uri.fsPath === uri.fsPath) {
						this.logger.debug(
							`✅ findItemByUri: Found in "${rootElement.label}": ${item.uri.fsPath}`,
						);
						return item; // Return the exact object instance from the tree
					}
				}
			}
		}

		this.logger.debug(
			`⏭️  findItemByUri: Not found in ${this.cachedTreeStructure.length} root elements`,
		);
		return undefined;
	}

	/**
	 * Type guard to check if element is a TimeGroup
	 *
	 * Used by getParent() for type-safe discrimination between
	 * TimeGroup (root items) and GitChangeItem (file items).
	 *
	 * This allows TypeScript to narrow the type and provide better
	 * compile-time type checking.
	 *
	 * @param element - Tree element to check
	 * @returns True if element is a TimeGroup (has timePeriod property)
	 */
	private isTimeGroup(element: TreeElement): element is TimeGroup {
		return "timePeriod" in element;
	}

	/**
	 * Gets the parent element for tree navigation
	 *
	 * CRITICAL: Required for TreeView.reveal() to work!
	 *
	 * VS Code's TreeView.reveal() API requires getParent() to navigate
	 * the tree structure and determine where to highlight items.
	 *
	 * Without this method:
	 * - reveal() will silently fail (no errors thrown)
	 * - Logs will show "Successfully revealed"
	 * - BUT no visual highlight appears in the tree
	 *
	 * Implementation:
	 * - File items (GitChangeItem) return their parent TimeGroup
	 * - Root items (TimeGroup) return undefined
	 * - Parent relationships populated by getChildren() → populateParentMap()
	 *
	 * @param element - The tree element to get parent for
	 * @returns Parent TimeGroup for file items, undefined for root items
	 */
	public getParent(element: TreeElement): TimeGroup | undefined {
		// Root level items (TimeGroups) have no parent
		if (this.isTimeGroup(element)) {
			return undefined;
		}

		// File items return their parent TimeGroup (may be undefined if not grouped)
		return this.parentMap.get(element);
	}

	/**
	 * Finds the repository that contains the given file URI
	 * Delegates to shared utility in utils/git-repo-utils.ts
	 *
	 * @param uri - File URI to find repository for
	 * @returns Repository containing the file, or undefined if not found
	 */
	findRepositoryForFile(uri: vscode.Uri): Repository | undefined {
		if (!this.gitApi) {
			return undefined;
		}
		return findRepoForFile(uri, this.gitApi);
	}

	/**
	 * Determines if a change represents a deleted file
	 * Follows VS Code Git API conventions for all deletion statuses
	 */
	private isDeletedFile(change: Change | GitChangeItem): boolean {
		if (!change || !change.uri) {
			return false;
		}

		// Add debug logging to understand what we're getting
		this.logger.debug(
			`Checking if deleted - status: ${change.status}, type: ${typeof change.status}`,
		);

		// Check numeric Status enum from VS Code Git API
		if ("status" in change && typeof change.status === "number") {
			// Check all deletion-related statuses
			const isDeleted =
				change.status === Status.INDEX_DELETED || // Staged deletion
				change.status === Status.DELETED || // Working tree deletion
				change.status === Status.BOTH_DELETED || // Deleted in both branches (merge)
				change.status === Status.DELETED_BY_US || // Deleted in our branch (merge)
				change.status === Status.DELETED_BY_THEM; // Deleted in their branch (merge)

			this.logger.debug(
				`Numeric status ${change.status} -> isDeleted: ${isDeleted}`,
			);
			return isDeleted;
		}

		// Check string status (after getStatusLabel conversion)
		if ("status" in change && typeof change.status === "string") {
			const isDeleted =
				change.status === "Deleted" ||
				change.status === "D" ||
				change.status === "Deleted (staged+unstaged)";
			this.logger.debug(
				`String status "${change.status}" -> isDeleted: ${isDeleted}`,
			);
			return isDeleted;
		}

		this.logger.debug(`No status found, returning false`);
		return false;
	}

	async dispose(): Promise<void> {
		// Abort any pending operations
		if (this.refreshAbortController) {
			this.refreshAbortController.abort();
		}

		// Clear timer
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}

		// Dispose all event subscriptions
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];

		// Dispose deleted file tracker (flushes pending saves)
		if (this.deletedFileTracker) {
			await this.deletedFileTracker.dispose();
		}

		// Close storage adapter
		if (this.storage) {
			await this.storage.close();
		}

		// Dispose EventEmitter if it was created
		if (this._onDidChangeTreeData) {
			this._onDidChangeTreeData.dispose();
		}
	}
}
