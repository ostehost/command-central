/**
 * Miscellaneous single-command registration — clipboard utility,
 * infrastructure dashboard link, and the test-count status bar refresh.
 *
 * The test-count status bar is constructed near the end of activation, long
 * after these commands register, and is reset on deactivate — so it is
 * injected as a getter and dereferenced at invocation time. Before the status
 * bar exists the handler is a graceful no-op.
 */

import * as vscode from "vscode";
import type { LoggerService } from "../services/logger-service.js";
import type { TestCountStatusBar } from "../services/test-count-status-bar.js";

export interface MiscCommandDeps {
	getTestCountStatusBar: () =>
		| Pick<TestCountStatusBar, "refreshCount">
		| undefined;
	logger: Pick<LoggerService, "error">;
}

/**
 * Register the three standalone utility commands. Returns one disposable per
 * command; the caller owns their lifecycle.
 */
export function registerMiscCommands(
	deps: MiscCommandDeps,
): vscode.Disposable[] {
	const { getTestCountStatusBar, logger } = deps;
	return [
		// Utility: copy text to clipboard (used by detail item click commands)
		vscode.commands.registerCommand(
			"commandCentral.copyToClipboard",
			async (text: string) => {
				if (text) {
					await vscode.env.clipboard.writeText(text);
				}
			},
		),

		vscode.commands.registerCommand(
			"commandCentral.openInfrastructureDashboard",
			async () => {
				await vscode.env.openExternal(
					vscode.Uri.parse("https://dashboard.partnerai.dev"),
				);
			},
		),

		vscode.commands.registerCommand(
			"command-central.showTestCount",
			async () => {
				try {
					const count = await getTestCountStatusBar()?.refreshCount();
					if (count !== undefined) {
						vscode.window.setStatusBarMessage(
							`CC: ${count} tests passed`,
							3000,
						);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					logger.error("Failed to refresh test count", err as Error);
					vscode.window.showErrorMessage(
						`Command Central: Failed to run tests — ${msg}`,
					);
				}
			},
		),
	];
}
