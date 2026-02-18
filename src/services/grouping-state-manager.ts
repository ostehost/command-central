/**
 * Grouping State Manager
 *
 * Manages global state for Git status grouping feature using VS Code Configuration API.
 *
 * Architecture Improvements:
 * - ✅ Configuration API (not raw globalState) for VS Code integration
 * - ✅ Explicit ConfigurationTarget.Global for cross-workspace settings
 * - ✅ Event-driven reactivity using EventEmitter
 * - ✅ External configuration change detection
 * - ✅ Type-safe configuration keys
 * - ✅ Sensible defaults (grouping disabled initially)
 *
 * User Benefits:
 * - Setting persists across VS Code sessions
 * - Appears in VS Code Settings UI (discoverability)
 * - Settings.json integration for power users
 * - Immediate UI updates on state changes
 * - Works across all workspaces (global preference)
 *
 * Usage:
 * ```typescript
 * const stateManager = new GroupingStateManager(vscode.workspace);
 *
 * // Check state
 * if (stateManager.isGroupingEnabled()) {
 *   // Show grouped view
 * }
 *
 * // Listen to changes
 * stateManager.onDidChangeGrouping((enabled) => {
 *   // Update UI
 * });
 *
 * // Toggle state
 * await stateManager.setGroupingEnabled(true);
 * ```
 */

import * as vscode from "vscode";
import type { IGroupingStateManager } from "../types/service-interfaces.js";

/** Configuration section for Git status grouping */
const CONFIG_SECTION = "commandCentral.gitStatusGrouping";

/** Configuration key for enabled/disabled state */
const CONFIG_KEY = "enabled";

/**
 * Grouping State Manager
 *
 * Manages global state for Git status grouping using VS Code Configuration API.
 * Provides event-driven reactivity for UI updates.
 */
export class GroupingStateManager
	implements IGroupingStateManager, vscode.Disposable
{
	private readonly _onDidChangeGrouping = new vscode.EventEmitter<boolean>();

	/** Event fired when grouping state changes */
	readonly onDidChangeGrouping = this._onDidChangeGrouping.event;

	private configChangeListener: vscode.Disposable;
	private lastKnownState: boolean;

	/**
	 * Create a new grouping state manager
	 *
	 * @param workspace - VS Code workspace (for configuration and events)
	 */
	constructor(private workspace: typeof vscode.workspace) {
		// Initialize state from configuration
		this.lastKnownState = this.readConfigurationValue();

		// Listen for external configuration changes (settings.json edits, sync, etc.)
		this.configChangeListener = this.workspace.onDidChangeConfiguration(
			(e: vscode.ConfigurationChangeEvent) => {
				// Only react if our configuration changed
				if (e.affectsConfiguration(CONFIG_SECTION)) {
					const newState = this.readConfigurationValue();

					// Only fire event if state actually changed
					if (newState !== this.lastKnownState) {
						this.lastKnownState = newState;
						this._onDidChangeGrouping.fire(newState);
					}
				}
			},
		);
	}

	/**
	 * Check if Git status grouping is enabled
	 *
	 * @returns true if grouping is enabled, false otherwise
	 */
	isGroupingEnabled(): boolean {
		return this.readConfigurationValue();
	}

	/**
	 * Enable or disable Git status grouping
	 *
	 * Updates global configuration (applies to all workspaces).
	 * Fires onDidChangeGrouping event for UI updates.
	 *
	 * @param enabled - true to enable grouping, false to disable
	 * @throws Error if configuration update fails
	 */
	async setGroupingEnabled(enabled: boolean): Promise<void> {
		const config = this.workspace.getConfiguration(CONFIG_SECTION);

		try {
			// IMPORTANT: Specify ConfigurationTarget.Global
			// Without this, setting would only apply to current workspace
			await config.update(
				CONFIG_KEY,
				enabled,
				vscode.ConfigurationTarget.Global,
			);

			// Only update state if configuration write succeeded
			this.lastKnownState = enabled;

			// Fire event for immediate UI updates
			// (onDidChangeConfiguration will also fire, but this is immediate)
			this._onDidChangeGrouping.fire(enabled);
		} catch (error) {
			// Preserve state consistency on failure - don't update lastKnownState
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			throw new Error(
				`Failed to update Git status grouping configuration: ${errorMessage}`,
			);
		}
	}

	/**
	 * Read current configuration value
	 * @private
	 */
	private readConfigurationValue(): boolean {
		const config = this.workspace.getConfiguration(CONFIG_SECTION);

		// Get with explicit default (false = grouping disabled initially)
		return config.get<boolean>(CONFIG_KEY, false);
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.configChangeListener.dispose();
		this._onDidChangeGrouping.dispose();
	}
}

/**
 * Get default configuration schema for package.json contribution
 *
 * This function provides the configuration schema that should be
 * added to package.json's "contributes.configuration" section.
 *
 * Example package.json:
 * ```json
 * "contributes": {
 *   "configuration": {
 *     "properties": {
 *       "commandCentral.gitStatusGrouping.enabled": {
 *         "type": "boolean",
 *         "default": false,
 *         "description": "Enable grouping of Git status changes by status type (staged/unstaged)"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * @returns Configuration schema object
 */
export function getDefaultGroupingConfiguration() {
	return {
		type: "boolean",
		default: false,
		description:
			"Enable grouping of Git status changes by status type (staged/unstaged) with time-based subgroups",
		scope: "application" as const, // Application scope = truly global
	};
}
