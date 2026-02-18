/**
 * Enable Git Sort Command
 */

import * as vscode from "vscode";
import type { GitSorter } from "../git-sort/scm-sorter.js";

export async function execute(sorter: GitSorter): Promise<void> {
	try {
		sorter.enable();
		await sorter.activate();

		// Simple status bar confirmation, no popup
		vscode.window.setStatusBarMessage("$(check) Git Sort enabled", 3000);
		// Command executed successfully
	} catch (_error) {
		// Error handled by UI message
		vscode.window.showErrorMessage("Failed to enable Git Sort");
	}
}
