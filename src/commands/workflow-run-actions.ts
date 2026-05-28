import type {
	WorkflowRunSourceRef,
	WorkflowRunView,
} from "../types/codex-run-types.js";

export type WorkflowRunAction =
	| "focusTerminal"
	| "showDetail"
	| "cancel"
	| "requestReview"
	| "dispatchFixup";

export type WorkflowRunOwnerKind = "openclaw" | "launcher";
export type WorkflowRunActionSurface = "agentStatus" | "symphony";

export interface WorkflowRunActionOptions {
	surface?: WorkflowRunActionSurface;
}

export interface WorkflowRunActionEnvelope {
	sourceRef: WorkflowRunSourceRef;
	action: WorkflowRunAction;
	ownerKind: WorkflowRunOwnerKind;
	runId: string;
	taskId?: string;
	flowId?: string;
	sessionKey?: string;
	execMode?: string;
	execNodeId?: string;
	execNodeName?: string;
}

const OWNER_KINDS = new Set<WorkflowRunOwnerKind>(["openclaw", "launcher"]);
const READ_ONLY_ACTIONS = new Set<WorkflowRunAction>([
	"focusTerminal",
	"showDetail",
]);

const ACTION_OWNER_ALLOWLIST: Record<
	WorkflowRunAction,
	readonly WorkflowRunOwnerKind[]
> = {
	focusTerminal: ["launcher"],
	showDetail: ["openclaw", "launcher"],
	cancel: ["openclaw"],
	requestReview: ["openclaw"],
	dispatchFixup: ["openclaw"],
};

export function isWorkflowRunOwnerKind(
	ownerKind: string | undefined,
): ownerKind is WorkflowRunOwnerKind {
	return OWNER_KINDS.has(ownerKind as WorkflowRunOwnerKind);
}

export function buildWorkflowRunActionEnvelope(
	run: WorkflowRunView,
	action: WorkflowRunAction,
	options: WorkflowRunActionOptions = {},
): WorkflowRunActionEnvelope {
	if (!isWorkflowRunOwnerKind(run.ownerKind)) {
		throw new Error(
			`Workflow run ${run.runId} cannot route ${action}: missing or unsupported ownerKind`,
		);
	}

	assertSurfaceCanHandleAction(action, run.runId, options);
	assertOwnerCanHandleAction(run.ownerKind, action, run.runId);

	return omitUndefined({
		sourceRef: { ...run.source },
		action,
		ownerKind: run.ownerKind,
		runId: run.runId,
		taskId: run.taskId,
		flowId: run.flowId,
		sessionKey: run.sessionKey,
		execMode: run.execMode,
		execNodeId: run.execNodeId,
		execNodeName: run.execNodeName,
	});
}

export function assertOwnerCanHandleAction(
	ownerKind: WorkflowRunOwnerKind,
	action: WorkflowRunAction,
	runId = "workflow run",
): void {
	if (!ACTION_OWNER_ALLOWLIST[action].includes(ownerKind)) {
		throw new Error(
			`Workflow run ${runId} cannot route ${action} to ${ownerKind}`,
		);
	}
}

export function assertSurfaceCanHandleAction(
	action: WorkflowRunAction,
	runId = "workflow run",
	options: WorkflowRunActionOptions = {},
): void {
	if (options.surface === "symphony" && !READ_ONLY_ACTIONS.has(action)) {
		throw new Error(
			`Workflow run ${runId} cannot route ${action}: read-only Symphony surface only allows focusTerminal/showDetail`,
		);
	}
}

export function getWorkflowRunActionOwner(
	envelope: WorkflowRunActionEnvelope,
	options: WorkflowRunActionOptions = {},
): WorkflowRunOwnerKind {
	assertSurfaceCanHandleAction(envelope.action, envelope.runId, options);
	assertOwnerCanHandleAction(
		envelope.ownerKind,
		envelope.action,
		envelope.runId,
	);
	return envelope.ownerKind;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}
