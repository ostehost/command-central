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
	// The Agent Status tree keeps a single static "Symphony Status Surface"
	// summary node that points at the dedicated Symphony view.
	const agentStatusTree = testApi.getAgentStatusTreeSnapshot({
		maxDepth: 2,
		requiredLabels: ["Symphony"],
	});
	// Workstreams + Run Attempts were promoted out of the Agent Status tree into
	// the dedicated Symphony view (commit 734d7280 "promote symphony tree
	// surface"). They are static top-level roots of the Symphony provider, so
	// they must be asserted via getSymphonyTreeSnapshot — mirroring the installed
	// VSIX proof — rather than against the Agent Status provider.
	const symphonyTree = testApi.getSymphonyTreeSnapshot({
		maxDepth: 1,
		requiredLabels: ["Workstreams", "Run Attempts"],
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
		agentStatusTree.selected.requiredLabels["Symphony"]?.length,
		"Agent Status tree inspection should expose the static Symphony status surface.",
	);
	assert.ok(
		symphonyTree.selected.requiredLabels["Workstreams"]?.length,
		"Symphony view inspection should expose the static Workstreams root.",
	);
	assert.ok(
		symphonyTree.selected.requiredLabels["Run Attempts"]?.length,
		"Symphony view inspection should expose the static Run Attempts root.",
	);
}
