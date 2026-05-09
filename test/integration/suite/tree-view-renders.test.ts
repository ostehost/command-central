import assert from "node:assert/strict";
import * as vscode from "vscode";
import { getTestApi, waitForIdleTurn } from "./helpers.js";

export const scenarioName = "tree view renders";

export async function run(): Promise<void> {
	const testApi = await getTestApi();
	await vscode.commands.executeCommand("commandCentral.agentStatus.focus");
	await waitForIdleTurn();

	const snapshot = testApi.getSnapshot();
	const agentStatus = testApi.getAgentStatusSnapshot();
	const tree = testApi.getAgentStatusTreeSnapshot({
		maxDepth: 2,
		requiredLabels: ["Symphony / Workstreams", "Symphony / Run Attempts"],
	});

	assert.equal(
		snapshot.hasAgentStatusProvider,
		true,
		"Tree view rendering requires an initialized agent status provider.",
	);
	assert.ok(
		agentStatus.rootChildrenCount >= 0,
		"Agent status root children count should be readable without throwing.",
	);
	assert.ok(
		tree.selected.requiredLabels["Symphony / Workstreams"]?.length,
		"Agent Status tree inspection should expose the static Symphony / Workstreams root.",
	);
	assert.ok(
		tree.selected.requiredLabels["Symphony / Run Attempts"]?.length,
		"Agent Status tree inspection should expose the Symphony / Run Attempts root.",
	);
}
