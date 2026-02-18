/**
 * Disable Git Sort Command
 */

import * as vscode from "vscode";
import type { GitSorter } from "../git-sort/scm-sorter.js";

export async function execute(sorter: GitSorter): Promise<void> {
	try {
		sorter.disable();

		// Confirm and offer re-enable
		vscode.window
			.showInformationMessage(
				"Git Sort disabled. Your changes will appear in default order.",
				"Re-enable",
			)
			.then((selection) => {
				if (selection === "Re-enable") {
					vscode.commands.executeCommand("commandCentral.gitSort.enable");
				}
			});
		// Command executed successfully
	} catch (_error) {
		// Error handled by UI message
		vscode.window.showErrorMessage("Failed to disable Git Sort");
	}
}
