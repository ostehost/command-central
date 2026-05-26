import type { AgentTask } from "../providers/agent-status-tree-provider.js";
import type {
	CodexRunEvidence,
	CodexRunPhase,
	CodexRunRole,
	CodexRunSourceRef,
	CodexRunStatus,
	CodexRunView,
	CodexRunViewField,
	SymphonyRetryEntryView,
	SymphonyRunningEntryView,
	SymphonyRuntimeSnapshotSource,
	SymphonyRuntimeSnapshotStatus,
	SymphonyRuntimeSnapshotView,
} from "../types/codex-run-types.js";
import type { OpenClawTask } from "../types/openclaw-task-types.js";
import type { TaskFlow, TaskFlowTask } from "../types/taskflow-types.js";

export interface CodexRunObserverInputs {
	agentTasks: AgentTask[];
	openClawTasks: OpenClawTask[];
	taskFlows: TaskFlow[];
}

type ArtifactCarrier = {
	artifactPaths?: unknown;
	artifact_paths?: unknown;
	stream_file?: unknown;
	prompt_file?: unknown;
	handoff_file?: unknown;
	pending_review_path?: unknown;
	pending_fixup_path?: unknown;
	start_sha?: unknown;
	start_commit?: unknown;
	end_commit?: unknown;
	branch?: unknown;
};

type ModeCarrier = {
	agent_backend?: unknown;
	runtime?: unknown;
	source_authority?: unknown;
	owner_kind?: unknown;
	team?: unknown;
	team_template?: unknown;
	agent_mode?: unknown;
	orchestration_mode?: unknown;
	provenance?: unknown;
};

type RuntimeSnapshotFields = Pick<
	CodexRunView,
	| "turnCount"
	| "inputTokens"
	| "outputTokens"
	| "totalTokens"
	| "runtimeSeconds"
	| "retryAttempt"
	| "retryDueAt"
	| "retryError"
	| "rateLimitSummary"
>;

type SymphonyRuntimeSnapshotField = Pick<
	CodexRunView,
	"symphonyRuntimeSnapshot"
>;

type SymphonyContractFields = Pick<
	CodexRunView,
	| "trackerKind"
	| "issueId"
	| "issueIdentifier"
	| "issueState"
	| "issueUrl"
	| "workflowRunId"
	| "workflowPath"
	| "workflowName"
>;

const ACTIVE_STATUS_ORDER: Record<CodexRunStatus, number> = {
	running: 0,
	queued: 1,
	waiting: 2,
	blocked: 3,
	unknown: 4,
	failed: 5,
	timed_out: 6,
	lost: 7,
	cancelled: 8,
	stopped: 9,
	succeeded: 10,
};

const CODEX_PHASES = new Set<CodexRunPhase>([
	"PreparingWorkspace",
	"BuildingPrompt",
	"LaunchingAgent",
	"LaunchingAgentProcess",
	"InitializingSession",
	"StreamingTurn",
	"Finishing",
	"Succeeded",
	"Failed",
	"TimedOut",
	"Stalled",
	"CanceledByReconciliation",
]);

const CODEX_RUN_ROLES = new Set<CodexRunRole>([
	"developer",
	"planner",
	"reviewer",
	"test",
]);

export class CodexRunObserverService {
	project(inputs: CodexRunObserverInputs): CodexRunView[] {
		const runs: CodexRunView[] = [];

		for (const task of inputs.openClawTasks) {
			runs.push(this.projectOpenClawTask(task));
		}

		for (const flow of inputs.taskFlows) {
			if (flow.tasks && flow.tasks.length > 0) {
				this.joinTaskFlow(flow, runs);
			} else {
				runs.push(this.projectTaskFlow(flow));
			}
		}

		for (const task of inputs.agentTasks) {
			const existing = this.findLauncherMatch(task, runs);
			if (existing) {
				this.joinLauncherTask(existing, task);
			} else if (
				this.isCodexLauncherTask(task) ||
				this.isSourceOwnedLauncherRun(task)
			) {
				runs.push(this.projectLauncherTask(task));
			}
		}

		return runs.sort((left, right) => this.compareRuns(left, right));
	}

	private projectOpenClawTask(task: OpenClawTask): CodexRunView {
		const ref = this.openClawTaskRef(task);
		const runId = this.firstNonEmpty(
			task.runId,
			task.taskId,
			`openclaw:${task.taskId}`,
		);
		const title = this.firstNonEmpty(task.label, task.task, task.taskId);
		const sourceStatus = task.status;
		const lastEvent = this.firstNonEmpty(
			task.progressSummary,
			task.terminalSummary,
			task.terminalOutcome,
			task.error,
		);
		const artifacts = this.collectArtifactPaths(task as ArtifactCarrier);
		const contract = this.extractSymphonyContract(
			task as unknown as Record<string, unknown>,
		);
		const runtimeSnapshot = this.extractRuntimeSnapshot(
			task as unknown as Record<string, unknown>,
		);
		const symphonyRuntimeSnapshot = this.extractSymphonyRuntimeSnapshot(
			task as unknown as Record<string, unknown>,
			ref,
		);
		const run: CodexRunView = {
			runId,
			title,
			source: ref,
			mergedFrom: [ref],
			sourceStatus,
			status: this.normalizeStatus(sourceStatus),
			phase: this.phaseFromSourceStatus(sourceStatus),
			runtime: task.runtime,
			taskId: task.taskId,
			flowId: task.flowId,
			...contract,
			sessionKey: this.firstNonEmpty(task.sessionKey, task.childSessionKey),
			execMode: task.execMode,
			execNodeId: task.execNodeId,
			execNodeName: task.execNodeName,
			nodeConnected: task.nodeConnected,
			sourceAuthority: task.sourceAuthority ?? "openclaw",
			ownerKind: task.ownerKind,
			callbackPresent: task.callbackPresent,
			reviewState: task.reviewState,
			fixupState: task.fixupState,
			workspacePath: task.workspacePath,
			host: task.host,
			model: task.model,
			lastEvent,
			...runtimeSnapshot,
			...symphonyRuntimeSnapshot,
			lastEventAt: task.lastEventAt,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
			artifactPaths: artifacts.length > 0 ? artifacts : undefined,
			provenance: [this.formatSourceRef(ref)],
			fieldSources: {},
		};

		this.addFieldSource(run, "runId", ref);
		this.addFieldSource(run, "title", ref);
		this.addFieldSource(run, "sourceStatus", ref);
		this.addFieldSource(run, "status", ref);
		this.addFieldSource(run, "taskId", ref);
		this.addFieldSource(run, "sourceAuthority", ref);
		if (run.flowId) this.addFieldSource(run, "flowId", ref);
		this.addSymphonyContractSources(run, contract, ref);
		if (run.sessionKey) this.addFieldSource(run, "sessionKey", ref);
		if (run.execMode) this.addFieldSource(run, "execMode", ref);
		if (run.execNodeId) this.addFieldSource(run, "execNodeId", ref);
		if (run.execNodeName) this.addFieldSource(run, "execNodeName", ref);
		if (run.nodeConnected != null)
			this.addFieldSource(run, "nodeConnected", ref);
		if (run.ownerKind) this.addFieldSource(run, "ownerKind", ref);
		if (run.callbackPresent != null)
			this.addFieldSource(run, "callbackPresent", ref);
		if (run.reviewState) this.addFieldSource(run, "reviewState", ref);
		if (run.fixupState) this.addFieldSource(run, "fixupState", ref);
		if (run.workspacePath) this.addFieldSource(run, "workspacePath", ref);
		if (run.host) this.addFieldSource(run, "host", ref);
		if (run.model) this.addFieldSource(run, "model", ref);
		this.addRuntimeSnapshotSources(run, runtimeSnapshot, ref);
		this.addSymphonyRuntimeSnapshotSource(run, symphonyRuntimeSnapshot, ref);
		if (run.lastEventAt != null) this.addFieldSource(run, "lastEventAt", ref);
		if (run.nextAction) this.addFieldSource(run, "nextAction", ref);
		if (run.startedAt != null) this.addFieldSource(run, "startedAt", ref);
		if (run.endedAt != null) this.addFieldSource(run, "endedAt", ref);
		if (artifacts.length > 0) this.addFieldSource(run, "artifactPaths", ref);
		return run;
	}

	private projectTaskFlow(flow: TaskFlow): CodexRunView {
		const ref = this.taskFlowRef(flow);
		const sourceStatus = flow.status;
		const run: CodexRunView = {
			runId: `taskflow:${flow.flowId}`,
			title: this.firstNonEmpty(flow.label, flow.flowId),
			source: ref,
			mergedFrom: [ref],
			sourceStatus,
			status: this.normalizeStatus(sourceStatus),
			runtime: "taskflow",
			flowId: flow.flowId,
			sourceAuthority: "taskflow",
			orchestrationMode: "workstream",
			lastEvent: flow.error,
			lastEventAt: flow.endedAt ?? flow.startedAt ?? flow.createdAt,
			startedAt: flow.startedAt,
			endedAt: flow.endedAt,
			provenance: [this.formatSourceRef(ref)],
			fieldSources: {},
		};
		const symphonyRuntimeSnapshot = this.extractSymphonyRuntimeSnapshot(
			flow as unknown as Record<string, unknown>,
			ref,
		);
		if (symphonyRuntimeSnapshot.symphonyRuntimeSnapshot) {
			run.symphonyRuntimeSnapshot =
				symphonyRuntimeSnapshot.symphonyRuntimeSnapshot;
		}

		this.addFieldSource(run, "runId", ref);
		this.addFieldSource(run, "title", ref);
		this.addFieldSource(run, "sourceStatus", ref);
		this.addFieldSource(run, "status", ref);
		this.addFieldSource(run, "flowId", ref);
		this.addFieldSource(run, "sourceAuthority", ref);
		this.addFieldSource(run, "orchestrationMode", ref);
		this.addSymphonyRuntimeSnapshotSource(run, symphonyRuntimeSnapshot, ref);
		this.addFieldSource(run, "lastEventAt", ref);
		if (run.startedAt != null) this.addFieldSource(run, "startedAt", ref);
		if (run.endedAt != null) this.addFieldSource(run, "endedAt", ref);
		return run;
	}

	private projectTaskFlowChild(
		flow: TaskFlow,
		task: TaskFlowTask,
	): CodexRunView {
		const run = this.projectOpenClawTask(task);
		const flowRef = this.taskFlowRef(flow);
		this.addMergedFrom(run, flowRef);
		if (!run.flowId) {
			run.flowId = flow.flowId;
			this.addFieldSource(run, "flowId", flowRef);
		}
		return run;
	}

	private projectLauncherTask(task: AgentTask): CodexRunView {
		const ref = this.launcherRef(task);
		const sourceStatus = task.status;
		const startedAt = this.parseTimestamp(task.started_at);
		const completedAt = this.parseTimestamp(task.completed_at);
		const updatedAt = this.parseTimestamp(task.updated_at);
		const model = this.firstNonEmpty(task.actual_model, task.model);
		const artifacts = this.collectArtifactPaths(task);
		const evidence = this.collectEvidence(task, ref);
		const orchestrationMode = this.resolveOrchestrationMode(task);
		const contract = this.extractSymphonyContract(
			task as unknown as Record<string, unknown>,
		);
		const runtimeSnapshot = this.extractRuntimeSnapshot(
			task as unknown as Record<string, unknown>,
		);
		const symphonyRuntimeSnapshot = this.extractSymphonyRuntimeSnapshot(
			task as unknown as Record<string, unknown>,
			ref,
		);
		const run: CodexRunView = {
			runId: this.firstNonEmpty(
				task.id,
				task.session_id,
				`launcher:${task.id}`,
			),
			title: this.firstNonEmpty(
				task.prompt_summary,
				task.id,
				task.project_name,
			),
			source: ref,
			mergedFrom: [ref],
			sourceStatus,
			status: this.normalizeStatus(sourceStatus),
			runtime: this.firstNonEmpty(
				task.agent_backend,
				task.cli_name,
				task.terminal_backend,
			),
			taskId: this.firstNonEmpty(task.task_id, task.id),
			flowId: task.flow_id ?? undefined,
			...contract,
			sessionKey: task.session_id,
			execMode: task.exec_mode ?? undefined,
			execNodeId: task.exec_node ?? undefined,
			execNodeName: this.firstNonEmpty(task.exec_node, task.exec_host),
			sourceAuthority: task.source_authority ?? "launcher",
			ownerKind: task.owner_kind ?? "launcher",
			role: this.normalizeRole(task.role),
			orchestrationMode,
			callbackPresent: Boolean(task.callback_url),
			reviewState: task.review_state ?? undefined,
			fixupState: task.fixup_state ?? undefined,
			workspacePath: this.firstNonEmpty(task.exec_cwd, task.project_dir),
			host: task.exec_host ?? undefined,
			model,
			lastEvent: task.error_message ?? undefined,
			...runtimeSnapshot,
			...symphonyRuntimeSnapshot,
			nextAction: this.resolveNextAction(
				this.normalizeStatus(sourceStatus),
				sourceStatus,
				task.owner_kind ?? "launcher",
				task.review_state ?? undefined,
				task.fixup_state ?? undefined,
				orchestrationMode,
			),
			lastEventAt: updatedAt ?? completedAt ?? startedAt,
			startedAt,
			endedAt: completedAt,
			artifactPaths: artifacts.length > 0 ? artifacts : undefined,
			evidence: evidence.length > 0 ? evidence : undefined,
			ownerActions: this.normalizeOwnerActions(task.owner_actions),
			provenance: [this.formatSourceRef(ref)],
			fieldSources: {},
		};

		this.addFieldSource(run, "runId", ref);
		this.addFieldSource(run, "title", ref);
		this.addFieldSource(run, "sourceStatus", ref);
		this.addFieldSource(run, "status", ref);
		if (run.taskId) this.addFieldSource(run, "taskId", ref);
		if (run.flowId) this.addFieldSource(run, "flowId", ref);
		this.addSymphonyContractSources(run, contract, ref);
		this.addFieldSource(run, "sourceAuthority", ref);
		this.addFieldSource(run, "ownerKind", ref);
		if (run.role) this.addFieldSource(run, "role", ref);
		if (run.orchestrationMode)
			this.addFieldSource(run, "orchestrationMode", ref);
		this.addFieldSource(run, "callbackPresent", ref);
		if (run.sessionKey) this.addFieldSource(run, "sessionKey", ref);
		if (run.execMode) this.addFieldSource(run, "execMode", ref);
		if (run.execNodeId) this.addFieldSource(run, "execNodeId", ref);
		if (run.execNodeName) this.addFieldSource(run, "execNodeName", ref);
		if (run.workspacePath) this.addFieldSource(run, "workspacePath", ref);
		if (run.host) this.addFieldSource(run, "host", ref);
		if (run.reviewState) this.addFieldSource(run, "reviewState", ref);
		if (run.fixupState) this.addFieldSource(run, "fixupState", ref);
		if (run.model) this.addFieldSource(run, "model", ref);
		this.addRuntimeSnapshotSources(run, runtimeSnapshot, ref);
		this.addSymphonyRuntimeSnapshotSource(run, symphonyRuntimeSnapshot, ref);
		if (run.lastEventAt != null) this.addFieldSource(run, "lastEventAt", ref);
		if (run.nextAction) this.addFieldSource(run, "nextAction", ref);
		if (run.startedAt != null) this.addFieldSource(run, "startedAt", ref);
		if (run.endedAt != null) this.addFieldSource(run, "endedAt", ref);
		if (artifacts.length > 0) this.addFieldSource(run, "artifactPaths", ref);
		if (evidence.length > 0) this.addFieldSource(run, "evidence", ref);
		if (run.ownerActions) this.addFieldSource(run, "ownerActions", ref);
		return run;
	}

	private joinTaskFlow(flow: TaskFlow, runs: CodexRunView[]): void {
		for (const task of flow.tasks ?? []) {
			const existing = this.findTaskMatch(task, runs);
			if (existing) {
				const flowRef = this.taskFlowRef(flow);
				this.addMergedFrom(existing, flowRef);
				if (!existing.flowId) {
					existing.flowId = flow.flowId;
					this.addFieldSource(existing, "flowId", flowRef);
				}
				const symphonyRuntimeSnapshot = this.extractSymphonyRuntimeSnapshot(
					flow as unknown as Record<string, unknown>,
					flowRef,
				);
				this.mergeSymphonyRuntimeSnapshot(
					existing,
					symphonyRuntimeSnapshot,
					flowRef,
				);
				this.fillTimingFromFlow(existing, flow, flowRef);
			} else {
				runs.push(this.projectTaskFlowChild(flow, task));
			}
		}
	}

	private joinLauncherTask(run: CodexRunView, task: AgentTask): void {
		const ref = this.launcherRef(task);
		this.addMergedFrom(run, ref);

		if (this.shouldUseLauncherTitle(run, task)) {
			const title = this.firstNonEmpty(task.prompt_summary, task.id);
			if (title) {
				run.title = title;
				this.addFieldSource(run, "title", ref);
			}
		}

		const model = this.firstNonEmpty(task.actual_model, task.model);
		if (!run.model && model) {
			run.model = model;
			this.addFieldSource(run, "model", ref);
		}

		if (!run.sessionKey && task.session_id) {
			run.sessionKey = task.session_id;
			this.addFieldSource(run, "sessionKey", ref);
		}

		if (!run.flowId && task.flow_id) {
			run.flowId = task.flow_id;
			this.addFieldSource(run, "flowId", ref);
		}

		const contract = this.extractSymphonyContract(
			task as unknown as Record<string, unknown>,
		);
		this.mergeSymphonyContract(run, contract, ref);

		if (!run.execMode && task.exec_mode) {
			run.execMode = task.exec_mode;
			this.addFieldSource(run, "execMode", ref);
		}

		if (!run.execNodeId && task.exec_node) {
			run.execNodeId = task.exec_node;
			this.addFieldSource(run, "execNodeId", ref);
		}

		const taskNodeName = this.firstNonEmpty(task.exec_node, task.exec_host);
		if (!run.execNodeName && taskNodeName) {
			run.execNodeName = taskNodeName;
			this.addFieldSource(run, "execNodeName", ref);
		}

		if (!run.ownerKind && task.owner_kind) {
			run.ownerKind = task.owner_kind;
			this.addFieldSource(run, "ownerKind", ref);
		}

		if (!run.orchestrationMode) {
			const orchestrationMode = this.resolveOrchestrationMode(task);
			if (orchestrationMode) {
				run.orchestrationMode = orchestrationMode;
				this.addFieldSource(run, "orchestrationMode", ref);
			}
		}

		const role = this.normalizeRole(task.role);
		if (!run.role && role) {
			run.role = role;
			this.addFieldSource(run, "role", ref);
		}

		if (run.callbackPresent == null && task.callback_url != null) {
			run.callbackPresent = Boolean(task.callback_url);
			this.addFieldSource(run, "callbackPresent", ref);
		}

		if (!run.reviewState && task.review_state) {
			run.reviewState = task.review_state;
			this.addFieldSource(run, "reviewState", ref);
		}

		if (!run.fixupState && task.fixup_state) {
			run.fixupState = task.fixup_state;
			this.addFieldSource(run, "fixupState", ref);
		}

		const runtimeSnapshot = this.extractRuntimeSnapshot(
			task as unknown as Record<string, unknown>,
		);
		this.mergeRuntimeSnapshot(run, runtimeSnapshot, ref);
		const symphonyRuntimeSnapshot = this.extractSymphonyRuntimeSnapshot(
			task as unknown as Record<string, unknown>,
			ref,
		);
		this.mergeSymphonyRuntimeSnapshot(run, symphonyRuntimeSnapshot, ref);

		const nextAction = this.resolveNextAction(
			run.status,
			task.status,
			run.ownerKind,
			run.reviewState,
			run.fixupState,
			run.orchestrationMode,
		);
		if (nextAction && run.nextAction !== nextAction) {
			run.nextAction = nextAction;
			this.addFieldSource(run, "nextAction", ref);
		}

		if (!run.workspacePath && task.project_dir) {
			run.workspacePath = task.project_dir;
			this.addFieldSource(run, "workspacePath", ref);
		}

		if (!run.host && task.exec_host) {
			run.host = task.exec_host;
			this.addFieldSource(run, "host", ref);
		}

		const startedAt = this.parseTimestamp(task.started_at);
		const completedAt = this.parseTimestamp(task.completed_at);
		const updatedAt = this.parseTimestamp(task.updated_at);
		if (run.startedAt == null && startedAt != null) {
			run.startedAt = startedAt;
			this.addFieldSource(run, "startedAt", ref);
		}
		if (run.endedAt == null && completedAt != null) {
			run.endedAt = completedAt;
			this.addFieldSource(run, "endedAt", ref);
		}
		const launcherActivity = updatedAt ?? completedAt ?? startedAt;
		if (
			launcherActivity != null &&
			(run.lastEventAt == null || launcherActivity > run.lastEventAt)
		) {
			run.lastEventAt = launcherActivity;
			this.addFieldSource(run, "lastEventAt", ref);
		}

		const artifacts = this.collectArtifactPaths(task);
		if (artifacts.length > 0) {
			run.artifactPaths = this.uniqueStrings([
				...(run.artifactPaths ?? []),
				...artifacts,
			]);
			this.addFieldSource(run, "artifactPaths", ref);
		}

		const evidence = this.collectEvidence(task, ref);
		if (evidence.length > 0) {
			run.evidence = this.uniqueEvidence([
				...(run.evidence ?? []),
				...evidence,
			]);
			this.addFieldSource(run, "evidence", ref);
		}

		const launcherOwnerActions = this.normalizeOwnerActions(task.owner_actions);
		if (launcherOwnerActions && !run.ownerActions) {
			run.ownerActions = launcherOwnerActions;
			this.addFieldSource(run, "ownerActions", ref);
		}
	}

	private fillTimingFromFlow(
		run: CodexRunView,
		flow: TaskFlow,
		ref: CodexRunSourceRef,
	): void {
		const flowActivity = flow.endedAt ?? flow.startedAt ?? flow.createdAt;
		if (run.lastEventAt == null && flowActivity != null) {
			run.lastEventAt = flowActivity;
			this.addFieldSource(run, "lastEventAt", ref);
		}
		if (run.startedAt == null && flow.startedAt != null) {
			run.startedAt = flow.startedAt;
			this.addFieldSource(run, "startedAt", ref);
		}
		if (run.endedAt == null && flow.endedAt != null) {
			run.endedAt = flow.endedAt;
			this.addFieldSource(run, "endedAt", ref);
		}
	}

	private findTaskMatch(
		task: Pick<OpenClawTask, "taskId" | "runId" | "childSessionKey" | "label">,
		runs: CodexRunView[],
	): CodexRunView | undefined {
		return runs.find(
			(run) =>
				run.taskId === task.taskId ||
				(task.runId != null && run.runId === task.runId) ||
				this.sessionsMatch(run.sessionKey, task.childSessionKey),
		);
	}

	private findLauncherMatch(
		task: AgentTask,
		runs: CodexRunView[],
	): CodexRunView | undefined {
		return runs.find((run) => {
			if (run.source.kind === "launcher") {
				return false;
			}

			if (run.taskId === task.id || run.runId === task.id) {
				return true;
			}

			return this.sessionsMatch(run.sessionKey, task.session_id);
		});
	}

	private compareRuns(left: CodexRunView, right: CodexRunView): number {
		const statusDiff =
			ACTIVE_STATUS_ORDER[left.status] - ACTIVE_STATUS_ORDER[right.status];
		if (statusDiff !== 0) return statusDiff;

		const leftActivity =
			left.lastEventAt ?? left.endedAt ?? left.startedAt ?? 0;
		const rightActivity =
			right.lastEventAt ?? right.endedAt ?? right.startedAt ?? 0;
		if (leftActivity !== rightActivity) return rightActivity - leftActivity;

		return left.runId.localeCompare(right.runId);
	}

	private normalizeStatus(status: string | undefined): CodexRunStatus {
		switch (status) {
			case "queued":
			case "running":
			case "waiting":
			case "blocked":
			case "succeeded":
			case "failed":
			case "timed_out":
			case "cancelled":
			case "lost":
			case "stopped":
				return status;
			case "PreparingWorkspace":
			case "BuildingPrompt":
			case "LaunchingAgent":
			case "LaunchingAgentProcess":
			case "InitializingSession":
			case "StreamingTurn":
			case "Finishing":
				return "running";
			case "Succeeded":
				return "succeeded";
			case "Failed":
				return "failed";
			case "TimedOut":
				return "timed_out";
			case "CanceledByReconciliation":
				return "cancelled";
			case "Stalled":
				return "blocked";
			case "completed":
			case "completed_dirty":
			case "completed_stale":
				return "succeeded";
			case "killed":
				return "stopped";
			case "contract_failure":
				return "failed";
			default:
				return "unknown";
		}
	}

	private phaseFromSourceStatus(
		status: string | undefined,
	): CodexRunPhase | undefined {
		if (!status) return undefined;
		return CODEX_PHASES.has(status as CodexRunPhase)
			? (status as CodexRunPhase)
			: undefined;
	}

	private normalizeRole(
		role: string | null | undefined,
	): CodexRunRole | undefined {
		if (!role) return undefined;
		return CODEX_RUN_ROLES.has(role as CodexRunRole)
			? (role as CodexRunRole)
			: undefined;
	}

	private shouldUseLauncherTitle(run: CodexRunView, task: AgentTask): boolean {
		if (!task.prompt_summary?.trim()) return false;
		return (
			run.title === run.runId ||
			run.title === run.taskId ||
			run.title.startsWith("openclaw:")
		);
	}

	private isCodexLauncherTask(task: AgentTask): boolean {
		return [task.agent_backend, task.cli_name].some((value) =>
			value?.toLowerCase().includes("codex"),
		);
	}

	/**
	 * Source-owned launcher rows are explicit workflow/run records, not generic
	 * process-discovery rows. They are safe to project as standalone Symphony run attempts
	 * because lifecycle authority still stays with the launcher/source owner.
	 */
	private isSourceOwnedLauncherRun(task: AgentTask): boolean {
		const meta = task as AgentTask & {
			sourceAuthority?: string | null;
			ownerKind?: string | null;
			ownerActions?: unknown;
			workflowRun?: unknown;
		};

		const sourceAuthority = this.firstNonEmpty(
			meta.source_authority,
			meta.sourceAuthority,
		).toLowerCase();
		if (sourceAuthority === "launcher") return true;

		if (this.firstNonEmpty(meta.owner_kind, meta.ownerKind)) return true;
		if (this.isNonEmptyArray(meta.owner_actions)) return true;
		if (this.isNonEmptyArray(meta.ownerActions)) return true;
		if (meta.workflow_run != null || meta.workflowRun != null) return true;

		if (meta.provenance && typeof meta.provenance === "object") {
			const provenance = meta.provenance as {
				source_ref?: unknown;
				sourceRef?: unknown;
			};
			return provenance.source_ref != null || provenance.sourceRef != null;
		}

		return false;
	}

	private isNonEmptyArray(value: unknown): boolean {
		return Array.isArray(value) && value.length > 0;
	}

	private openClawTaskRef(
		task: Pick<OpenClawTask, "taskId">,
	): CodexRunSourceRef {
		return { kind: "openclaw-task", id: task.taskId };
	}

	private taskFlowRef(flow: Pick<TaskFlow, "flowId">): CodexRunSourceRef {
		return { kind: "taskflow", id: flow.flowId };
	}

	private launcherRef(task: AgentTask): CodexRunSourceRef {
		return {
			kind: "launcher",
			id: task.id,
			path: task.project_dir || undefined,
		};
	}

	private addMergedFrom(run: CodexRunView, ref: CodexRunSourceRef): void {
		if (!run.mergedFrom.some((candidate) => this.refsEqual(candidate, ref))) {
			run.mergedFrom.push(ref);
			run.provenance = this.uniqueStrings([
				...(run.provenance ?? []),
				this.formatSourceRef(ref),
			]);
		}
	}

	private addFieldSource(
		run: CodexRunView,
		field: CodexRunViewField,
		ref: CodexRunSourceRef,
	): void {
		const refs = run.fieldSources[field] ?? [];
		if (!refs.some((candidate) => this.refsEqual(candidate, ref))) {
			run.fieldSources[field] = [...refs, ref];
		}
	}

	private refsEqual(
		left: CodexRunSourceRef,
		right: CodexRunSourceRef,
	): boolean {
		return (
			left.kind === right.kind &&
			left.id === right.id &&
			left.path === right.path
		);
	}

	private formatSourceRef(ref: CodexRunSourceRef): string {
		return [ref.kind, ref.id, ref.path].filter(Boolean).join(":");
	}

	private sessionsMatch(
		left: string | undefined,
		right: string | null | undefined,
	): boolean {
		if (!left || !right) return false;
		const leftCandidates = this.sessionCandidates(left);
		const rightCandidates = this.sessionCandidates(right);
		return leftCandidates.some((leftCandidate) =>
			rightCandidates.includes(leftCandidate),
		);
	}

	private sessionCandidates(value: string): string[] {
		const trimmed = value.trim();
		if (!trimmed) return [];
		const withoutPrefix = trimmed.replace(/^session:/, "");
		return this.uniqueStrings([trimmed, withoutPrefix]);
	}

	private extractSymphonyContract(
		source: Record<string, unknown>,
	): SymphonyContractFields {
		const workflowRun = this.objectValue(
			source["workflow_run"] ?? source["workflowRun"],
		);
		const provenance = this.objectValue(source["provenance"]);
		const issue = this.objectValue(
			source["issue"] ?? workflowRun?.["issue"] ?? provenance?.["issue"],
		);
		const tracker = this.objectValue(
			source["tracker"] ?? workflowRun?.["tracker"] ?? provenance?.["tracker"],
		);
		const workflow = this.objectValue(
			source["workflow"] ??
				workflowRun?.["workflow"] ??
				provenance?.["workflow"],
		);

		return {
			trackerKind: this.firstNonEmpty(
				this.stringValue(source["tracker_kind"]),
				this.stringValue(source["trackerKind"]),
				this.stringValue(tracker?.["kind"]),
				this.stringValue(provenance?.["tracker_kind"]),
				this.stringValue(provenance?.["trackerKind"]),
			),
			issueId: this.firstNonEmpty(
				this.stringValue(source["issue_id"]),
				this.stringValue(source["issueId"]),
				this.stringValue(issue?.["id"]),
				this.stringValue(workflowRun?.["issue_id"]),
			),
			issueIdentifier: this.firstNonEmpty(
				this.stringValue(source["issue_identifier"]),
				this.stringValue(source["issueIdentifier"]),
				this.stringValue(issue?.["identifier"]),
				this.stringValue(issue?.["key"]),
				this.stringValue(workflowRun?.["issue_identifier"]),
			),
			issueState: this.firstNonEmpty(
				this.stringValue(source["issue_state"]),
				this.stringValue(source["issueState"]),
				this.stringValue(issue?.["state"]),
				this.stringValue(workflowRun?.["issue_state"]),
			),
			issueUrl: this.firstNonEmpty(
				this.stringValue(source["issue_url"]),
				this.stringValue(source["issueUrl"]),
				this.stringValue(issue?.["url"]),
				this.stringValue(workflowRun?.["issue_url"]),
			),
			workflowRunId: this.firstNonEmpty(
				this.stringValue(source["workflow_run_id"]),
				this.stringValue(source["workflowRunId"]),
				this.stringValue(workflowRun?.["id"]),
			),
			workflowPath: this.firstNonEmpty(
				this.stringValue(source["workflow_path"]),
				this.stringValue(source["workflow_file"]),
				this.stringValue(source["workflowPath"]),
				this.stringValue(workflow?.["path"]),
				this.stringValue(workflow?.["file"]),
				this.stringValue(workflowRun?.["workflow_path"]),
			),
			workflowName: this.firstNonEmpty(
				this.stringValue(source["workflow_name"]),
				this.stringValue(source["workflowName"]),
				this.stringValue(workflow?.["name"]),
				this.stringValue(workflowRun?.["workflow_name"]),
			),
		};
	}

	private mergeSymphonyContract(
		run: CodexRunView,
		contract: SymphonyContractFields,
		ref: CodexRunSourceRef,
	): void {
		for (const field of [
			"trackerKind",
			"issueId",
			"issueIdentifier",
			"issueState",
			"issueUrl",
			"workflowRunId",
			"workflowPath",
			"workflowName",
		] as const) {
			if (run[field] || !contract[field]) continue;
			run[field] = contract[field];
			this.addFieldSource(run, field, ref);
		}
	}

	private addSymphonyContractSources(
		run: CodexRunView,
		contract: SymphonyContractFields,
		ref: CodexRunSourceRef,
	): void {
		for (const field of [
			"trackerKind",
			"issueId",
			"issueIdentifier",
			"issueState",
			"issueUrl",
			"workflowRunId",
			"workflowPath",
			"workflowName",
		] as const) {
			if (!contract[field]) continue;
			this.addFieldSource(run, field, ref);
		}
	}

	private extractRuntimeSnapshot(
		source: Record<string, unknown>,
	): RuntimeSnapshotFields {
		const tokens = this.objectValue(source["tokens"]);
		const retry = this.objectValue(source["retry"]);
		const rateLimits =
			source["rate_limits"] ??
			source["rateLimits"] ??
			source["codex_rate_limits"] ??
			source["codexRateLimits"];

		return {
			turnCount: this.numberValue(source["turn_count"] ?? source["turnCount"]),
			inputTokens: this.numberValue(
				source["codex_input_tokens"] ??
					source["codexInputTokens"] ??
					source["input_tokens"] ??
					source["inputTokens"] ??
					tokens?.["input_tokens"] ??
					tokens?.["inputTokens"],
			),
			outputTokens: this.numberValue(
				source["codex_output_tokens"] ??
					source["codexOutputTokens"] ??
					source["output_tokens"] ??
					source["outputTokens"] ??
					tokens?.["output_tokens"] ??
					tokens?.["outputTokens"],
			),
			totalTokens: this.numberValue(
				source["codex_total_tokens"] ??
					source["codexTotalTokens"] ??
					source["total_tokens"] ??
					source["totalTokens"] ??
					tokens?.["total_tokens"] ??
					tokens?.["totalTokens"],
			),
			runtimeSeconds: this.numberValue(
				source["runtime_seconds"] ??
					source["runtimeSeconds"] ??
					source["seconds_running"] ??
					source["secondsRunning"],
			),
			retryAttempt: this.numberValue(
				source["retry_attempt"] ??
					source["retryAttempt"] ??
					source["attempt"] ??
					retry?.["attempt"],
			),
			retryDueAt:
				this.firstNonEmpty(
					this.stringValue(source["retry_due_at"]),
					this.stringValue(source["retryDueAt"]),
					this.stringValue(source["due_at"]),
					this.stringValue(retry?.["due_at"]),
					this.formatDueAtValue(
						source["retry_due_at_ms"] ?? source["due_at_ms"],
					),
					this.formatDueAtValue(retry?.["due_at_ms"]),
				) || undefined,
			retryError:
				this.firstNonEmpty(
					this.stringValue(source["retry_error"]),
					this.stringValue(source["retryError"]),
					this.stringValue(retry?.["error"]),
				) || undefined,
			rateLimitSummary:
				this.firstNonEmpty(
					this.stringValue(source["rate_limit_summary"]),
					this.stringValue(source["rateLimitSummary"]),
					this.formatRateLimitSummary(rateLimits),
				) || undefined,
		};
	}

	private mergeRuntimeSnapshot(
		run: CodexRunView,
		snapshot: RuntimeSnapshotFields,
		ref: CodexRunSourceRef,
	): void {
		for (const field of [
			"turnCount",
			"inputTokens",
			"outputTokens",
			"totalTokens",
			"runtimeSeconds",
			"retryAttempt",
			"retryDueAt",
			"retryError",
			"rateLimitSummary",
		] as const) {
			if (run[field] != null || snapshot[field] == null) continue;
			run[field] = snapshot[field] as never;
			this.addFieldSource(run, field, ref);
		}
	}

	private addRuntimeSnapshotSources(
		run: CodexRunView,
		snapshot: RuntimeSnapshotFields,
		ref: CodexRunSourceRef,
	): void {
		for (const field of [
			"turnCount",
			"inputTokens",
			"outputTokens",
			"totalTokens",
			"runtimeSeconds",
			"retryAttempt",
			"retryDueAt",
			"retryError",
			"rateLimitSummary",
		] as const) {
			if (snapshot[field] == null) continue;
			this.addFieldSource(run, field, ref);
		}
	}

	private extractSymphonyRuntimeSnapshot(
		source: Record<string, unknown>,
		ref: CodexRunSourceRef,
	): SymphonyRuntimeSnapshotField {
		const raw = this.objectValue(
			source["symphony_runtime_snapshot"] ??
				source["symphonyRuntimeSnapshot"] ??
				source["orchestrator_runtime_state"] ??
				source["orchestratorRuntimeState"],
		);
		if (!raw) return {};

		const error = this.objectValue(raw["error"]);
		const errorCode = this.stringValue(error?.["code"]);
		const status = this.normalizeSymphonyRuntimeSnapshotStatus(
			this.stringValue(raw["status"]),
			errorCode,
		);
		const counts = this.objectValue(raw["counts"]);
		const codexTotals = this.objectValue(
			raw["codex_totals"] ?? raw["codexTotals"],
		);
		const diagnostics = this.objectValue(raw["diagnostics"]);
		const running = Array.isArray(raw["running"])
			? raw["running"]
					.map((entry) => this.normalizeSymphonyRunningEntry(entry))
					.filter((entry): entry is SymphonyRunningEntryView => Boolean(entry))
			: undefined;
		const retrying = Array.isArray(raw["retrying"])
			? raw["retrying"]
					.map((entry) => this.normalizeSymphonyRetryEntry(entry))
					.filter((entry): entry is SymphonyRetryEntryView => Boolean(entry))
			: undefined;
		const snapshot: SymphonyRuntimeSnapshotView = {
			generatedAt: this.firstNonEmpty(
				this.stringValue(raw["generated_at"]),
				this.stringValue(raw["generatedAt"]),
			),
			lastCronTick: this.firstNonEmpty(
				this.stringValue(raw["last_cron_tick"]),
				this.stringValue(raw["lastCronTick"]),
			),
			workflowPath: this.firstNonEmpty(
				this.stringValue(raw["workflow_path"]),
				this.stringValue(raw["workflowPath"]),
			),
			pollingCadenceMs: this.numberValue(
				raw["polling_cadence_ms"] ?? raw["pollingCadenceMs"],
			),
			status,
			error: errorCode
				? {
						code: errorCode,
						message:
							this.firstNonEmpty(
								this.stringValue(error?.["message"]),
								errorCode,
							) || errorCode,
					}
				: undefined,
			counts: counts
				? {
						running: this.numberValue(counts["running"]),
						retrying: this.numberValue(counts["retrying"]),
						claimed: this.numberValue(counts["claimed"]),
						completed: this.numberValue(counts["completed"]),
					}
				: undefined,
			completedCount: this.numberValue(
				raw["completed_count"] ??
					raw["completedCount"] ??
					counts?.["completed"],
			),
			completedLimit: this.numberValue(
				raw["completed_limit"] ?? raw["completedLimit"],
			),
			running,
			retrying,
			codexTotals: codexTotals
				? {
						inputTokens: this.numberValue(
							codexTotals["input_tokens"] ?? codexTotals["inputTokens"],
						),
						outputTokens: this.numberValue(
							codexTotals["output_tokens"] ?? codexTotals["outputTokens"],
						),
						totalTokens: this.numberValue(
							codexTotals["total_tokens"] ?? codexTotals["totalTokens"],
						),
						secondsRunning: this.numberValue(
							codexTotals["seconds_running"] ?? codexTotals["secondsRunning"],
						),
					}
				: undefined,
			rateLimits: raw["rate_limits"] ?? raw["rateLimits"],
			diagnostics: diagnostics
				? {
						lastCronTickStatus: this.stringValue(
							diagnostics["last_cron_tick_status"] ??
								diagnostics["lastCronTickStatus"],
						),
						lastReconciliationDurationMs: this.numberValue(
							diagnostics["last_reconciliation_duration_ms"] ??
								diagnostics["lastReconciliationDurationMs"],
						),
						lastLinearErrorAt: this.stringValue(
							diagnostics["last_linear_error_at"] ??
								diagnostics["lastLinearErrorAt"],
						),
						consecutiveLinearErrors: this.numberValue(
							diagnostics["consecutive_linear_errors"] ??
								diagnostics["consecutiveLinearErrors"],
						),
						lastCallbackStatus: this.stringValue(
							diagnostics["last_callback_status"] ??
								diagnostics["lastCallbackStatus"],
						),
						lastCallbackUrl: this.stringValue(
							diagnostics["last_callback_url"] ??
								diagnostics["lastCallbackUrl"],
						),
						lastWakeAt: this.stringValue(
							diagnostics["last_wake_at"] ?? diagnostics["lastWakeAt"],
						),
						nodeConnected: this.booleanValue(
							diagnostics["node_connected"] ?? diagnostics["nodeConnected"],
						),
					}
				: undefined,
			source: this.symfonySnapshotSource(ref),
			sourcePath: this.firstNonEmpty(
				this.stringValue(raw["source_path"]),
				this.stringValue(raw["sourcePath"]),
				ref.path,
			),
		};

		return { symphonyRuntimeSnapshot: snapshot };
	}

	private mergeSymphonyRuntimeSnapshot(
		run: CodexRunView,
		snapshot: SymphonyRuntimeSnapshotField,
		ref: CodexRunSourceRef,
	): void {
		if (run.symphonyRuntimeSnapshot || !snapshot.symphonyRuntimeSnapshot) {
			return;
		}
		run.symphonyRuntimeSnapshot = snapshot.symphonyRuntimeSnapshot;
		this.addFieldSource(run, "symphonyRuntimeSnapshot", ref);
	}

	private addSymphonyRuntimeSnapshotSource(
		run: CodexRunView,
		snapshot: SymphonyRuntimeSnapshotField,
		ref: CodexRunSourceRef,
	): void {
		if (!snapshot.symphonyRuntimeSnapshot) return;
		this.addFieldSource(run, "symphonyRuntimeSnapshot", ref);
	}

	private normalizeSymphonyRuntimeSnapshotStatus(
		status: string | undefined,
		errorCode: string | undefined,
	): SymphonyRuntimeSnapshotStatus {
		if (errorCode === "snapshot_timeout") return "timeout";
		if (errorCode === "snapshot_unavailable") return "unavailable";
		if (
			status === "fresh" ||
			status === "timeout" ||
			status === "unavailable" ||
			status === "not_provided"
		) {
			return status;
		}
		return "fresh";
	}

	private normalizeSymphonyRunningEntry(
		value: unknown,
	): SymphonyRunningEntryView | undefined {
		const entry = this.objectValue(value);
		if (!entry) return undefined;
		const tokens = this.objectValue(entry["tokens"]);
		return {
			issueId: this.stringValue(entry["issue_id"] ?? entry["issueId"]),
			issueIdentifier: this.stringValue(
				entry["issue_identifier"] ??
					entry["identifier"] ??
					entry["issueIdentifier"],
			),
			issueState: this.stringValue(
				entry["issue_state"] ?? entry["issueState"] ?? entry["state"],
			),
			runAttempt: this.stringValue(
				entry["run_attempt"] ?? entry["runAttempt"] ?? entry["run_id"],
			),
			workspacePath: this.stringValue(
				entry["workspace_path"] ?? entry["workspacePath"],
			),
			sessionId: this.stringValue(entry["session_id"] ?? entry["sessionId"]),
			phase: this.stringValue(entry["phase"] ?? entry["lifecycle_phase"]),
			startedAt: this.stringValue(entry["started_at"] ?? entry["startedAt"]),
			lastCodexEvent: this.stringValue(
				entry["last_codex_event"] ??
					entry["last_event"] ??
					entry["lastCodexEvent"],
			),
			lastCodexEventAt: this.stringValue(
				entry["last_codex_timestamp"] ??
					entry["last_event_at"] ??
					entry["lastCodexEventAt"],
			),
			lastCodexMessage: this.stringValue(
				entry["last_codex_message"] ??
					entry["last_message"] ??
					entry["lastCodexMessage"],
			),
			turnCount: this.numberValue(entry["turn_count"] ?? entry["turnCount"]),
			codexInputTokens: this.numberValue(
				entry["codex_input_tokens"] ??
					entry["input_tokens"] ??
					tokens?.["input_tokens"] ??
					tokens?.["inputTokens"],
			),
			codexOutputTokens: this.numberValue(
				entry["codex_output_tokens"] ??
					entry["output_tokens"] ??
					tokens?.["output_tokens"] ??
					tokens?.["outputTokens"],
			),
			codexTotalTokens: this.numberValue(
				entry["codex_total_tokens"] ??
					entry["total_tokens"] ??
					tokens?.["total_tokens"] ??
					tokens?.["totalTokens"],
			),
		};
	}

	private normalizeSymphonyRetryEntry(
		value: unknown,
	): SymphonyRetryEntryView | undefined {
		const entry = this.objectValue(value);
		if (!entry) return undefined;
		return {
			issueId: this.stringValue(entry["issue_id"] ?? entry["issueId"]),
			issueIdentifier: this.stringValue(
				entry["issue_identifier"] ??
					entry["identifier"] ??
					entry["issueIdentifier"],
			),
			issueState: this.stringValue(entry["issue_state"] ?? entry["issueState"]),
			runAttempt: this.stringValue(
				entry["run_attempt"] ?? entry["runAttempt"] ?? entry["run_id"],
			),
			attempt: this.numberValue(entry["attempt"]),
			dueAt: this.firstNonEmpty(
				this.stringValue(entry["due_at"]),
				this.stringValue(entry["dueAt"]),
				this.formatDueAtValue(entry["due_at_ms"] ?? entry["dueAtMs"]),
			),
			error: this.stringValue(entry["error"]),
		};
	}

	private symfonySnapshotSource(
		ref: CodexRunSourceRef,
	): SymphonyRuntimeSnapshotSource {
		if (ref.kind === "launcher") return "launcher";
		if (ref.kind === "taskflow") return "taskflow";
		if (ref.kind === "openclaw-task") return "openclaw";
		return "fixture";
	}

	private collectArtifactPaths(source: ArtifactCarrier): string[] {
		const paths: string[] = [];
		if (Array.isArray(source.artifactPaths)) {
			for (const value of source.artifactPaths) {
				if (typeof value === "string" && value.trim()) paths.push(value);
			}
		}
		if (Array.isArray(source.artifact_paths)) {
			for (const value of source.artifact_paths) {
				if (typeof value === "string" && value.trim()) paths.push(value);
			}
		}
		for (const value of [
			source.stream_file,
			source.prompt_file,
			source.handoff_file,
			source.pending_review_path,
			source.pending_fixup_path,
		]) {
			if (typeof value === "string" && value.trim()) paths.push(value);
		}
		return this.uniqueStrings(paths);
	}

	private collectEvidence(
		source: ArtifactCarrier,
		ref: CodexRunSourceRef,
	): CodexRunEvidence[] {
		const evidence: CodexRunEvidence[] = [];
		const push = (
			label: string,
			value: unknown,
			kind: CodexRunEvidence["kind"],
		): void => {
			if (typeof value !== "string") return;
			const trimmed = value.trim();
			if (!trimmed) return;
			evidence.push({ label, value: trimmed, kind, source: ref });
		};

		push("Prompt", source.prompt_file, "file");
		push("Stream", source.stream_file, "file");
		push("Handoff", source.handoff_file, "file");
		push("Pending review", source.pending_review_path, "file");
		push("Pending fixup", source.pending_fixup_path, "file");

		if (Array.isArray(source.artifact_paths)) {
			for (const [index, value] of source.artifact_paths.entries()) {
				push(index === 0 ? "Artifact" : `Artifact ${index + 1}`, value, "file");
			}
		}

		if (Array.isArray(source.artifactPaths)) {
			for (const [index, value] of source.artifactPaths.entries()) {
				push(index === 0 ? "Artifact" : `Artifact ${index + 1}`, value, "file");
			}
		}

		push("Start commit", source.start_commit ?? source.start_sha, "commit");
		push("End commit", source.end_commit, "commit");
		push("Branch", source.branch, "metadata");

		return this.uniqueEvidence(evidence);
	}

	private resolveOrchestrationMode(source: ModeCarrier): string | undefined {
		const explicitMode = this.firstNonEmpty(
			this.stringValue(source.orchestration_mode),
			this.stringValue(source.agent_mode),
		);
		if (explicitMode) return explicitMode;

		const teamTemplate = this.firstNonEmpty(
			this.stringValue(source.team_template),
			this.stringValue(source.team),
		);
		if (teamTemplate) return `team:${teamTemplate}`;

		const provenance = this.objectValue(source.provenance);
		const adapterKind = this.stringValue(provenance?.["adapter_kind"]);
		if (adapterKind) {
			const normalizedAdapter = adapterKind.toLowerCase();
			if (normalizedAdapter.includes("ralph")) return "ralph";
			if (normalizedAdapter.includes("team")) return "team";
			if (normalizedAdapter.includes("ghostty-launcher")) return "normal";
			return adapterKind;
		}

		const ownershipHint = this.firstNonEmpty(
			this.stringValue(source.source_authority),
			this.stringValue(source.owner_kind),
		).toLowerCase();
		if (ownershipHint.includes("ralph")) return "ralph";

		if (this.stringValue(source.agent_backend)) {
			return "normal";
		}

		return undefined;
	}

	private resolveNextAction(
		status: CodexRunStatus,
		sourceStatus?: string,
		ownerKind?: string,
		reviewState?: string,
		fixupState?: string,
		orchestrationMode?: string,
	): string | undefined {
		const owner = ownerKind || "source owner";
		const mode = orchestrationMode ? ` (${orchestrationMode})` : "";
		if (sourceStatus === "contract_failure") {
			return `Review evidence, then route ${owner} fixup or relaunch${mode}`;
		}
		if (status === "failed" || status === "timed_out" || status === "lost") {
			return `Inspect evidence, then dispatch owner-routed fixup${mode}`;
		}
		if (status === "blocked" || status === "waiting") {
			return `Steer the active owner or unblock prerequisites${mode}`;
		}
		if (status === "stopped" || status === "cancelled") {
			return `Decide whether to relaunch through ${owner}${mode}`;
		}
		if (reviewState === "pending") {
			return "Review pending handoff, report findings, then continue";
		}
		if (fixupState === "pending") {
			return `Dispatch queued fixup through ${owner}${mode}`;
		}
		return undefined;
	}

	private stringValue(value: unknown): string | undefined {
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	}

	private objectValue(value: unknown): Record<string, unknown> | undefined {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return undefined;
		}
		return value as Record<string, unknown>;
	}

	private numberValue(value: unknown): number | undefined {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "string" || !value.trim()) return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private booleanValue(value: unknown): boolean | undefined {
		if (typeof value === "boolean") return value;
		if (typeof value !== "string") return undefined;
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
		return undefined;
	}

	private formatDueAtValue(value: unknown): string | undefined {
		if (typeof value === "string" && value.trim()) return value.trim();
		const numeric = this.numberValue(value);
		if (numeric == null) return undefined;
		if (numeric > 1_000_000_000_000) {
			return new Date(numeric).toISOString();
		}
		return `${numeric}ms`;
	}

	private formatRateLimitSummary(value: unknown): string | undefined {
		if (typeof value === "string" && value.trim()) return value.trim();
		const object = this.objectValue(value);
		if (!object) return undefined;
		const parts: string[] = [];
		for (const key of [
			"remaining",
			"limit",
			"reset_at",
			"resetAt",
			"window_seconds",
			"windowSeconds",
		]) {
			const scalar = object[key];
			if (
				typeof scalar === "string" ||
				typeof scalar === "number" ||
				typeof scalar === "boolean"
			) {
				parts.push(`${key}=${String(scalar)}`);
			}
		}
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	private parseTimestamp(value: string | null | undefined): number | undefined {
		if (!value) return undefined;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private firstNonEmpty(...values: Array<string | null | undefined>): string {
		for (const value of values) {
			const trimmed = value?.trim();
			if (trimmed) return trimmed;
		}
		return "";
	}

	private normalizeOwnerActions(
		raw: unknown[] | null | undefined,
	): unknown[] | undefined {
		if (!Array.isArray(raw) || raw.length === 0) return undefined;
		return raw;
	}

	private uniqueStrings(values: string[]): string[] {
		return [...new Set(values.filter((value) => value.trim().length > 0))];
	}

	private uniqueEvidence(values: CodexRunEvidence[]): CodexRunEvidence[] {
		const seen = new Set<string>();
		const unique: CodexRunEvidence[] = [];
		for (const value of values) {
			const key = `${value.label}\0${value.value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			unique.push(value);
		}
		return unique;
	}
}
