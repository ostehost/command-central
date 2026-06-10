/**
 * Cron Jobs feature — service, tree view, and command registration.
 *
 * The CronService and CronTreeProvider modules load lazily via dynamic
 * import to keep extension activation fast. Lifecycle ownership stays with
 * the extension context: every disposable is pushed onto
 * `context.subscriptions`.
 */

import * as vscode from "vscode";
import type { CronTreeProvider } from "../providers/cron-tree-provider.js";
import type { CronService } from "../services/cron-service.js";

type CronNodeArg = { kind: string; job?: { id: string } };

export interface CronCommandDeps {
	cronService: Pick<CronService, "runJob" | "enableJob" | "disableJob">;
	cronTreeProvider: Pick<CronTreeProvider, "refresh">;
}

/**
 * Register the eight commandCentral.cron.* commands. Returns one disposable
 * per command; the caller owns their lifecycle.
 */
export function registerCronCommands(
	deps: CronCommandDeps,
): vscode.Disposable[] {
	const { cronService, cronTreeProvider } = deps;
	return [
		vscode.commands.registerCommand("commandCentral.cron.refresh", () =>
			cronTreeProvider.refresh(),
		),
		vscode.commands.registerCommand(
			"commandCentral.cron.runNow",
			async (node?: CronNodeArg) => {
				if (node?.kind === "job" && node.job) {
					await cronService.runJob(node.job.id);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.cron.enable",
			async (node?: CronNodeArg) => {
				if (node?.kind === "job" && node.job) {
					await cronService.enableJob(node.job.id);
				}
			},
		),
		vscode.commands.registerCommand(
			"commandCentral.cron.disable",
			async (node?: CronNodeArg) => {
				if (node?.kind === "job" && node.job) {
					await cronService.disableJob(node.job.id);
				}
			},
		),
		vscode.commands.registerCommand("commandCentral.cron.create", () =>
			vscode.window.showInformationMessage(
				"Create Cron Job — coming in Phase 2",
			),
		),
		vscode.commands.registerCommand("commandCentral.cron.edit", () =>
			vscode.window.showInformationMessage("Edit Cron Job — coming in Phase 2"),
		),
		vscode.commands.registerCommand("commandCentral.cron.delete", () =>
			vscode.window.showInformationMessage(
				"Delete Cron Job — coming in Phase 2",
			),
		),
		vscode.commands.registerCommand("commandCentral.cron.viewHistory", () =>
			vscode.window.showInformationMessage(
				"View Run History — coming in Phase 2",
			),
		),
	];
}

/**
 * Construct the cron service, tree provider, and tree view, start the
 * service, and register the cron commands onto the extension context.
 */
export async function activateCronFeature(
	context: vscode.ExtensionContext,
): Promise<void> {
	const { CronService } = await import("../services/cron-service.js");
	const { CronTreeProvider } = await import(
		"../providers/cron-tree-provider.js"
	);

	const cronService = new CronService();
	const cronTreeProvider = new CronTreeProvider(cronService);
	const cronView = vscode.window.createTreeView("commandCentral.cronJobs", {
		treeDataProvider: cronTreeProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(cronService, cronTreeProvider, cronView);
	cronService.start(() => cronTreeProvider.refresh());

	context.subscriptions.push(
		...registerCronCommands({ cronService, cronTreeProvider }),
	);
}
