import assert from "node:assert/strict";
import * as vscode from "vscode";
import type {
	AgentNode,
	AgentStatusTreeProvider,
} from "../../../src/providers/agent-status-tree-provider.js";
import { getTreeSnapshotForProvider } from "../../../src/services/integration-test-api.js";
import { getTestApi, waitForIdleTurn } from "./helpers.js";

export const scenarioName = "tree view renders";

/**
 * Regression for PAR-69 / CP-30: a required label on a node hidden past the
 * snapshot child/root cap must still surface in `selected.requiredLabels`.
 * Before the fix, root/child selection sliced to `maxChildrenPerNode` (and the
 * only pre-cap escape hatch was for `requiredTaskId`), so a label on a
 * capped-out node was never visited. Uses a fake provider so the cap is
 * deterministic without depending on live host state.
 */
function buildFakeProviderWithCappedLabel(
	rootCount: number,
	requiredLabelIndex: number,
	requiredLabel: string,
): AgentStatusTreeProvider {
	const roots: AgentNode[] = Array.from({ length: rootCount }, (_, index) => ({
		type: "state",
		label: index === requiredLabelIndex ? requiredLabel : `filler-${index}`,
	}));
	const fake = {
		getChildren(element?: AgentNode): AgentNode[] {
			return element ? [] : roots;
		},
		getTreeItem(element: AgentNode): vscode.TreeItem {
			return new vscode.TreeItem(
				element.type === "state" ? element.label : element.type,
			);
		},
		getTasks(): unknown[] {
			return [];
		},
	};
	return fake as unknown as AgentStatusTreeProvider;
}

function runCappedRequiredLabelRegression(): void {
	const maxChildrenPerNode = 3;
	const requiredLabel = "PAR-69-capped-out-root";
	// Place the required label on a root strictly beyond the cap so naive
	// `.slice(0, maxChildrenPerNode)` selection drops it.
	const provider = buildFakeProviderWithCappedLabel(
		maxChildrenPerNode + 2,
		maxChildrenPerNode + 1,
		requiredLabel,
	);

	const snapshot = getTreeSnapshotForProvider(provider, {
		maxDepth: 1,
		maxChildrenPerNode,
		requiredLabels: [requiredLabel],
	});

	const selected = snapshot.selected.requiredLabels[requiredLabel];
	assert.ok(
		selected?.length,
		"A required label on a root past the snapshot cap must still be selected (PAR-69).",
	);
	assert.deepEqual(
		selected?.[0]?.path,
		[requiredLabel],
		"The selected capped-out node must carry its own path.",
	);
	assert.equal(
		selected?.[0]?.node.label,
		requiredLabel,
		"The selected node must be the capped-out root carrying the required label.",
	);
}

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

	runCappedRequiredLabelRegression();
}
