import { DEFAULT_LANE_REGISTRY_FILES } from "../../src/utils/tasks-file-resolver.js";

export interface SerializedCommand {
	command: string;
	title: string;
	arguments?: unknown[];
}

/**
 * The zero-config lane registry paths the extension resolves under default
 * settings, expanded against the given home directory. The quarantine-default
 * proof phase asserts the provider resolves exactly these (lane-records-only
 * bridges) and nothing else.
 */
export function expandedDefaultLaneRegistryPaths(homeDir: string): string[] {
	return DEFAULT_LANE_REGISTRY_FILES.map((entry) =>
		entry.startsWith("~/") ? `${homeDir}/${entry.slice(2)}` : entry,
	);
}

export interface AgentStatusProofTreeNode {
	label: string;
	description?: string;
	contextValue?: string;
	nodeKind: string;
	command?: SerializedCommand;
	ownerFields?: Record<string, unknown>;
	children?: AgentStatusProofTreeNode[];
	truncatedChildCount?: number;
}

export interface AgentStatusProofSelectedNode {
	path: string[];
	node: AgentStatusProofTreeNode;
}

export interface AgentStatusProofTreeSnapshot {
	rootChildrenCount: number;
	taskCount: number;
	roots: AgentStatusProofTreeNode[];
	selected: {
		requiredLabels: Record<string, AgentStatusProofSelectedNode[]>;
		requiredTaskId?: AgentStatusProofSelectedNode;
	};
}

export type InstalledVsixProofPhase = "quarantine-default" | "legacy-fixture";

export interface LauncherRegistryProviderProofSnapshot {
	resolvedFilePaths: string[];
	launcherTaskCount: number;
	launcherTaskIds: string[];
}

export interface LauncherRegistryProofSnapshot {
	agentStatus: LauncherRegistryProviderProofSnapshot;
	symphony: LauncherRegistryProviderProofSnapshot;
}

export interface LauncherTaskIdHit {
	taskId: string;
	label: string;
	nodeKind: string;
	reason: string;
}

export interface SourceAuthorityMatrixRow {
	row_label: string;
	source_owner?: unknown;
	lifecycle_owner?: unknown;
	source_authority?: unknown;
	available_actions: string[];
	disabled_or_missing_reason?: string;
}

export const SPEC_BOUNDARY_FORBIDDEN_PATTERNS = [
	/\bretry\b/i,
	/\breconcile\b/i,
	/\bdispatch\b/i,
	/\bpoll\s+linear\b/i,
	/\btransition\s+issue\b/i,
	/\bclaim\b/i,
	/\bcleanup\s+workspace\b/i,
	/\bcancel\b/i,
	/\bkill\b/i,
];

export function flattenProofTree(
	nodes: AgentStatusProofTreeNode[],
): AgentStatusProofTreeNode[] {
	const flattened: AgentStatusProofTreeNode[] = [];
	const visit = (node: AgentStatusProofTreeNode): void => {
		flattened.push(node);
		for (const child of node.children ?? []) {
			visit(child);
		}
	};
	for (const node of nodes) visit(node);
	return flattened;
}

/**
 * Parse a JSON-array task-id list passed through the proof environment.
 * Tolerates an unset/empty value (no ids) but rejects malformed payloads so
 * a broken harness wiring fails loudly instead of weakening the proof.
 */
export function parseTaskIdListEnv(value: string | undefined): string[] {
	const trimmed = value?.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed) as unknown;
	if (
		!Array.isArray(parsed) ||
		parsed.some((entry) => typeof entry !== "string")
	) {
		throw new Error(
			`Task id list env must be a JSON array of strings, got: ${trimmed}`,
		);
	}
	return parsed.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function nodeMatchesTaskId(
	node: AgentStatusProofTreeNode,
	taskId: string,
): boolean {
	if (node.label.includes(taskId)) return true;
	const ownerTaskId = node.ownerFields?.["taskId"];
	return typeof ownerTaskId === "string" && ownerTaskId === taskId;
}

function launcherAttributionReason(
	node: AgentStatusProofTreeNode,
): string | undefined {
	if (node.nodeKind === "task") return "nodeKind=task";
	const fields = node.ownerFields ?? {};
	for (const key of [
		"source_owner",
		"lifecycle_owner",
		"source_authority",
	] as const) {
		if (fields[key] === "launcher") return `${key}=launcher`;
	}
	return undefined;
}

/**
 * Find tree nodes that surface one of the given task ids AS LAUNCHER DATA
 * (launcher-attributed owner fields or a launcher `task` node). Ids that
 * appear via OpenClaw/ACP-native sources are not hits — the quarantine proof
 * forbids launcher ingestion, not the task id itself.
 */
export function collectLauncherAttributedTaskIdHits(
	snapshot: AgentStatusProofTreeSnapshot,
	taskIds: readonly string[],
): LauncherTaskIdHit[] {
	if (taskIds.length === 0) return [];
	const hits: LauncherTaskIdHit[] = [];
	for (const node of flattenProofTree(snapshot.roots)) {
		const reason = launcherAttributionReason(node);
		if (!reason) continue;
		for (const taskId of taskIds) {
			if (nodeMatchesTaskId(node, taskId)) {
				hits.push({
					taskId,
					label: node.label,
					nodeKind: node.nodeKind,
					reason,
				});
			}
		}
	}
	return hits;
}

/** Whether each task id is visible anywhere in the snapshot (any source). */
export function collectTaskIdPresence(
	snapshot: AgentStatusProofTreeSnapshot,
	taskIds: readonly string[],
): Record<string, boolean> {
	const presence: Record<string, boolean> = {};
	for (const taskId of taskIds) presence[taskId] = false;
	for (const node of flattenProofTree(snapshot.roots)) {
		for (const taskId of taskIds) {
			if (!presence[taskId] && nodeMatchesTaskId(node, taskId)) {
				presence[taskId] = true;
			}
		}
	}
	return presence;
}

export function findNodesByLabel(
	nodes: AgentStatusProofTreeNode[],
	predicate: (label: string) => boolean,
): AgentStatusProofTreeNode[] {
	return flattenProofTree(nodes).filter((node) => predicate(node.label));
}

export function collectAvailableActions(
	node: AgentStatusProofTreeNode,
): string[] {
	const actions = new Set<string>();
	const visit = (current: AgentStatusProofTreeNode): void => {
		if (current.command?.command) {
			actions.add(
				[current.command.command, current.command.title]
					.filter(Boolean)
					.join(" :: "),
			);
		}
		for (const child of current.children ?? []) visit(child);
	};
	visit(node);
	return [...actions].sort();
}

export function buildSourceAuthorityMatrix(
	selectedRows: AgentStatusProofSelectedNode[],
): SourceAuthorityMatrixRow[] {
	return selectedRows.map((selected) => {
		const fields = selected.node.ownerFields ?? {};
		const actions = collectAvailableActions(selected.node);
		return {
			row_label: selected.node.label,
			source_owner: fields["source_owner"],
			lifecycle_owner: fields["lifecycle_owner"],
			source_authority: fields["source_authority"],
			available_actions: actions,
			disabled_or_missing_reason:
				actions.length === 0
					? "No read-only action is available on this row"
					: undefined,
		};
	});
}

export function findSpecBoundaryViolations(
	snapshot: AgentStatusProofTreeSnapshot,
): string[] {
	const symphonyRoots = snapshot.roots.filter((node) =>
		node.label.startsWith("Symphony"),
	);
	const rootsToInspect =
		symphonyRoots.length > 0 ? symphonyRoots : snapshot.roots;
	const violations: string[] = [];
	for (const node of flattenProofTree(rootsToInspect)) {
		const commandText = [node.command?.command, node.command?.title]
			.filter(Boolean)
			.join(" ");
		if (!commandText) continue;
		for (const pattern of SPEC_BOUNDARY_FORBIDDEN_PATTERNS) {
			if (pattern.test(commandText)) {
				violations.push(`${node.label}: ${commandText}`);
				break;
			}
		}
	}
	return violations;
}

export function hasRequiredSymphonyRoots(
	snapshot: AgentStatusProofTreeSnapshot,
): boolean {
	return Boolean(
		(snapshot.selected.requiredLabels["Symphony"]?.length ||
			snapshot.selected.requiredLabels["Operations Dashboard"]?.length) &&
			snapshot.selected.requiredLabels["Workstreams"]?.length &&
			snapshot.selected.requiredLabels["Run Attempts"]?.length,
	);
}
