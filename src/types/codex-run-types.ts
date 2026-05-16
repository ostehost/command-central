export type CodexRunSourceKind =
	| "openclaw-task"
	| "taskflow"
	| "launcher"
	| "codex-harness"
	| "trajectory"
	| "process";

export interface CodexRunSourceRef {
	kind: CodexRunSourceKind;
	id?: string;
	path?: string;
}

export type CodexRunStatus =
	| "queued"
	| "running"
	| "waiting"
	| "blocked"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "lost"
	| "stopped"
	| "unknown";

export type CodexRunPhase =
	| "PreparingWorkspace"
	| "BuildingPrompt"
	| "LaunchingAgent"
	| "LaunchingAgentProcess"
	| "InitializingSession"
	| "StreamingTurn"
	| "Finishing"
	| "Succeeded"
	| "Failed"
	| "TimedOut"
	| "Stalled"
	| "CanceledByReconciliation";

export type CodexRunRole = "developer" | "planner" | "reviewer" | "test";

export type CodexRunEvidenceKind = "file" | "commit" | "metadata";

export interface CodexRunEvidence {
	label: string;
	value: string;
	kind: CodexRunEvidenceKind;
	source?: CodexRunSourceRef;
}

export type SymphonyRuntimeSnapshotStatus =
	| "fresh"
	| "timeout"
	| "unavailable"
	| "not_provided";

export type SymphonyRuntimeSnapshotSource =
	| "launcher"
	| "taskflow"
	| "openclaw"
	| "fixture";

export interface SymphonyRuntimeSnapshotError {
	code: "snapshot_timeout" | "snapshot_unavailable" | string;
	message: string;
}

export interface SymphonyRuntimeSnapshotCounts {
	running?: number;
	retrying?: number;
	claimed?: number;
	completed?: number;
}

export interface SymphonyCodexTotalsView {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	secondsRunning?: number;
}

export interface SymphonyRunningEntryView {
	issueId?: string;
	issueIdentifier?: string;
	issueState?: string;
	runAttempt?: string;
	workspacePath?: string;
	sessionId?: string;
	phase?: CodexRunPhase | string;
	startedAt?: string;
	lastCodexEvent?: string;
	lastCodexEventAt?: string;
	lastCodexMessage?: string;
	turnCount?: number;
	codexInputTokens?: number;
	codexOutputTokens?: number;
	codexTotalTokens?: number;
}

export interface SymphonyRetryEntryView {
	issueId?: string;
	issueIdentifier?: string;
	issueState?: string;
	runAttempt?: string;
	attempt?: number;
	dueAt?: string;
	error?: string;
}

export interface SymphonyRuntimeSnapshotDiagnostics {
	lastCronTickStatus?: string;
	lastReconciliationDurationMs?: number;
	lastLinearErrorAt?: string;
	consecutiveLinearErrors?: number;
	lastCallbackStatus?: string;
	lastCallbackUrl?: string;
	lastWakeAt?: string;
	nodeConnected?: boolean;
}

export interface SymphonyRuntimeSnapshotView {
	generatedAt?: string;
	lastCronTick?: string;
	workflowPath?: string;
	pollingCadenceMs?: number;
	status: SymphonyRuntimeSnapshotStatus;
	error?: SymphonyRuntimeSnapshotError;
	counts?: SymphonyRuntimeSnapshotCounts;
	completedCount?: number;
	completedLimit?: number;
	running?: SymphonyRunningEntryView[];
	retrying?: SymphonyRetryEntryView[];
	codexTotals?: SymphonyCodexTotalsView;
	rateLimits?: unknown;
	diagnostics?: SymphonyRuntimeSnapshotDiagnostics;
	source: SymphonyRuntimeSnapshotSource;
	sourcePath?: string;
}

export interface CodexRunView {
	runId: string;
	title: string;
	source: CodexRunSourceRef;
	mergedFrom: CodexRunSourceRef[];
	sourceStatus?: string;
	status: CodexRunStatus;
	phase?: CodexRunPhase;
	runtime?: string;
	taskId?: string;
	flowId?: string;
	sessionKey?: string;
	threadId?: string;
	turnId?: string;
	trackerKind?: string;
	issueId?: string;
	issueIdentifier?: string;
	issueState?: string;
	issueUrl?: string;
	workflowRunId?: string;
	workflowPath?: string;
	workflowName?: string;
	execMode?: string;
	execNodeId?: string;
	execNodeName?: string;
	nodeConnected?: boolean;
	sourceAuthority?: string;
	ownerKind?: string;
	role?: CodexRunRole;
	orchestrationMode?: string;
	callbackPresent?: boolean;
	reviewState?: string;
	fixupState?: string;
	workspacePath?: string;
	host?: string;
	branch?: string;
	model?: string;
	currentTool?: string;
	lastEvent?: string;
	nextAction?: string;
	turnCount?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	runtimeSeconds?: number;
	retryAttempt?: number;
	retryDueAt?: string;
	retryError?: string;
	rateLimitSummary?: string;
	symphonyRuntimeSnapshot?: SymphonyRuntimeSnapshotView;
	lastEventAt?: number;
	startedAt?: number;
	endedAt?: number;
	artifactPaths?: string[];
	evidence?: CodexRunEvidence[];
	provenance?: string[];
	fieldSources: Partial<Record<CodexRunViewField, CodexRunSourceRef[]>>;
}

export type CodexRunViewField = keyof Omit<CodexRunView, "fieldSources">;

export type WorkflowRunView = CodexRunView;
export type WorkflowRunSourceRef = CodexRunSourceRef;
