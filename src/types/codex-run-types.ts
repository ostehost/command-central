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
	execMode?: string;
	execNodeId?: string;
	execNodeName?: string;
	nodeConnected?: boolean;
	sourceAuthority?: string;
	ownerKind?: string;
	callbackPresent?: boolean;
	reviewState?: string;
	fixupState?: string;
	workspacePath?: string;
	host?: string;
	branch?: string;
	model?: string;
	currentTool?: string;
	lastEvent?: string;
	lastEventAt?: number;
	startedAt?: number;
	endedAt?: number;
	artifactPaths?: string[];
	provenance?: string[];
	fieldSources: Partial<Record<CodexRunViewField, CodexRunSourceRef[]>>;
}

export type CodexRunViewField = keyof Omit<CodexRunView, "fieldSources">;

export type WorkflowRunView = CodexRunView;
export type WorkflowRunSourceRef = CodexRunSourceRef;
export type WorkflowRunStatus = CodexRunStatus;
export type WorkflowRunPhase = CodexRunPhase;
