/**
 * Command: commandCentral.launchTerminal
 * Generates a macOS .app bundle for the current workspace and launches it.
 */

import * as vscode from "vscode";
import {
	type AppBundleConfig,
	generateAppBundle,
	launchApp,
} from "../terminal/app-bundle-generator.js";

export async function execute(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage(
			"Command Central: No workspace folder open.",
		);
		return;
	}

	const config = vscode.workspace.getConfiguration(
		"commandCentral",
		folder.uri,
	);
	const projectName = config.get<string>("project.name") || folder.name;
	const projectIcon = config.get<string>("project.icon") || "🖥️";
	const theme = config.get<string>("terminal.theme");

	const bundleConfig: AppBundleConfig = {
		projectName,
		projectIcon,
		workspacePath: folder.uri.fsPath,
		theme: theme || undefined,
	};

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Launching ${projectIcon} ${projectName}...`,
			},
			async () => {
				const appPath = await generateAppBundle(bundleConfig);
				await launchApp(appPath);
			},
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(
			`Command Central: Failed to launch terminal — ${msg}`,
		);
	}
}
