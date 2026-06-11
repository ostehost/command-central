import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import {
	type AgentStatusProofSelectedNode,
	type AgentStatusProofTreeNode,
	type AgentStatusProofTreeSnapshot,
	buildSourceAuthorityMatrix,
	collectLauncherAttributedTaskIdHits,
	collectTaskIdPresence,
	findNodesByLabel,
	findSpecBoundaryViolations,
	hasRequiredSymphonyRoots,
	type InstalledVsixProofPhase,
	type LauncherRegistryProofSnapshot,
	type LauncherTaskIdHit,
	parseTaskIdListEnv,
} from "./installed-vsix-proof-shared.js";

type ProofMode = "passive" | "live";
type ExpectedVsixIdentityKind =
	| "published-prerelease"
	| "temporary-proof-artifact";

interface ProofAction {
	name: string;
	status: "passed" | "skipped" | "failed";
	non_mutating_to: string[];
	ui_effect?: string;
	detail?: string;
}

interface ProofManifest {
	proof_kind: "installed-vsix-agent-status";
	proof_phase: InstalledVsixProofPhase;
	mode: ProofMode;
	passive_or_live_mode: ProofMode;
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
	expected_vsix_sha256?: string;
	expected_vsix_identity_kind?: ExpectedVsixIdentityKind;
	vsix_matches_expected_sha?: boolean;
	published_release_match: boolean;
	commit: string;
	command_central_loaded_from_vsix: true;
	is_extension_development_path_used_for_cc: false;
	task_registry_path: string;
	launcher_registry_snapshot: LauncherRegistryProofSnapshot;
	forbidden_task_ids: string[];
	forbidden_launcher_task_id_hits: LauncherTaskIdHit[];
	expected_task_ids: string[];
	expected_task_id_presence: Record<string, boolean>;
	command_central_views: Array<{ id?: string; name?: string; type?: string }>;
	agent_status_tree_snapshot: AgentStatusProofTreeSnapshot;
	symphony_tree_snapshot: AgentStatusProofTreeSnapshot;
	tree_snapshot: AgentStatusProofTreeSnapshot;
	selected_symphony_nodes: Array<{
		path: string[];
		label: string;
		node_kind: string;
		owner_fields?: Record<string, unknown>;
	}>;
	source_authority_matrix: ReturnType<typeof buildSourceAuthorityMatrix>;
	actions: ProofAction[];
	action_probe_results: ProofAction[];
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
	const isFocusCommand = (cmd?: string) =>
		cmd === "commandCentral.focusAgentTerminal" ||
		cmd === "commandCentral.defaultAgentAction";
	if (isFocusCommand(selected.node.command?.command)) {
		return selected.node;
	}
	return findFirstCommandNode(selected.node, (node) =>
		isFocusCommand(node.command?.command),
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

function selectedNodeSummary(selected: AgentStatusProofSelectedNode): {
	path: string[];
	label: string;
	node_kind: string;
	owner_fields?: Record<string, unknown>;
} {
	return {
		path: selected.path,
		label: selected.node.label,
		node_kind: selected.node.nodeKind,
		owner_fields: selected.node.ownerFields,
	};
}

function hasDetailLabel(
	node: AgentStatusProofTreeNode,
	prefix: string,
): boolean {
	return allNodes(node).some((candidate) => candidate.label.startsWith(prefix));
}

async function getProofTreeSnapshot(
	testApi: {
		getSymphonyTreeSnapshot(options?: {
			maxDepth?: number;
			maxChildrenPerNode?: number;
			rootLabelPrefixes?: string[];
			requiredLabels?: string[];
			requiredTaskId?: string;
		}): AgentStatusProofTreeSnapshot;
	},
	requiredTaskId: string | undefined,
): Promise<AgentStatusProofTreeSnapshot> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const snapshot = testApi.getSymphonyTreeSnapshot({
			maxDepth: 4,
			maxChildrenPerNode: 35,
			requiredLabels: ["Operations Dashboard", "Workstreams", "Run Attempts"],
			requiredTaskId,
		});
		if (hasRequiredSymphonyRoots(snapshot)) return snapshot;
		await vscode.commands.executeCommand("commandCentral.refreshAgentStatus");
		await sleep(500);
	}
	return testApi.getSymphonyTreeSnapshot({
		maxDepth: 4,
		maxChildrenPerNode: 35,
		requiredLabels: ["Operations Dashboard", "Workstreams", "Run Attempts"],
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
		const before = `command-central-proof-sentinel-${Date.now()}-${Math.random()
			.toString(16)
			.slice(2)}`;
		await vscode.env.clipboard.writeText(before);
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
	const expectedVsixSha256 = process.env["COMMAND_CENTRAL_EXPECTED_VSIX_SHA256"]
		?.trim()
		.toLowerCase();
	const expectedIdentityKind = process.env[
		"COMMAND_CENTRAL_EXPECTED_VSIX_IDENTITY_KIND"
	]?.trim() as ExpectedVsixIdentityKind | undefined;
	const repoRoot = requireEnv("COMMAND_CENTRAL_REPO_ROOT");
	const requiredTaskId = process.env["COMMAND_CENTRAL_REQUIRED_TASK_ID"];
	const phase = (process.env["COMMAND_CENTRAL_PROOF_PHASE"] ??
		"legacy-fixture") as InstalledVsixProofPhase;
	assert.ok(
		phase === "quarantine-default" || phase === "legacy-fixture",
		`Unknown COMMAND_CENTRAL_PROOF_PHASE: ${phase}`,
	);
	assert.ok(
		!(phase === "quarantine-default" && mode === "live"),
		"Live action probes are not supported in the quarantine-default phase.",
	);
	const forbiddenTaskIds = parseTaskIdListEnv(
		process.env["COMMAND_CENTRAL_FORBIDDEN_TASK_IDS"],
	);
	const expectedTaskIds = parseTaskIdListEnv(
		process.env["COMMAND_CENTRAL_EXPECTED_TASK_IDS"],
	);

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
			"getAgentStatusTreeSnapshot" in testApi &&
			"getSymphonyTreeSnapshot" in testApi,
		"COMMAND_CENTRAL_TEST_MODE must expose the inspection API.",
	);
	assert.ok(
		"getLauncherRegistrySnapshot" in testApi,
		"Installed VSIX must expose getLauncherRegistrySnapshot — build the proof artifact from a quarantine-aware commit.",
	);

	await vscode.commands.executeCommand("commandCentral.refreshAgentStatus");
	await sleep(1000);
	const snapshot = await getProofTreeSnapshot(
		testApi as {
			getSymphonyTreeSnapshot(options?: {
				maxDepth?: number;
				maxChildrenPerNode?: number;
				rootLabelPrefixes?: string[];
				requiredLabels?: string[];
				requiredTaskId?: string;
			}): AgentStatusProofTreeSnapshot;
		},
		requiredTaskId,
	);
	const agentStatusSnapshot = (
		testApi as {
			getAgentStatusTreeSnapshot(options?: {
				maxDepth?: number;
				maxChildrenPerNode?: number;
				rootLabelPrefixes?: string[];
				requiredLabels?: string[];
				requiredTaskId?: string;
			}): AgentStatusProofTreeSnapshot;
		}
	).getAgentStatusTreeSnapshot({
		maxDepth: 2,
		maxChildrenPerNode: 35,
		requiredLabels: ["Symphony"],
	});
	const commandCentralViews = (extension.packageJSON.contributes?.views
		?.commandCentral ?? []) as Array<{
		id?: string;
		name?: string;
		type?: string;
	}>;

	const errors: string[] = [];
	const skips: string[] = [];
	const actions: ProofAction[] = [];
	const actualVsixSha256 = requireEnv(
		"COMMAND_CENTRAL_VSIX_SHA256",
	).toLowerCase();
	const matchesExpectedSha = expectedVsixSha256
		? actualVsixSha256 === expectedVsixSha256
		: undefined;
	if (expectedVsixSha256 && actualVsixSha256 !== expectedVsixSha256) {
		errors.push(
			`VSIX SHA256 mismatch: expected ${expectedVsixSha256}, got ${actualVsixSha256}.`,
		);
	}
	if (!hasRequiredSymphonyRoots(snapshot)) {
		if (phase === "legacy-fixture") {
			errors.push(
				"Missing required top-level Symphony view roots with Operations Dashboard, Workstreams, and Run Attempts.",
			);
		} else {
			skips.push(
				"Quarantine phase: required Symphony roots absent (acceptable empty state with no launcher source configured).",
			);
		}
	}

	const launcherRegistrySnapshot = (
		testApi as { getLauncherRegistrySnapshot(): LauncherRegistryProofSnapshot }
	).getLauncherRegistrySnapshot();
	const forbiddenHits = [
		...collectLauncherAttributedTaskIdHits(snapshot, forbiddenTaskIds),
		...collectLauncherAttributedTaskIdHits(
			agentStatusSnapshot,
			forbiddenTaskIds,
		),
	];
	for (const hit of forbiddenHits) {
		errors.push(
			`Forbidden launcher task id surfaced as launcher data: ${hit.taskId} (${hit.reason}) on "${hit.label}" [${hit.nodeKind}]`,
		);
	}
	const expectedPresence = collectTaskIdPresence(snapshot, expectedTaskIds);
	const agentStatusPresence = collectTaskIdPresence(
		agentStatusSnapshot,
		expectedTaskIds,
	);
	for (const taskId of expectedTaskIds) {
		expectedPresence[taskId] =
			Boolean(expectedPresence[taskId]) || Boolean(agentStatusPresence[taskId]);
	}

	if (phase === "quarantine-default") {
		for (const [providerName, providerSnapshot] of Object.entries(
			launcherRegistrySnapshot,
		)) {
			if (providerSnapshot.resolvedFilePaths.length > 0) {
				errors.push(
					`Quarantine violated: ${providerName} provider resolved launcher registries with default settings: ${providerSnapshot.resolvedFilePaths.join(", ")}`,
				);
			}
			if (providerSnapshot.launcherTaskCount > 0) {
				errors.push(
					`Quarantine violated: ${providerName} provider ingested ${providerSnapshot.launcherTaskCount} launcher task(s) with default settings: ${providerSnapshot.launcherTaskIds.join(", ")}`,
				);
			}
		}
		if (forbiddenTaskIds.length === 0) {
			skips.push(
				"No forbidden launcher task ids supplied (real global registry absent or empty); quarantine id sweep is vacuous on this machine.",
			);
		}
	}

	if (phase === "legacy-fixture") {
		const legacyRegistryPath = requireEnv("COMMAND_CENTRAL_TASK_REGISTRY_PATH");
		for (const [providerName, providerSnapshot] of Object.entries(
			launcherRegistrySnapshot,
		)) {
			if (!providerSnapshot.resolvedFilePaths.includes(legacyRegistryPath)) {
				errors.push(
					`Legacy escape hatch broken: ${providerName} provider did not resolve the fixture registry ${legacyRegistryPath} (resolved: ${providerSnapshot.resolvedFilePaths.join(", ") || "none"})`,
				);
			}
			for (const taskId of expectedTaskIds) {
				if (!providerSnapshot.launcherTaskIds.includes(taskId)) {
					errors.push(
						`Legacy escape hatch broken: ${providerName} provider did not ingest expected task id ${taskId}`,
					);
				}
			}
		}
		for (const taskId of expectedTaskIds) {
			if (!expectedPresence[taskId]) {
				errors.push(
					`Expected legacy fixture task id not visible in any tree snapshot: ${taskId}`,
				);
			}
		}
	}
	const symphonyViewIndex = commandCentralViews.findIndex(
		(view) => view.id === "commandCentral.symphony",
	);
	const agentStatusViewIndex = commandCentralViews.findIndex(
		(view) => view.id === "commandCentral.agentStatus",
	);
	if (symphonyViewIndex < 0 || agentStatusViewIndex < 0) {
		errors.push(
			"Command Central manifest must contribute both commandCentral.symphony and commandCentral.agentStatus.",
		);
	} else if (symphonyViewIndex === agentStatusViewIndex) {
		errors.push("Symphony and Agent Status must be separate top-level views.");
	}
	errors.push(...findSpecBoundaryViolations(snapshot));

	const selectedRows = [
		...findNodesByLabel(
			snapshot.roots,
			(label) =>
				label.startsWith("Operations Dashboard") ||
				label.startsWith("Running Sessions") ||
				label.startsWith("Retry Queue") ||
				label.startsWith("Workstreams") ||
				label.startsWith("Run Attempts"),
		).map((node) => ({ path: [node.label], node })),
	];
	const passiveRun = findNodesByLabel(snapshot.roots, (label) =>
		label.startsWith("Run Attempts"),
	)[0]?.children?.find((node) => node.nodeKind === "codexRun");
	if (passiveRun && mode === "passive" && phase === "legacy-fixture") {
		if (!hasDetailLabel(passiveRun, "Lifecycle owner")) {
			errors.push("Passive run attempt is missing lifecycle-owner detail.");
		}
		if (!hasDetailLabel(passiveRun, "Provenance from")) {
			errors.push("Passive run attempt is missing provenance detail.");
		}
		if (!hasDetailLabel(passiveRun, "Tracker source")) {
			errors.push(
				"Passive run attempt is missing explicit tracker-state detail.",
			);
		}
		selectedRows.push({
			path: ["Run Attempts", passiveRun.label],
			node: passiveRun,
		});
	}
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
		const hasTrackerState = targetNodes.some((node) =>
			node.label.startsWith("Tracker source"),
		);
		if (mode === "live") {
			if (!hasEvidence) errors.push("Live target is missing evidence rows.");
			if (!hasProvenance)
				errors.push("Live target is missing provenance rows.");
			if (!hasAuthority)
				errors.push("Live target is missing owner authority fields.");
			if (!hasTrackerState)
				errors.push("Live target is missing explicit tracker-state detail.");
			const probes = await runLiveActionProbes(liveSelected);
			actions.push(...probes.actions);
			errors.push(...probes.errors);
		}
		selectedRows.push(liveSelected);
	}

	const manifest: ProofManifest = {
		proof_kind: "installed-vsix-agent-status",
		proof_phase: phase,
		mode,
		passive_or_live_mode: mode,
		machine: {
			hostname: os.hostname(),
			platform: process.platform,
			arch: process.arch,
			user: os.userInfo().username,
		},
		extension_id: extensionId,
		installed_version: extension.packageJSON.version,
		vsix_path: requireEnv("COMMAND_CENTRAL_VSIX_PROOF_PATH"),
		vsix_sha256: actualVsixSha256,
		expected_vsix_sha256: expectedVsixSha256 || undefined,
		expected_vsix_identity_kind: expectedIdentityKind,
		vsix_matches_expected_sha: matchesExpectedSha,
		published_release_match:
			expectedIdentityKind === "published-prerelease" &&
			matchesExpectedSha === true,
		commit: requireEnv("COMMAND_CENTRAL_PROOF_COMMIT"),
		command_central_loaded_from_vsix: true,
		is_extension_development_path_used_for_cc: false,
		task_registry_path: requireEnv("COMMAND_CENTRAL_TASK_REGISTRY_PATH"),
		launcher_registry_snapshot: launcherRegistrySnapshot,
		forbidden_task_ids: forbiddenTaskIds,
		forbidden_launcher_task_id_hits: forbiddenHits,
		expected_task_ids: expectedTaskIds,
		expected_task_id_presence: expectedPresence,
		command_central_views: commandCentralViews,
		agent_status_tree_snapshot: agentStatusSnapshot,
		symphony_tree_snapshot: snapshot,
		tree_snapshot: snapshot,
		selected_symphony_nodes: selectedRows.map(selectedNodeSummary),
		source_authority_matrix: buildSourceAuthorityMatrix(selectedRows),
		actions,
		action_probe_results: actions,
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
