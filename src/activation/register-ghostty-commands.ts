/**
 * Ghostty command registration — project terminal creation and the launcher
 * binary check/update flow.
 *
 * TerminalManager and BinaryManager are constructed immediately before these
 * commands register, but both live as resettable module state in extension.ts
 * (cleared in deactivate()), so they are injected as getters and dereferenced
 * at invocation time — never captured by value at registration time. Both
 * handlers degrade to a graceful no-op while a manager is missing.
 */

import * as vscode from "vscode";
import type { BinaryManager } from "../ghostty/BinaryManager.js";
import type { TerminalManager } from "../ghostty/TerminalManager.js";
import type { LoggerService } from "../services/logger-service.js";

export interface GhosttyCommandDeps {
	getTerminalManager: () =>
		| Pick<TerminalManager, "runInProjectTerminal">
		| undefined;
	getBinaryManager: () =>
		| Pick<
				BinaryManager,
				"isInstalled" | "getVersion" | "getLatestRelease" | "downloadRelease"
		  >
		| undefined;
	logger: Pick<LoggerService, "error">;
}

/**
 * Register the two commandCentral.ghostty.* commands. Returns one disposable
 * per command; the caller owns their lifecycle.
 */
export function registerGhosttyCommands(
	deps: GhosttyCommandDeps,
): vscode.Disposable[] {
	const { getTerminalManager, getBinaryManager, logger } = deps;
	return [
		vscode.commands.registerCommand(
			"commandCentral.ghostty.createTerminal",
			async () => {
				const folders = vscode.workspace.workspaceFolders;
				if (!folders || folders.length === 0) {
					vscode.window.showErrorMessage(
						"Command Central: No workspace folder open.",
					);
					return;
				}

				// Multi-root workspace: show picker to choose which folder
				let selectedFolder: vscode.WorkspaceFolder;
				if (folders.length > 1) {
					const folderItems = folders.map((folder) => ({
						label: folder.name,
						description: folder.uri.fsPath,
						folder: folder,
					}));

					const selectedItem = await vscode.window.showQuickPick(folderItems, {
						placeHolder: "Select workspace folder for terminal",
						canPickMany: false,
					});

					if (!selectedItem) {
						// User cancelled the picker
						return;
					}

					selectedFolder = selectedItem.folder;
				} else {
					// Single workspace folder: use it directly
					selectedFolder = folders[0] as vscode.WorkspaceFolder;
				}

				try {
					await getTerminalManager()?.runInProjectTerminal(
						selectedFolder.uri.fsPath,
					);
					vscode.window.showInformationMessage(
						`Command Central: Project terminal opened for ${selectedFolder.name}.`,
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.error("Failed to open project terminal", err as Error);
					vscode.window.showErrorMessage(
						`Command Central: Failed to open terminal — ${msg}`,
					);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.ghostty.checkBinary",
			async () => {
				try {
					const isInstalled = await getBinaryManager()?.isInstalled();

					if (isInstalled) {
						const versionInfo = await getBinaryManager()?.getVersion();
						if (!versionInfo) return;
						const versionStr = versionInfo.bundleVersion ?? "unknown";
						const hashStr = versionInfo.commitHash
							? ` (${versionInfo.commitHash.slice(0, 8)})`
							: "";

						const choice = await vscode.window.showInformationMessage(
							`Command Central: Ghostty CC ${versionStr}${hashStr} is installed.`,
							"Check for Updates",
							"OK",
						);

						if (choice !== "Check for Updates") return;
					}

					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: "Command Central: Checking for Ghostty updates…",
							cancellable: false,
						},
						async () => {
							const release = await getBinaryManager()?.getLatestRelease();
							if (!release) return;

							const versionInfo = isInstalled
								? await getBinaryManager()?.getVersion()
								: { bundleVersion: null, commitHash: null };
							if (!versionInfo) return;

							const alreadyLatest =
								versionInfo.bundleVersion === release.tag_name;

							if (alreadyLatest) {
								vscode.window.showInformationMessage(
									`Command Central: Ghostty is already up to date (${release.tag_name}).`,
								);
								return;
							}

							const action = await vscode.window.showInformationMessage(
								`Command Central: Ghostty ${release.tag_name} is available.${versionInfo.bundleVersion ? ` (current: ${versionInfo.bundleVersion})` : ""}`,
								"Install",
								"Cancel",
							);

							if (action !== "Install") return;

							await vscode.window.withProgress(
								{
									location: vscode.ProgressLocation.Notification,
									title: `Command Central: Installing Ghostty ${release.tag_name}…`,
									cancellable: false,
								},
								async () => {
									await getBinaryManager()?.downloadRelease(release.tag_name);
								},
							);

							vscode.window.showInformationMessage(
								`Command Central: Ghostty ${release.tag_name} installed successfully.`,
							);
						},
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.error("Ghostty binary check failed", err as Error);
					vscode.window.showErrorMessage(
						`Command Central: Ghostty check failed — ${msg}`,
					);
				}
			},
		),
	];
}
