/**
 * FilterStateManager - Event-driven state manager for extension filters
 *
 * Wraps ExtensionFilterState with observable state changes and bulk operations.
 * Provides single source of truth for filter state across the extension.
 *
 * Features:
 * - EventEmitter pattern for state change notifications
 * - Bulk operations (setAllWorkspaces, isGloballyEnabled)
 * - Workspace-aware filtering
 * - Persistence via underlying ExtensionFilterState
 *
 * Usage:
 * ```typescript
 * const manager = new FilterStateManager(filterState, workspaceIds);
 * manager.onDidChange(event => {
 *   // React to state changes
 *   provider.refresh();
 * });
 * manager.setAllWorkspaces('.ts', true); // Enable .ts in all workspaces
 * ```
 */

import * as vscode from "vscode";
import type { IExtensionFilterState } from "../types/service-interfaces.js";

/**
 * Event emitted when filter state changes
 */
export interface StateChangeEvent {
	/** File extension that changed (e.g., ".ts") */
	extension: string;
	/** Workspace ID affected */
	workspace: string;
	/** New enabled state */
	enabled: boolean;
}

/**
 * Event-driven state manager for extension filters
 *
 * Wraps ExtensionFilterState with:
 * - Observable state changes via EventEmitter
 * - Bulk operations for multiple workspaces
 * - Semantic correctness (isGloballyEnabled uses .every())
 */
export class FilterStateManager implements vscode.Disposable {
	private _onDidChange = new vscode.EventEmitter<StateChangeEvent>();
	readonly onDidChange = this._onDidChange.event;

	/**
	 * List of workspace IDs managed by this instance
	 * Can be updated dynamically as workspaces change
	 */
	private workspaces: string[];

	/**
	 * Create a new filter state manager
	 *
	 * @param filterState - Underlying filter state (handles persistence)
	 * @param workspaces - Array of workspace IDs to manage
	 */
	constructor(
		private filterState: IExtensionFilterState,
		workspaces: string[],
	) {
		this.workspaces = [...workspaces]; // Defensive copy
	}

	/**
	 * Check if extension is enabled in specific workspace
	 *
	 * @param extension - File extension (e.g., ".ts")
	 * @param workspace - Workspace ID
	 * @returns true if extension is enabled, false otherwise
	 */
	isEnabled(extension: string, workspace: string): boolean {
		const enabled = this.filterState.getEnabledExtensions(workspace);
		return enabled.has(extension);
	}

	/**
	 * Enable or disable extension for specific workspace
	 *
	 * Fires onDidChange event after state update.
	 *
	 * @param extension - File extension (e.g., ".ts")
	 * @param workspace - Workspace ID
	 * @param enabled - true to enable, false to disable
	 */
	setEnabled(extension: string, workspace: string, enabled: boolean): void {
		// Update underlying state
		this.filterState.setExtensionEnabled(workspace, extension, enabled);

		// Fire change event
		console.log(
			`[FilterStateManager] Firing event: ${extension} / ${workspace} / ${enabled}`,
		);
		this._onDidChange.fire({ extension, workspace, enabled });
	}

	/**
	 * Enable or disable extension in ALL managed workspaces (bulk operation)
	 *
	 * Fires one onDidChange event per workspace.
	 *
	 * @param extension - File extension (e.g., ".ts")
	 * @param enabled - true to enable, false to disable
	 */
	setAllWorkspaces(extension: string, enabled: boolean): void {
		for (const workspace of this.workspaces) {
			this.setEnabled(extension, workspace, enabled);
		}
	}

	/**
	 * Check if extension is enabled in ALL relevant workspaces
	 *
	 * NEW: Accepts optional list of relevant workspaces to check.
	 * This fixes sparse extension presence: when an extension exists in
	 * workspace A but not workspace B, we only check workspace A.
	 *
	 * Uses .every() for semantic correctness:
	 * - Returns true only if ALL relevant workspaces have extension enabled
	 * - Returns false if ANY relevant workspace doesn't have it enabled
	 * - Returns false if workspace list is empty
	 *
	 * This is the correct logic for parent checkbox state in TreeView.
	 *
	 * @param extension - File extension (e.g., ".ts")
	 * @param relevantWorkspaces - Optional: specific workspaces to check (for sparse extensions)
	 * @returns true if enabled in ALL relevant workspaces, false otherwise
	 *
	 * @example
	 * // Sparse extension: .example exists only in MARKMERGE
	 * manager.isGloballyEnabled(".example", ["MARKMERGE"]) // Only checks MARKMERGE
	 *
	 * @example
	 * // Backward compatible: check all managed workspaces
	 * manager.isGloballyEnabled(".ts") // Checks all workspaces
	 */
	isGloballyEnabled(extension: string, relevantWorkspaces?: string[]): boolean {
		// Determine which workspaces to check
		const workspacesToCheck = relevantWorkspaces ?? this.workspaces;

		// Empty workspace list = not globally enabled
		if (workspacesToCheck.length === 0) {
			return false;
		}

		// Check if ALL relevant workspaces have extension enabled
		return workspacesToCheck.every((workspace) =>
			this.isEnabled(extension, workspace),
		);
	}

	/**
	 * Update the list of managed workspaces
	 *
	 * Call this when workspace folders change.
	 *
	 * @param workspaces - New array of workspace IDs
	 */
	setWorkspaces(workspaces: string[]): void {
		this.workspaces = [...workspaces]; // Defensive copy
	}

	/**
	 * Dispose of resources
	 *
	 * Cleans up EventEmitter to prevent memory leaks.
	 */
	dispose(): void {
		this._onDidChange.dispose();
	}
}
