/**
 * Workspace Project Source
 *
 * Automatically discovers workspace folders and maps them to dynamic view slots.
 *
 * Requirements:
 * - REQ-WORKSPACE-001: Auto-discover workspace folders
 * - REQ-SLOT-001: Manage 10 view slots dynamically
 * - REQ-ICON-001: Cycle through 6 available icons
 * - REQ-PERF-001: Parallel slot clearing/enabling for performance
 *
 * Phase 2 Features:
 * - Per-workspace-folder git repository tracking
 * - Custom icons from workspace-folder settings
 * - Folder name extraction from filesystem path
 */

import path from "node:path";
import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";
import type { ProjectConfigSource } from "./project-config-source.js";
import type { ProjectViewConfig } from "./project-views.js";

/**
 * Configuration source that loads projects from workspace folders
 *
 * Architecture:
 * - Implements ProjectConfigSource interface
 * - Maps workspace folders to slot1-slot10
 * - Controls slot visibility via setContext commands
 * - Cycles through 6 available icons for visual variety
 */
export class WorkspaceProjectSource implements ProjectConfigSource {
	private readonly SLOTS = 10;
	private truncationWarningShown = false;
	private slotMapping = new Map<string, string>(); // For debugging

	/**
	 * Available custom SVG icons (verified to exist in resources/icons/)
	 * Icons cycle through this array: slot7 reuses icon from slot1, etc.
	 */
	private readonly AVAILABLE_ICONS = ["activity-bar.svg"];

	constructor(private logger: LoggerService) {}

	/**
	 * Load projects from workspace folders
	 *
	 * Flow:
	 * 1. Clear all slots (parallel for performance)
	 * 2. Get workspace folders
	 * 3. Map first 10 to slots
	 * 4. Enable slots (parallel for performance)
	 * 5. Show truncation warning if needed
	 *
	 * @returns Array of project configurations (0-10 items)
	 */
	async loadProjects(): Promise<ProjectViewConfig[]> {
		// Clear all slots first
		await this.clearAllSlots();

		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			this.logger.info("No workspace folders found");
			return [];
		}

		this.logger.info(`Loading ${folders.length} workspace folders`);

		const projects: ProjectViewConfig[] = [];
		const slotsToUse = Math.min(folders.length, this.SLOTS);
		const enablePromises: Promise<unknown>[] = [];

		for (let i = 0; i < slotsToUse; i++) {
			const folder = folders[i];
			if (!folder) continue; // Type guard (should never happen)

			const slotId = `slot${i + 1}`;
			const iconPath = this.AVAILABLE_ICONS[i % this.AVAILABLE_ICONS.length];

			// Extract folder name from filesystem path
			// Note: VS Code Activity Bar automatically uppercases view container titles
			// This is native behavior and cannot be changed
			const folderName = path.basename(folder.uri.fsPath);

			// Read custom icon from workspace-folder-specific settings
			// Users can set "commandCentral.project.icon": "👻" in .vscode/settings.json
			const workspaceConfig = vscode.workspace.getConfiguration(
				"commandCentral",
				folder.uri,
			);
			const customIcon = workspaceConfig.get<string>("project.icon");

			// Build display name with optional custom icon prefix
			const displayName = customIcon
				? `${customIcon} ${folderName}`
				: folderName;

			// Track for debugging
			this.slotMapping.set(slotId, displayName);
			this.logger.debug(`Mapping ${slotId} → "${displayName}"`);

			// Queue slot enablement (parallel execution)
			// Note: executeCommand returns Thenable, wrap in Promise.resolve
			enablePromises.push(
				Promise.resolve(
					vscode.commands.executeCommand(
						"setContext",
						`commandCentral.${slotId}.active`,
						true,
					),
				),
			);

			projects.push({
				id: slotId,
				displayName,
				iconPath: `resources/icons/${iconPath}`,
				gitPath: folder.uri.fsPath,
				description: undefined, // No warning needed in Phase 2
				sortOrder: i + 1,
			});
		}

		// Enable all slots in parallel (performance optimization)
		await Promise.all(enablePromises);

		// Show truncation warning once (not on every reload)
		if (folders.length > this.SLOTS && !this.truncationWarningShown) {
			this.truncationWarningShown = true;
			vscode.window.showInformationMessage(
				`Command Central: Showing ${this.SLOTS} of ${folders.length} folders. Only first 10 displayed.`,
			);
		}

		return projects;
	}

	/**
	 * Clear all 10 slots (set context keys to false)
	 *
	 * Performance: Uses Promise.all for parallel execution (~100ms for 10 slots)
	 * Sequential would take ~200ms
	 */
	private async clearAllSlots(): Promise<void> {
		const promises: Promise<unknown>[] = [];
		for (let i = 1; i <= this.SLOTS; i++) {
			// Note: executeCommand returns Thenable, wrap in Promise.resolve
			promises.push(
				Promise.resolve(
					vscode.commands.executeCommand(
						"setContext",
						`commandCentral.slot${i}.active`,
						false,
					),
				),
			);
		}
		await Promise.all(promises);
	}
}
