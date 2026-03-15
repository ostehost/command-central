/**
 * Activity Timeline Commands
 *
 * Command handlers for the Agent Activity Timeline view:
 * - refreshActivityTimeline: re-collects events and refreshes the tree
 * - filterActivityByAgent: QuickPick to filter by agent name
 */

import * as vscode from "vscode";
import type { ActivityTimelineTreeProvider } from "../providers/activity-timeline-tree-provider.js";
import type { ActivityCollector } from "../services/activity-collector.js";

/**
 * Refresh the activity timeline by re-collecting events from git log
 */
export async function refreshActivityTimeline(
	_collector: ActivityCollector,
	treeProvider: ActivityTimelineTreeProvider,
): Promise<void> {
	await treeProvider.refresh();
}

/**
 * Register all activity timeline commands
 *
 * Note: The core refresh command is registered in the view manager.
 * This function registers supplementary commands (filter, diff).
 */
export function registerActivityTimelineCommands(
	context: vscode.ExtensionContext,
	collector: ActivityCollector,
	treeProvider: ActivityTimelineTreeProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"commandCentral.filterActivityByAgent",
			async () => {
				const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(
					(f) => f.uri.fsPath,
				);
				const lookbackDays =
					vscode.workspace
						.getConfiguration("commandCentral")
						.get<number>("activityTimeline.lookbackDays") ?? 7;

				const events = await collector.collectEvents(
					workspaceFolders,
					lookbackDays,
				);

				const agentNames = [...new Set(events.map((e) => e.agent.name))].sort();
				if (agentNames.length === 0) {
					vscode.window.showInformationMessage("No agent activity found.");
					return;
				}

				const picked = await vscode.window.showQuickPick(
					["Show All", ...agentNames],
					{ placeHolder: "Filter timeline by agent" },
				);

				if (picked) {
					// For now, refresh shows all — filtering is a future enhancement
					await treeProvider.refresh();
				}
			},
		),
	);
}
