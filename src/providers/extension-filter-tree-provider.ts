/**
 * ExtensionFilterTreeProvider - TreeView provider for hierarchical extension filters
 *
 * Provides a proper hierarchical checkbox tree for filtering Git changes by extension:
 * - Parent nodes: Extensions (e.g., ".ts (TypeScript)")
 * - Child nodes: Workspaces (e.g., "Frontend — 10 files")
 * - Checkbox semantics: Parent checked = ALL children checked (using .every())
 *
 * Architecture:
 * - Uses FilterStateManager for state management
 * - Subscribes to state changes for automatic tree refresh
 * - Implements VS Code TreeDataProvider with checkbox support
 *
 * Usage:
 * ```typescript
 * const provider = new ExtensionFilterTreeProvider(extensionData, stateManager, displayNames);
 * const treeView = vscode.window.createTreeView('myView', { treeDataProvider: provider });
 * ```
 */

import * as vscode from "vscode";
import type { FilterStateManager } from "../state/filter-state-manager.js";
import type { FileExtensionInfo } from "../utils/extension-discovery.js";

/**
 * Node types in the extension filter tree
 */
export type FilterNode = ExtensionNode | WorkspaceNode;

/**
 * Parent node representing a file extension
 */
export interface ExtensionNode {
	type: "extension";
	extension: string; // e.g., ".ts"
	displayName: string; // e.g., "TypeScript"
	totalCount: number; // Total files across all workspaces
}

/**
 * Child node representing a workspace containing files of this extension
 */
export interface WorkspaceNode {
	type: "workspace";
	extension: string; // Parent extension
	workspace: string; // Workspace ID
	displayName: string; // Friendly workspace name
	fileCount: number; // Files in this workspace
}

/**
 * TreeView provider for extension-based file filtering
 *
 * Implements proper hierarchical checkbox tree with semantic correctness:
 * - Parent checkbox: checked if ALL children checked (uses .every())
 * - Clicking parent: applies to ALL children
 * - No semantic mismatch or data corruption
 */
export class ExtensionFilterTreeProvider
	implements vscode.TreeDataProvider<FilterNode>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<
		FilterNode | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private stateChangeDisposable: vscode.Disposable;

	/**
	 * Create a new extension filter tree provider
	 *
	 * @param extensionData - Extension metadata with workspace counts (can be empty initially)
	 * @param stateManager - State manager for filter state
	 * @param workspaceDisplayNames - Mapping of workspace IDs to friendly names
	 */
	constructor(
		private extensionData: FileExtensionInfo[] = [],
		private stateManager: FilterStateManager,
		private workspaceDisplayNames: Map<string, string> = new Map(),
	) {
		console.log(
			"[TreeProvider] Constructor called, subscribing to state changes",
		);
		// Subscribe to state changes to refresh tree automatically
		this.stateChangeDisposable = this.stateManager.onDidChange((event) => {
			console.log(
				`[TreeProvider] State changed: ${event.extension} / ${event.workspace} / ${event.enabled}`,
			);
			console.log("[TreeProvider] Firing onDidChangeTreeData to refresh UI");
			this._onDidChangeTreeData.fire(undefined);
			console.log("[TreeProvider] onDidChangeTreeData fired");
		});
		console.log("[TreeProvider] State change subscription established");
	}

	/**
	 * Update provider with new data
	 *
	 * Allows updating the tree without recreating the provider.
	 * Useful for maintaining TreeView persistence across command invocations.
	 *
	 * NOTE: State manager is NOT updated here anymore. It's created once
	 * in the constructor and reused. This prevents subscription churn.
	 * Use forceRefresh() to manually trigger tree updates.
	 *
	 * @param extensionData - New extension metadata
	 * @param workspaceDisplayNames - New workspace display names
	 * @param stateManager - DEPRECATED - Not used, kept for API compatibility
	 */
	updateData(
		extensionData: FileExtensionInfo[],
		workspaceDisplayNames: Map<string, string>,
		_stateManager?: FilterStateManager,
	): void {
		console.log(
			`[TreeProvider] updateData called with ${extensionData.length} extensions`,
		);
		this.extensionData = extensionData;
		this.workspaceDisplayNames = workspaceDisplayNames;

		// Trigger tree refresh
		console.log("[TreeProvider] Triggering immediate tree refresh");
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * Get children for a tree node
	 *
	 * @param element - Parent node (undefined = root)
	 * @returns Array of child nodes
	 */
	async getChildren(element?: FilterNode): Promise<FilterNode[]> {
		// Root level: return extension nodes
		if (!element) {
			return this.buildExtensionNodes();
		}

		// Extension node: return workspace children
		if (element.type === "extension") {
			return this.buildWorkspaceNodes(element);
		}

		// Workspace node: no children (leaf node)
		return [];
	}

	/**
	 * Build root-level extension nodes
	 * @private
	 */
	private buildExtensionNodes(): FilterNode[] {
		// Sort extensions alphabetically
		const sorted = [...this.extensionData].sort((a, b) =>
			a.extension.localeCompare(b.extension),
		);

		return sorted.map((info) => ({
			type: "extension" as const,
			extension: info.extension,
			displayName: info.displayName,
			totalCount: info.totalCount,
		}));
	}

	/**
	 * Build workspace child nodes for an extension
	 * @private
	 */
	private buildWorkspaceNodes(parent: ExtensionNode): FilterNode[] {
		// Find extension metadata
		const info = this.extensionData.find(
			(e) => e.extension === parent.extension,
		);
		if (!info) {
			return [];
		}

		// Build workspace nodes
		const nodes: FilterNode[] = [];
		for (const [workspace, count] of info.workspaceCounts.entries()) {
			// Skip workspaces with 0 files
			if (count === 0) continue;

			// Get display name (fallback to workspace ID)
			const displayName =
				this.workspaceDisplayNames.get(workspace) || workspace;

			nodes.push({
				type: "workspace" as const,
				extension: parent.extension,
				workspace,
				displayName,
				fileCount: count,
			});
		}

		// Sort by display name
		nodes.sort((a, b) => a.displayName.localeCompare(b.displayName));

		return nodes;
	}

	/**
	 * Convert a node to a TreeItem for rendering
	 *
	 * @param element - Node to render
	 * @returns VS Code TreeItem with checkbox state
	 */
	getTreeItem(element: FilterNode): vscode.TreeItem {
		if (element.type === "extension") {
			return this.buildExtensionTreeItem(element);
		}
		return this.buildWorkspaceTreeItem(element);
	}

	/**
	 * Build TreeItem for extension node (parent with children)
	 * @private
	 */
	private buildExtensionTreeItem(node: ExtensionNode): vscode.TreeItem {
		// Label: ".ts (TypeScript)"
		const label = `${node.extension} (${node.displayName})`;

		// Collapsible to show workspace children
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);

		// Context value for commands
		item.contextValue = "extension";

		// Description: "25 files"
		const fileText =
			node.totalCount === 1 ? "1 file" : `${node.totalCount} files`;
		item.description = fileText;

		// NEW: Find extension metadata to get relevant workspaces
		// This fixes sparse extension presence: when .example exists only in MARKMERGE,
		// we only check MARKMERGE instead of checking all managed workspaces
		const info = this.extensionData.find((e) => e.extension === node.extension);

		// Extract workspace IDs where this extension exists
		const relevantWorkspaces = info
			? Array.from(info.workspaceCounts.keys())
			: [];

		// Checkbox state: checked if enabled in ALL workspaces where it exists
		const isEnabled = this.stateManager.isGloballyEnabled(
			node.extension,
			relevantWorkspaces, // NEW: Only check workspaces that have this extension
		);

		console.log(
			`[TreeProvider] Building item for ${node.extension}: ` +
				`globally enabled = ${isEnabled}, ` +
				`relevant workspaces = [${relevantWorkspaces.join(", ")}]`,
		);

		item.checkboxState = isEnabled
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;

		return item;
	}

	/**
	 * Build TreeItem for workspace node (leaf)
	 * @private
	 */
	private buildWorkspaceTreeItem(node: WorkspaceNode): vscode.TreeItem {
		// Label: Workspace display name (e.g., "Frontend")
		const item = new vscode.TreeItem(
			node.displayName,
			vscode.TreeItemCollapsibleState.None,
		);

		// Context value for commands
		item.contextValue = "workspace";

		// Description: "10 files"
		const fileText =
			node.fileCount === 1 ? "1 file" : `${node.fileCount} files`;
		item.description = fileText;

		// Checkbox state: checked if this workspace has extension enabled
		item.checkboxState = this.stateManager.isEnabled(
			node.extension,
			node.workspace,
		)
			? vscode.TreeItemCheckboxState.Checked
			: vscode.TreeItemCheckboxState.Unchecked;

		return item;
	}

	/**
	 * Force an immediate tree refresh
	 *
	 * Directly fires onDidChangeTreeData to tell VS Code to re-render the tree.
	 * Use this when you need to ensure the UI updates immediately,
	 * such as after checkbox state changes.
	 */
	forceRefresh(): void {
		console.log(
			"[TreeProvider] forceRefresh() called - firing onDidChangeTreeData",
		);
		this._onDidChangeTreeData.fire(undefined);
		console.log("[TreeProvider] Tree refresh fired");
	}

	/**
	 * Dispose of resources
	 *
	 * Cleans up event subscriptions to prevent memory leaks.
	 */
	dispose(): void {
		this._onDidChangeTreeData.dispose();
		this.stateChangeDisposable.dispose();
	}
}
