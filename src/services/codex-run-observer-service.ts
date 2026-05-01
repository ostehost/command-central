import type { AgentTask } from "../providers/agent-status-tree-provider.js";
import type {
	CodexRunPhase,
	CodexRunSourceRef,
	CodexRunStatus,
	CodexRunView,
	CodexRunViewField,
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
	stream_file?: unknown;
	prompt_file?: unknown;
	handoff_file?: unknown;
};

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
			} else if (this.isCodexLauncherTask(task)) {
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
			sessionKey: task.childSessionKey,
			lastEvent,
			lastEventAt: task.lastEventAt,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
			artifactPaths: artifacts.length > 0 ? artifacts : undefined,
			fieldSources: {},
		};

		this.addFieldSource(run, "runId", ref);
		this.addFieldSource(run, "title", ref);
		this.addFieldSource(run, "sourceStatus", ref);
		this.addFieldSource(run, "status", ref);
		this.addFieldSource(run, "taskId", ref);
		if (run.sessionKey) this.addFieldSource(run, "sessionKey", ref);
		if (run.lastEventAt != null) this.addFieldSource(run, "lastEventAt", ref);
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
			lastEvent: flow.error,
			lastEventAt: flow.endedAt ?? flow.startedAt ?? flow.createdAt,
			startedAt: flow.startedAt,
			endedAt: flow.endedAt,
			fieldSources: {},
		};

		this.addFieldSource(run, "runId", ref);
		this.addFieldSource(run, "title", ref);
		this.addFieldSource(run, "sourceStatus", ref);
		this.addFieldSource(run, "status", ref);
		this.addFieldSource(run, "flowId", ref);
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
			sessionKey: task.session_id,
			workspacePath: task.project_dir,
			model,
			lastEvent: task.error_message ?? undefined,
			lastEventAt: updatedAt ?? completedAt ?? startedAt,
			startedAt,
			endedAt: completedAt,
			artifactPaths: artifacts.length > 0 ? artifacts : undefined,
			fieldSources: {},
		};

		this.addFieldSource(run, "runId", ref);
		this.addFieldSource(run, "title", ref);
		this.addFieldSource(run, "sourceStatus", ref);
		this.addFieldSource(run, "status", ref);
		if (run.sessionKey) this.addFieldSource(run, "sessionKey", ref);
		if (run.workspacePath) this.addFieldSource(run, "workspacePath", ref);
		if (run.model) this.addFieldSource(run, "model", ref);
		if (run.lastEventAt != null) this.addFieldSource(run, "lastEventAt", ref);
		if (run.startedAt != null) this.addFieldSource(run, "startedAt", ref);
		if (run.endedAt != null) this.addFieldSource(run, "endedAt", ref);
		if (artifacts.length > 0) this.addFieldSource(run, "artifactPaths", ref);
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

		if (!run.workspacePath && task.project_dir) {
			run.workspacePath = task.project_dir;
			this.addFieldSource(run, "workspacePath", ref);
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

	private collectArtifactPaths(source: ArtifactCarrier): string[] {
		const paths: string[] = [];
		if (Array.isArray(source.artifactPaths)) {
			for (const value of source.artifactPaths) {
				if (typeof value === "string" && value.trim()) paths.push(value);
			}
		}
		for (const value of [
			source.stream_file,
			source.prompt_file,
			source.handoff_file,
		]) {
			if (typeof value === "string" && value.trim()) paths.push(value);
		}
		return this.uniqueStrings(paths);
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

	private uniqueStrings(values: string[]): string[] {
		return [...new Set(values.filter((value) => value.trim().length > 0))];
	}
}
