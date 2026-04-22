import assert from "node:assert/strict";
import * as vscode from "vscode";
import { getTestApi, waitForIdleTurn } from "./helpers.js";

export const scenarioName = "side-effect-free command executes";

export async function run(): Promise<void> {
	const testApi = await getTestApi();

	await vscode.commands.executeCommand("commandCentral.refreshAgentStatus");
	await waitForIdleTurn();

	const snapshot = testApi.getSnapshot();
	assert.equal(
		snapshot.hasAgentStatusProvider,
		true,
		"The refresh command should keep the agent status provider alive.",
	);
}
