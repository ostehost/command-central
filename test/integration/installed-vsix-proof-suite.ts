import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import {
	type AgentStatusProofSelectedNode,
	type AgentStatusProofTreeNode,
	type AgentStatusProofTreeSnapshot,
	buildSourceAuthorityMatrix,
	findNodesByLabel,
	findSpecBoundaryViolations,
	hasRequiredSymphonyRoots,
} from "./installed-vsix-proof-shared.js";

type ProofMode = "passive" | "live";

interface ProofAction {
	name: string;
	status: "passed" | "skipped" | "failed";
	non_mutating_to: string[];
	ui_effect?: string;
	detail?: string;
}

interface ProofManifest {
	proof_kind: "installed-vsix-agent-status";
	mode: ProofMode;
	machine: {
		hostname: string;
		platform: NodeJS.Platform;
		arch: string;
		user: string;
	};
	extension_id: string;
	installed_version: string;
	vsix_path: string;
	vsix_sha256: string;
	commit: string;
	is_extension_development_path_used_for_cc: false;
	task_registry_path: string;
	tree_snapshot: AgentStatusProofTreeSnapshot;
	source_authority_matrix: ReturnType<typeof buildSourceAuthorityMatrix>;
	actions: ProofAction[];
	skips: string[];
	errors: string[];
}

function requireEnv(name: string): string {
	const value = process.env[name];
	assert.ok(value, `${name} must be set for installed VSIX proof.`);
	return value;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function allNodes(node: AgentStatusProofTreeNode): AgentStatusProofTreeNode[] {
	const nodes = [node];
	for (const child of node.children ?? []) nodes.push(...allNodes(child));
	return nodes;
}

function commandArgumentToVsCodeValue(argument: unknown): unknown {
	if (
		argument &&
		typeof argument === "object" &&
		"__kind" in argument &&
		(argument as { __kind?: unknown }).__kind === "Uri"
	) {
		const uri = argument as { external?: string; fsPath?: string };
		return uri.external
			? vscode.Uri.parse(uri.external)
			: vscode.Uri.file(uri.fsPath ?? "");
	}
	if (Array.isArray(argument))
		return argument.map(commandArgumentToVsCodeValue);
	if (argument && typeof argument === "object") {
		return Object.fromEntries(
			Object.entries(argument).map(([key, value]) => [
				key,
				commandArgumentToVsCodeValue(value),
			]),
		);
	}
	return argument;
}

async function executeSerializedCommand(
	commandNode: AgentStatusProofTreeNode,
): Promise<void> {
	assert.ok(commandNode.command, `Node ${commandNode.label} has no command.`);
	const args = (commandNode.command.arguments ?? []).map(
		commandArgumentToVsCodeValue,
	);
	await vscode.commands.executeCommand(commandNode.command.command, ...args);
}

function findFirstCommandNode(
	root: AgentStatusProofTreeNode,
	predicate: (node: AgentStatusProofTreeNode) => boolean,
): AgentStatusProofTreeNode | undefined {
	return allNodes(root).find(
		(node) => node.command?.command && predicate(node),
	);
}

function findOpenEvidenceNode(
	root: AgentStatusProofTreeNode,
): AgentStatusProofTreeNode | undefined {
	return findFirstCommandNode(
		root,
		(node) =>
			node.label.startsWith("Evidence:") &&
			node.command?.command === "vscode.open",
	);
}

function findCopyNode(
	root: AgentStatusProofTreeNode,
): AgentStatusProofTreeNode | undefined {
	return findFirstCommandNode(
		root,
		(node) => node.command?.command === "commandCentral.copyToClipboard",
	);
}

function findFocusNode(
	selected: AgentStatusProofSelectedNode,
): AgentStatusProofTreeNode | undefined {
	if (selected.node.command?.command === "commandCentral.focusAgentTerminal") {
		return selected.node;
	}
	return findFirstCommandNode(
		selected.node,
		(node) => node.command?.command === "commandCentral.focusAgentTerminal",
	);
}

function getOpenedEvidencePath(
	node: AgentStatusProofTreeNode,
): string | undefined {
	const firstArg = node.command?.arguments?.[0];
	if (
		firstArg &&
		typeof firstArg === "object" &&
		"fsPath" in firstArg &&
		typeof (firstArg as { fsPath?: unknown }).fsPath === "string"
	) {
		return (firstArg as { fsPath: string }).fsPath;
	}
	return undefined;
}

function makeAction(
	name: string,
	status: ProofAction["status"],
	uiEffect?: string,
	detail?: string,
): ProofAction {
	return {
		name,
		status,
		non_mutating_to: ["lifecycle", "tracker", "workspace"],
		ui_effect: uiEffect,
		detail,
	};
}

async function getProofTreeSnapshot(
	testApi: {
		getAgentStatusTreeSnapshot(options?: {
			maxDepth?: number;
			maxChildrenPerNode?: number;
			requiredLabels?: string[];
			requiredTaskId?: string;
		}): AgentStatusProofTreeSnapshot;
	},
	requiredTaskId: string | undefined,
): Promise<AgentStatusProofTreeSnapshot> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const snapshot = testApi.getAgentStatusTreeSnapshot({
			maxDepth: 4,
			maxChildrenPerNode: 35,
			requiredLabels: ["Symphony / Workstreams", "Symphony / Run Attempts"],
			requiredTaskId,
		});
		if (hasRequiredSymphonyRoots(snapshot)) return snapshot;
		await vscode.commands.executeCommand("commandCentral.refreshAgentStatus");
		await sleep(500);
	}
	return testApi.getAgentStatusTreeSnapshot({
		maxDepth: 4,
		maxChildrenPerNode: 35,
		requiredLabels: ["Symphony / Workstreams", "Symphony / Run Attempts"],
		requiredTaskId,
	});
}

async function runLiveActionProbes(
	selected: AgentStatusProofSelectedNode,
): Promise<{ actions: ProofAction[]; errors: string[] }> {
	const actions: ProofAction[] = [];
	const errors: string[] = [];

	const copyNode = findCopyNode(selected.node);
	if (!copyNode) {
		errors.push("Live target has no copy command.");
		actions.push(makeAction("copy", "failed", undefined, "missing command"));
	} else {
		const before = await vscode.env.clipboard.readText();
		await executeSerializedCommand(copyNode);
		const after = await vscode.env.clipboard.readText();
		if (after && after !== before) {
			actions.push(
				makeAction("copy", "passed", "clipboard changed", copyNode.label),
			);
		} else {
			errors.push("Copy command did not change the clipboard.");
			actions.push(
				makeAction("copy", "failed", "clipboard unchanged", copyNode.label),
			);
		}
	}

	const evidenceNode = findOpenEvidenceNode(selected.node);
	if (!evidenceNode) {
		errors.push("Live target has no openable evidence command.");
		actions.push(
			makeAction(
				"open evidence",
				"failed",
				undefined,
				"missing evidence command",
			),
		);
	} else {
		await executeSerializedCommand(evidenceNode);
		await sleep(250);
		const expectedPath = getOpenedEvidencePath(evidenceNode);
		const opened = expectedPath
			? vscode.window.visibleTextEditors.some(
					(editor) => editor.document.uri.fsPath === expectedPath,
				)
			: false;
		if (opened) {
			actions.push(
				makeAction("open evidence", "passed", "file opened", expectedPath),
			);
		} else {
			errors.push(
				`Evidence file did not become visible: ${expectedPath ?? "(unknown)"}`,
			);
			actions.push(
				makeAction("open evidence", "failed", "file not visible", expectedPath),
			);
		}
	}

	const focusNode = findFocusNode(selected);
	if (!focusNode) {
		errors.push("Live target has no terminal focus command.");
		actions.push(
			makeAction("focus terminal", "failed", undefined, "missing command"),
		);
	} else {
		await executeSerializedCommand(focusNode);
		actions.push(
			makeAction(
				"focus terminal",
				"passed",
				"terminal focus invoked",
				focusNode.label,
			),
		);
	}

	return { actions, errors };
}

export async function run(): Promise<void> {
	const mode = (process.env["COMMAND_CENTRAL_PROOF_MODE"] ??
		"passive") as ProofMode;
	const extensionId = requireEnv("COMMAND_CENTRAL_EXTENSION_ID");
	const manifestPath = requireEnv("COMMAND_CENTRAL_PROOF_MANIFEST");
	const expectedVersion = requireEnv("COMMAND_CENTRAL_EXPECTED_VERSION");
	const repoRoot = requireEnv("COMMAND_CENTRAL_REPO_ROOT");
	const requiredTaskId = process.env["COMMAND_CENTRAL_REQUIRED_TASK_ID"];

	const extension = vscode.extensions.getExtension(extensionId);
	assert.ok(
		extension,
		`Installed extension ${extensionId} must be visible to VS Code.`,
	);
	const testApi = await extension.activate();
	assert.equal(
		extension.isActive,
		true,
		"Installed Command Central must activate.",
	);
	assert.equal(
		extension.packageJSON.version,
		expectedVersion,
		"Installed extension version must match the VSIX manifest version.",
	);
	assert.equal(
		extension.extensionPath.startsWith(repoRoot),
		false,
		"Installed Command Central must not load from --extensionDevelopmentPath/source checkout.",
	);
	assert.ok(
		testApi &&
			typeof testApi === "object" &&
			"getAgentStatusTreeSnapshot" in testApi,
		"COMMAND_CENTRAL_TEST_MODE must expose the inspection API.",
	);

	await vscode.commands.executeCommand("commandCentral.refreshAgentStatus");
	await sleep(1000);
	const snapshot = await getProofTreeSnapshot(
		testApi as {
			getAgentStatusTreeSnapshot(options?: {
				maxDepth?: number;
				maxChildrenPerNode?: number;
				requiredLabels?: string[];
				requiredTaskId?: string;
			}): AgentStatusProofTreeSnapshot;
		},
		requiredTaskId,
	);

	const errors: string[] = [];
	const skips: string[] = [];
	const actions: ProofAction[] = [];
	if (!hasRequiredSymphonyRoots(snapshot)) {
		errors.push(
			"Missing required Symphony / Workstreams or Symphony / Run Attempts root.",
		);
	}
	errors.push(...findSpecBoundaryViolations(snapshot));

	const selectedRows = [
		...findNodesByLabel(snapshot.roots, (label) =>
			label.startsWith("Symphony /"),
		),
	];
	const liveSelected = snapshot.selected.requiredTaskId;
	if (mode === "live") {
		if (!requiredTaskId) {
			errors.push("Live proof requires COMMAND_CENTRAL_REQUIRED_TASK_ID.");
		}
		if (!liveSelected) {
			errors.push(
				`Live proof target not found: ${requiredTaskId ?? "(missing)"}`,
			);
		}
	} else if (!liveSelected) {
		skips.push(
			"No live target requested; action probes skipped in passive mode.",
		);
		actions.push(makeAction("copy", "skipped", undefined, "passive mode"));
		actions.push(
			makeAction("open evidence", "skipped", undefined, "passive mode"),
		);
		actions.push(
			makeAction("focus terminal", "skipped", undefined, "passive mode"),
		);
	}

	if (liveSelected) {
		const targetNodes = allNodes(liveSelected.node);
		const hasEvidence = targetNodes.some((node) =>
			node.label.startsWith("Evidence:"),
		);
		const hasProvenance = targetNodes.some((node) =>
			node.label.startsWith("Provenance from"),
		);
		const hasAuthority = targetNodes.some((node) =>
			node.label.startsWith("Lifecycle owner"),
		);
		if (mode === "live") {
			if (!hasEvidence) errors.push("Live target is missing evidence rows.");
			if (!hasProvenance)
				errors.push("Live target is missing provenance rows.");
			if (!hasAuthority)
				errors.push("Live target is missing owner authority fields.");
			const probes = await runLiveActionProbes(liveSelected);
			actions.push(...probes.actions);
			errors.push(...probes.errors);
		}
		selectedRows.push(liveSelected.node);
	}

	const manifest: ProofManifest = {
		proof_kind: "installed-vsix-agent-status",
		mode,
		machine: {
			hostname: os.hostname(),
			platform: process.platform,
			arch: process.arch,
			user: os.userInfo().username,
		},
		extension_id: extensionId,
		installed_version: extension.packageJSON.version,
		vsix_path: requireEnv("COMMAND_CENTRAL_VSIX_PROOF_PATH"),
		vsix_sha256: requireEnv("COMMAND_CENTRAL_VSIX_SHA256"),
		commit: requireEnv("COMMAND_CENTRAL_PROOF_COMMIT"),
		is_extension_development_path_used_for_cc: false,
		task_registry_path: requireEnv("COMMAND_CENTRAL_TASK_REGISTRY_PATH"),
		tree_snapshot: snapshot,
		source_authority_matrix: buildSourceAuthorityMatrix(
			selectedRows.map((node) => ({ path: [node.label], node })),
		),
		actions,
		skips,
		errors,
	};

	await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

	assert.deepEqual(
		errors,
		[],
		`Installed VSIX proof failed; manifest: ${manifestPath}`,
	);
}
