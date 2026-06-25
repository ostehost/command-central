/**
 * Tree node data model for the Agent Status / Symphony views.
 *
 * These interfaces describe *what the tree contains* (the discriminated
 * `AgentNode` union and its members). They are intentionally separated from
 * AgentStatusTreeProvider, which owns *how* the tree is built and rendered.
 * Pure type declarations only — no runtime behavior — so they carry no
 * dependency back on provider state (AgentTask is imported type-only).
 */

import type * as vscode from "vscode";
import type { DiscoveredAgent } from "../discovery/types.js";
import type { AgentTask } from "../types/agent-task.js";
import type {
	CodexRunView,
	SymphonyRetryEntryView,
	SymphonyRunningEntryView,
	SymphonyRuntimeSnapshotView,
} from "../types/codex-run-types.js";
import type { OpenClawTask } from "../types/openclaw-task-types.js";
import type { TaskFlow } from "../types/taskflow-types.js";
import type { TimePeriod } from "../utils/time-grouping.js";

export type AgentNode =
	| SummaryNode
	| TreeElement
	| DetailNode
	| FileChangeNode
	| DiscoveredNode
	| OpenClawTaskNode
	| BackgroundTasksNode
	| SymphonyRootNode
	| SymphonyDashboardNode
	| SymphonyRunGroupNode
	| SymphonySnapshotEntryNode
	| TaskFlowGroupNode
	| TaskFlowChildNode
	| TaskFlowsContainerNode
	| TaskFlowSingleNode
	| CodexRunsContainerNode
	| CodexRunNode
	| StatusTimeGroupNode
	| OlderRunsNode
	| StateNode;

export interface SymphonyRootNode {
	type: "symphony";
	runs: CodexRunView[];
	flows: TaskFlow[];
}

export interface SymphonyDashboardNode {
	type: "symphonyDashboard";
	runs: CodexRunView[];
	flows: TaskFlow[];
}

export type SymphonyRunGroupKind = "running" | "retryQueued" | "released";

export interface SymphonyRunGroupNode {
	type: "symphonyRunGroup";
	kind: SymphonyRunGroupKind;
	runs: CodexRunView[];
	snapshot?: SymphonyRuntimeSnapshotView;
}

export interface SymphonySnapshotEntryNode {
	type: "symphonySnapshotEntry";
	kind: Extract<SymphonyRunGroupKind, "running" | "retryQueued">;
	entry: SymphonyRunningEntryView | SymphonyRetryEntryView;
	index: number;
	snapshot: SymphonyRuntimeSnapshotView;
}

export interface TaskFlowGroupNode {
	type: "taskFlowGroup";
	flow: TaskFlow;
}

export interface TaskFlowChildNode {
	type: "taskFlowChild";
	taskId: string;
	flowId: string;
	label: string;
	status: string;
}

export interface TaskFlowsContainerNode {
	type: "taskflows";
	flows: TaskFlow[];
}

export interface CodexRunsContainerNode {
	type: "codexRuns";
	runs: CodexRunView[];
}

export interface CodexRunNode {
	type: "codexRun";
	run: CodexRunView;
	/**
	 * Which projected container rendered this run. The same run can appear both
	 * under a run-group fallback (when the group has no runtime snapshot
	 * entries) and under the Run Attempts container, so the container
	 * disambiguates the TreeItem id and the getParent target. Defaults to the
	 * Run Attempts container when absent.
	 */
	container?: SymphonyRunGroupKind | "runs";
}

export interface TaskFlowSingleNode {
	type: "taskflow";
	flow: TaskFlow;
}

export interface SummaryNode {
	type: "summary";
	label: string;
	tooltip?: string;
	/**
	 * Discriminates the Sources provenance summary from the ordinary V2 count
	 * summary. In flat root mode both render as siblings, so their stable
	 * TreeItem.id must differ (a duplicate id is a hard "already registered"
	 * tree crash). Only the Sources node sets this.
	 */
	kind?: "sources";
}

export interface TaskNode {
	type: "task";
	task: AgentTask;
}

export interface OpenClawTaskNode {
	type: "openclawTask";
	task: OpenClawTask;
}

export interface BackgroundTasksNode {
	type: "backgroundTasks";
	tasks: OpenClawTask[];
}

export interface ProjectGroupNode {
	type: "projectGroup";
	projectName: string;
	projectDir?: string;
	/**
	 * The unique grouping key buildProjectNodes keyed this group by
	 * (`id:<project_ref.id>`, `dir:<dir>`, `name:<name>`, or the Unregistered
	 * bucket key). The display dir/name are not unique — registry-backed lanes
	 * with no project_dir normalize to a shared "(unknown project)" placeholder
	 * — so this is the authoritative identity for the stable TreeItem id.
	 */
	groupKey?: string;
	tasks: AgentTask[];
	discoveredAgents?: DiscoveredAgent[];
	parentGroupKey?: string;
	parentGroupName?: string;
	/**
	 * Synthetic bucket for records with no Work Registry identity and no
	 * explicit launcher project name. Rendered with warning metadata and
	 * pinned after real project groups.
	 */
	unregistered?: boolean;
}

export interface FolderGroupNode {
	type: "folderGroup";
	groupKey: string;
	groupName: string;
	projectCount: number;
	projects: ProjectGroupNode[];
}

export type AgentStatusGroup = "running" | "done" | "attention" | "limbo";

export interface StatusGroupNode {
	type: "statusGroup";
	status: AgentStatusGroup;
	nodes: SortableAgentNode[];
	parentProjectName?: string;
	parentProjectDir?: string;
	parentGroupKey?: string;
}

export type StatusTimeGroupPeriod = Extract<
	TimePeriod,
	"today" | "yesterday" | "last7days" | "last30days" | "older"
>;

export interface StatusTimeGroupNode {
	type: "statusTimeGroup";
	status: AgentStatusGroup;
	period: StatusTimeGroupPeriod;
	label: string;
	nodes: SortableAgentNode[];
	collapsibleState: vscode.TreeItemCollapsibleState;
	parentProjectName?: string;
	parentProjectDir?: string;
	parentGroupKey?: string;
}

export type TreeElement =
	| TaskNode
	| ProjectGroupNode
	| FolderGroupNode
	| StatusGroupNode
	| StatusTimeGroupNode;

export interface DetailNode {
	type: "detail";
	label: string;
	value: string;
	taskId: string;
	description?: string;
	icon?: string;
	iconColor?: string;
	command?: vscode.Command;
}

export interface PerFileDiff {
	filePath: string;
	additions: number;
	deletions: number;
	status?: FileChangeStatus;
}

export type FileChangeStatus = "A" | "M" | "D";

/**
 * Explicit diff-routing intent carried on diff command payloads.
 * "workingTree" diffs startCommit (or HEAD) against the on-disk working
 * tree; "boundedCommit" diffs startCommit against endCommit and refuses
 * to open without an end ref.
 */
export type AgentDiffMode = "workingTree" | "boundedCommit";

export interface FileChangeNode {
	type: "fileChange";
	taskId: string;
	projectDir: string;
	projectName: string;
	filePath: string;
	additions: number;
	deletions: number;
	status: FileChangeStatus;
	diffMode: AgentDiffMode;
	startCommit?: string;
	endCommit?: string;
}

export interface DiscoveredNode {
	type: "discovered";
	agent: DiscoveredAgent;
}

export interface OlderRunsNode {
	type: "olderRuns";
	label: string;
	hiddenNodes: SortableAgentNode[];
	parentProjectName?: string;
	parentProjectDir?: string;
	parentGroupKey?: string;
	/**
	 * The status group this bucket lives under, when emitted beneath a
	 * `statusGroup` (project mode with >5 lanes). Part of the node's stable
	 * identity so two sibling buckets under the same project never collide.
	 * Undefined at the flat-root and background-tasks lanes.
	 */
	parentStatus?: AgentStatusGroup;
}

export interface StateNode {
	type: "state";
	label: string;
	description?: string;
	icon?: string;
}

export type SortableAgentNode =
	| { type: "task"; task: AgentTask }
	| { type: "discovered"; agent: DiscoveredAgent }
	| { type: "openclawTask"; task: OpenClawTask };
