/**
 * Integration test API surface.
 *
 * `extension.ts` exposes a `CommandCentralIntegrationTestApi` when activated in
 * test mode (`COMMAND_CENTRAL_TEST_MODE=1`). The API is **read-only**: it
 * serializes the live Agent Status / Symphony tree provider state into plain
 * JSON shapes that the integration suites and the installed-VSIX proof
 * harness can assert against without holding references to live VS Code
 * objects.
 *
 * Everything in this module is pure serialization / projection logic — no
 * side effects, no provider mutation. State is supplied through the
 * `IntegrationTestApiDeps` accessor object so the activation file stays
 * wiring-only.
 */
import type * as vscode from "vscode";
import type {
	AgentNode,
	AgentStatusTreeProvider,
} from "../providers/agent-status-tree-provider.js";

export interface CommandCentralIntegrationSnapshot {
	subscriptionCount: number;
	hasAgentStatusProvider: boolean;
	hasSymphonyProvider: boolean;
	hasProjectViewManager: boolean;
	hasProjectIconService: boolean;
	hasExtensionFilterViewManager: boolean;
	hasGroupingStateManager: boolean;
	hasGroupingViewManager: boolean;
	hasTerminalManager: boolean;
	hasBinaryManager: boolean;
	hasTestCountStatusBar: boolean;
	/** Current rendered text of the OpenClaw infrastructure health item. */
	infrastructureHealthStatusText: string | undefined;
	activeProjectSlots: string[];
}

export interface CommandCentralAgentStatusSnapshot {
	rootChildrenCount: number;
	taskCount: number;
}

export interface CommandCentralSerializedCommand {
	command: string;
	title: string;
	arguments?: unknown[];
}

export interface CommandCentralAgentStatusTreeNode {
	label: string;
	description?: string;
	contextValue?: string;
	nodeKind: string;
	collapsibleState?: number;
	command?: CommandCentralSerializedCommand;
	ownerFields?: Record<string, unknown>;
	children?: CommandCentralAgentStatusTreeNode[];
	truncatedChildCount?: number;
}

export interface CommandCentralAgentStatusTreeSelectedNode {
	path: string[];
	node: CommandCentralAgentStatusTreeNode;
}

export interface CommandCentralAgentStatusTreeSnapshot {
	rootChildrenCount: number;
	taskCount: number;
	roots: CommandCentralAgentStatusTreeNode[];
	selected: {
		requiredLabels: Record<string, CommandCentralAgentStatusTreeSelectedNode[]>;
		requiredTaskId?: CommandCentralAgentStatusTreeSelectedNode;
	};
}

export interface CommandCentralAgentStatusTreeSnapshotOptions {
	maxDepth?: number;
	maxChildrenPerNode?: number;
	rootLabelPrefixes?: string[];
	requiredLabels?: string[];
	requiredTaskId?: string;
}

export interface CommandCentralIntegrationDeactivationSnapshot {
	before: CommandCentralIntegrationSnapshot;
	after: CommandCentralIntegrationSnapshot;
}

export interface CommandCentralIntegrationTestApi {
	kind: "command-central-test-api";
	getSnapshot(): CommandCentralIntegrationSnapshot;
	getAgentStatusSnapshot(): CommandCentralAgentStatusSnapshot;
	getAgentStatusTreeSnapshot(
		options?: CommandCentralAgentStatusTreeSnapshotOptions,
	): CommandCentralAgentStatusTreeSnapshot;
	getSymphonyTreeSnapshot(
		options?: CommandCentralAgentStatusTreeSnapshotOptions,
	): CommandCentralAgentStatusTreeSnapshot;
	deactivateForTest(): Promise<CommandCentralIntegrationDeactivationSnapshot>;
}

/**
 * Wiring contract from `extension.ts` to this module. Every getter is
 * lazy so the API always reflects the latest extension state — important
 * for `deactivateForTest`, where providers are torn down between the
 * `before` and `after` snapshot.
 */
export interface IntegrationTestApiDeps {
	getExtensionContext(): vscode.ExtensionContext | undefined;
	getAgentStatusProvider(): AgentStatusTreeProvider | undefined;
	getSymphonyProvider(): AgentStatusTreeProvider | undefined;
	hasProjectViewManager(): boolean;
	hasProjectIconService(): boolean;
	hasExtensionFilterViewManager(): boolean;
	hasGroupingStateManager(): boolean;
	hasGroupingViewManager(): boolean;
	hasTerminalManager(): boolean;
	hasBinaryManager(): boolean;
	hasTestCountStatusBar(): boolean;
	getInfrastructureHealthStatusText(): string | undefined;
	getActiveProjectSlots(): string[];
	deactivate(): Promise<void>;
	clearIntegrationTestContextSubscriptions(): void;
}

function treeItemLabelToString(label: vscode.TreeItem["label"]): string {
	if (typeof label === "string") return label;
	if (label && typeof label === "object" && "label" in label) {
		return String(label.label);
	}
	return "";
}

function treeItemDescriptionToString(
	description: vscode.TreeItem["description"],
): string | undefined {
	if (typeof description === "string") return description;
	if (description === true) return "true";
	return undefined;
}

function isVsCodeUriLike(value: object): value is vscode.Uri {
	return "scheme" in value && "fsPath" in value && "path" in value;
}

function serializeUnknown(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number"
	) {
		return value;
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "undefined") return undefined;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value);
	if (isVsCodeUriLike(value)) {
		return {
			__kind: "Uri",
			scheme: value.scheme,
			fsPath: value.fsPath,
			path: value.path,
			external: value.toString(),
		};
	}
	if (seen.has(value)) return "[Circular]";
	if (depth >= 5) return "[MaxDepth]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value
			.slice(0, 25)
			.map((item) => serializeUnknown(item, seen, depth + 1));
	}
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (typeof nested === "function") continue;
		result[key] = serializeUnknown(nested, seen, depth + 1);
		if (Object.keys(result).length >= 40) break;
	}
	return result;
}

function serializeCommandArgument(argument: unknown): unknown {
	return serializeUnknown(argument, new WeakSet<object>(), 0);
}

function serializeCommand(
	command: vscode.Command | undefined,
): CommandCentralSerializedCommand | undefined {
	if (!command) return undefined;
	return {
		command: command.command,
		title: command.title,
		arguments: command.arguments?.map((argument) =>
			serializeCommandArgument(argument),
		),
	};
}

function selectedAgentStatusOwnerFields(
	element: AgentNode,
): Record<string, unknown> | undefined {
	if (element.type === "codexRun") {
		const run = element.run;
		return {
			runId: run.runId,
			taskId: run.taskId,
			flowId: run.flowId,
			source_owner: run.source.kind,
			lifecycle_owner: run.ownerKind ?? run.source.kind,
			source_authority: run.sourceAuthority ?? run.source.kind,
			source_status: run.sourceStatus,
			orchestration_mode: run.orchestrationMode,
			available_owner_actions: run.ownerActions ?? [],
		};
	}
	if (element.type === "task") {
		const task = element.task;
		return {
			taskId: task.id,
			source_owner: task.owner_kind ?? "launcher",
			lifecycle_owner: task.owner_kind ?? "launcher",
			source_authority: task.source_authority ?? "launcher",
			source_status: task.status,
			orchestration_mode: task.orchestration_mode ?? task.agent_mode,
			available_owner_actions: task.owner_actions ?? [],
		};
	}
	if (element.type === "taskFlowGroup") {
		return {
			flowId: element.flow.flowId,
			source_owner: "taskflow",
			lifecycle_owner: "taskflow",
			source_authority: "taskflow",
			source_status: element.flow.status,
		};
	}
	if (element.type === "openclawTask") {
		return {
			taskId: element.task.taskId,
			source_owner: "openclaw",
			lifecycle_owner: element.task.ownerKey,
			source_authority: "openclaw",
			source_status: element.task.status,
		};
	}
	if (element.type === "detail") {
		return {
			taskId: element.taskId,
			field: element.label,
			value: element.value,
		};
	}
	return undefined;
}

function matchesRequiredTaskId(
	element: AgentNode,
	requiredTaskId: string,
): boolean {
	if (element.type === "codexRun") {
		return (
			element.run.runId === requiredTaskId ||
			element.run.taskId === requiredTaskId ||
			element.run.source.id === requiredTaskId ||
			element.run.title.includes(requiredTaskId)
		);
	}
	if (element.type === "task") {
		return element.task.id === requiredTaskId;
	}
	if (element.type === "openclawTask") {
		return element.task.taskId === requiredTaskId;
	}
	return false;
}

/**
 * Project a live `AgentStatusTreeProvider` into a serializable snapshot. The
 * traversal is bounded by `maxDepth` / `maxChildrenPerNode` so the result
 * stays small enough to embed in a proof manifest, while still surfacing
 * any node whose label or task id matches the caller's selection filters.
 */
export function getTreeSnapshotForProvider(
	provider: AgentStatusTreeProvider | undefined,
	options: CommandCentralAgentStatusTreeSnapshotOptions = {},
): CommandCentralAgentStatusTreeSnapshot {
	if (!provider) {
		return {
			rootChildrenCount: 0,
			taskCount: 0,
			roots: [],
			selected: { requiredLabels: {} },
		};
	}

	const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 4, 8));
	const maxChildrenPerNode = Math.max(
		1,
		Math.min(options.maxChildrenPerNode ?? 75, 250),
	);
	const requiredLabels = options.requiredLabels ?? [];
	const selectedRequiredLabels = Object.fromEntries(
		requiredLabels.map((label) => [label, []]),
	) as Record<string, CommandCentralAgentStatusTreeSelectedNode[]>;
	let selectedRequiredTaskId:
		| CommandCentralAgentStatusTreeSelectedNode
		| undefined;

	const serializeNode = (
		element: AgentNode,
		depth: number,
		pathParts: string[],
	): CommandCentralAgentStatusTreeNode => {
		const item = provider.getTreeItem(element);
		const label = treeItemLabelToString(item.label);
		const nodePath = [...pathParts, label || element.type];

		const children =
			depth < maxDepth ? provider.getChildren(element) : ([] as AgentNode[]);
		const childLimit =
			element.type === "codexRuns" || element.type === "symphonyRunGroup"
				? Math.min(maxChildrenPerNode, 5)
				: maxChildrenPerNode;
		const cappedChildren = children.slice(0, childLimit);
		if (
			options.requiredTaskId &&
			!cappedChildren.some((child) =>
				matchesRequiredTaskId(child, options.requiredTaskId as string),
			)
		) {
			const requiredChild = children.find((child) =>
				matchesRequiredTaskId(child, options.requiredTaskId as string),
			);
			if (requiredChild) cappedChildren.push(requiredChild);
		}
		const node: CommandCentralAgentStatusTreeNode = {
			label,
			description: treeItemDescriptionToString(item.description),
			contextValue:
				typeof item.contextValue === "string" ? item.contextValue : undefined,
			nodeKind: element.type,
			collapsibleState: item.collapsibleState,
			command: serializeCommand(item.command),
			ownerFields: selectedAgentStatusOwnerFields(element),
			children: cappedChildren.map((child) =>
				serializeNode(child, depth + 1, nodePath),
			),
			truncatedChildCount:
				children.length > cappedChildren.length
					? children.length - cappedChildren.length
					: undefined,
		};
		const selectedNode: CommandCentralAgentStatusTreeSelectedNode = {
			path: nodePath,
			node,
		};
		for (const requiredLabel of requiredLabels) {
			if (label.includes(requiredLabel)) {
				selectedRequiredLabels[requiredLabel]?.push(selectedNode);
			}
		}
		if (
			options.requiredTaskId &&
			!selectedRequiredTaskId &&
			matchesRequiredTaskId(element, options.requiredTaskId)
		) {
			selectedRequiredTaskId = selectedNode;
		}
		return node;
	};

	const rootLabelPrefixes = options.rootLabelPrefixes ?? [];
	const roots = provider.getChildren().filter((root) => {
		if (rootLabelPrefixes.length === 0) return true;
		const item = provider.getTreeItem(root);
		const label = treeItemLabelToString(item.label);
		return rootLabelPrefixes.some((prefix) => label.startsWith(prefix));
	});
	return {
		rootChildrenCount: provider.getChildren().length,
		taskCount: provider.getTasks().length,
		roots: roots
			.slice(0, maxChildrenPerNode)
			.map((child) => serializeNode(child, 0, [])),
		selected: {
			requiredLabels: selectedRequiredLabels,
			requiredTaskId: selectedRequiredTaskId,
		},
	};
}

export function getAgentStatusSnapshot(
	provider: AgentStatusTreeProvider | undefined,
): CommandCentralAgentStatusSnapshot {
	const rootChildren = provider?.getChildren();
	return {
		rootChildrenCount: rootChildren?.length ?? 0,
		taskCount: provider?.getTasks().length ?? 0,
	};
}

export function getIntegrationSnapshot(
	deps: IntegrationTestApiDeps,
): CommandCentralIntegrationSnapshot {
	return {
		subscriptionCount: deps.getExtensionContext()?.subscriptions.length ?? 0,
		hasAgentStatusProvider: deps.getAgentStatusProvider() !== undefined,
		hasSymphonyProvider: deps.getSymphonyProvider() !== undefined,
		hasProjectViewManager: deps.hasProjectViewManager(),
		hasProjectIconService: deps.hasProjectIconService(),
		hasExtensionFilterViewManager: deps.hasExtensionFilterViewManager(),
		hasGroupingStateManager: deps.hasGroupingStateManager(),
		hasGroupingViewManager: deps.hasGroupingViewManager(),
		hasTerminalManager: deps.hasTerminalManager(),
		hasBinaryManager: deps.hasBinaryManager(),
		hasTestCountStatusBar: deps.hasTestCountStatusBar(),
		infrastructureHealthStatusText: deps.getInfrastructureHealthStatusText(),
		activeProjectSlots: deps.getActiveProjectSlots(),
	};
}

/**
 * Build the integration test API surface exposed by `activate()` when the
 * extension is launched in test mode. The returned object is a thin facade
 * over the pure projection helpers above; all live state is resolved
 * through `deps` so the wiring file does not have to keep state inside this
 * module.
 */
export function createIntegrationTestApi(
	deps: IntegrationTestApiDeps,
): CommandCentralIntegrationTestApi {
	const snapshot = () => getIntegrationSnapshot(deps);
	return {
		kind: "command-central-test-api",
		getSnapshot: snapshot,
		getAgentStatusSnapshot: () =>
			getAgentStatusSnapshot(deps.getAgentStatusProvider()),
		getAgentStatusTreeSnapshot: (options) =>
			getTreeSnapshotForProvider(deps.getAgentStatusProvider(), options),
		getSymphonyTreeSnapshot: (options) =>
			getTreeSnapshotForProvider(deps.getSymphonyProvider(), options),
		deactivateForTest: async () => {
			const before = snapshot();
			await deps.deactivate();
			deps.clearIntegrationTestContextSubscriptions();
			const after = snapshot();
			return { before, after };
		},
	};
}
