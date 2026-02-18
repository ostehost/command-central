/**
 * Launch Here command handler
 * Launches terminal at the selected file/folder location
 */

import * as vscode from "vscode";
import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(
	service: TerminalLauncherService,
	uri?: vscode.Uri,
): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine(
		`Executing commandCentral.terminal.launchHere command ${uri ? `at ${uri.fsPath}` : ""}`,
	);

	try {
		// If no URI provided, try to get from active editor
		let targetUri = uri;
		if (!targetUri) {
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor) {
				targetUri = activeEditor.document.uri;
			}
		}

		if (!targetUri) {
			outputChannel.appendLine(
				"Warning: No path available for launchHere command",
			);
			vscode.window.showWarningMessage(
				"No file or folder selected. Right-click on a file or folder in the Explorer, or open a file in the editor first.",
			);
			return;
		}

		const result = await service.launchHere(targetUri);

		if (!result.success) {
			outputChannel.appendLine(
				`Failed to launch terminal here: ${result.error}`,
			);
			// Error is already user-friendly from service layer
			throw new Error(
				result.error ||
					"Failed to launch terminal at selected location. Check the Output panel for more details.",
			);
		}
		outputChannel.appendLine(
			`Terminal launched successfully at ${targetUri.fsPath}${result.pid ? ` with PID: ${result.pid}` : ""}`,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Error in launchHere command: ${errorMessage}`);

		// Add context if it's a generic error
		if (
			!errorMessage.includes("terminal") &&
			!errorMessage.includes("terminal") &&
			!errorMessage.includes("path")
		) {
			throw new Error(`Failed to launch terminal at location: ${errorMessage}`);
		}
		throw error; // Re-throw to be handled by command registration
	}
}
