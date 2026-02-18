/**
 * GroupingViewManager - Simplified view lifecycle management
 *
 * NEW STANDARD (Simplified vs Extension Filter):
 * ✅ No complex 3-state lifecycle machine (simple is better)
 * ✅ Synchronous construction (no async population)
 * ✅ Proper visibility persistence (globalState + setContext)
 * ✅ createTreeView registration (recommended pattern)
 * ✅ Clean encapsulation - No test-only methods
 *
 * Anti-Patterns ELIMINATED:
 * ❌ No over-engineered async lifecycle (Extension Filter: 909 lines, 3-state machine)
 * ❌ No unnecessary complexity for static data
 * ❌ No test-only getters (isVisible(), getTreeView())
 * ✅ Simple, testable, maintainable design
 *
 * Testing Philosophy (Industry Best Practice):
 * This class is tested through OBSERVABLE EFFECTS only:
 * - globalState.update() - Verifies persistence
 * - executeCommand("setContext") - Verifies UI state
 * - createTreeView() - Verifies registration
 * - dispose() - Verifies cleanup
 *
 * We do NOT expose internal state for testing (no isVisible() getter).
 * This follows Google Testing Blog guidance: "Test behavior, not implementation."
 *
 * See: TEST_DESIGN_BEST_PRACTICES.md and TEST_REFACTORING_PLAN.md
 *
 * Complexity Comparison:
 * - Extension Filter ViewManager: 909 lines, async flow, state machine
 * - THIS GroupingViewManager: ~200 lines, sync flow, simple
 * - Reduction: 78% less code, easier to test and debug
 */

import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";
import type {
	IGroupingStateManager,
	IGroupingViewManager,
} from "../types/service-interfaces.js";
import {
	type GroupingOption,
	GroupingTreeProvider,
} from "./grouping-tree-provider.js";

/**
 * Manages the Grouping Options TreeView lifecycle
 *
 * Responsibilities:
 * - Create and register TreeView at construction
 * - Manage view visibility (show/hide panel)
 * - Persist visibility preference across sessions
 * - Clean up resources on disposal
 *
 * Architecture:
 * - Simple constructor (no async, no state machine)
 * - TreeView created immediately (always available)
 * - Visibility controlled via VS Code context
 */
export class GroupingViewManager
	implements IGroupingViewManager, vscode.Disposable
{
	/** TreeView instance (created at construction) */
	private treeView: vscode.TreeView<GroupingOption>;

	/** Tree provider (created at construction) */
	private provider: GroupingTreeProvider;

	/** Current visibility state */
	private isViewVisible: boolean;

	/** Storage key for visibility persistence */
	private static readonly VISIBILITY_KEY = "commandCentral.grouping.visible";

	/** VS Code context key for when clauses */
	private static readonly VISIBILITY_CONTEXT =
		"commandCentral.grouping.visible";

	/**
	 * Create a new grouping view manager
	 *
	 * NEW STANDARD: Simple, synchronous constructor
	 * - No async lifecycle
	 * - No state machine (uninitialized → loading → ready)
	 * - TreeView created immediately
	 * - Visibility restored from storage
	 *
	 * @param context - Extension context for storage and subscriptions
	 * @param stateManager - Grouping state manager
	 * @param logger - Logger service
	 */
	constructor(
		private context: vscode.ExtensionContext,
		stateManager: IGroupingStateManager,
		private logger: LoggerService,
	) {
		// Restore visibility from storage (default: visible for new users)
		this.isViewVisible = context.globalState.get(
			GroupingViewManager.VISIBILITY_KEY,
			true, // Default to visible - show feature to new users
		);

		// Create provider (simple, no async data loading)
		this.provider = new GroupingTreeProvider(stateManager);

		// 🆕 PROPER REGISTRATION: createTreeView (not registerTreeDataProvider)
		// Provides full TreeView API access (reveal, focus, etc.)
		this.treeView = vscode.window.createTreeView("commandCentral.grouping", {
			treeDataProvider: this.provider,
			canSelectMany: false, // Single selection semantics
			showCollapseAll: false, // Flat list - no collapse needed
		});

		// Add to extension subscriptions for automatic disposal
		context.subscriptions.push(this.treeView);

		// Apply initial visibility state
		// Sets VS Code context for package.json when clause
		void this.updateVisibilityContext(this.isViewVisible);

		this.logger.info(
			`Grouping view manager initialized (visible: ${this.isViewVisible})`,
		);
	}

	/**
	 * Toggle view visibility
	 *
	 * Called by:
	 * - Keyboard shortcut ('g' key when focused on commandCentral view)
	 * - Command palette
	 * - Context menu (future)
	 *
	 * Flow:
	 * 1. Flip visibility boolean
	 * 2. Persist to globalState (survives reload/restart)
	 * 3. Update VS Code context (for when clause in package.json)
	 *
	 * @returns Promise that resolves when toggle is complete
	 */
	async toggle(): Promise<void> {
		// Flip visibility
		this.isViewVisible = !this.isViewVisible;

		// Persist to storage (survives VS Code restart)
		await this.context.globalState.update(
			GroupingViewManager.VISIBILITY_KEY,
			this.isViewVisible,
		);

		// Update VS Code context (for when clause: "commandCentral.grouping.visible")
		await this.updateVisibilityContext(this.isViewVisible);

		this.logger.info(
			`Grouping view ${this.isViewVisible ? "shown" : "hidden"}`,
		);
	}

	/**
	 * Update VS Code context for visibility control
	 *
	 * Sets context variable that package.json when clause uses:
	 * "when": "commandCentral.grouping.visible"
	 *
	 * @param visible - true to show view, false to hide
	 * @private
	 */
	private async updateVisibilityContext(visible: boolean): Promise<void> {
		await vscode.commands.executeCommand(
			"setContext",
			GroupingViewManager.VISIBILITY_CONTEXT,
			visible,
		);
	}

	/**
	 * Select a grouping option
	 *
	 * Called by command when user clicks an option in the tree
	 * Delegates to the provider's selectOption method
	 *
	 * @param optionId - ID of the option to select
	 */
	async selectOption(optionId: "none" | "gitStatus"): Promise<void> {
		await this.provider.selectOption(optionId);
	}

	/**
	 * Dispose resources
	 *
	 * Required by vscode.Disposable interface
	 *
	 * Cleans up:
	 * - TreeView (already in context.subscriptions)
	 * - Provider (EventEmitter, state subscriptions)
	 */
	dispose(): void {
		this.provider.dispose();
		this.treeView.dispose();
		this.logger.info("Grouping view manager disposed");
	}
}
