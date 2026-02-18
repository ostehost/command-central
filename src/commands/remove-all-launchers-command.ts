/**
 * Remove all launchers command handler
 * Removes all project launchers
 */

import * as vscode from "vscode";
import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(service: TerminalLauncherService): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine(
		"Executing commandCentral.terminal.removeAllLaunchers command",
	);

	try {
		// Confirm removal
		const confirm = await vscode.window.showWarningMessage(
			"Remove ALL project launchers? This cannot be undone.",
			"Remove All",
			"Cancel",
		);

		if (confirm !== "Remove All") {
			return;
		}

		const success = await service.removeAllLaunchers();
		if (success) {
			outputChannel.appendLine("Successfully removed all launchers");
		} else {
			outputChannel.appendLine("Failed to remove all launchers");
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(
			`Error in removeAllLaunchers command: ${errorMessage}`,
		);
		throw new Error(`Failed to remove all launchers: ${errorMessage}`);
	}
}
