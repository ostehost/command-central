/**
 * Remove launcher command handler
 * Removes the current project's launcher
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { TerminalLauncherService } from "../services/terminal-launcher-service.js";

export async function execute(service: TerminalLauncherService): Promise<void> {
	const outputChannel = service.getSecurityService().getOutputChannel();
	outputChannel.appendLine(
		"Executing commandCentral.terminal.removeLauncher command",
	);

	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage("No workspace folder is open");
			return;
		}

		// Try to get project name from settings
		const settingsPath = path.join(
			workspaceFolder.uri.fsPath,
			".vscode",
			"settings.json",
		);
		let projectName = path.basename(workspaceFolder.uri.fsPath);

		try {
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(settingsPath, "utf-8");
			const settings = JSON.parse(content);

			// Read from new format
			if (settings["commandCentral.project.name"]) {
				projectName = settings["commandCentral.project.name"];
			}
		} catch {
			// Use folder name as fallback
		}

		// Confirm removal
		const confirm = await vscode.window.showWarningMessage(
			`Remove launcher for "${projectName}"?`,
			"Remove",
			"Cancel",
		);

		if (confirm !== "Remove") {
			return;
		}

		const success = await service.removeLauncher(projectName);
		if (success) {
			outputChannel.appendLine(`Successfully removed launcher: ${projectName}`);
		} else {
			outputChannel.appendLine(`Failed to remove launcher: ${projectName}`);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(
			`Error in removeCurrentLauncher command: ${errorMessage}`,
		);
		throw new Error(`Failed to remove launcher: ${errorMessage}`);
	}
}
