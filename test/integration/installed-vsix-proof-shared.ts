export interface SerializedCommand {
	command: string;
	title: string;
	arguments?: unknown[];
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
