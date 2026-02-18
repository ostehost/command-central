/**
 * Service for managing project icons across workspaces
 */

import * as vscode from "vscode";
import type { ProjectIconConfig } from "../types/project-icon-types.js";
import type { LoggerService } from "./logger-service.js";

export class ProjectIconService {
	private statusBarItem: vscode.StatusBarItem | undefined;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly logger: LoggerService,
		private readonly context: vscode.ExtensionContext,
	) {
		this.initialize();
	}

	private initialize(): void {
		this.logger.info("ProjectIconService: Initializing...");

		// Watch for configuration changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				this.logger.debug(
					`ProjectIconService: Configuration changed, checking if affects project settings...`,
				);
				if (
					e.affectsConfiguration("commandCentral.project") ||
					e.affectsConfiguration("commandCentral.statusBar")
				) {
					this.logger.info(
						"ProjectIconService: Relevant configuration changed, refreshing...",
					);
					this.refresh();
				}
			}),
		);

		// Initial display
		this.logger.info("ProjectIconService: Performing initial refresh...");
		this.refresh();
		this.logger.info("ProjectIconService: Initialization complete");
	}

	/**
	 * Get current workspace icon configuration
	 */
	private getCurrentIconConfig(): ProjectIconConfig | undefined {
		this.logger.debug("ProjectIconService: Getting current icon config...");

		// Read commandCentral.project configuration
		const config = vscode.workspace.getConfiguration("commandCentral");
		const projectIcon = config.get<string>("project.icon");
		const projectName = config.get<string>("project.name");

		this.logger.debug(
			`ProjectIconService: icon="${projectIcon}", name="${projectName}"`,
		);

		if (!projectIcon && !projectName) {
			this.logger.debug("ProjectIconService: No icon configuration found");
			return undefined;
		}

		const showInStatusBar = config.get<boolean>(
			"statusBar.showProjectIcon",
			true,
		);
		const priority = config.get<number>("statusBar.priority", 10000);

		const result = {
			icon: projectIcon || "",
			tooltip: projectName || "Project Icon",
			showInStatusBar,
			priority,
		};

		this.logger.debug(
			`ProjectIconService: Using config: ${JSON.stringify(result)}`,
		);
		return result;
	}

	/**
	 * Refresh icon display
	 */
	public refresh(): void {
		this.logger.debug("ProjectIconService: refresh() called");
		const config = this.getCurrentIconConfig();

		if (config) {
			this.logger.info(
				`ProjectIconService: Found config, updating status bar with icon: "${config.icon}"`,
			);
			this.updateStatusBar(config);
		} else {
			this.logger.info(
				"ProjectIconService: No config found, hiding status bar",
			);
			this.hideStatusBar();
		}
	}

	/**
	 * Update the status bar with project icon
	 */
	private updateStatusBar(config: ProjectIconConfig): void {
		this.logger.debug(
			`ProjectIconService: Updating status bar with config: ${JSON.stringify(config)}`,
		);

		if (!this.statusBarItem) {
			this.logger.debug("ProjectIconService: Creating new status bar item");
			this.statusBarItem = vscode.window.createStatusBarItem(
				vscode.StatusBarAlignment.Left,
				config.priority || 10000,
			);
			this.context.subscriptions.push(this.statusBarItem);
			this.logger.debug("ProjectIconService: Status bar item created");
		}

		// Show just the project icon
		this.statusBarItem.text = config.icon || "";
		this.statusBarItem.tooltip = config.tooltip || this.getDefaultTooltip();
		this.statusBarItem.command = "commandCentral.terminal.launch";
		this.statusBarItem.show();

		this.logger.debug(
			`ProjectIconService: Status bar updated - text="${this.statusBarItem.text}", tooltip="${this.statusBarItem.tooltip}"`,
		);

		this.logger.debug(
			`Updated status bar with icon: ${config.icon}`,
			"ProjectIconService",
		);
	}

	/**
	 * Hide the status bar item
	 */
	private hideStatusBar(): void {
		if (this.statusBarItem) {
			this.statusBarItem.hide();
		}
	}

	/**
	 * Get default tooltip text
	 */
	private getDefaultTooltip(): string {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			return `Project: ${workspaceFolder.name}\nPath: ${workspaceFolder.uri.fsPath}`;
		}
		return "Project Icon";
	}

	/**
	 * Dispose of resources
	 */
	public dispose(): void {
		this.disposables.forEach((d) => {
			d.dispose();
		});
		if (this.statusBarItem) {
			this.statusBarItem.dispose();
		}
	}
}
