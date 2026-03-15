/**
 * Activity Timeline View Manager
 *
 * Manages the Activity Timeline TreeView lifecycle:
 * - Creates the TreeView and registers it with VS Code
 * - Sets up FileSystemWatcher for .git changes (new commits)
 * - Debounced refresh on file system changes
 * - Registers the refresh command
 *
 * Follows the same pattern as ExtensionFilterViewManager.
 */

import * as vscode from "vscode";
import type { ActivityCollector } from "../services/activity-collector.js";
import type { TimelineNode } from "./activity-timeline-tree-provider.js";
import { ActivityTimelineTreeProvider } from "./activity-timeline-tree-provider.js";

/**
 * Create and wire up the Activity Timeline view.
 *
 * @returns Disposable that tears down the view and all watchers
 */
export function createActivityTimelineView(
	_context: vscode.ExtensionContext,
	collector: ActivityCollector,
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	// Resolve workspace folders
	const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(
		(f) => f.uri.fsPath,
	);

	const lookbackDays =
		vscode.workspace
			.getConfiguration("commandCentral")
			.get<number>("activityTimeline.lookbackDays") ?? 7;

	// Create provider
	const provider = new ActivityTimelineTreeProvider(
		collector,
		workspaceFolders,
		lookbackDays,
	);
	disposables.push(provider);

	// Register TreeView
	const treeView = vscode.window.createTreeView<TimelineNode>(
		"commandCentral.activityTimeline",
		{
			treeDataProvider: provider,
			showCollapseAll: true,
		},
	);
	disposables.push(treeView);

	// Set empty-state message
	treeView.message =
		workspaceFolders.length === 0
			? "Open a workspace folder to see agent activity."
			: undefined;

	// Refresh command
	disposables.push(
		vscode.commands.registerCommand(
			"commandCentral.refreshActivityTimeline",
			() => {
				void provider.refresh();
			},
		),
	);

	// ── Debounced refresh on .git changes ────────────────────────────

	let debounceTimer: NodeJS.Timeout | undefined;
	const DEBOUNCE_MS = 500;

	const scheduleRefresh = () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void provider.refresh();
		}, DEBOUNCE_MS);
	};

	// Watch for new commits across all workspace folders
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const pattern = new vscode.RelativePattern(folder, ".git/refs/heads/**");
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		watcher.onDidChange(scheduleRefresh);
		watcher.onDidCreate(scheduleRefresh);
		watcher.onDidDelete(scheduleRefresh);
		disposables.push(watcher);
	}

	// React to workspace folder additions/removals
	disposables.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const folders = (vscode.workspace.workspaceFolders ?? []).map(
				(f) => f.uri.fsPath,
			);
			provider.updateWorkspaceFolders(folders);
			treeView.message =
				folders.length === 0
					? "Open a workspace folder to see agent activity."
					: undefined;
			scheduleRefresh();
		}),
	);

	// Initial population when the view becomes visible
	disposables.push(
		treeView.onDidChangeVisibility((e) => {
			if (e.visible) {
				void provider.refresh();
			}
		}),
	);

	// Initial load
	void provider.refresh();

	return vscode.Disposable.from(...disposables);
}
