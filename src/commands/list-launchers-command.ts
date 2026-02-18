/**
 * List launchers command handler
 * Shows all project launchers created by the terminal launcher script
 */

import * as vscode from "vscode";
import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(service: TerminalLauncherService): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine(
		"Executing commandCentral.terminal.listLaunchers command",
	);

	try {
		const launchers = await service.listLaunchers();

		if (launchers.length === 0) {
			vscode.window.showInformationMessage("No project launchers found");
			return;
		}

		// Show quick pick with launcher list
		const selected = await vscode.window.showQuickPick(launchers, {
			placeHolder: `Found ${launchers.length} project launcher(s)`,
			title: "Terminal Project Launchers",
		});

		if (selected) {
			// User selected a launcher - could add actions here in future
			vscode.window.showInformationMessage(`Selected: ${selected}`);
		}

		outputChannel.appendLine(`Listed ${launchers.length} launcher(s)`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Error in listLaunchers command: ${errorMessage}`);
		throw new Error(`Failed to list launchers: ${errorMessage}`);
	}
}
