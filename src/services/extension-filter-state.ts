import * as path from "node:path";
import type * as vscode from "vscode";
import type { LoggerService } from "./logger-service.js";

/**
 * Manages filter state for file extensions across workspaces
 *
 * Core behavior:
 * - No entry in Map = show all files (default, not filtered)
 * - Non-empty Set = show only files with these extensions (filtered)
 * - Empty Set NEVER exists = deleted to return to "show all" mode
 * - Persistence: Optional workspaceState/globalState persistence
 */
export class ExtensionFilterState {
	/**
	 * Internal storage: workspace ID -> Set of enabled extensions
	 * - No entry = show all files (default, not filtered)
	 * - Non-empty Set = show only these extensions (filtered)
	 * - Empty Set NEVER exists (deleted automatically)
	 */
	private filters = new Map<string, Set<string>>();

	/** Storage key for workspaceState/globalState */
	private readonly STORAGE_KEY = "commandCentral.extensionFilters";

	constructor(
		private context?: vscode.ExtensionContext,
		private persistenceMode: "workspace" | "global" | "none" = "workspace",
		private logger?: LoggerService,
	) {
		// Load persisted state on construction
		if (this.context && this.persistenceMode !== "none") {
			this.loadFromStorage();
		}
	}

	/**
	 * Loads filter state from VS Code storage
	 * @private
	 */
	private loadFromStorage(): void {
		if (!this.context) return;

		try {
			const storage =
				this.persistenceMode === "workspace"
					? this.context.workspaceState
					: this.context.globalState;

			const stored = storage.get<Record<string, string[]>>(this.STORAGE_KEY);

			if (stored) {
				// Restore Map<workspace, Set<extensions>> from serializable format
				this.filters.clear();
				for (const [workspace, extensions] of Object.entries(stored)) {
					if (extensions && extensions.length > 0) {
						this.filters.set(workspace, new Set(extensions));
						this.logger?.info(
							`Loaded filter for ${workspace}: [${extensions.join(", ")}]`,
						);
					}
				}
				this.logger?.info(
					`Extension filter state loaded: ${this.filters.size} workspace(s) with filters`,
				);
			} else {
				this.logger?.info(
					"No persisted extension filter state found (first run or state cleared)",
				);
			}
		} catch (error) {
			this.logger?.error(
				"Failed to load extension filter state",
				error instanceof Error ? error : undefined,
			);
			// Continue with empty filters (graceful degradation)
		}
	}

	/**
	 * Persists filter state to VS Code storage
	 * @private
	 */
	private async persistToStorage(): Promise<void> {
		if (!this.context || this.persistenceMode === "none") return;

		try {
			const storage =
				this.persistenceMode === "workspace"
					? this.context.workspaceState
					: this.context.globalState;

			// Convert Map<string, Set<string>> to serializable object
			const serializable: Record<string, string[]> = {};
			for (const [workspace, extensions] of this.filters) {
				if (extensions.size > 0) {
					serializable[workspace] = Array.from(extensions);
				}
			}

			await storage.update(this.STORAGE_KEY, serializable);

			this.logger?.info(
				`Extension filter state persisted: ${Object.keys(serializable).length} workspace(s)`,
			);

			// Log each workspace for debugging
			for (const [workspace, exts] of Object.entries(serializable)) {
				this.logger?.debug(`  ${workspace}: [${exts.join(", ")}]`);
			}
		} catch (error) {
			this.logger?.error(
				"Failed to persist extension filter state",
				error instanceof Error ? error : undefined,
			);
			// Non-fatal: Continue without persistence
		}
	}

	/**
	 * Checks if a workspace is in "filtered mode"
	 *
	 * Returns true if the workspace has a filter entry (non-empty Set).
	 * Returns false if workspace has no entry (default "show all" state).
	 *
	 * IMPORTANT: Empty Sets are automatically deleted, so this method
	 * will always return false for workspaces with no enabled extensions.
	 *
	 * @param workspace - Workspace ID
	 * @returns true if workspace is in filtered mode, false if in default "show all" mode
	 */
	isFiltered(workspace: string): boolean {
		// Check if workspace has an entry in the filters Map
		// Entry exists = filtered mode (non-empty Set only, empty Sets are deleted)
		// No entry = default "show all" mode
		return this.filters.has(workspace);
	}

	/**
	 * Gets the set of enabled extensions for a workspace
	 *
	 * @param workspace - Workspace ID
	 * @returns Set of enabled extensions (empty Set = show all)
	 *
	 * NOTE: Returns a defensive copy to prevent external modification
	 */
	getEnabledExtensions(workspace: string): Set<string> {
		const extensions = this.filters.get(workspace);
		// Return defensive copy (or empty set if no filter)
		return extensions ? new Set(extensions) : new Set();
	}

	/**
	 * Enables or disables an extension for a specific workspace
	 *
	 * @param workspace - Workspace ID
	 * @param ext - File extension
	 * @param enabled - true to enable, false to disable
	 */
	setExtensionEnabled(workspace: string, ext: string, enabled: boolean): void {
		if (enabled) {
			// Enable: Add extension to workspace's set
			if (!this.filters.has(workspace)) {
				this.filters.set(workspace, new Set());
			}
			const extensions = this.filters.get(workspace);
			if (extensions) {
				extensions.add(ext);
			}
		} else {
			// Disable: Remove extension from workspace's set
			const extensions = this.filters.get(workspace);
			if (extensions) {
				extensions.delete(ext);

				// CRITICAL FIX: Delete workspace entry when Set becomes empty
				// This returns workspace to "not filtered, show all files" state
				// Empty Set should NEVER exist - it's semantically equivalent to no entry
				// UX: Unchecking last extension = return to "show all" mode
				if (extensions.size === 0) {
					this.filters.delete(workspace);
				}
			}
		}

		// Persist after state change (fire-and-forget with error logging)
		void this.persistToStorage();
	}

	/**
	 * Validates filter state against actual files and removes stale extensions
	 *
	 * When all files with a filtered extension are deleted, the extension should
	 * be auto-removed from the filter to prevent "ghost" extensions in the title.
	 *
	 * Example: User filters by [.bak2, .py], then deletes all .bak2 files.
	 * This method detects .bak2 has no files and removes it from the filter,
	 * updating the title to show only [.py].
	 *
	 * @param workspace - Workspace ID to validate
	 * @param actualFiles - Current file paths from Git (absolute paths)
	 * @returns true if filter was modified, false if unchanged
	 */
	validateAndCleanFilter(workspace: string, actualFiles: string[]): boolean {
		// Get current filter for workspace
		const filter = this.filters.get(workspace);
		if (!filter || filter.size === 0) {
			// No filter to validate
			return false;
		}

		// Extract extensions from actual files
		const actualExtensions = new Set(
			actualFiles.map((f) => path.extname(f).toLowerCase()),
		);

		this.logger?.debug(
			`[${workspace}] Validating filter: ${filter.size} filtered extensions, ${actualExtensions.size} actual extensions in Git`,
		);

		// Find stale extensions (in filter but no files)
		let modified = false;
		for (const ext of filter) {
			if (!actualExtensions.has(ext)) {
				this.logger?.info(
					`[${workspace}] Removing stale extension from filter: ${ext} (no files found)`,
				);
				filter.delete(ext);
				modified = true;
			}
		}

		// Auto-delete workspace entry if filter becomes empty
		// This returns workspace to "show all files" default state
		if (filter.size === 0) {
			this.logger?.info(
				`[${workspace}] Filter empty after cleanup, removing workspace entry (returning to show-all mode)`,
			);
			this.filters.delete(workspace);
		}

		// Persist if modified
		if (modified) {
			this.logger?.info(
				`[${workspace}] Filter state cleaned, persisting changes`,
			);
			void this.persistToStorage();
		}

		return modified;
	}
}
