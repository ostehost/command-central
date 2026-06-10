/**
 * Grouping command registration — toggle and option selection for the
 * git-status grouping feature.
 *
 * The grouping view manager is module state in extension.ts that is reset on
 * deactivate, so it is injected as a getter and dereferenced at invocation
 * time, never captured by value.
 */

import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";
import type { TelemetryService } from "../services/telemetry-service.js";
import type { GroupingViewManager } from "../ui/grouping-view-manager.js";

export interface GroupingCommandDeps {
	getGroupingViewManager: () => GroupingViewManager | undefined;
	telemetry: Pick<TelemetryService, "track">;
	logger: Pick<LoggerService, "error">;
}

/**
 * Register the two commandCentral.grouping.* commands. Returns one disposable
 * per command; the caller owns their lifecycle.
 */
export function registerGroupingCommands(
	deps: GroupingCommandDeps,
): vscode.Disposable[] {
	const { getGroupingViewManager, telemetry, logger } = deps;
	return [
		vscode.commands.registerCommand(
			"commandCentral.grouping.toggle",
			async () => {
				const groupingViewManager = getGroupingViewManager();
				if (!groupingViewManager) {
					logger.error("Grouping view manager not initialized");
					return;
				}
				await groupingViewManager.toggle();
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.grouping.selectOption",
			async (optionId: "none" | "gitStatus") => {
				const groupingViewManager = getGroupingViewManager();
				if (!groupingViewManager) {
					logger.error("Grouping view manager not initialized");
					vscode.window.showErrorMessage(
						"Command Central: Grouping feature not available",
					);
					return;
				}

				try {
					await groupingViewManager.selectOption(optionId);

					// Track grouping mode change
					telemetry.track("cc_agent_status_group_toggled", {
						grouped: optionId === "gitStatus",
					});

					// Provide user feedback on success
					const message =
						optionId === "gitStatus"
							? "Grouping enabled: Files grouped by Git status"
							: "Grouping disabled: Files sorted by time only";
					vscode.window.setStatusBarMessage(`✓ ${message}`, 2000);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : "Unknown error";
					logger.error("Failed to change grouping mode", error as Error);
					vscode.window.showErrorMessage(
						`Command Central: Failed to change grouping - ${errorMessage}`,
					);
				}
			},
		),
	];
}
