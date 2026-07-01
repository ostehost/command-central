/**
 * AgentStatusTreeProvider - TreeView provider for Ghostty launcher agent status
 *
 * Reads a JSON task registry (tasks.json) and displays agent tasks in a tree:
 * - Root items: task ID + status + project name + time elapsed
 * - Child items: prompt file, worktree path, attempt count, PR info
 *
 * Watches the file for changes and auto-refreshes.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	getValidClaudeSessionId,
	resolveResumeBackend,
} from "../commands/resume-session.js";
import { AgentRegistry } from "../discovery/agent-registry.js";
import type { ProcessScanDiagnosticEntry } from "../discovery/process-scanner.js";
import type { DiscoveredAgent } from "../discovery/types.js";
import type { AgentEvent } from "../events/agent-events.js";
import type { AcpSessionService } from "../services/acp-session-service.js";
import { CodexRunObserverService } from "../services/codex-run-observer-service.js";
import type {
	OpenClawAgentModel,
	OpenClawConfigService,
} from "../services/openclaw-config-service.js";
import type { OpenClawTaskService } from "../services/openclaw-task-service.js";
import { ProjectIconManager } from "../services/project-icon-manager.js";
import { ReviewTracker } from "../services/review-tracker.js";
import {
	buildUnreachableNodeCard,
	collectHubSyncReadiness,
	type SyncReadinessReceipt,
} from "../services/sync-readiness-service.js";
import type { TaskFlowService } from "../services/taskflow-service.js";
import type {
	AgentStatusSortMode,
	AgentTask,
	AgentTaskStatus,
	TaskRegistry,
} from "../types/agent-task.js";

// Tree node types live in ./agent-status-tree-nodes.ts (the single source of
// truth for the AgentNode union); re-exported here so existing import sites stay
// stable.
export type {
	AgentDiffMode,
	AgentNode,
	AgentStatusGroup,
	BackgroundTasksNode,
	CodexRunNode,
	CodexRunsContainerNode,
	DetailNode,
	DiscoveredNode,
	FileChangeNode,
	FileChangeStatus,
	FolderGroupNode,
	OlderRunsNode,
	OpenClawTaskNode,
	PerFileDiff,
	ProjectGroupNode,
	StateNode,
	StatusGroupNode,
	StatusTimeGroupNode,
	StatusTimeGroupPeriod,
	SummaryNode,
	SymphonyDashboardNode,
	SymphonyRootNode,
	SymphonyRunGroupKind,
	SymphonyRunGroupNode,
	SymphonySnapshotEntryNode,
	TaskFlowChildNode,
	TaskFlowGroupNode,
	TaskFlowSingleNode,
	TaskFlowsContainerNode,
	TaskNode,
	TreeElement,
} from "./agent-status-tree-nodes.js";

import type {
	CodexRunView,
	SymphonyRetryEntryView,
	SymphonyRunningEntryView,
} from "../types/codex-run-types.js";
import {
	type OpenClawTask,
	openclawStatusToIcon,
	openclawStatusToLabel,
} from "../types/openclaw-task-types.js";
import {
	type TaskFlow,
	type TaskFlowTask,
	taskflowStatusToIcon,
	taskflowStatusToLabel,
} from "../types/taskflow-types.js";
import { type AgentCounts, countAgentStatuses } from "../utils/agent-counts.js";
import {
	classifyPaneAttention,
	emptyUnifiedCounts,
	formatV2Summary,
	isBenignLivePane,
	type PaneAttentionState,
	sectionFromStatusGroup,
	type UnifiedCounts,
	V2_SECTION_HEADERS,
} from "../utils/agent-status-sections.js";
import {
	CLEARABLE_AGENT_TASK_STATUSES,
	STALE_AGENT_STATUS_DESCRIPTION,
} from "../utils/agent-task-registry.js";
import {
	extractSourceTaskId,
	isAutoReviewLane,
	isReviewOnlyLane,
} from "../utils/auto-review-lane.js";
import {
	checkDeclaredHandoff,
	type DeclaredHandoffState,
} from "../utils/handoff-file-health.js";
import { getModelAlias } from "../utils/model-aliases.js";
import {
	isReceiptReviewed,
	readLaneProjectionGcReceipt,
	readPendingReviewReceipt,
	readReviewedReceipt,
	receiptToOverlay,
} from "../utils/pending-review-probe.js";
import { isPersistSessionAlive as checkPersistSessionAlive } from "../utils/persist-health.js";
import type { ListeningPort } from "../utils/port-detector.js";
import { detectListeningPortsAsync } from "../utils/port-detector.js";
import {
	nullProjectRefResolver,
	type ProjectRefResolver,
} from "../utils/project-ref-resolver.js";
import { relativeTime } from "../utils/relative-time.js";
import {
	type AdvertisedReviewQueueState,
	checkAdvertisedReviewQueue,
	isReviewLifecycleResolved,
	type LaneProjectionGcReceipt,
} from "../utils/review-queue-health.js";
import {
	type ResolvedTaskRegistrySource,
	resolveTaskRegistrySources,
	type TaskRegistryIngest,
} from "../utils/tasks-file-resolver.js";
import {
	groupByTimePeriod,
	TIME_PERIOD_LABELS,
} from "../utils/time-grouping.js";
import { defaultTimingRecorder } from "../utils/timing-recorder.js";
import {
	capturePaneSnippet,
	type TmuxPaneAgentEvidence,
} from "../utils/tmux-pane-health.js";
import { TtlCache } from "../utils/ttl-cache.js";
import {
	formatDurationPrecise,
	formatElapsed,
	getStatusDisplayLabel,
	getStatusThemeIcon,
	ROLE_ICONS,
} from "./agent-status-formatters.js";
import type {
	AgentNode,
	AgentStatusGroup,
	BackgroundTasksNode,
	CodexRunNode,
	CodexRunsContainerNode,
	DetailNode,
	DiscoveredNode,
	FileChangeNode,
	FolderGroupNode,
	OlderRunsNode,
	OpenClawTaskNode,
	PerFileDiff,
	ProjectGroupNode,
	SortableAgentNode,
	StateNode,
	StatusGroupNode,
	StatusTimeGroupNode,
	StatusTimeGroupPeriod,
	SummaryNode,
	SymphonyDashboardNode,
	SymphonyRootNode,
	SymphonyRunGroupNode,
	SymphonySnapshotEntryNode,
	TaskFlowGroupNode,
	TaskFlowsContainerNode,
	TaskNode,
	TreeElement,
} from "./agent-status-tree-nodes.js";
import {
	canonicalGenerationToken,
	classifyCompletionRouting,
	classifyLifecycleConflict,
	classifyOpenClawCrossProjectContext,
	classifyTaskSurface,
	getTaskDisplayProjectName,
	getTaskExecutionHostLabel,
	hasFirstClassTerminalFocusSurface,
	isAgentTeamLead,
	isLocalFileProbeAuthoritative,
	isRemoteNodeTaskForCurrentHost,
	isSupersededByReleaseReset,
	isSymphonyLane,
} from "./agent-task-classification.js";
import {
	detectAgentType,
	formatAgentTypeSummary,
	getBackendLabel,
	getTaskAgentIdentities,
} from "./agent-type-detection.js";
import {
	createCodexRunsTooltip,
	formatCodexRunAuthority,
	formatCodexRunAutomationSource,
	formatCodexRunFieldSourceDetails,
	formatCodexRunIssue,
	formatCodexRunLastEvent,
	formatCodexRunOwnership,
	formatCodexRunRetry,
	formatCodexRunRuntime,
	formatCodexRunSource,
	formatCodexRunStatus,
	formatCodexRunsDescription,
	formatCodexRunTokens,
	formatCodexRunTrackerSource,
	formatCodexRunTurns,
	formatCodexRunWorkflow,
	getCodexRunActivityTimeMs,
	getCodexRunEvidenceIcon,
	getCodexRunStatusIcon,
} from "./codex-run-format.js";
import {
	deriveFallbackFileChangeStatus,
	extractCommitHash,
	formatFileChangeDescription,
	formatNotificationDiffSummary,
	formatPerFileDiffSummary,
	getFileChangePathParts,
	parsePerFileStatusesFromNameStatus,
	shortenCommitHash,
} from "./diff-format.js";
import {
	formatRetainedDiscoveryEntry,
	summarizeFilteredDiscoveryMatches,
} from "./discovery-format.js";
import {
	computeDiffSummaryAsync,
	getPerFileNumstatDiffs,
	getTaskDiffEndCommit,
	getTaskDiffStartCommit,
	runGitDiffOutput,
} from "./git-diff.js";
import {
	formatOpenClawAuditStatusLabel,
	formatOpenClawTaskDuration,
	getOpenClawRuntimeIcon,
	getOpenClawTaskActivityTimeMs,
	getOpenClawTaskDisplayTitle,
	isOpenClawTaskActive,
	isOpenClawTaskVisibleInRunningMode,
	mapOpenClawTaskToAgentStatus,
	openClawTaskMatchesLauncherTask,
	toSyntheticOpenClawTask,
} from "./openclaw-task-format.js";
import {
	cleanPromptForDisplay,
	isPromptBoilerplateLine,
	normalizePromptSummaryLine,
	truncatePromptSummary,
} from "./prompt-display.js";
import {
	formatSymphonyDashboardDescription,
	formatSymphonyRootDescription,
	formatSymphonyRuntimeSnapshotStatus,
	formatSymphonySnapshotValue,
	getSymphonyReleasedRuns,
	getSymphonyRetryQueuedRuns,
	getSymphonyRunGroupCount,
	getSymphonyRunGroupEmptyDescription,
	getSymphonyRunGroupEmptyLabel,
	getSymphonyRunGroupIcon,
	getSymphonyRunGroupLabel,
	getSymphonyRunGroupSnapshotEntries,
	getSymphonyRunGroupSpecStatus,
	getSymphonyRunningSessionRuns,
	getSymphonyRuntimeSnapshot,
	getSymphonySnapshotEntryIssue,
} from "./symphony-projection.js";
import { TaskRegistryReader } from "./task-registry-reader.js";
import { TmuxLivenessChecker } from "./tmux-liveness-checker.js";

export type { AgentEvent } from "../events/agent-events.js";
export type {
	CompletionRoutingInfo,
	CompletionRoutingKind,
	LifecycleConflictInfo,
	LifecycleConflictKind,
	TaskSurfaceKind,
	TaskSurfaceSummary,
} from "./agent-task-classification.js";
// Task-classification helpers were extracted to agent-task-classification.ts;
// re-exported here so existing import sites stay stable.
export {
	__setCurrentMachineHostOverrideForTests,
	classifyCompletionRouting,
	classifyLifecycleConflict,
	classifyTaskSurface,
	getTaskExecutionHostLabel,
	hasFirstClassTerminalFocusSurface,
	isRemoteNodeTaskForCurrentHost,
	isSymphonyLane,
} from "./agent-task-classification.js";

/** Validate session ID to prevent shell injection */
export function isValidSessionId(name: string): boolean {
	return /^[a-zA-Z0-9._-]+$/.test(name);
}

// ── Task registry & lane types ───────────────────────────────────────
// AgentTask and the registry types live in ../types/agent-task.ts (a leaf
// module with no provider dependency, which breaks the import cycle the sibling
// node/formatter/detection modules otherwise have with this file); re-exported
// here so existing import sites stay stable.
export type {
	AgentRole,
	AgentStatusSortMode,
	AgentTask,
	AgentTaskProjectRef,
	AgentTaskStatus,
	TaskRegistry,
} from "../types/agent-task.js";

/**
 * A `running` lane whose live work CC cannot substantiate, so it must NOT
 * render the animated `sync~spin` spinner (which asserts active work is
 * happening right now). This is a VISIBILITY judgement, not a lifecycle one —
 * the row stays `running` and in its status group; only the icon/description
 * become honest. Two truth sources, in order:
 *
 *  1. Launcher-projected evidence (preferred — the executor's own probe):
 *     `attach.available === false` (no attachable terminal at emission) or
 *     `visibility.degraded === true` (a visible lane that failed its on-screen
 *     verification). These ride the `lane_ref_update` envelope and are the
 *     launcher's authoritative statement about the writer host.
 *  2. Structural fallback (local, when the launcher projected nothing): a
 *     non-authoritative projection row (`lane_projection`) emitted session-less
 *     — `laneRefUpdateToTaskRecord` falls the session id back to
 *     `launcher:<task_id>`, which fails {@link isValidSessionId} by
 *     construction — so there is no tmux session/pane/pid for CC to probe and
 *     the `running` state is a bare projection assertion plus one timestamp.
 *
 * Remote-node lanes are ALWAYS excluded: their host can't be verified locally
 * and they are deliberately fail-open (never demoted by a local probe — see
 * {@link isRemoteNodeTaskForCurrentHost}). This is a STATIC check; callers
 * additionally gate on the runtime liveness probe (`hasPositiveLivenessEvidence`)
 * so a projection row whose worktree actually hosts a discovered live agent —
 * or a launcher-flagged row CC can locally confirm is alive — keeps its spinner.
 */
export function isLivenessUnobservableRunningLane(task: AgentTask): boolean {
	if (task.status !== "running") return false;
	if (isRemoteNodeTaskForCurrentHost(task)) return false;
	if (task.launcher_attach_available === false) return true;
	if (task.launcher_visibility_degraded === true) return true;
	return task.lane_projection === true && !isValidSessionId(task.session_id);
}

export type AgentStatusTreeViewMode = "agentStatus" | "symphony";

export interface AgentStatusTreeProviderOptions {
	viewMode?: AgentStatusTreeViewMode;
	/**
	 * Adapter that attributes legacy/fixture records (no embedded
	 * `project_ref`) to Work Registry projects by directory or repo origin.
	 * Defaults to a resolver that resolves nothing, which routes such records
	 * into the UNREGISTERED PROJECTS bucket when they also lack an explicit
	 * launcher-assigned project name.
	 */
	projectRefResolver?: ProjectRefResolver;
}

// ── Tree node types ──────────────────────────────────────────────────

const UNREGISTERED_PROJECT_GROUP_KEY = "unregistered:";
export const UNREGISTERED_PROJECT_GROUP_NAME = "Unregistered projects";

function projectGroupNodeKey(
	node: Pick<ProjectGroupNode, "projectDir" | "projectName" | "groupKey">,
): string {
	if (node.groupKey) return node.groupKey;
	const dir = node.projectDir?.trim();
	return dir ? dir : node.projectName;
}

function symphonyRunIdentity(run: CodexRunView): string {
	return encodeURIComponent(run.runId);
}

// ── Status formatting & elapsed time ─────────────────────────────────
// These presentation helpers were extracted to agent-status-formatters.ts;
// re-exported here so existing import sites stay stable. The provider consumes
// getStatusThemeIcon / getStatusDisplayLabel / ROLE_ICONS / formatElapsed /
// formatDurationPrecise via the import above.
export {
	formatElapsed,
	formatTaskElapsedDescription,
	getStatusThemeIcon,
} from "./agent-status-formatters.js";
// canonicalGenerationToken / isAgentTeamLead / isSupersededByReleaseReset were
// extracted to agent-task-classification.ts; re-exported here so existing
// import sites stay stable.
export {
	canonicalGenerationToken,
	isAgentTeamLead,
	isSupersededByReleaseReset,
} from "./agent-task-classification.js";
// isRegistryBackedLaneTask / WORK_SYSTEM_LANES_PROJECTION_KIND were extracted
// to agent-task-normalize.ts; re-exported here so existing import sites stay
// stable.
export {
	isRegistryBackedLaneTask,
	WORK_SYSTEM_LANES_PROJECTION_KIND,
} from "./agent-task-normalize.js";
export type { AgentType } from "./agent-type-detection.js";
// ── Agent type detection ─────────────────────────────────────────────
// detectAgentType / getAgentTypeIcon (and the AgentType union) were extracted
// to agent-type-detection.ts; re-exported here so existing import sites stay
// stable. The provider consumes them — plus getBackendLabel,
// getTaskAgentIdentities, and formatAgentTypeSummary — via the import above.
export { detectAgentType, getAgentTypeIcon } from "./agent-type-detection.js";

const TASK_STATUS_PRIORITY: Record<AgentStatusGroup, number> = {
	running: 0,
	attention: 1,
	limbo: 2,
	done: 3,
};

// PORT_LOADING_LABEL removed — ports row only renders with real data
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Needs Review (limbo) status groups auto-expand only while they hold a review
 * item from the active working window. Older review backlog — review-receipt-
 * missing or completed-dirty/stale lanes left over from a prior session — stays
 * collapsed-but-counted so it does not dominate the tree as noise. Tuned below
 * the overnight gap so 21h–1d-old review lanes (operator-reported noise)
 * collapse while a just-completed needs-review lane stays expanded. The bucket
 * header keeps its full count, so nothing is hidden — only auto-expansion is
 * suppressed.
 */
const LIMBO_RECENT_THRESHOLD_MS = 8 * 60 * 60 * 1000;

// Section subgroup headers are the locked Agent Status V2 labels, sourced from
// the single centralized map (V2_SECTION_HEADERS) so a wording refinement is a
// one-line change. The four legacy status buckets map onto the V2 lane sections:
//   running → Live · limbo → Needs Review · attention → Action Required · done → History
// "Live" (not "Current · Live") makes the live surface unmistakable; it sorts
// first and auto-expands, and holds registry-`running` lanes whose visibility is
// merely detached/unconfirmable rather than dead (detached is a chip, not death).
const STATUS_GROUP_LABELS: Record<AgentStatusGroup, string> = {
	running: V2_SECTION_HEADERS.live,
	done: V2_SECTION_HEADERS.history,
	attention: V2_SECTION_HEADERS.action,
	limbo: V2_SECTION_HEADERS.review,
};

const STATUS_GROUP_ICONS: Record<AgentStatusGroup, vscode.ThemeIcon> = {
	running: getStatusThemeIcon("running"),
	done: getStatusThemeIcon("completed"),
	attention: new vscode.ThemeIcon(
		"warning",
		new vscode.ThemeColor("charts.orange"),
	),
	limbo: new vscode.ThemeIcon(
		"question",
		new vscode.ThemeColor("charts.yellow"),
	),
};

export function resolveAgentStatusSortMode(): AgentStatusSortMode {
	return "status-recency";
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHomePath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

// ── Provider ─────────────────────────────────────────────────────────

export interface GitInfo {
	branch: string;
	lastCommit: string;
}

export class AgentStatusTreeProvider
	implements vscode.TreeDataProvider<AgentNode>, vscode.Disposable
{
	private static readonly GIT_DIFF_TIMEOUT_MS = 1_500;
	private static readonly OPENCLAW_AUDIT_TIMEOUT_MS = 5_000;
	private static readonly STUCK_THRESHOLD_DEFAULT_MINUTES = 15;
	private static readonly STUCK_THRESHOLD_MIN_MINUTES = 5;
	private static readonly STUCK_THRESHOLD_MAX_MINUTES = 60;
	private static readonly MAX_VISIBLE_AGENTS_DEFAULT = 50;
	private static readonly COMPLETED_TASK_LIMIT_DEFAULT = 10;
	/**
	 * Tail window used when resolving a stream file's last event line. Agent
	 * stream JSONL files grow without bound while a task runs, so large files are
	 * read from this bounded window instead of in full (see
	 * {@link readLastNonEmptyStreamLine}).
	 */
	private static readonly STREAM_TAIL_BYTES = 64 * 1024;
	private static readonly STREAM_BACKEND_PREFIXES = [
		"claude",
		"codex",
		"gemini",
	];

	private _onDidChangeTreeData = new vscode.EventEmitter<
		AgentNode | undefined | null
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _onAgentEvent = new vscode.EventEmitter<AgentEvent>();
	readonly onAgentEvent = this._onAgentEvent.event;

	private registry: TaskRegistry = { version: 2, tasks: {} };
	private fileWatchers: vscode.FileSystemWatcher[] = [];
	private _nativeWatchers: fs.FSWatcher[] = [];
	private _filePath: string | null = null;
	private _filePaths: string[] = [];
	/** Record-level ingest mode per resolved registry path (default `all`). */
	private _fileIngestModes = new Map<string, TaskRegistryIngest>();
	private disposables: vscode.Disposable[] = [];
	private debounceTimer: NodeJS.Timeout | null = null;
	private autoRefreshTimer: NodeJS.Timeout | null = null;
	private treeRefreshTimer: NodeJS.Timeout | null = null;
	private pendingGlobalRefresh = false;
	private pendingElementRefreshes = new Map<string, AgentNode>();
	private previousStatuses = new Map<string, string>();
	/**
	 * Tracks the terminal-run key (`<status>::<started_at>`) we last fired a
	 * completion/failure notification for, per task id. Guards against
	 * registry read-race flaps re-firing duplicate toasts/sounds for the same
	 * run — see {@link shouldNotifyTerminalTransition}.
	 */
	private notifiedTerminalRuns = new Map<string, string>();
	private _agentRegistry: AgentRegistry | null = null;
	private _discoveredAgents: DiscoveredAgent[] = [];
	private _allDiscoveredAgents: DiscoveredAgent[] = [];
	/** Cached port detection results per task ID (undefined = not yet detected) */
	private _portCache = new Map<string, ListeningPort[]>();
	/** Task IDs with ongoing async port detection */
	private _portDetecting = new Set<string>();
	/** Cached prompt summaries per file path */
	private _promptCache = new Map<string, string>();
	/** Cached prompt summaries for discovered agents keyed by sessionId or pid */
	private _discoveredPromptCache = new Map<string, string>();
	/** Cached diff summaries keyed by task/discovered cache key */
	private _diffSummaryCache = new Map<string, string | null>();
	/** Cache keys with ongoing async diff summary calculation */
	private _diffSummaryDetecting = new Set<string>();
	/** Tracks malformed/unsupported registry issues for inline error state */
	private _registryLoadIssue: string | null = null;
	/** First read loading indicator (shown only before initial reload finishes) */
	private _initialReadInProgress = true;
	private _lastLoggedTasksFilePath: string | null = null;
	/**
	 * Whether the deprecated `legacyLauncherTasks.enabled` diagnostics escape
	 * hatch is on — surfaces a warning row at the tree root so full launcher
	 * ingestion is never mistaken for the primary truth surface.
	 */
	private _legacyDiagnosticsEnabled = false;
	private _agentStatusView: vscode.TreeView<AgentNode> | null = null;
	private previousStuckStates = new Map<string, boolean>();
	private hasInitializedStuckState = false;
	private staleTaskReasons = new Map<string, string>();
	private readonly tmuxLiveness = new TmuxLivenessChecker();
	private readonly registryReader = new TaskRegistryReader();
	// CCSYNC-03 (PAR-228): cached live-pane attention classification, warmed by
	// the render path (subprocess capture-pane) and read cache-only on the
	// `getNodeStatusGroup` hot path so benign live shells are not badge-counted.
	private readonly _tmuxPaneAttentionCache = new TtlCache<PaneAttentionState>(
		5_000,
	);
	private readonly _handoffFileCache = new TtlCache<DeclaredHandoffState>(
		5_000,
	);
	private readonly _reviewQueueCache = new TtlCache<AdvertisedReviewQueueState>(
		5_000,
	);
	private readonly _persistSessionHealthCache = new TtlCache<boolean>(5_000);
	/** TTL cache for stream file path resolution, keyed by task.id (TTL 5s) */
	private _streamFilePathCache = new Map<
		string,
		{ path: string | null; checkedAt: number }
	>();
	/** TTL cache for getStreamTerminalState results, keyed by task.id (TTL 5s) */
	private _streamTerminalStateCache = new Map<
		string,
		{
			state: {
				status: "completed" | "failed";
				reason?: string;
				completedAt?: string;
				exitCode?: number | null;
			} | null;
			checkedAt: number;
		}
	>();
	/** TTL cache for hasCommitsSinceStart, keyed by `taskId::startCommit` (TTL 30s) */
	private _commitsSinceStartCache = new Map<
		string,
		{ result: boolean; checkedAt: number }
	>();
	/**
	 * Per-render-cycle memoization for getDisplayLauncherTasks().
	 *
	 * Populated on the first call within a synchronous burst; the cached result
	 * is only returned when `this.registry` is the same object as when the
	 * cache was populated (i.e. no reload/test-helper assignment happened).
	 * Additionally invalidated via queueMicrotask so each new event-loop entry
	 * recomputes even when the registry object is stable.
	 */
	private _displayTasksRenderCache: AgentTask[] | null = null;
	private _displayTasksCachedRegistry: TaskRegistry | null = null;
	private projectIconManager: ProjectIconManager;
	/** Project filter: when set, only show agents from this project dir */
	private _projectFilter: string | null = null;
	private _openclawConfigService: OpenClawConfigService | null = null;
	private _openclawTaskService: OpenClawTaskService | null = null;
	private _acpSessionService: AcpSessionService | null = null;
	private _taskFlowService: TaskFlowService | null = null;
	private _reviewTracker: ReviewTracker = new ReviewTracker();
	/**
	 * In-memory override for the active release/reset generation. Null in
	 * production (the real source is the launcher state file — see
	 * {@link getCurrentReleaseGeneration}); tests set this seam to exercise the
	 * guard without an on-disk baseline.
	 */
	private _currentReleaseGenerationOverride: string | null = null;
	/**
	 * Short-lived memo of the canonical current-generation token read from the
	 * launcher baseline file. The baseline only changes on release, so a small
	 * TTL is ample and keeps the per-render hot path off the filesystem.
	 */
	private _currentGenerationCache: {
		path: string | null;
		token: string | null;
		checkedAt: number;
	} | null = null;
	private codexRunObserverService: CodexRunObserverService;
	private readonly viewMode: AgentStatusTreeViewMode;
	private readonly projectRefResolver: ProjectRefResolver;

	constructor(
		projectIconManager?: ProjectIconManager,
		codexRunObserverService?: CodexRunObserverService,
		options: AgentStatusTreeProviderOptions = {},
	) {
		this.projectIconManager = projectIconManager ?? new ProjectIconManager();
		this.codexRunObserverService =
			codexRunObserverService ?? new CodexRunObserverService();
		this.viewMode = options.viewMode ?? "agentStatus";
		this.projectRefResolver =
			options.projectRefResolver ?? nullProjectRefResolver;
		// Watch config changes for the tasks file path
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.agentTasksFile")) {
					this.setupFileWatch();
					void this.reload();
				}
				if (e.affectsConfiguration("commandCentral.agentTasksFiles")) {
					this.setupFileWatch();
					void this.reload();
				}
				if (
					e.affectsConfiguration("commandCentral.legacyLauncherTasks.enabled")
				) {
					this.setupFileWatch();
					void this.reload();
				}
				if (e.affectsConfiguration("commandCentral.laneRegistry.files")) {
					this.setupFileWatch();
					void this.reload();
				}
				if (
					e.affectsConfiguration("commandCentral.agentStatus.groupByProject") ||
					e.affectsConfiguration(
						"commandCentral.agentStatus.completedTaskLimit",
					) ||
					e.affectsConfiguration("commandCentral.project.group") ||
					e.affectsConfiguration("commandCentral.project.icon") ||
					e.affectsConfiguration("commandCentral.projects")
				) {
					this.scheduleTreeRefresh();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.setupFileWatch();
				void this.reload();
			}),
		);
		this.setupFileWatch();
		if (process.env["NODE_ENV"] === "test") {
			this.reload();
		} else {
			void Promise.resolve().then(() => this.reload());
		}
		this.initDiscovery();
	}

	/** Initialize discovery module if enabled in config */
	private initDiscovery(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const enabled = config.get<boolean>("discovery.enabled", true);
		if (!enabled) return;

		this._agentRegistry = new AgentRegistry();
		this._agentRegistry.start();
		this._allDiscoveredAgents = this._agentRegistry.getAllDiscovered();
		this._discoveredAgents = this._agentRegistry.getDiscoveredAgents(
			this.getLauncherTasks(),
		);

		// Refresh tree when discovered agents change
		this.disposables.push(
			this._agentRegistry.onDidChangeAgents(() => {
				this._allDiscoveredAgents = this._agentRegistry
					? this._agentRegistry.getAllDiscovered()
					: [];
				this._discoveredAgents = this._agentRegistry
					? this._agentRegistry.getDiscoveredAgents(this.getLauncherTasks())
					: [];
				this.setHasAgentsContext();
				this.updateDockBadge();
				this.scheduleTreeRefresh();
			}),
		);

		// React to discovery enabled/disabled changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("commandCentral.discovery.enabled")) {
					const nowEnabled = vscode.workspace
						.getConfiguration("commandCentral")
						.get<boolean>("discovery.enabled", true);
					if (!nowEnabled && this._agentRegistry) {
						this._agentRegistry.dispose();
						this._agentRegistry = null;
						this._discoveredAgents = [];
						this._allDiscoveredAgents = [];
						this.setHasAgentsContext();
						this.scheduleTreeRefresh();
					} else if (nowEnabled && !this._agentRegistry) {
						this.initDiscovery();
					}
				}
			}),
		);
	}

	/** Public accessor for the configured file path */
	get filePath(): string | null {
		return this._filePath;
	}

	get filePaths(): string[] {
		return [...this._filePaths];
	}

	setTreeView(treeView: vscode.TreeView<AgentNode>): void {
		this._agentStatusView = treeView;
		this.updateDockBadge();
	}

	/** Filter the tree to show only agents from the given project dir. Pass null to clear. */
	filterToProject(projectDir: string | null): void {
		this._projectFilter = projectDir;
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.agentStatus.projectFilterActive",
			projectDir != null,
		);
		if (this._agentStatusView) {
			this._agentStatusView.description = projectDir
				? `Filtered: ${path.basename(projectDir)}`
				: undefined;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Get the current project filter dir (if any). */
	get projectFilter(): string | null {
		return this._projectFilter;
	}

	/** Filter to the project that owns the currently active editor file. */
	filterToCurrentProject(): void {
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		if (!activeUri) {
			vscode.window.showInformationMessage(
				"No active editor — cannot determine current project.",
			);
			return;
		}
		const filePath = activeUri.fsPath;
		// Find which project dir the file belongs to
		const tasks = this.getTasks();
		const match = tasks.find(
			(t) => t.project_dir && filePath.startsWith(t.project_dir),
		);
		if (match?.project_dir) {
			this.filterToProject(match.project_dir);
		} else {
			vscode.window.showInformationMessage(
				"No agent project found for the active editor file.",
			);
		}
	}

	/** Return all known project directories from tasks and discovered agents. */
	getKnownProjectDirs(): string[] {
		const dirs = new Set<string>();
		for (const task of this.getScopedLauncherTasks()) {
			if (task.project_dir) dirs.add(task.project_dir);
		}
		for (const agent of this.getScopedDiscoveredAgents()) {
			dirs.add(this.getDiscoveredProjectDir(agent));
		}
		return Array.from(dirs).sort();
	}

	setOpenClawConfigService(service: OpenClawConfigService): void {
		this._openclawConfigService = service;
	}

	setOpenClawTaskService(service: OpenClawTaskService): void {
		this._openclawTaskService = service;
	}

	setAcpSessionService(service: AcpSessionService): void {
		this._acpSessionService = service;
	}

	setTaskFlowService(service: TaskFlowService): void {
		this._taskFlowService = service;
	}

	setReviewTracker(tracker: ReviewTracker): void {
		this._reviewTracker = tracker;
	}

	markTaskReviewed(taskId: string): void {
		this._reviewTracker.markReviewed(taskId);
		// Reviewed state feeds status grouping (a reviewed task leaves the
		// Attention bucket), so a full rebuild is required — an element-level
		// refresh would update the badge but leave the row in the old group.
		this.scheduleTreeRefresh();
	}

	getReviewedTaskIds(): Set<string> {
		return this._reviewTracker.getReviewedIds();
	}

	findTaskElement(taskId: string): TreeElement | undefined {
		const task = this.getDisplayTaskById(taskId);
		if (!task) return undefined;
		const scopedTasks = this.isRunningOnlyFilterEnabled()
			? this.getScopedLauncherTasks().filter((t) => t.status === "running")
			: this.getScopedLauncherTasks();
		if (!scopedTasks.some((t) => t.id === taskId)) return undefined;
		return { type: "task", task };
	}

	private getRefreshElementKey(element: AgentNode): string | null {
		// Use the same canonical identity as TreeItem.id. Refresh coalescing does
		// not get a parallel key scheme: if a node cannot be identified safely for
		// VS Code tree identity, fall back to a full refresh instead of inventing a
		// second, potentially divergent identity path.
		return this.getStableTreeItemId(element) ?? null;
	}

	private scheduleTreeRefresh(element?: AgentNode): void {
		if (!element) {
			this.pendingGlobalRefresh = true;
			this.pendingElementRefreshes.clear();
		} else if (!this.pendingGlobalRefresh) {
			const key = this.getRefreshElementKey(element);
			if (key) {
				this.pendingElementRefreshes.set(key, element);
			} else {
				this.pendingGlobalRefresh = true;
				this.pendingElementRefreshes.clear();
			}
		}

		if (this.treeRefreshTimer) return;
		this.treeRefreshTimer = setTimeout(() => {
			this.treeRefreshTimer = null;
			const refreshAll =
				this.pendingGlobalRefresh || this.pendingElementRefreshes.size === 0;
			const elements = refreshAll
				? []
				: [...this.pendingElementRefreshes.values()];
			this.pendingGlobalRefresh = false;
			this.pendingElementRefreshes.clear();

			if (refreshAll) {
				this._onDidChangeTreeData.fire(undefined);
				return;
			}

			for (const pending of elements) {
				this._onDidChangeTreeData.fire(pending);
			}
		}, 16);
	}

	private pruneDiffSummaryCache(
		tasks: AgentTask[],
		discoveredAgents: DiscoveredAgent[],
	): void {
		const validCacheKeys = new Set<string>([
			...tasks.map((task) => this.getTaskDiffCacheKey(task)),
			...discoveredAgents.map((agent) => this.getDiscoveredDiffCacheKey(agent)),
		]);

		for (const key of this._diffSummaryCache.keys()) {
			if (!validCacheKeys.has(key)) {
				this._diffSummaryCache.delete(key);
			}
		}
		for (const key of this._diffSummaryDetecting) {
			if (!validCacheKeys.has(key)) {
				this._diffSummaryDetecting.delete(key);
			}
		}
	}

	private getTaskRefreshElement(taskId: string): AgentNode | undefined {
		return this.findTaskElement(taskId);
	}

	private getConfiguredSources(): ResolvedTaskRegistrySource[] {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const configValue = config.get<string>("agentTasksFile") ?? "";
		const additionalConfigValues = this.getStringArrayConfig(
			config,
			"agentTasksFiles",
		);
		// Zero-config behavior comes from the package.json default
		// (DEFAULT_LANE_REGISTRY_FILES): real VS Code returns it for unset
		// settings. Deliberately no code-side fallback here — config-less hosts
		// (unit-test mocks) must resolve [] so the operator's real $HOME
		// registries never leak into hermetic tests.
		const laneRegistryFiles = this.getStringArrayConfig(
			config,
			"laneRegistry.files",
		);
		const legacyLauncherEnabled =
			config.get<boolean>("legacyLauncherTasks.enabled", false) === true;
		this._legacyDiagnosticsEnabled = legacyLauncherEnabled;
		return resolveTaskRegistrySources(
			configValue,
			additionalConfigValues,
			vscode.workspace.workspaceFolders,
			{ legacyLauncherEnabled, laneRegistryFiles },
		);
	}

	private getStringArrayConfig(
		config: vscode.WorkspaceConfiguration,
		key: string,
	): string[] {
		const value = config.get<unknown>(key, []) ?? [];
		return Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string")
			: [];
	}

	private setupFileWatch(): void {
		for (const watcher of this.fileWatchers) {
			watcher.dispose();
		}
		this.fileWatchers = [];
		for (const watcher of this._nativeWatchers) {
			watcher.close();
		}
		this._nativeWatchers = [];

		// Clear existing debounce timer before setting up new watcher
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		const sources = this.getConfiguredSources();
		const filePaths = sources.map((source) => source.path);
		this._fileIngestModes = new Map(
			sources.map((source) => [source.path, source.ingest]),
		);
		this._filePaths = filePaths;
		this._filePath = filePaths[0] ?? null;
		const filePathLogKey = filePaths.join(", ");
		if (this._lastLoggedTasksFilePath !== filePathLogKey) {
			if (filePaths.length > 0) {
				console.info(
					`[Command Central] Agent Status using tasks file${
						filePaths.length === 1 ? "" : "s"
					}: ${filePathLogKey}`,
				);
			} else {
				console.info(
					"[Command Central] Agent Status has no tasks file configured",
				);
			}
			this._lastLoggedTasksFilePath = filePathLogKey;
			this.registryReader.resetLoggedState();
		}
		if (filePaths.length === 0) return;

		const debouncedReload = () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				void this.reload();
			}, 150);
		};

		for (const filePath of filePaths) {
			// VS Code's createFileSystemWatcher can be unreliable for paths outside
			// the workspace (e.g., ~/.config/). Use both VS Code watcher AND native
			// fs.watch for defense-in-depth — whichever fires first wins via debounce.
			const pattern = new vscode.RelativePattern(
				vscode.Uri.file(path.dirname(filePath)),
				path.basename(filePath),
			);
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			this.fileWatchers.push(watcher);

			this.disposables.push(
				watcher.onDidChange(debouncedReload),
				watcher.onDidCreate(debouncedReload),
				watcher.onDidDelete(debouncedReload),
			);

			// Native fs.watch fallback — watches the directory for changes to the target file
			try {
				const dir = path.dirname(filePath);
				const basename = path.basename(filePath);
				const nativeWatcher = fs.watch(dir, (_eventType, filename) => {
					if (filename === basename) {
						debouncedReload();
					}
				});
				nativeWatcher.on("error", () => {
					// Silently ignore — VS Code watcher is the primary
				});
				this._nativeWatchers.push(nativeWatcher);
			} catch {
				// Directory doesn't exist yet or not watchable — that's fine
			}
		}
	}

	private getTaskAgeMs(task: AgentTask): number | null {
		const startedMs = new Date(task.started_at).getTime();
		if (!Number.isFinite(startedMs)) return null;
		return Math.max(0, Date.now() - startedMs);
	}

	private hasLiveDiscoveredSession(task: AgentTask): boolean {
		if (!task.session_id) return false;
		return this._allDiscoveredAgents.some(
			(agent) => agent.sessionId === task.session_id,
		);
	}

	/**
	 * Public click-time liveness check for command handlers in extension.ts.
	 *
	 * Delegates to the tmux liveness checker's 5s-TTL cache so callers reuse
	 * the tree-render probe result rather than shelling out a separate
	 * `has-session` per click. Returns `false` immediately for remote-node
	 * tasks (wrong host) and for missing/invalid session IDs.
	 */
	public isTaskTmuxSessionAlive(task: AgentTask): boolean {
		if (!task.session_id || !isValidSessionId(task.session_id)) return false;
		if (isRemoteNodeTaskForCurrentHost(task)) return false;
		return this.isTmuxSessionAlive(task.session_id, task.tmux_socket);
	}

	private isTmuxSessionAlive(
		sessionId: string,
		socketPath?: string | null,
	): boolean {
		return this.tmuxLiveness.isSessionAlive(sessionId, socketPath);
	}

	private isTmuxPaneAgentHealthy(task: AgentTask): boolean {
		return this.tmuxLiveness.isPaneAgentHealthy(task);
	}

	private getTmuxPaneAgentEvidence(task: AgentTask): TmuxPaneAgentEvidence {
		return this.tmuxLiveness.getPaneAgentEvidence(task);
	}

	private getDeclaredHandoffState(task: AgentTask): DeclaredHandoffState {
		// Local file probes are only evidence about this host — remote/node-
		// origin tasks (or node tasks whose host we can't verify) stay unknown.
		if (!isLocalFileProbeAuthoritative(task)) return "unknown";

		const cacheKey = `${task.project_dir}::${task.handoff_file ?? ""}`;
		const cached = this._handoffFileCache.getFresh(cacheKey);
		if (cached !== undefined) return cached;
		const state = checkDeclaredHandoff(task);
		this._handoffFileCache.set(cacheKey, state);
		return state;
	}

	private getPendingReviewQueueState(
		task: AgentTask,
	): AdvertisedReviewQueueState {
		// Local file probes are only evidence about this host — remote/node-
		// origin tasks (or node tasks whose host we can't verify) stay unknown.
		if (!isLocalFileProbeAuthoritative(task)) return "unknown";

		const cacheKey = `${task.project_dir}::${task.pending_review_path ?? ""}`;
		const cached = this._reviewQueueCache.getFresh(cacheKey);
		if (cached !== undefined) return cached;
		const state = checkAdvertisedReviewQueue(task);
		this._reviewQueueCache.set(cacheKey, state);
		return state;
	}

	/**
	 * True when this task advertised a pending-review receipt that should
	 * exist on this machine but does not — i.e. the review-queue intake
	 * genuinely failed and the task would never reach a reviewer.
	 *
	 * Source-of-truth order (both gates must pass before "missing" counts):
	 * 1. Review metadata wins. Once the launcher records the review as
	 *    resolved (review_status=approved or review_state=reviewed/
	 *    no_review_expected), the review flow has consumed the receipt and
	 *    its absence is the expected steady state, not a gap.
	 * 2. Local probes only apply to local tasks. Remote/node-origin tasks
	 *    return "unknown" from getPendingReviewQueueState, never "missing" —
	 *    a path like /tmp/oste-pending-review/… is only meaningful on the
	 *    host that executed the task.
	 */
	private isReviewQueueReceiptMissing(task: AgentTask): boolean {
		if (isReviewLifecycleResolved(task)) return false;
		// A reviewer lane is never owed a review of ITSELF (no_review_expected):
		// its handoff IS the review artifact. A stale row may still carry a
		// self-referential pending_review_path whose receipt is absent — that
		// absence is the expected steady state for a reviewer lane, not a
		// review-queue gap, so it must not surface as "review receipt missing".
		if (isReviewOnlyLane(task)) return false;
		if (!task.pending_review_path) return false;
		if (this.getPendingReviewQueueState(task) !== "missing") return false;
		// The active receipt is gone — but before flagging a queue gap, honor the
		// reviewed archive: a manual review may have marked the SOURCE receipt
		// reviewed (and the launcher snapshots it under reviewed/) even though
		// this task's tasks.json row never refreshed its review_state.
		if (this.isPendingReviewReceiptReviewed(task)) return false;
		return true;
	}

	/**
	 * Whether the lane has positive evidence that its pane/process is still
	 * alive — the cache-only tmux probe says "alive", or the launcher's own
	 * recorded `session_live` corroborates it. Cache-only / metadata-only so it
	 * is safe on the `getNodeStatusGroup` hot path.
	 */
	private hasLivePaneOrProcessEvidence(task: AgentTask): boolean {
		if (this.getCachedTerminalTaskLivenessEvidence(task) === "alive") {
			return true;
		}
		return this.effectiveLauncherSessionLive(task) === true;
	}

	/**
	 * CCSYNC-01: a terminal row whose review metadata still claims `pending`
	 * (review_status="pending" or a `pending`-ish launcher review_state) but
	 * whose advertised pending-review receipt is MISSING locally AND that has no
	 * live pane/process evidence is a stale read-model projection — the launcher
	 * settled the lane (or the receipt was consumed) and the row simply never
	 * refreshed. Such a row must NOT be counted as attention-required work; it
	 * is reconciliation backlog that belongs in Needs Review (limbo), never the
	 * activity-bar action badge.
	 *
	 * Gated narrowly so genuine attention work is preserved:
	 *  - a present receipt → a real pending review the reviewer can act on.
	 *  - live pane/process evidence → the lane is actually live, not stale.
	 *  - a remote/node row (non-authoritative local probe) → receipt state is
	 *    "unknown", never "missing", so isReviewQueueReceiptMissing returns
	 *    false and this predicate stays false (judged by metadata, not a probe).
	 */
	private isStaleReviewProjection(task: AgentTask): boolean {
		// CCSYNC-02: an authoritative lane-projection GC pass already classified
		// this row as no longer live attention work (downgraded/archived/removed).
		// The GC receipt verdict is authoritative reconciliation truth, so honor
		// it directly instead of re-deriving from live FS state on the hot path.
		if (this.isGcReconciledRow(task)) return true;
		if (!this.isReviewPendingProjection(task)) return false;
		if (!this.isReviewQueueReceiptMissing(task)) return false;
		if (this.hasLivePaneOrProcessEvidence(task)) return false;
		return true;
	}

	/**
	 * CCSYNC-02: whether a lane-projection GC pass downgraded/archived/removed
	 * this row (stamped by {@link applyGcReceiptReconciliation}). A
	 * reconciled-out row is reconciliation backlog, never attention work.
	 * Metadata-only — safe on the `getNodeStatusGroup` hot path.
	 */
	private isGcReconciledRow(task: AgentTask): boolean {
		return task.gc_reconcile !== undefined;
	}

	/**
	 * Whether the lane's recorded review metadata advertises a still-pending
	 * review — either the structured `review_status="pending"` or a launcher
	 * `review_state` that means "review not yet settled" (pending). Reviewed /
	 * no_review_expected / approved are settled and handled elsewhere.
	 */
	private isReviewPendingProjection(task: AgentTask): boolean {
		if (task.review_status === "pending") return true;
		return task.review_state?.trim().toLowerCase() === "pending";
	}

	/**
	 * Whether the launcher's pending-review receipt records THIS task's review
	 * as reviewed — ground truth that OVERRIDES a stale tasks.json review_state.
	 *
	 * Symphony dogfood gap (2026-06-16): auto-review dispatch failed
	 * (spawn_failed) leaving review_state="reviewing" on the receipt AND the
	 * task row; a separate manual review lane later marked the SOURCE receipt
	 * reviewed (review_state="reviewed", reviewed:true) and the launcher
	 * snapshotted it to the reviewed/ archive — but the tasks.json task-row
	 * projection never refreshed. The receipt (active file, else the reviewed/
	 * archive snapshot) is authoritative, so a reviewed receipt resolves the
	 * review lifecycle even when the row still says reviewing/pending.
	 *
	 * Gated on a declared pending_review_path (no review expected → nothing to
	 * reconcile) and isLocalFileProbeAuthoritative (a receipt path under
	 * /tmp/oste-pending-review is only meaningful on the host that ran the
	 * task — see TODO(work-system) in agent-task-classification.ts).
	 */
	private isPendingReviewReceiptReviewed(task: AgentTask): boolean {
		if (!task.pending_review_path) return false;
		if (!isLocalFileProbeAuthoritative(task)) return false;
		const receipt = readReviewedReceipt(task.id);
		return receipt ? isReceiptReviewed(receipt) : false;
	}

	/**
	 * A task counts as reviewed when the local ReviewTracker sidecar marked it
	 * OR the launcher's pending-review receipt records it reviewed. The receipt
	 * is the cross-machine source of truth a separate manual-review lane writes,
	 * so it surfaces the ✓ badge and clears the Attention bucket even when this
	 * hub never ran "Mark Agent Reviewed" and the task row is stale.
	 */
	private isTaskReviewed(task: AgentTask): boolean {
		return (
			this._reviewTracker.isReviewed(task.id) ||
			this.isPendingReviewReceiptReviewed(task)
		);
	}

	/**
	 * Checks whether a specific tmux window (by `@N` ID) still exists.
	 * More accurate than `isTmuxSessionAlive` for multi-window sessions where
	 * multiple tasks share a single session but occupy distinct windows.
	 */
	private isTmuxWindowAlive(
		sessionId: string,
		windowId: string,
		socketPath?: string | null,
	): boolean {
		return this.tmuxLiveness.isWindowAlive(sessionId, windowId, socketPath);
	}

	private getPersistSocketPath(task: AgentTask): string | null {
		if (task.persist_socket) return task.persist_socket;
		if (!isValidSessionId(task.session_id)) return null;
		return path.join(
			os.homedir(),
			".local",
			"share",
			"cc",
			"sockets",
			`${task.session_id}.sock`,
		);
	}

	private isPersistTaskAlive(task: AgentTask): boolean {
		const socketPath = this.getPersistSocketPath(task);
		if (!socketPath) return false;

		const cached = this._persistSessionHealthCache.getFresh(socketPath);
		if (cached !== undefined) return cached;

		const alive = checkPersistSessionAlive(socketPath);
		this._persistSessionHealthCache.set(socketPath, alive);
		return alive;
	}

	private isRunningTaskHealthy(task: AgentTask): boolean {
		if (task.status !== "running") return true;
		if (isRemoteNodeTaskForCurrentHost(task)) return true;

		const ageMs = this.getTaskAgeMs(task);
		const staleThresholdMs = Math.max(
			60 * 60_000,
			this.getStuckThresholdMinutes() * 60_000 * 4,
		);
		const looksStale =
			ageMs !== null && ageMs >= staleThresholdMs && this.isAgentStuck(task);

		if (task.terminal_backend === "persist") {
			if (!this.isPersistTaskAlive(task)) return false;
			return !looksStale;
		}

		// Backward compatibility: tasks without terminal_backend were tmux-backed.
		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === undefined) &&
			isValidSessionId(task.session_id)
		) {
			// Use window-level check when available — more accurate for multi-window
			// sessions where all tasks share the same session ID.
			const windowAlive = task.tmux_window_id
				? this.isTmuxWindowAlive(
						task.session_id,
						task.tmux_window_id,
						task.tmux_socket,
					)
				: this.isTmuxSessionAlive(task.session_id, task.tmux_socket);
			if (!windowAlive) return false;
			const paneEvidence = this.getTmuxPaneAgentEvidence(task);
			if (paneEvidence === "dead") return false;
			// Positive pane evidence is authoritative for launcher-managed work:
			// the user is actively in the lane (interactive Claude / awaiting
			// input). Don't downgrade to stale just because the JSONL stream is
			// silent — interactive REPL turns frequently produce no stream.
			if (paneEvidence === "alive") return true;
			// "unknown" (fail-open): if discovery cross-validates the session is
			// live, that is also positive evidence of the lane being alive.
			if (this.hasLiveDiscoveredSession(task)) return true;
			return !looksStale;
		}

		// Non-tmux, non-persist (e.g. external terminal discovery). If process
		// discovery confirms the session is live, treat that as positive
		// evidence of an active lane and skip the stream-staleness downgrade.
		if (this.hasLiveDiscoveredSession(task)) return true;
		return !looksStale;
	}

	/**
	 * True when there is positive evidence that the launcher-managed lane is
	 * still alive — distinct from "we couldn't tell". Used to suppress
	 * stuck-warning UI for tasks that are interactive/awaiting-input rather
	 * than actually wedged.
	 */
	private hasPositiveLivenessEvidence(task: AgentTask): boolean {
		if (task.status !== "running") return false;
		if (isRemoteNodeTaskForCurrentHost(task)) return true;
		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === undefined) &&
			isValidSessionId(task.session_id)
		) {
			if (this.getTmuxPaneAgentEvidence(task) === "alive") return true;
		}
		if (this.hasLiveDiscoveredSession(task)) return true;
		return false;
	}

	/**
	 * Probe tmux liveness for a task whose status is already terminal.
	 * Returns the raw evidence tri-state or "not-checked" when the task
	 * lacks tmux metadata or is remote. Used by rendering to detect
	 * lifecycle conflicts (launcher says dead, but process is alive).
	 */
	private getTerminalTaskLivenessEvidence(
		task: AgentTask,
	): "alive" | "dead" | "unknown" | "not-checked" {
		if (isRemoteNodeTaskForCurrentHost(task)) return "not-checked";
		if (
			(task.terminal_backend !== "tmux" &&
				task.terminal_backend !== undefined) ||
			!isValidSessionId(task.session_id)
		) {
			return "not-checked";
		}
		return this.getTmuxPaneAgentEvidence(task);
	}

	/**
	 * Cache-only variant of `getTerminalTaskLivenessEvidence`. Returns warm
	 * cached evidence when available, "not-checked" otherwise. Safe to call
	 * on the hot path (e.g. `getNodeStatusGroup`) because it never triggers
	 * subprocess calls. The evidence cache is warmed by `getTreeItem`
	 * rendering; subsequent refresh cycles will have correct grouping.
	 */
	private getCachedTerminalTaskLivenessEvidence(
		task: AgentTask,
	): "alive" | "dead" | "unknown" | "not-checked" {
		if (isRemoteNodeTaskForCurrentHost(task)) return "not-checked";
		if (
			(task.terminal_backend !== "tmux" &&
				task.terminal_backend !== undefined) ||
			!isValidSessionId(task.session_id)
		) {
			return "not-checked";
		}
		return this.tmuxLiveness.peekPaneAgentEvidence(task) ?? "not-checked";
	}

	/**
	 * The tmux target (a `%NN` pane id when recorded, else the session id) the
	 * attention classifier reads, plus the cache key. Mirrors the pane/session
	 * targeting `getTmuxPaneAgentEvidence` already uses so a shared pane in a
	 * shared session is classified from the exact pane, not a sibling.
	 */
	private getTmuxPaneAttentionTarget(
		task: AgentTask,
	): { target: string; cacheKey: string } | null {
		if (isRemoteNodeTaskForCurrentHost(task)) return null;
		if (
			(task.terminal_backend !== "tmux" &&
				task.terminal_backend !== undefined) ||
			!isValidSessionId(task.session_id)
		) {
			return null;
		}
		if (task.tmux_pane_id) {
			return {
				target: task.tmux_pane_id,
				cacheKey: `${task.tmux_socket ?? "__default__"}::pane::${task.tmux_pane_id}`,
			};
		}
		return {
			target: task.session_id,
			cacheKey: `${task.tmux_socket ?? "__default__"}::${task.session_id}`,
		};
	}

	/**
	 * CCSYNC-03 (PAR-228): WARM the live-pane attention classification by
	 * capturing a recent pane snippet (subprocess) and running the pure
	 * {@link classifyPaneAttention}. Read-only w.r.t. the terminal. Called from
	 * the render path alongside the liveness probe so the `getNodeStatusGroup`
	 * hot path can read it cache-only. Returns "unknown" when the task has no
	 * probe-able pane/session.
	 */
	private getTerminalTaskPaneAttention(task: AgentTask): PaneAttentionState {
		const targetInfo = this.getTmuxPaneAttentionTarget(task);
		if (!targetInfo) return "unknown";
		const cached = this._tmuxPaneAttentionCache.getFresh(targetInfo.cacheKey);
		if (cached !== undefined) return cached;
		// An agent process owning the pane is the strongest signal — reuse the
		// already-warmed liveness evidence so an "alive" pane is never demoted to
		// a benign state by a snippet that happens to look quiet.
		const agentOwned = this.getTerminalTaskLivenessEvidence(task) === "alive";
		const snippet = capturePaneSnippet(targetInfo.target, task.tmux_socket);
		const state = classifyPaneAttention(
			agentOwned ? "claude" : undefined,
			snippet ?? "",
		);
		this._tmuxPaneAttentionCache.set(targetInfo.cacheKey, state);
		return state;
	}

	/**
	 * Cache-only variant of {@link getTerminalTaskPaneAttention}. Returns warm
	 * cached state when available, "unknown" otherwise (never spawns a
	 * subprocess). Safe on the `getNodeStatusGroup` hot path; the cache is warmed
	 * by `getTreeItem` rendering.
	 */
	private getCachedTerminalTaskPaneAttention(
		task: AgentTask,
	): PaneAttentionState {
		const targetInfo = this.getTmuxPaneAttentionTarget(task);
		if (!targetInfo) return "unknown";
		return (
			this._tmuxPaneAttentionCache.getFresh(targetInfo.cacheKey) ?? "unknown"
		);
	}

	/**
	 * CCSYNC-03 (PAR-228): whether a terminal-status lane's lifecycle-conflict
	 * promotion into the badge-counted `attention` bucket should be SUPPRESSED
	 * because its live pane is benign — a finished command sitting at its prompt
	 * or a bare/idle shell. A genuine "awaiting-user-input" pane (or an unknown
	 * one) is never suppressed: attention is preserved when in doubt.
	 *
	 * Cache-only — safe on the `getNodeStatusGroup` hot path.
	 */
	private isBenignLiveTerminalPane(task: AgentTask): boolean {
		return isBenignLivePane(this.getCachedTerminalTaskPaneAttention(task));
	}

	private static readonly RELEASE_GENERATION_CACHE_TTL_MS = 5_000;

	/**
	 * The active release/reset generation token, or null when unknown.
	 *
	 * Source of truth: the launcher's `release-generation.json` baseline written
	 * by `ghostty-launcher/scripts/oste-terminal-generation.sh stamp`, reduced to
	 * a canonical token by {@link canonicalGenerationToken}. A lane carrying a
	 * different generation token is a pre-reset leftover (see
	 * {@link isSupersededByReleaseReset}). When no source is configured/present
	 * the token is null and the staleness guard is a safe no-op. The in-memory
	 * override short-circuits the file read for tests.
	 */
	private getCurrentReleaseGeneration(): string | null {
		if (this._currentReleaseGenerationOverride !== null) {
			return this._currentReleaseGenerationOverride;
		}
		return this.readCurrentReleaseGenerationFromState();
	}

	/**
	 * Resolve the launcher release-generation baseline file path, or null when no
	 * source is configured. Config-less hosts (unit-test mocks) resolve null, so
	 * the operator's real $HOME baseline never leaks into hermetic tests — the
	 * same discipline as the lane-registry default.
	 *
	 * Precedence (env first, matching the launcher tool's own override so CC and
	 * the launcher agree on relocated state):
	 *   1. `OSTE_RELEASE_GENERATION_FILE` env var — the launcher tool's override.
	 *   2. `commandCentral.releaseGeneration.file` setting — operator override.
	 * The well-known default (`~/.config/ghostty-launcher/release-generation.json`)
	 * is contributed in package.json, so no user-specific absolute path lives in
	 * code and real VS Code surfaces it through the setting.
	 */
	private getReleaseGenerationFilePath(): string | null {
		const envPath = asString(process.env["OSTE_RELEASE_GENERATION_FILE"]);
		if (envPath) return expandHomePath(envPath);
		const configured = asString(
			vscode.workspace
				.getConfiguration("commandCentral")
				.get<string>("releaseGeneration.file", ""),
		);
		if (configured) return expandHomePath(configured);
		return null;
	}

	/**
	 * Read and canonicalize the current generation from the launcher baseline.
	 * Missing file or malformed JSON → null (no throw, guard stays inert).
	 * Memoized briefly so the per-render hot path does not re-stat the file.
	 */
	private readCurrentReleaseGenerationFromState(): string | null {
		const filePath = this.getReleaseGenerationFilePath();
		if (!filePath) return null;
		const now = Date.now();
		const cached = this._currentGenerationCache;
		if (
			cached &&
			cached.path === filePath &&
			now - cached.checkedAt <
				AgentStatusTreeProvider.RELEASE_GENERATION_CACHE_TTL_MS
		) {
			return cached.token;
		}
		let token: string | null = null;
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			token = canonicalGenerationToken(JSON.parse(raw));
		} catch {
			// Missing file or malformed JSON → no current generation known.
			token = null;
		}
		this._currentGenerationCache = { path: filePath, token, checkedAt: now };
		return token;
	}

	/**
	 * The launcher's recorded `session_live` to TRUST for liveness — suppressed
	 * (→ null) when the lane belongs to a superseded Ghostty-app/release
	 * generation. A pre-reset app's `session_live: true` was recorded under the
	 * OLD generation and must not corroborate a "current live" verdict. A
	 * real-time tmux probe is unaffected here (it is gated separately at the
	 * render site) — this only governs the cheap recorded-belief fallback.
	 */
	private effectiveLauncherSessionLive(task: AgentTask): boolean | null {
		if (isSupersededByReleaseReset(task, this.getCurrentReleaseGeneration())) {
			return null;
		}
		return task.session_live ?? null;
	}

	/**
	 * Reconcile a raw tasks.json record into a display-ready AgentTask.
	 *
	 * Source-of-truth hierarchy (highest → lowest):
	 *
	 *   Tier 1 — Launcher-local authoritative state
	 *     1a. tasks.json terminal status (completed / failed / stopped / ...)
	 *         is already final; return unchanged.
	 *     1b. Pending-review receipt (`/tmp/oste-pending-review/<id>.json`)
	 *         written by `oste-complete.sh` the moment the agent really
	 *         finishes. Overlays a `running` entry that tasks.json has not
	 *         yet caught up to.
	 *
	 *   Tier 2 — Launcher-local secondary signals
	 *     2a. CC staleness cache (`staleTaskReasons`) populated during prior
	 *         reconciliations — sticky so a task doesn't bounce back to
	 *         `running` once we've decided it's stale.
	 *     2b. JSONL stream terminal event (`turn.completed` / `turn.failed`
	 *         / `result`). Authoritative when present because the launcher-
	 *         spawned agent writes it directly.
	 *
	 *   Tier 2c — Launcher completion evidence in tasks.json
	 *     `completed_at` set (no exit_code) → completed.
	 *     `exit_code === 0` → completed.
	 *     non-zero `exit_code` → failed.
	 *     Must run BEFORE the liveness check; a partial-write race can leave
	 *     `status:"running"` while these fields are already set. tmux liveness
	 *     is fail-open (unknown pane → healthy), so completion facts must win.
	 *
	 *   Tier 3 — Liveness overlay (does NOT decide status on its own)
	 *     Tmux pane evidence + discovered-session presence are consulted by
	 *     `isRunningTaskHealthy()` only to decide whether to keep trusting a
	 *     `running` status. They can never promote or demote a task without
	 *     corroborating Tier 1/2 signals.
	 *
	 *   Tier 4 — Last-resort inference (only when Tier 1–3 say "unhealthy")
	 *     4a. Commits since start → completed_dirty.
	 *     4b. Default → stopped.
	 *
	 *   See research/COMMAND-CENTRAL-LAUNCHER-TRUTH-HIERARCHY-2026-04-20.md
	 *   for the full rationale.
	 */
	private toDisplayTask(task: AgentTask): AgentTask {
		// Tier 1b — Pending-review receipt is ground truth for a running task.
		// The launcher's oste-complete.sh writes it the moment the agent
		// actually finishes, which can land before tasks.json is updated. Trust
		// it over both the CC-local staleness cache and the runtime health
		// inference. For non-running statuses, tasks.json itself is already
		// Tier 1a authoritative, so we don't probe.
		if (task.status === "running") {
			const receipt = readPendingReviewReceipt(task.id);
			const overlay = receipt ? receiptToOverlay(receipt) : null;
			if (overlay) {
				return this.applyRuntimeStatusOverlay(task, overlay);
			}

			// Tier 1c — Reviewer-lane delivery. A reviewer lane's job is to
			// PRODUCE a review (its handoff IS the review artifact), not to be
			// reviewed itself (review_state: no_review_expected). When such a lane
			// still reads `running` but has already delivered its review artifact
			// / commit, the launcher's completion hook simply failed to finalize
			// the row — the lane is done. This is launcher-authoritative delivery
			// evidence, so it beats the staleness cache and the liveness inference
			// below (the reviewing agent often lingers at its prompt after
			// finishing, keeping the pane "alive"). Resolves the Symphony dogfood
			// gap where a completed review lane stayed under Live/running.
			const reviewOverlay = this.getDeliveredReviewLaneOverlay(task);
			if (reviewOverlay) {
				return reviewOverlay;
			}
		}

		// Tier 2a — Staleness cache (sticky CC-local decision).
		const staleReason = this.staleTaskReasons.get(task.id);
		if (staleReason) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed_stale",
				reason: staleReason,
			});
		}
		if (task.status !== "running") return task; // Tier 1a: terminal → keep.

		// Tier 2b — JSONL stream terminal event.
		const streamTerminalState = this.getStreamTerminalState(task);
		if (streamTerminalState) {
			return this.applyRuntimeStatusOverlay(task, streamTerminalState);
		}

		// Tier 2c — Launcher completion evidence already in tasks.json.
		// A partial-write race can leave status:"running" while completed_at or
		// exit_code is already set by the completion hook.  These are launcher-
		// authoritative signals and must beat liveness checks: an alive tmux
		// window / fail-open pane inspection must NOT keep a fully-completed
		// task in the "running" group.
		if (task.exit_code === 0 || (task.exit_code == null && task.completed_at)) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed",
				reason: "Completion evidence found in launcher record.",
			});
		}
		if (task.exit_code != null && task.exit_code !== 0) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "failed",
				reason: `Session ended with exit code ${task.exit_code}.`,
			});
		}

		// Tier 3 — Liveness overlay. `isRunningTaskHealthy()` folds tmux pane
		// evidence and discovered-session presence into a single verdict. If it
		// still says "healthy", keep the task as running.
		if (this.isRunningTaskHealthy(task)) return task;

		// Tier 3b — Detached ≠ dead. `isRunningTaskHealthy()` returning false
		// only means we could NOT positively confirm the lane is alive (stale
		// heuristic, silent JSONL, an unrecognized pane command, or a host whose
		// tmux we cannot probe). That is a *visibility* signal, not a terminal
		// one. A registry-`running` lane is only demoted out of the live surface
		// once its session is POSITIVELY confirmed dead — the same gate
		// `getStaleTransitionReason()` already applies before marking a task
		// stale. Otherwise keep it `running` (the renderer badges it detached /
		// possibly-stuck) so a live-but-detached lane never lands in Failed &
		// Stopped. See research/RESULT-cc-current-running-surface-fix-20260613.md.
		if (!this.isTaskSessionConfirmedDead(task)) return task;

		// Tier 4 — Last-resort inference. The session is positively confirmed
		// dead; we have no receipt, no stream terminal event, and no launcher
		// completion evidence.  Commit history is the final fallback.

		// Dirty-exit tasks lack exit_code and completed_at, but may have
		// produced commits.  Check git history as a last-resort signal
		// before defaulting to "stopped".
		if (this.hasCommitsSinceStart(task)) {
			return this.applyRuntimeStatusOverlay(task, {
				status: "completed_dirty",
				reason:
					"Session ended without completion signal, but commits were produced.",
			});
		}

		return this.applyRuntimeStatusOverlay(task, {
			status: "stopped",
			reason: "Session no longer appears active. Showing as stopped.",
		});
	}

	private applyRuntimeStatusOverlay(
		task: AgentTask,
		overlay: {
			status: AgentTaskStatus;
			reason?: string;
			completedAt?: string;
			exitCode?: number | null;
			endCommit?: string | null;
		},
	): AgentTask {
		return {
			...task,
			status: overlay.status,
			completed_at:
				overlay.completedAt ?? task.completed_at ?? new Date().toISOString(),
			exit_code:
				overlay.exitCode === undefined
					? overlay.status === "completed"
						? (task.exit_code ?? 0)
						: task.exit_code
					: overlay.exitCode,
			end_commit: overlay.endCommit ?? task.end_commit,
			error_message:
				overlay.status === "stopped" ||
				overlay.status === "failed" ||
				overlay.status === "completed_stale"
					? (task.error_message ?? overlay.reason ?? null)
					: task.error_message,
		};
	}

	/**
	 * Reconcile a `running` reviewer-lane row that has already delivered its
	 * review, returning a display task finalized to `completed` /
	 * `no_review_expected` — or null when the lane is NOT a reviewer lane, is
	 * not locally probe-able, or has produced no review yet (so a genuinely
	 * in-flight reviewer is preserved as running).
	 *
	 * Why this exists (Symphony dogfood gap, 2026-06-16): review lane
	 * `review-symphony-visible-claude-entrypoint-20260616` finished — it wrote
	 * and committed its `research/REVIEW-…md` artifact and the source task was
	 * marked reviewed — but Command Central kept showing the REVIEW LANE itself
	 * under Live/running. Its lifecycle hook never finalized the row
	 * (status=running, completed_at=null, end_commit=null) and the agent process
	 * lingered at its prompt, so the cheap liveness probe read the pane as
	 * "alive" and every demotion tier was skipped. `oste-complete.sh` later
	 * repaired the projection to completed / no_review_expected.
	 *
	 * Authoritative evidence a reviewer lane is DONE (any one suffices):
	 *  - its declared review handoff artifact exists on disk
	 *    (the reviewer-specific deliverable; "the handoff IS the review"), or
	 *  - it recorded a review commit (`end_commit`).
	 *
	 * Gates:
	 *  - {@link isReviewOnlyLane}: only reviewer lanes are `no_review_expected`.
	 *  - {@link isLocalFileProbeAuthoritative}: a remote node's lane is judged
	 *    by its own metadata, never by a hub-local file probe — so a genuine
	 *    running reviewer on another machine is never demoted from here.
	 *  - a genuinely PRESENT self pending-review receipt aborts the override:
	 *    reviewer lanes are never owed a review of themselves, so a present
	 *    active receipt is anomalous and we defer rather than force-complete.
	 *
	 * Does NOT mutate tasks.json — it only shapes the in-memory display row,
	 * exactly like every other {@link toDisplayTask} overlay.
	 */
	private getDeliveredReviewLaneOverlay(task: AgentTask): AgentTask | null {
		if (task.status !== "running") return null;
		if (!isReviewOnlyLane(task)) return null;
		if (!isLocalFileProbeAuthoritative(task)) return null;
		if (this.getPendingReviewQueueState(task) === "present") return null;

		const artifactDelivered = this.getDeclaredHandoffState(task) === "present";
		const committed = Boolean(task.end_commit) && task.end_commit !== "unknown";
		if (!artifactDelivered && !committed) return null;

		const base = this.applyRuntimeStatusOverlay(task, {
			status: "completed",
			reason:
				"Reviewer lane delivered its review artifact; finalizing stale running row (no_review_expected).",
		});
		// Recover the reviewer-lane disposition the stale row never projected:
		// a reviewer lane is no_review_expected, which also clears the
		// review-receipt-missing limbo gate (isReviewQueueReceiptMissing).
		return { ...base, review_state: "no_review_expected" };
	}

	/**
	 * Check if a task's project has commits after its start_commit.
	 * Used as a last-resort signal for dirty-exit tasks that lack
	 * exit_code and completed_at but actually produced work.
	 */
	private hasCommitsSinceStart(task: AgentTask): boolean {
		const startRef = task.start_commit;
		if (!startRef || startRef === "unknown") return false;
		if (!task.project_dir) return false;
		if (isRemoteNodeTaskForCurrentHost(task)) return false;

		const cacheKey = `${task.id}::${startRef}`;
		const cached = this._commitsSinceStartCache.get(cacheKey);
		const now = Date.now();
		if (cached && now - cached.checkedAt < 30_000) {
			return cached.result;
		}

		let result = false;
		try {
			const output = execFileSync(
				"git",
				["-C", task.project_dir, "rev-list", "--count", `${startRef}..HEAD`],
				{ encoding: "utf-8", timeout: 3000 },
			);
			const count = Number.parseInt(output.trim(), 10);
			result = Number.isFinite(count) && count > 0;
		} catch {
			// Git call failed (missing repo, bad ref, etc.) — fall through.
		}
		this._commitsSinceStartCache.set(cacheKey, { result, checkedAt: now });
		return result;
	}

	private getStreamTerminalState(task: AgentTask): {
		status: "completed" | "failed";
		reason?: string;
		completedAt?: string;
		exitCode?: number | null;
	} | null {
		const now = Date.now();
		const cached = this._streamTerminalStateCache.get(task.id);
		if (cached && now - cached.checkedAt < 5_000) {
			return cached.state;
		}

		const state = this._computeStreamTerminalState(task);
		this._streamTerminalStateCache.set(task.id, { state, checkedAt: now });
		return state;
	}

	private _computeStreamTerminalState(task: AgentTask): {
		status: "completed" | "failed";
		reason?: string;
		completedAt?: string;
		exitCode?: number | null;
	} | null {
		const streamFile = this.resolveStreamFilePath(task);
		if (!streamFile) return null;

		try {
			const lastEventLine = this.readLastNonEmptyStreamLine(streamFile);
			if (!lastEventLine) return null;

			const event = JSON.parse(lastEventLine) as Record<string, unknown>;
			const eventType = asString(event["type"]);
			if (!eventType) return null;

			const completedAt = new Date(
				fs.statSync(streamFile).mtimeMs,
			).toISOString();
			if (eventType === "turn.completed") {
				return { status: "completed", completedAt, exitCode: 0 };
			}
			if (eventType === "turn.failed") {
				const reason =
					event["error"] && typeof event["error"] === "object"
						? asString((event["error"] as Record<string, unknown>)["message"])
						: undefined;
				return {
					status: "failed",
					completedAt,
					reason: reason ?? "Stream ended with a failed turn.",
				};
			}
			if (eventType !== "result") return null;

			const resultStatus = asString(event["status"]);
			if (resultStatus === "success" || event["is_error"] === false) {
				return { status: "completed", completedAt, exitCode: 0 };
			}
			if (resultStatus || event["is_error"] === true) {
				return {
					status: "failed",
					completedAt,
					reason: resultStatus
						? `Stream ended with result status ${resultStatus}.`
						: "Stream ended with an error result.",
				};
			}
		} catch {
			// Ignore malformed or unreadable stream output and fall back to health checks.
		}

		return null;
	}

	/**
	 * Return the last non-empty line of a stream file without reading the whole
	 * file. Agent stream JSONL files grow without bound while a task runs, and
	 * this read sits on the per-running-task classification hot path
	 * ({@link toDisplayTask} → {@link getStreamTerminalState}, 5 s TTL); reading
	 * megabytes just to take the final line blocked the extension host on every
	 * reload/auto-refresh. Large files are read from a bounded tail window
	 * instead. The result is identical to a full read: a single stream event is
	 * far smaller than the window, so the final non-empty line is always inside
	 * it — and the rare oversized-final-line case (a window with no line break)
	 * falls back to a full read so an outsized event still parses exactly as
	 * before.
	 */
	private readLastNonEmptyStreamLine(streamFile: string): string | null {
		const size = fs.statSync(streamFile).size;
		const tailBytes = AgentStatusTreeProvider.STREAM_TAIL_BYTES;
		let content: string;
		if (size <= tailBytes) {
			content = fs.readFileSync(streamFile, "utf-8");
		} else {
			content = this.readFileTailUtf8(streamFile, size, tailBytes);
			// Fall back to a full read when the tail window can't answer the
			// question: no line break means a single final line longer than the
			// window, and an all-blank window means the last non-empty line sits
			// further back. Both fully preserve the original full-read result.
			// Neither shape occurs for real agent streams (which end with the
			// latest event line), so the fast path is the norm.
			if (!content.includes("\n") || content.trim().length === 0) {
				content = fs.readFileSync(streamFile, "utf-8");
			}
		}

		let lastNonEmpty: string | null = null;
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length > 0) lastNonEmpty = trimmed;
		}
		return lastNonEmpty;
	}

	/** Read the final `tailBytes` of a file as UTF-8 (helper for the tail read). */
	private readFileTailUtf8(
		filePath: string,
		size: number,
		tailBytes: number,
	): string {
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(tailBytes);
			const bytesRead = fs.readSync(fd, buffer, 0, tailBytes, size - tailBytes);
			return buffer.toString("utf-8", 0, bytesRead);
		} finally {
			fs.closeSync(fd);
		}
	}

	private getTaskStartedAtMs(task: AgentTask): number {
		const startedAtMs = new Date(task.started_at).getTime();
		return Number.isFinite(startedAtMs) ? startedAtMs : 0;
	}

	private getTaskRuntimeBackend(
		task: AgentTask,
	): NonNullable<AgentTask["terminal_backend"]> {
		return task.terminal_backend ?? "tmux";
	}

	private getRunningRuntimeIdentityKey(task: AgentTask): string | null {
		if (task.status !== "running") return null;

		const backend = this.getTaskRuntimeBackend(task);
		const bundlePath = task.bundle_path.trim();
		const identity: Record<string, string> = {
			backend,
			projectDir: task.project_dir,
		};

		if (bundlePath) {
			identity["bundlePath"] = bundlePath;
		}

		if (backend === "persist") {
			const persistSocketPath =
				task.persist_socket ?? this.getPersistSocketPath(task);
			if (persistSocketPath) {
				identity["persistSocket"] = persistSocketPath;
			} else if (task.session_id) {
				identity["sessionId"] = task.session_id;
			} else {
				return null;
			}
			return JSON.stringify(identity);
		}

		if (backend === "tmux") {
			if (!task.session_id) return null;
			identity["tmuxSocket"] = task.tmux_socket ?? "__default__";
			identity["sessionId"] = task.session_id;
			identity["windowId"] = task.tmux_window_id ?? "__session__";
			return JSON.stringify(identity);
		}

		if (!task.session_id) return null;
		identity["sessionId"] = task.session_id;
		return JSON.stringify(identity);
	}

	private getTaskRuntimeIdentityBreadcrumb(task: AgentTask): string | null {
		const backend = this.getTaskRuntimeBackend(task);
		const breadcrumbs: string[] = [backend];
		const projectName = task.project_dir
			? path.basename(task.project_dir)
			: task.project_name;
		if (projectName) {
			breadcrumbs.push(`project=${projectName}`);
		}

		if (task.session_id) {
			breadcrumbs.push(`session=${task.session_id}`);
		}

		if (backend === "persist") {
			const persistSocketPath =
				task.persist_socket ?? this.getPersistSocketPath(task);
			if (persistSocketPath) {
				breadcrumbs.push(`socket=${path.basename(persistSocketPath)}`);
			}
		} else if (backend === "tmux") {
			if (task.tmux_window_id) {
				breadcrumbs.push(`window=${task.tmux_window_id}`);
			}
			if (task.tmux_socket) {
				breadcrumbs.push(`socket=${path.basename(task.tmux_socket)}`);
			}
		}

		const executionHost = getTaskExecutionHostLabel(task);
		if (executionHost) {
			breadcrumbs.push(`host=${executionHost}`);
		}
		if (task.exec_visible != null) {
			breadcrumbs.push(`visible=${task.exec_visible ? "yes" : "no"}`);
		}
		if (task.exec_cwd) {
			breadcrumbs.push(`cwd=${task.exec_cwd}`);
		}

		const bundlePath = task.bundle_path.trim();
		if (bundlePath) {
			breadcrumbs.push(`bundle=${path.basename(bundlePath)}`);
		}

		return breadcrumbs.length > 0 ? breadcrumbs.join(" · ") : null;
	}

	private getTaskTranscriptBreadcrumb(task: AgentTask): string | null {
		const claudeSessionId = task.claude_session_id?.trim();
		if (claudeSessionId) {
			return claudeSessionId.length > 40
				? `claude=${claudeSessionId.slice(0, 16)}...${claudeSessionId.slice(-8)}`
				: `claude=${claudeSessionId}`;
		}

		const streamFile = task.stream_file?.trim();
		return streamFile ? `stream=${path.basename(streamFile)}` : null;
	}

	private clearRuntimeHealthCache(task: AgentTask): void {
		const persistSocketPath =
			task.persist_socket ?? this.getPersistSocketPath(task);
		if (persistSocketPath) {
			this._persistSessionHealthCache.delete(persistSocketPath);
		}

		if (!task.session_id) return;

		this.tmuxLiveness.invalidateSession(
			task.session_id,
			task.tmux_socket,
			task.tmux_window_id,
		);
	}

	private reconcileDuplicateRunningSessions(tasks: AgentTask[]): AgentTask[] {
		const runningByRuntime = new Map<string, AgentTask[]>();
		for (const task of tasks) {
			const runtimeKey = this.getRunningRuntimeIdentityKey(task);
			if (!runtimeKey) continue;
			const existing = runningByRuntime.get(runtimeKey);
			if (existing) {
				existing.push(task);
			} else {
				runningByRuntime.set(runtimeKey, [task]);
			}
		}

		const staleReasons = new Map<string, string>();
		for (const sessionTasks of runningByRuntime.values()) {
			if (sessionTasks.length <= 1) continue;
			const newestTask = [...sessionTasks].sort((a, b) => {
				const startedDiff =
					this.getTaskStartedAtMs(b) - this.getTaskStartedAtMs(a);
				if (startedDiff !== 0) return startedDiff;
				return b.id.localeCompare(a.id);
			})[0];
			if (!newestTask) continue;
			const runtimeBreadcrumb =
				this.getTaskRuntimeIdentityBreadcrumb(newestTask) ?? "the same runtime";
			for (const task of sessionTasks) {
				if (task.id === newestTask?.id) continue;
				staleReasons.set(
					task.id,
					`Superseded by newer running task ${newestTask.id} on ${runtimeBreadcrumb}.`,
				);
				this.clearRuntimeHealthCache(task);
			}
			const sessionId = newestTask.session_id;
			if (sessionId) {
				this.tmuxLiveness.invalidateAllForSessionId(sessionId);
			}
			const persistSocketPath =
				newestTask.persist_socket ?? this.getPersistSocketPath(newestTask);
			if (persistSocketPath) {
				this._persistSessionHealthCache.delete(persistSocketPath);
			}
		}

		return tasks.map((task) =>
			staleReasons.has(task.id)
				? this.applyRuntimeStatusOverlay(task, {
						status: "stopped",
						reason: staleReasons.get(task.id),
					})
				: task,
		);
	}

	private getDisplayLauncherTasks(): AgentTask[] {
		// Cache hit: same registry object AND cache populated in this synchronous
		// burst (queueMicrotask hasn't fired yet to clear _displayTasksRenderCache).
		// The registry-reference check also handles direct test-helper assignments
		// like `provider.registry = {...}` that bypass reload().
		if (
			this._displayTasksRenderCache !== null &&
			this._displayTasksCachedRegistry === this.registry
		) {
			return this._displayTasksRenderCache;
		}
		const displayTasks = Object.values(this.registry.tasks).map((task) =>
			this.toDisplayTask(task),
		);
		const result = this.reconcileDuplicateRunningSessions(displayTasks);
		this._displayTasksRenderCache = result;
		this._displayTasksCachedRegistry = this.registry;
		// Invalidate after the current synchronous burst so each new event-loop
		// entry (next render, next timer callback) recomputes fresh task states.
		queueMicrotask(() => {
			this._displayTasksRenderCache = null;
		});
		return result;
	}

	private getDisplayTaskById(taskId: string): AgentTask | undefined {
		return this.getDisplayLauncherTasks().find((task) => task.id === taskId);
	}

	private getScopedLauncherTasks(
		tasks = this.getDisplayLauncherTasks(),
	): AgentTask[] {
		return tasks.filter((t) => !isAutoReviewLane(t));
	}

	private getScopedDiscoveredAgents(
		agents = this._discoveredAgents,
	): DiscoveredAgent[] {
		return agents;
	}

	private shouldDedupOpenClawTask(task: OpenClawTask): boolean {
		const launcherTasks = this.getLauncherTasks();
		return launcherTasks.some((launcherTask) =>
			openClawTaskMatchesLauncherTask(task, launcherTask),
		);
	}

	private getAllOpenClawTaskSources(): OpenClawTask[] {
		const taskMap = new Map<string, OpenClawTask>();
		for (const task of this._openclawTaskService?.getTasks() ?? []) {
			taskMap.set(task.taskId, task);
		}
		for (const task of this._acpSessionService?.getTasks() ?? []) {
			taskMap.set(task.taskId, task);
		}
		return Array.from(taskMap.values());
	}

	private getNonLauncherOpenClawTasks(): OpenClawTask[] {
		return this.getAllOpenClawTaskSources().filter(
			(task) => !this.shouldDedupOpenClawTask(task),
		);
	}

	private getCodexRuns(
		agentTasks = this.getDisplayLauncherTasks(),
		openClawTasks = this.getAllOpenClawTaskSources(),
		taskFlows = this.getVisibleTaskFlows(),
	): CodexRunView[] {
		return this.codexRunObserverService.project({
			agentTasks,
			openClawTasks,
			taskFlows,
		});
	}

	private getVisibleCodexRuns(): CodexRunView[] {
		let runs = this.getCodexRuns(
			this.getScopedLauncherTasks(),
			this.getAllOpenClawTaskSources(),
			this.getVisibleTaskFlows(),
		);
		if (this._projectFilter) {
			runs = runs.filter((run) =>
				this.isCodexRunInProject(run, this._projectFilter ?? ""),
			);
		}
		return runs;
	}

	private isCodexRunInProject(run: CodexRunView, filterDir: string): boolean {
		if (!run.workspacePath) return false;
		return (
			run.workspacePath === filterDir ||
			path.basename(run.workspacePath) === path.basename(filterDir)
		);
	}

	private getVisibleOpenClawTasks(
		tasks = this.getNonLauncherOpenClawTasks(),
	): OpenClawTask[] {
		const filtered = this.isRunningOnlyFilterEnabled()
			? tasks.filter((task) => isOpenClawTaskVisibleInRunningMode(task))
			: tasks;
		return [...filtered].sort(
			(left, right) =>
				getOpenClawTaskActivityTimeMs(right) -
				getOpenClawTaskActivityTimeMs(left),
		);
	}

	private getScopedTasksForSummary(
		tasks = this.getScopedLauncherTasks(),
		discovered = this.getScopedDiscoveredAgents(),
	): AgentTask[] {
		const syntheticDiscovered: AgentTask[] = discovered.map((agent) => ({
			id: `discovered-${agent.pid}`,
			status: "running" as const,
			project_dir: agent.projectDir,
			project_name: path.basename(agent.projectDir) || agent.projectDir,
			session_id: agent.sessionId ?? `pid-${agent.pid}`,
			bundle_path: "",
			prompt_file: "",
			started_at: agent.startTime.toISOString(),
			attempts: 0,
			max_attempts: 0,
		}));
		const syntheticOpenClaw = this.getVisibleOpenClawTasks().map((task) =>
			toSyntheticOpenClawTask(task),
		);
		return [...tasks, ...syntheticDiscovered, ...syntheticOpenClaw];
	}

	private getScopedAgentTasksForSummary(
		tasks = this.getScopedLauncherTasks(),
		discovered = this.getScopedDiscoveredAgents(),
	): AgentTask[] {
		const syntheticDiscovered: AgentTask[] = discovered.map((agent) => ({
			id: `discovered-${agent.pid}`,
			status: "running" as const,
			project_dir: agent.projectDir,
			project_name: path.basename(agent.projectDir) || agent.projectDir,
			session_id: agent.sessionId ?? `pid-${agent.pid}`,
			bundle_path: "",
			prompt_file: "",
			started_at: agent.startTime.toISOString(),
			attempts: 0,
			max_attempts: 0,
		}));
		return [...tasks, ...syntheticDiscovered];
	}

	private getStuckRunningCount(tasks: AgentTask[]): number {
		return tasks.filter(
			(task) => task.status === "running" && this.isAgentStuck(task),
		).length;
	}

	private getSummaryTooltip(counts: AgentCounts, stuckCount: number): string {
		const hints: string[] = [];
		if (stuckCount > 0) {
			hints.push(
				`${stuckCount} running ${stuckCount === 1 ? "agent is" : "agents are"} possibly stuck`,
			);
		}
		const actionableCount = counts.attention;
		if (actionableCount > 0) {
			hints.push(
				`${actionableCount} stopped ${actionableCount === 1 ? "agent" : "agents"} — use Agent Actions in Agent Status tree to restart or inspect`,
			);
		}
		return hints.join("\n");
	}

	private setHasAgentsContext(): void {
		const hasAgents =
			Object.keys(this.registry.tasks).length > 0 ||
			this._discoveredAgents.length > 0 ||
			this.getNonLauncherOpenClawTasks().length > 0;
		const hasTerminalTasks = this.getDisplayLauncherTasks().some((task) =>
			CLEARABLE_AGENT_TASK_STATUSES.has(task.status),
		);
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.hasAgentTasks",
			hasAgents,
		);
		void vscode.commands.executeCommand(
			"setContext",
			"commandCentral.agentStatus.hasTerminalTasks",
			hasTerminalTasks,
		);
	}

	reload(): void {
		const reloadStart = performance.now();
		const isInitial = this._initialReadInProgress;
		if (isInitial) {
			this._onDidChangeTreeData.fire(undefined);
		}
		this._registryLoadIssue = null;
		const readStart = performance.now();
		const nextRegistry = this.readRegistry();
		defaultTimingRecorder.record(
			"tree.readRegistry",
			performance.now() - readStart,
		);
		this.registry = nextRegistry;
		// Invalidate per-render and TTL caches so downstream code sees the new
		// registry and recomputed stream/commit state for the next render cycle.
		this._displayTasksRenderCache = null;
		this._displayTasksCachedRegistry = null;
		this._streamTerminalStateCache.clear();
		this._streamFilePathCache.clear();
		this._commitsSinceStartCache.clear();
		this._initialReadInProgress = false;
		this._allDiscoveredAgents = this._agentRegistry
			? this._agentRegistry.getAllDiscovered()
			: [];
		this._discoveredAgents = this._agentRegistry
			? this._agentRegistry.getDiscoveredAgents(this.getLauncherTasks())
			: [];
		this.checkStaleTransitions();
		this.pruneDiffSummaryCache(
			this.getDisplayLauncherTasks(),
			this._allDiscoveredAgents,
		);
		this.checkCompletionNotifications();
		this.updateAutoRefreshTimer();
		this.checkStuckTransitions();
		// Clear port cache for tasks that are no longer running
		for (const [taskId, task] of Object.entries(this.registry.tasks)) {
			if (task.status !== "running") {
				this._portCache.delete(taskId);
				this._portDetecting.delete(taskId);
			}
		}
		this.setHasAgentsContext();
		this.updateDockBadge();
		this._onDidChangeTreeData.fire(undefined);
		defaultTimingRecorder.record(
			"tree.reload",
			performance.now() - reloadStart,
		);
	}

	/** Check for running→completed/failed transitions and fire notifications */
	private checkCompletionNotifications(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const masterEnabled = config.get<boolean>(
			"agentStatus.notifications",
			true,
		);
		const dockBounceEnabled = config.get<boolean>("dockBounce", true);
		const notifConfig = vscode.workspace.getConfiguration(
			"commandCentral.notifications",
		);
		const onCompletion = notifConfig.get<boolean>("onCompletion", true);
		const onFailure = notifConfig.get<boolean>("onFailure", true);
		const soundEnabled = notifConfig.get<boolean>("sound", false);
		const messageOptions = soundEnabled ? { modal: false } : undefined;

		for (const task of Object.values(this.registry.tasks)) {
			const prev = this.previousStatuses.get(task.id);
			if (
				prev === "running" &&
				(task.status === "completed" ||
					task.status === "completed_dirty" ||
					task.status === "failed")
			) {
				this.requestDockAttention(dockBounceEnabled);
			}
			if (masterEnabled && prev === "running") {
				const elapsed = formatElapsed(task.started_at);
				const backend = getBackendLabel(task);
				const isTerminalTransition =
					task.status === "completed" ||
					task.status === "completed_dirty" ||
					task.status === "failed" ||
					task.status === "stopped" ||
					task.status === "killed";

				if (
					isTerminalTransition &&
					!this.shouldNotifyTerminalTransition(task)
				) {
					// Duplicate terminal notification for the same run — suppress.
					// A registry read-race (primary registry momentarily unreadable
					// while the lanes projection still reports the task running) can
					// flap raw status completed→running→completed and would otherwise
					// re-fire the toast/sound/reveal for an already-notified run.
				} else if (
					(task.status === "completed" || task.status === "completed_dirty") &&
					onCompletion
				) {
					const diffSummary = formatNotificationDiffSummary(
						this.getDiffSummary(task.project_dir, task),
					);
					const exitSuffix =
						task.exit_code != null ? ` · exit ${task.exit_code}` : "";
					const msg = `✅ ${task.id} completed (${elapsed}) · ${diffSummary} [${backend}]${exitSuffix}`;
					this.revealTaskInSidebar(task.id);
					this.playNotificationSound(soundEnabled);
					this.showInfoNotification(
						msg,
						messageOptions,
						"View Diff",
						"Show Output",
						"Focus Terminal",
					).then((action) => {
						if (action === "View Diff") {
							this.executeTaskCommand("commandCentral.viewAgentDiff", task);
						} else if (action === "Show Output") {
							this.executeTaskCommand("commandCentral.showAgentOutput", task);
						} else if (action === "Focus Terminal") {
							this.executeTaskCommand(
								"commandCentral.focusAgentTerminal",
								task,
							);
						}
					});
					this._onAgentEvent.fire({
						type: "agent-completed",
						taskId: task.id,
						timestamp: new Date(),
						projectDir: task.project_dir,
						elapsed,
					});
				} else if (task.status === "failed" && onFailure) {
					const exitCode = task.exit_code ?? "unknown";
					let msg = `❌ ${task.id} failed (${elapsed}) · exit ${exitCode} [${backend}]`;
					const errorMessage = this.truncateErrorMessage(task.error_message);
					if (errorMessage) msg += ` — ${errorMessage}`;
					this.revealTaskInSidebar(task.id);
					this.playNotificationSound(soundEnabled);
					this.showWarningNotification(
						msg,
						messageOptions,
						"Show Output",
						"View Diff",
						"Restart",
					).then((action) => {
						if (action === "Show Output") {
							this.executeTaskCommand("commandCentral.showAgentOutput", task);
						} else if (action === "View Diff") {
							this.executeTaskCommand("commandCentral.viewAgentDiff", task);
						} else if (action === "Restart") {
							this.executeTaskCommand("commandCentral.restartAgent", task);
						}
					});
					this._onAgentEvent.fire({
						type: "agent-failed",
						taskId: task.id,
						timestamp: new Date(),
						projectDir: task.project_dir,
					});
				} else if (task.status === "stopped" && onCompletion) {
					let msg = `⏹️ ${task.id} stopped (${elapsed}) [${backend}]`;
					const stopReason = this.truncateErrorMessage(task.error_message);
					if (stopReason) msg += ` — ${stopReason}`;
					this.revealTaskInSidebar(task.id);
					this.showInfoNotification(msg, messageOptions, "Show Output").then(
						(action) => {
							if (action === "Show Output") {
								this.executeTaskCommand("commandCentral.showAgentOutput", task);
							}
						},
					);
				} else if (task.status === "killed" && onFailure) {
					const msg = `💀 ${task.id} killed (${elapsed}) [${backend}]`;
					this.revealTaskInSidebar(task.id);
					this.showWarningNotification(msg, messageOptions, "Show Output").then(
						(action) => {
							if (action === "Show Output") {
								this.executeTaskCommand("commandCentral.showAgentOutput", task);
							}
						},
					);
				}
			}
			// Detect running transitions (new task appearing as running, or transition to running)
			if (
				task.status === "running" &&
				prev !== undefined &&
				prev !== "running"
			) {
				this._onAgentEvent.fire({
					type: "agent-started",
					taskId: task.id,
					timestamp: new Date(),
					projectDir: task.project_dir,
				});
			}
			this.previousStatuses.set(task.id, task.status);
		}
	}

	private showInfoNotification(
		message: string,
		options: vscode.MessageOptions | undefined,
		...actions: string[]
	): Thenable<string | undefined> {
		return options
			? vscode.window.showInformationMessage(message, options, ...actions)
			: vscode.window.showInformationMessage(message, ...actions);
	}

	private showWarningNotification(
		message: string,
		options: vscode.MessageOptions | undefined,
		...actions: string[]
	): Thenable<string | undefined> {
		return options
			? vscode.window.showWarningMessage(message, options, ...actions)
			: vscode.window.showWarningMessage(message, ...actions);
	}

	private executeTaskCommand(command: string, task: AgentTask): void {
		void vscode.commands.executeCommand(command, {
			type: "task" as const,
			task,
		});
	}

	/**
	 * Returns true the first time a given terminal run should fire a
	 * notification, false for subsequent duplicates of the same run.
	 *
	 * Keyed by `<status>::<started_at>` so a genuine re-run (new `started_at`)
	 * still notifies, while a registry read-race flap — which reuses the same
	 * `started_at` — is suppressed. This is the source-level guard behind the
	 * frequent duplicate completion toasts/sounds operators can see when a
	 * busy launcher rewrites the registry mid-read.
	 */
	private shouldNotifyTerminalTransition(task: AgentTask): boolean {
		const key = `${task.status}::${task.started_at ?? ""}`;
		if (this.notifiedTerminalRuns.get(task.id) === key) return false;
		this.notifiedTerminalRuns.set(task.id, key);
		return true;
	}

	private playNotificationSound(enabled: boolean): void {
		if (!enabled) return;
		try {
			process.stdout.write("\x07");
		} catch {
			// Best-effort only.
		}
	}

	private resolveInheritedTaskModel(
		task: AgentTask,
	): OpenClawAgentModel | null {
		if (!this._openclawConfigService) return null;

		for (const agentId of getTaskAgentIdentities(task)) {
			const model = this._openclawConfigService.getAgentModel(agentId);
			if (model?.model?.trim()) return model;
		}

		return null;
	}

	private resolveTaskModelDisplay(task: AgentTask): {
		fullName: string;
		alias: string;
		isExplicit: boolean;
	} | null {
		const explicitModel = task.model?.trim();
		if (explicitModel) {
			return {
				fullName: explicitModel,
				alias: getModelAlias(explicitModel),
				isExplicit: true,
			};
		}

		const inheritedModel = this.resolveInheritedTaskModel(task);
		if (!inheritedModel) return null;

		return {
			fullName: inheritedModel.model,
			alias: getModelAlias(inheritedModel.model),
			isExplicit: inheritedModel.isExplicit,
		};
	}

	/**
	 * Detect provider fallback: actual_model differs from requested model.
	 */
	private getTaskFallbackInfo(task: AgentTask): {
		actualFull: string;
		actualAlias: string;
		requestedFull: string;
		requestedAlias: string;
	} | null {
		const actual = task.actual_model?.trim();
		const requested = task.model?.trim();
		if (!actual || !requested || actual === requested) return null;
		return {
			actualFull: actual,
			actualAlias: getModelAlias(actual),
			requestedFull: requested,
			requestedAlias: getModelAlias(requested),
		};
	}

	private truncateErrorMessage(errorMessage?: string | null): string | null {
		if (!errorMessage) return null;
		const compact = errorMessage.trim().replace(/\s+/g, " ");
		if (compact.length <= 100) return compact;
		return `${compact.slice(0, 97)}...`;
	}

	private requestDockAttention(dockBounceEnabled: boolean): void {
		if (!dockBounceEnabled || process.platform !== "darwin") return;
		const windowWithAttention = vscode.window as typeof vscode.window & {
			requestAttention?: () => void;
		};
		if (typeof windowWithAttention.requestAttention !== "function") return;
		try {
			windowWithAttention.requestAttention();
		} catch {
			// Best-effort only.
		}
	}

	/**
	 * VS Code sums every view badge inside an activity bar container. The
	 * Symphony view is a second AgentStatusTreeProvider over the same data,
	 * so only the Agent Status provider may write badges — otherwise the
	 * container icon shows a multiple of the real running count.
	 */
	private get ownsActivityBadge(): boolean {
		return this.viewMode === "agentStatus";
	}

	private updateDockBadge(): void {
		if (!this.ownsActivityBadge) return;
		const runningCount = this.getTasks().filter(
			(task) => task.status === "running",
		).length;
		const tooltip =
			runningCount === 1 ? "1 working agent" : `${runningCount} working agents`;
		const badge: vscode.ViewBadge | undefined =
			runningCount > 0 ? { value: runningCount, tooltip } : undefined;

		if (process.platform === "darwin") {
			const windowWithBadge = vscode.window as typeof vscode.window & {
				badge?: vscode.ViewBadge;
			};
			try {
				windowWithBadge.badge = badge;
			} catch {
				// Best-effort only.
			}
		}

		if (this._agentStatusView) {
			this._agentStatusView.badge = badge;
		}
	}

	private checkStuckTransitions(): void {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const dockBounceEnabled = config.get<boolean>("dockBounce", true);
		const nextStates = new Map<string, boolean>();
		for (const task of this.getDisplayLauncherTasks()) {
			if (task.status !== "running") continue;
			const isStuck = this.isAgentStuck(task);
			nextStates.set(task.id, isStuck);

			const wasStuck = this.previousStuckStates.get(task.id) ?? false;
			if (this.hasInitializedStuckState && isStuck && !wasStuck) {
				this.requestDockAttention(dockBounceEnabled);
			}
		}
		this.previousStuckStates = nextStates;
		this.hasInitializedStuckState = true;
	}

	public checkStaleTransitions(): void {
		const nextReasons = new Map<string, string>();
		for (const task of Object.values(this.registry.tasks)) {
			const reason = this.getStaleTransitionReason(task);
			if (reason) {
				nextReasons.set(task.id, reason);
			}
		}
		this.staleTaskReasons = nextReasons;
	}

	public getStaleLauncherTasks(): AgentTask[] {
		return this.getDisplayLauncherTasks().filter(
			(task) => task.status === "completed_stale",
		);
	}

	private getStaleTransitionReason(task: AgentTask): string | null {
		if (task.status !== "running") return null;
		if (this.getStreamTerminalState(task)) return null;
		if (!this.isAgentStuck(task)) return null;
		if (this.isRunningTaskHealthy(task)) return null;
		if (!this.isTaskSessionConfirmedDead(task)) return null;
		// Task would be marked stale, but if it produced commits it's
		// more accurately "completed_dirty" — handled in toDisplayTask.
		if (this.hasCommitsSinceStart(task)) return null;
		return STALE_AGENT_STATUS_DESCRIPTION;
	}

	private isTaskSessionConfirmedDead(task: AgentTask): boolean {
		if (isRemoteNodeTaskForCurrentHost(task)) return false;
		// A local tmux/persist probe can only CONFIRM DEATH for a task that
		// demonstrably executed on this host. For a node-origin task whose host
		// we cannot verify as local, the absence of a local session here is not
		// evidence of anything — mirror `isLocalFileProbeAuthoritative` so we
		// never demote another machine's still-live lane to stopped/stale.
		// (cc-current-running-surface-fix-20260613)
		if (!isLocalFileProbeAuthoritative(task)) return false;

		if (task.terminal_backend === "persist") {
			return !this.isPersistTaskAlive(task);
		}

		if (
			(task.terminal_backend === "tmux" ||
				task.terminal_backend === undefined) &&
			isValidSessionId(task.session_id)
		) {
			// Use window-level check when available for multi-window sessions.
			if (task.tmux_window_id) {
				if (
					!this.isTmuxWindowAlive(
						task.session_id,
						task.tmux_window_id,
						task.tmux_socket,
					)
				) {
					return true;
				}
			} else if (!this.isTmuxSessionAlive(task.session_id, task.tmux_socket)) {
				return true;
			}
			// Session/window alive but agent process may be gone.
			return !this.isTmuxPaneAgentHealthy(task);
		}

		if (this.hasLiveDiscoveredSession(task)) {
			return false;
		}

		return !this.isRunningTaskHealthy(task);
	}

	private revealTaskInSidebar(taskId: string): void {
		if (!this._agentStatusView) return;
		const taskElement = this.findTaskElement(taskId);
		if (!taskElement) return;
		try {
			void this._agentStatusView.reveal(taskElement, {
				select: true,
				focus: false,
			});
		} catch {
			// Reveal failures are non-fatal (e.g., filtered-out task).
		}
	}

	/** Start or stop auto-refresh timer based on whether any tasks are running */
	private updateAutoRefreshTimer(): void {
		const hasRunning = this.getDisplayLauncherTasks().some(
			(task) => task.status === "running",
		);

		if (hasRunning && !this.autoRefreshTimer) {
			const config = vscode.workspace.getConfiguration("commandCentral");
			const intervalMs = config.get<number>("agentStatus.autoRefreshMs", 30000);
			this.autoRefreshTimer = setInterval(() => {
				this.checkStaleTransitions();
				this.checkStuckTransitions();
				this.scheduleTreeRefresh();
			}, intervalMs);
		} else if (!hasRunning && this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
	}

	/** Exposed for testing — override to inject mock data */
	readRegistry(): TaskRegistry {
		this._registryLoadIssue = null;
		const filePaths =
			this._filePaths.length > 0
				? this._filePaths
				: this._filePath
					? [this._filePath]
					: [];
		return this.registryReader.readMerged(
			filePaths,
			(filePath) => this._fileIngestModes.get(filePath) ?? "all",
			() => this.readLaneProjectionGcReceipt(),
		);
	}

	/**
	 * Seam for tests + dependency injection: read the lane-projection GC receipt.
	 * Defaults to the launcher's on-disk receipt; overridable so suites can
	 * inject a fixture receipt without touching the global filesystem.
	 */
	protected readLaneProjectionGcReceipt(): LaneProjectionGcReceipt | null {
		return readLaneProjectionGcReceipt();
	}

	getTreeItem(element: AgentNode): vscode.TreeItem {
		const timingStart = performance.now();
		try {
			const item = this.getTreeItemImpl(element);
			// Anchor every node to the provider's one canonical stable identity.
			// Without one, VS Code derives a node's handle from its parent's handle +
			// position + label. The project-first tree re-sorts project groups by
			// activity and embeds live counts in section/header labels, so derived
			// handles go stale across refreshes — orphaning descendants and causing
			// "Failed to resolve tree node" storms with audible alert feedback.
			const stableId = this.getStableTreeItemId(element);
			if (stableId !== undefined) {
				item.id = stableId;
			}
			return item;
		} finally {
			defaultTimingRecorder.record(
				`tree.getTreeItem.${element.type}`,
				performance.now() - timingStart,
			);
		}
	}

	/**
	 * One canonical, globally-unique, render-stable identity for Agent Status
	 * tree nodes. The returned value is used for BOTH `TreeItem.id` and
	 * element-level refresh coalescing; do not add per-node helper identity paths.
	 *
	 * MUST NOT depend on tree index, display label, live count, or current sort
	 * position. Those values change across refreshes and are exactly what breaks
	 * VS Code's node resolution. Return `undefined` only when the provider cannot
	 * prove a stable global id; those nodes use VS Code's parent-relative derived
	 * handle and force full refreshes when targeted.
	 */
	private getStableTreeItemId(element: AgentNode): string | undefined {
		switch (element.type) {
			case "task":
				return `task:${element.task.id}`;
			case "discovered":
				return `discovered:${element.agent.pid}`;
			case "openclawTask":
				return `openclaw:${element.task.taskId}`;
			case "projectGroup":
				return element.unregistered
					? "project:__unregistered__"
					: `project:${projectGroupNodeKey(element)}`;
			case "folderGroup":
				return `folder:${element.groupKey}`;
			case "statusGroup":
				return `status-group:${element.status}:${
					element.parentProjectDir ?? element.parentProjectName ?? ""
				}:${element.parentGroupKey ?? ""}`;
			case "statusTimeGroup":
				return `status-time-group:${element.status}:${element.period}:${
					element.parentProjectDir ?? element.parentProjectName ?? ""
				}:${element.parentGroupKey ?? ""}`;
			case "backgroundTasks":
				return "backgroundTasks";
			case "summary":
				// Flat root mode renders two summary siblings (V2 count + Sources
				// provenance). Tag the Sources node so the two never collide into a
				// duplicate id (a hard "already registered" tree crash).
				return element.kind === "sources" ? "summary:sources" : "summary";
			case "olderRuns":
				// Identity mirrors the parent group's stable scope — status, project,
				// and folder group — exactly as `statusGroup` does, so this bucket is
				// unique wherever its parent is. It MUST NOT hash the hidden-node set
				// or the count-bearing "Show N older completed..." label: membership
				// churns as completed lanes age in and out, and a content-derived id
				// would silently re-key the node on every refresh (losing expand state
				// and orphaning targeted refreshes). `applyAgentVisibilityCap` emits at
				// most one bucket per (status, project, group), so this is collision-free.
				return `olderRuns:${element.parentStatus ?? ""}:${
					element.parentProjectDir ?? element.parentProjectName ?? ""
				}:${element.parentGroupKey ?? ""}`;
			// Symphony root containers are singletons per render (getSymphonyChildren
			// pushes exactly one of each, and the run-group `kind` is unique among
			// running/retryQueued/released). Without a content-free stable id they
			// fall back to VS Code's parent-handle + position + label scheme, so the
			// conditional `released` group shifting the position of `taskflows` /
			// `codexRuns` — or a count changing in their labels on the 30s global
			// refresh — silently re-keys them and collapses any expanded subtree.
			// NOTE: `codexRun` / `symphonySnapshotEntry` intentionally stay undefined
			// (fall through to default): the same run renders as a `codexRun` under
			// BOTH its run-group and the `codexRuns` container, so a per-run id would
			// be a duplicate-id ("already registered") tree crash.
			case "symphonyDashboard":
				return "symphony:dashboard";
			case "symphonyRunGroup":
				return `symphony:run-group:${element.kind}`;
			case "taskflows":
				return "symphony:taskflows";
			case "codexRuns":
				return "symphony:codex-runs";
			default:
				return undefined;
		}
	}

	private getTreeItemImpl(element: AgentNode): vscode.TreeItem {
		if (element.type === "summary") {
			return this.createSummaryItem(element);
		}
		if (element.type === "task") {
			return this.createTaskItem(element.task);
		}
		if (element.type === "openclawTask") {
			return this.createOpenClawTaskItem(element.task);
		}
		if (element.type === "backgroundTasks") {
			return this.createBackgroundTasksItem(element);
		}
		if (element.type === "symphony") {
			return this.createSymphonyItem(element);
		}
		if (element.type === "symphonyDashboard") {
			return this.createSymphonyDashboardItem(element);
		}
		if (element.type === "symphonyRunGroup") {
			return this.createSymphonyRunGroupItem(element);
		}
		if (element.type === "symphonySnapshotEntry") {
			return this.createSymphonySnapshotEntryItem(element);
		}
		if (element.type === "taskFlowGroup") {
			return this.createTaskFlowItem(element.flow);
		}
		if (element.type === "taskflow") {
			return this.createTaskFlowItem(element.flow);
		}
		if (element.type === "taskflows") {
			return this.createTaskFlowsItem(element);
		}
		if (element.type === "codexRuns") {
			return this.createCodexRunsItem(element);
		}
		if (element.type === "codexRun") {
			return this.createCodexRunItem(element);
		}
		if (element.type === "projectGroup") {
			return this.createProjectGroupItem(element);
		}
		if (element.type === "folderGroup") {
			return this.createFolderGroupItem(element);
		}
		if (element.type === "statusGroup") {
			return this.createStatusGroupItem(element);
		}
		if (element.type === "statusTimeGroup") {
			return this.createStatusTimeGroupItem(element);
		}
		if (element.type === "fileChange") {
			return this.createFileChangeItem(element);
		}
		if (element.type === "discovered") {
			return this.createDiscoveredItem(element);
		}
		if (element.type === "olderRuns") {
			return this.createOlderRunsItem(element);
		}
		if (element.type === "state") {
			return this.createStateItem(element);
		}
		if (element.type === "taskFlowChild") {
			const item = new vscode.TreeItem(element.label);
			item.description = element.status;
			item.iconPath = new vscode.ThemeIcon("circle-outline");
			item.contextValue = "taskFlowChild";
			return item;
		}
		return this.createDetailItem(element);
	}

	getChildren(element?: AgentNode): AgentNode[] {
		const timingStart = performance.now();
		const label = `tree.getChildren.${element?.type ?? "root"}`;
		try {
			return this.getChildrenImpl(element);
		} finally {
			defaultTimingRecorder.record(label, performance.now() - timingStart);
		}
	}

	private getChildrenImpl(element?: AgentNode): AgentNode[] {
		if (!element) {
			let allTasks = this.getScopedLauncherTasks();
			let discovered = this.getScopedDiscoveredAgents();
			const openclawTasks = this.getVisibleOpenClawTasks();

			// Apply project filter before grouping (works for both flat and grouped modes)
			if (this._projectFilter) {
				const filterDir = this._projectFilter;
				allTasks = allTasks.filter(
					(t) =>
						t.project_dir === filterDir ||
						t.project_name === path.basename(filterDir),
				);
				discovered = discovered.filter(
					(a) => this.getDiscoveredProjectDir(a) === filterDir,
				);
			}
			const taskFlows = this.getVisibleTaskFlows();
			let codexRuns = this.getCodexRuns(
				allTasks,
				this.getAllOpenClawTaskSources(),
				taskFlows,
			);
			if (this._projectFilter) {
				codexRuns = codexRuns.filter((run) =>
					this.isCodexRunInProject(run, this._projectFilter ?? ""),
				);
			}
			const symphonyNode: SymphonyRootNode = {
				type: "symphony",
				runs: codexRuns,
				flows: taskFlows,
			};
			if (this.viewMode === "symphony") {
				return this.getSymphonyChildren(symphonyNode);
			}
			const legacyDiagnosticsNodes = this.createLegacyDiagnosticsMarkerNodes();
			const hasAnyAgents =
				allTasks.length > 0 ||
				discovered.length > 0 ||
				openclawTasks.length > 0 ||
				taskFlows.length > 0;
			if (!hasAnyAgents) {
				if (this._initialReadInProgress && this._filePath) {
					return [
						...legacyDiagnosticsNodes,
						this.createSourcesProvenanceSummaryNode(symphonyNode),
						{
							type: "state",
							label: "Scanning for agents...",
							description: "Checking processes, sessions, and tasks",
							icon: "loading~spin",
						},
					];
				}
				if (this._registryLoadIssue) {
					return [
						...legacyDiagnosticsNodes,
						this.createSourcesProvenanceSummaryNode(symphonyNode),
						{
							type: "state",
							label: "Could not read tasks.json",
							description: this._registryLoadIssue,
							icon: "warning",
						},
					];
				}
				return [
					...legacyDiagnosticsNodes,
					this.createSourcesProvenanceSummaryNode(symphonyNode),
					{
						type: "state",
						label: "Waiting for agents...",
						description: "Start Claude Code, Codex, or Gemini in any terminal",
						icon: "search",
					},
				];
			}

			const tasks = allTasks;
			const groupedByProject = this.isProjectGroupingEnabled();
			const showOpenClawInline = !groupedByProject;
			const sortableFlatNodes = this.sortAgentNodes([
				...tasks.map(
					(task) =>
						({ type: "task" as const, task }) satisfies SortableAgentNode,
				),
				...discovered.map(
					(agent) =>
						({
							type: "discovered" as const,
							agent,
						}) satisfies SortableAgentNode,
				),
				...(showOpenClawInline
					? openclawTasks.map(
							(task) =>
								({
									type: "openclawTask" as const,
									task,
								}) satisfies SortableAgentNode,
						)
					: []),
			]);
			const groupedNodes: AgentNode[] = groupedByProject
				? this.buildGroupedRootNodes(tasks, discovered)
				: [];
			const flatNodes: AgentNode[] = groupedByProject
				? []
				: this.applyAgentVisibilityCap(sortableFlatNodes);

			const reviewedTaskIds = this._reviewTracker.getReviewedIds();
			const agentCounts = countAgentStatuses(
				this.getScopedAgentTasksForSummary(tasks, discovered),
				{ reviewedTaskIds },
			);
			// V2 root denominator: one `live · review · action · history` vocabulary
			// over the same lane set the tree renders. Always explicit (live: 0 when
			// idle), full history retained — never "none active".
			const unifiedCounts = this.computeUnifiedSectionCountsForTasks(
				this.getScopedTasksForSummary(tasks, discovered),
			);
			const backgroundTaskCount = openclawTasks.length;
			const stuckCount = this.getStuckRunningCount(allTasks);
			const summaryLabel = [
				formatV2Summary(unifiedCounts),
				...(backgroundTaskCount > 0
					? [
							backgroundTaskCount === 1
								? "1 background task"
								: `${backgroundTaskCount} background tasks`,
						]
					: []),
				...(stuckCount > 0 ? [`${stuckCount} stuck`] : []),
			]
				.filter((part) => part.length > 0)
				.join(" · ");
			const summaryTooltip = this.getSummaryTooltip(agentCounts, stuckCount);

			this.updateDockBadge();

			const summaryNodes: AgentNode[] = groupedByProject
				? []
				: [
						{
							type: "summary" as const,
							label: summaryLabel,
							tooltip: summaryTooltip || undefined,
						},
					];

			return [
				...legacyDiagnosticsNodes,
				...summaryNodes,
				this.createSourcesProvenanceSummaryNode(symphonyNode),
				...(!showOpenClawInline && openclawTasks.length > 0
					? [
							{
								type: "backgroundTasks" as const,
								tasks: openclawTasks,
							},
						]
					: []),
				...(groupedByProject ? groupedNodes : flatNodes),
			];
		}

		if (element.type === "folderGroup") {
			return element.projects;
		}

		if (element.type === "projectGroup") {
			return this.getProjectGroupChildren(element);
		}

		if (element.type === "statusGroup") {
			return this.getStatusGroupChildren(element);
		}

		if (element.type === "statusTimeGroup") {
			return element.nodes.map((node) => this.toAgentNode(node));
		}

		if (element.type === "olderRuns") {
			return element.hiddenNodes.map((node) => this.toAgentNode(node));
		}

		if (element.type === "task") {
			const compact = this.isCompactMode();
			const detailChildren = compact
				? this.getCompactChildren(element.task)
				: this.getDetailChildren(element.task);
			const reviewChildren = this.getAutoReviewLaneChildren(element.task);
			return [
				...detailChildren,
				...reviewChildren,
				...this.getFileChangeChildren(element.task),
			];
		}

		if (element.type === "openclawTask") {
			return this.getOpenClawTaskDetailChildren(element.task);
		}

		if (element.type === "symphony") {
			if (this.viewMode !== "symphony") {
				return [];
			}
			return this.getSymphonyChildren(element);
		}

		if (element.type === "symphonyDashboard") {
			return this.getSymphonyDashboardDetailChildren(element);
		}

		if (element.type === "symphonyRunGroup") {
			const snapshotEntries = getSymphonyRunGroupSnapshotEntries(element);
			if (snapshotEntries.length > 0) {
				return snapshotEntries;
			}
			if (element.runs.length === 0) {
				return [
					{
						type: "state",
						label: getSymphonyRunGroupEmptyLabel(element.kind),
						description: getSymphonyRunGroupEmptyDescription(element.kind),
						icon: "circle-slash",
					},
				];
			}
			return element.runs.map(
				(run): CodexRunNode => ({
					type: "codexRun",
					run,
					container: element.kind,
				}),
			);
		}

		if (element.type === "symphonySnapshotEntry") {
			return this.getSymphonySnapshotEntryDetailChildren(element);
		}

		if (element.type === "taskflows") {
			if (element.flows.length === 0) {
				return [
					{
						type: "state",
						label: "No projected workstreams",
						description: "TaskFlow conductor rows will appear here",
						icon: "circle-slash",
					},
				];
			}
			return element.flows.map(
				(flow): TaskFlowGroupNode => ({ type: "taskFlowGroup", flow }),
			);
		}

		if (element.type === "taskFlowGroup") {
			return [
				...this.getTaskFlowDetailChildren(element.flow),
				...this.getTaskFlowChildNodes(element.flow),
			];
		}

		if (element.type === "codexRuns") {
			if (element.runs.length === 0) {
				return [
					{
						type: "state",
						label: "No projected run attempts",
						description:
							"OpenClaw, TaskFlow, or launcher rows will appear here",
						icon: "circle-slash",
					},
				];
			}
			return element.runs.map(
				(run): CodexRunNode => ({ type: "codexRun", run, container: "runs" }),
			);
		}

		if (element.type === "codexRun") {
			return this.getCodexRunDetailChildren(element.run);
		}

		if (element.type === "backgroundTasks") {
			return this.applyAgentVisibilityCap(
				this.sortAgentNodes(
					element.tasks.map(
						(task) =>
							({
								type: "openclawTask" as const,
								task,
							}) satisfies SortableAgentNode,
					),
				),
			);
		}

		if (element.type === "discovered") {
			return this.getDiscoveredChildren(element.agent);
		}

		return [];
	}

	private getTaskDiffCacheKey(task: AgentTask): string {
		return [
			"task",
			task.id,
			task.status,
			task.project_dir,
			task.started_at,
			task.start_sha ?? task.start_commit ?? "",
			task.updated_at ?? "",
			task.completed_at ?? "",
		].join(":");
	}

	private getDiscoveredDiffCacheKey(agent: DiscoveredAgent): string {
		return `discovered:${agent.pid}:${agent.projectDir}:${agent.startTime.toISOString()}`;
	}

	private getCachedDiffSummaryForTask(task: AgentTask): string | null {
		const cacheKey = this.getTaskDiffCacheKey(task);
		if (this._diffSummaryCache.has(cacheKey)) {
			return this._diffSummaryCache.get(cacheKey) ?? null;
		}

		// Test overrides often monkeypatch getDiffSummary on the instance.
		// Preserve deterministic synchronous behavior in that case.
		if (Object.hasOwn(this, "getDiffSummary")) {
			const value = this.getDiffSummary(task.project_dir, task);
			this._diffSummaryCache.set(cacheKey, value);
			return value;
		}

		if (!this._diffSummaryDetecting.has(cacheKey)) {
			this._diffSummaryDetecting.add(cacheKey);
			void computeDiffSummaryAsync(task.project_dir, task)
				.then((summary) => {
					this._diffSummaryCache.set(cacheKey, summary);
					this.scheduleTreeRefresh(this.getTaskRefreshElement(task.id));
				})
				.finally(() => {
					this._diffSummaryDetecting.delete(cacheKey);
				});
		}

		return null;
	}

	private getCachedDiffSummaryForDiscovered(
		agent: DiscoveredAgent,
	): string | null {
		const cacheKey = this.getDiscoveredDiffCacheKey(agent);
		if (this._diffSummaryCache.has(cacheKey)) {
			return this._diffSummaryCache.get(cacheKey) ?? null;
		}

		const syntheticTask = { status: "running" } as AgentTask;
		if (Object.hasOwn(this, "getDiffSummary")) {
			const value = this.getDiffSummary(agent.projectDir, syntheticTask);
			this._diffSummaryCache.set(cacheKey, value);
			return value;
		}

		if (!this._diffSummaryDetecting.has(cacheKey)) {
			this._diffSummaryDetecting.add(cacheKey);
			void computeDiffSummaryAsync(agent.projectDir, syntheticTask)
				.then((summary) => {
					this._diffSummaryCache.set(cacheKey, summary);
					this.scheduleTreeRefresh({
						type: "discovered",
						agent,
					});
				})
				.finally(() => {
					this._diffSummaryDetecting.delete(cacheKey);
				});
		}
		return null;
	}

	/** Get detail children for discovered agents (no task record) */
	private getDiscoveredChildren(agent: DiscoveredAgent): DetailNode[] {
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Working Dir",
				value: agent.projectDir,
				taskId: `discovered-${agent.pid}`,
			},
			{
				type: "detail",
				label: "Uptime",
				value: formatElapsed(agent.startTime.toISOString()),
				taskId: `discovered-${agent.pid}`,
			},
		];
		// Prompt for discovered agents
		const discoveredPrompt = this.readDiscoveredPrompt(agent);
		if (discoveredPrompt) {
			details.push({
				type: "detail",
				label: "Prompt",
				value: discoveredPrompt,
				taskId: `discovered-${agent.pid}`,
			});
		}
		// Diff summary for discovered agents (working tree vs HEAD)
		const diffSummary = this.getCachedDiffSummaryForDiscovered(agent);
		if (diffSummary) {
			details.push({
				type: "detail",
				label: "Changes",
				value: diffSummary,
				taskId: `discovered-${agent.pid}`,
			});
		}
		// Omit diff loading placeholder — show nothing until ready
		if (agent.model) {
			details.push({
				type: "detail",
				label: "Model",
				value: agent.model,
				taskId: `discovered-${agent.pid}`,
			});
		}
		if (agent.worktree?.isLinkedWorktree) {
			details.push({
				type: "detail",
				label: "Worktree",
				value: `${agent.worktree.branch} · ${agent.worktree.worktreeDir}`,
				taskId: `discovered-${agent.pid}`,
			});
		}
		return details;
	}

	private isCompactMode(): boolean {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<boolean>("agentStatus.compactMode", false);
	}

	private isRunningOnlyFilterEnabled(): boolean {
		return false;
	}

	private isProjectGroupingEnabled(): boolean {
		const config = vscode.workspace.getConfiguration("commandCentral");
		return config.get<boolean>("agentStatus.groupByProject", true);
	}

	private getMaxVisibleAgents(): number {
		return AgentStatusTreeProvider.MAX_VISIBLE_AGENTS_DEFAULT;
	}

	private getCompletedTaskLimit(): number {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const raw = config.get<number>(
			"agentStatus.completedTaskLimit",
			AgentStatusTreeProvider.COMPLETED_TASK_LIMIT_DEFAULT,
		);
		return Math.max(1, Math.floor(raw));
	}

	/**
	 * V2 unified section counts over a set of render nodes. Each node is
	 * classified through the existing four-bucket status engine and relabelled to
	 * a V2 lane section, so the counts are guaranteed consistent with the group a
	 * lane actually renders under. Reads only cache-warmed liveness state (via
	 * `getNodeStatusGroup`) — no new subprocess on the hot path.
	 */
	private computeUnifiedSectionCounts(
		nodes: SortableAgentNode[],
	): UnifiedCounts {
		const counts = emptyUnifiedCounts();
		for (const node of nodes) {
			counts[sectionFromStatusGroup(this.getNodeStatusGroup(node))] += 1;
		}
		return counts;
	}

	/**
	 * Project-aware V2 counts: classify a project's launcher tasks and fold in its
	 * always-live discovered agents. Keeps per-project counts in the same single
	 * `live · review · action · history` denominator as the root.
	 */
	private computeUnifiedSectionCountsForTasks(
		tasks: AgentTask[],
		discoveredCount = 0,
	): UnifiedCounts {
		const counts = this.computeUnifiedSectionCounts(
			tasks.map((task) => ({ type: "task" as const, task })),
		);
		counts.live += discoveredCount;
		return counts;
	}

	private getTimestampMs(timestamp?: string | null): number {
		if (!timestamp) return 0;
		const timeMs = new Date(timestamp).getTime();
		return Number.isFinite(timeMs) ? timeMs : 0;
	}

	private getTaskStartedTimeMs(task: AgentTask): number {
		return this.getTimestampMs(task.started_at);
	}

	private getTaskActivityTimeMs(task: AgentTask): number {
		return Math.max(
			this.getTaskStartedTimeMs(task),
			this.getTimestampMs(task.completed_at),
			this.getTimestampMs(task.updated_at),
		);
	}

	private getDiscoveredActivityTimeMs(agent: DiscoveredAgent): number {
		const startedAtMs = agent.startTime.getTime();
		return Number.isFinite(startedAtMs) ? startedAtMs : 0;
	}

	private getNodeActivityTimeMs(node: SortableAgentNode): number {
		if (node.type === "task") {
			return this.getTaskActivityTimeMs(node.task);
		}
		if (node.type === "discovered") {
			return this.getDiscoveredActivityTimeMs(node.agent);
		}
		return getOpenClawTaskActivityTimeMs(node.task);
	}

	private getNodeStatus(node: SortableAgentNode): AgentTaskStatus {
		if (node.type === "task") return node.task.status;
		if (node.type === "discovered") return "running";
		return mapOpenClawTaskToAgentStatus(node.task);
	}

	private compareActivityTimeDesc(
		leftActivityTimeMs: number,
		rightActivityTimeMs: number,
	): number {
		return rightActivityTimeMs - leftActivityTimeMs;
	}

	private compareTaskNames(left: string, right: string): number {
		return left.localeCompare(right);
	}

	private compareSortableAgentNodes(
		left: SortableAgentNode,
		right: SortableAgentNode,
	): number {
		const priorityDiff =
			TASK_STATUS_PRIORITY[this.getNodeStatusGroup(left)] -
			TASK_STATUS_PRIORITY[this.getNodeStatusGroup(right)];
		if (priorityDiff !== 0) {
			return priorityDiff;
		}

		const activityDiff = this.compareActivityTimeDesc(
			this.getNodeActivityTimeMs(left),
			this.getNodeActivityTimeMs(right),
		);
		if (activityDiff !== 0) {
			return activityDiff;
		}

		if (left.type === "task" && right.type === "task") {
			return this.compareTaskNames(left.task.id, right.task.id);
		}
		if (left.type === "openclawTask" && right.type === "openclawTask") {
			return this.compareTaskNames(left.task.taskId, right.task.taskId);
		}
		if (left.type === "discovered" && right.type === "discovered") {
			return right.agent.pid - left.agent.pid;
		}
		if (left.type === "task") return -1;
		if (right.type === "task") return 1;
		if (left.type === "openclawTask") return -1;
		if (right.type === "openclawTask") return 1;
		return 1;
	}

	private sortAgentNodes(nodes: SortableAgentNode[]): SortableAgentNode[] {
		return [...nodes].sort((left, right) =>
			this.compareSortableAgentNodes(left, right),
		);
	}

	private toAgentNode(node: SortableAgentNode): AgentNode {
		if (node.type === "task") {
			return { type: "task", task: node.task };
		}
		if (node.type === "discovered") {
			return { type: "discovered", agent: node.agent };
		}
		return { type: "openclawTask", task: node.task };
	}

	private getNodeStatusGroup(node: SortableAgentNode): AgentStatusGroup {
		const status = this.getNodeStatus(node);

		// CCSYNC-02: a lane-projection GC pass that downgraded/archived/removed
		// this row is the authoritative reconciliation verdict — the projection
		// row is stale read-model backlog, not live attention work. Route it to
		// Needs Review (limbo) so it never counts in the activity-bar action badge
		// or masquerades as a live "running" lane, even when its projected status
		// field still says running/pending. Only ever applies to projection rows
		// the GC receipt explicitly reconciled out (see applyGcReceiptReconciliation).
		if (node.type === "task" && this.isGcReconciledRow(node.task)) {
			return "limbo";
		}

		if (status === "running") return "running";

		// Lifecycle conflict: the launcher recorded a TERMINAL status but the
		// session is provably alive — surface in attention ("live attention
		// required") so the contradiction is visible, never silently grouped as a
		// dead failure or aged into History.
		//
		// The gate spans every conflict-eligible status — not just `completed*`.
		// `classifyLifecycleConflict` itself filters by CONFLICT_ELIGIBLE_STATUSES,
		// so a `contract_failure`/`failed`/`stopped`/`killed`-but-alive lane is now
		// detected here too (previously these skipped the liveness check and fell
		// through as plain dead failures). Liveness is the cache-only probe (no
		// subprocess on the hot path) OR — when the cache is cold or the lane is a
		// node-origin row we cannot probe locally — the launcher's own
		// `session_live` corroboration.
		//
		// A lane from a superseded Ghostty-app/release generation is skipped: its
		// app/window is a pre-reset leftover (the pane inside may still be a live
		// orphan), not current work, so it never promotes into the live-attention
		// bucket — the lane keeps its plain terminal bucket and is badged
		// "stale (pre-release)" on the row instead.
		if (
			node.type === "task" &&
			!isSupersededByReleaseReset(node.task, this.getCurrentReleaseGeneration())
		) {
			const liveness = this.getCachedTerminalTaskLivenessEvidence(node.task);
			if (
				classifyLifecycleConflict(
					node.task,
					liveness,
					this.effectiveLauncherSessionLive(node.task),
				).kind === "live-process-conflict"
			) {
				// CCSYNC-03 (PAR-228): a terminal lane whose "liveness" is only the
				// launcher's recorded session_live (no agent process confirmed by the
				// probe) and whose live pane is BENIGN — a finished command sitting at
				// its prompt or a bare/idle shell — is not attention work. The shell
				// is alive but the agent is gone and the human is not blocked, so let
				// it fall through to its normal terminal bucket instead of the
				// badge-counted action bucket. A confirmed agent process (liveness
				// "alive") or a genuine awaiting-user-input pane is never suppressed —
				// attention is preserved when in doubt.
				const benignLivePane =
					liveness !== "alive" && this.isBenignLiveTerminalPane(node.task);
				if (!benignLivePane) {
					return "attention";
				}
			}
		}

		if (status === "completed") {
			// A pending/changes_requested review keeps the task in Attention
			// only until the user manually marks it reviewed (ReviewTracker
			// sidecar). Reviewed tasks fall through to the handoff and
			// pending-review-receipt checks below, so true blockers still
			// surface in Limbo instead of silently landing in Done.
			//
			// CCSYNC-01: a stale read-model projection (review still says pending
			// but the advertised receipt is missing and nothing is live) is NOT
			// attention-required work — it is reconciliation backlog. Let it fall
			// through to the receipt-missing check below, which routes it to Needs
			// Review (limbo), keeping it out of the activity-bar action badge.
			if (
				node.type === "task" &&
				(node.task.review_status === "pending" ||
					node.task.review_status === "changes_requested") &&
				!this.isTaskReviewed(node.task) &&
				!this.isStaleReviewProjection(node.task)
			) {
				return "attention";
			}
			if (
				node.type === "task" &&
				this.getDeclaredHandoffState(node.task) === "missing"
			) {
				return "limbo";
			}
			if (node.type === "task" && this.isReviewQueueReceiptMissing(node.task)) {
				return "limbo";
			}
			return "done";
		}
		if (status === "completed_dirty" || status === "completed_stale") {
			if (node.type === "task" && this.isReviewQueueReceiptMissing(node.task)) {
				// CCSYNC-01: a missing receipt only counts as attention work when
				// the lane is NOT a stale projection. A stale/dirty row that still
				// claims pending review with a missing receipt and no live
				// pane/process evidence has not been refreshed by the launcher —
				// surface it as reconciliation backlog (Needs Review), never as a
				// badge-counted action terminal.
				if (node.type === "task" && this.isStaleReviewProjection(node.task)) {
					return "limbo";
				}
				return "attention";
			}
			return "limbo";
		}
		return "attention";
	}

	private buildStatusGroupNodes(
		nodes: SortableAgentNode[],
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
		},
	): AgentNode[] {
		const grouped = new Map<AgentStatusGroup, SortableAgentNode[]>();
		for (const node of nodes) {
			const statusGroup = this.getNodeStatusGroup(node);
			const bucket = grouped.get(statusGroup) ?? [];
			bucket.push(node);
			grouped.set(statusGroup, bucket);
		}

		return (["running", "attention", "limbo", "done"] as AgentStatusGroup[])
			.map((status) => {
				const groupNodes = grouped.get(status) ?? [];
				if (groupNodes.length === 0) return null;
				const groupNode: StatusGroupNode = {
					type: "statusGroup",
					status,
					nodes: groupNodes,
				};
				if (options?.parentProjectName) {
					groupNode.parentProjectName = options.parentProjectName;
				}
				if (options?.parentProjectDir) {
					groupNode.parentProjectDir = options.parentProjectDir;
				}
				if (options?.parentGroupKey) {
					groupNode.parentGroupKey = options.parentGroupKey;
				}
				return groupNode;
			})
			.filter((node): node is StatusGroupNode => Boolean(node));
	}

	private shouldUseStatusTimeGrouping(
		_status: AgentStatusGroup,
		_nodes: SortableAgentNode[],
	): boolean {
		return false;
	}

	private getStatusGroupRecentThresholdMs(status: AgentStatusGroup): number {
		if (status === "running") return Number.POSITIVE_INFINITY;
		if (status === "attention") return 2 * DAY_MS;
		// Needs Review (limbo) collapses overnight review backlog while keeping
		// freshly-completed review items expanded; Done is always collapsed and
		// never consults this threshold.
		if (status === "limbo") return LIMBO_RECENT_THRESHOLD_MS;
		return DAY_MS;
	}

	private buildStatusTimeGroups(
		status: AgentStatusGroup,
		nodes: SortableAgentNode[],
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
		},
	): StatusTimeGroupNode[] {
		const periods: StatusTimeGroupPeriod[] = [
			"today",
			"yesterday",
			"last7days",
			"last30days",
			"older",
		];
		const grouped = groupByTimePeriod(
			nodes,
			(node) => this.getNodeActivityTimeMs(node),
			periods,
		);

		return periods
			.map((period) => {
				const periodNodes = grouped.get(period) ?? [];
				if (periodNodes.length === 0) return null;

				const groupNode: StatusTimeGroupNode = {
					type: "statusTimeGroup" as const,
					status,
					period,
					label: `${TIME_PERIOD_LABELS[period]} (${periodNodes.length})`,
					nodes: periodNodes,
					collapsibleState:
						period === "older" || period === "last30days"
							? vscode.TreeItemCollapsibleState.Collapsed
							: vscode.TreeItemCollapsibleState.Expanded,
				};
				if (options?.parentProjectName) {
					groupNode.parentProjectName = options.parentProjectName;
				}
				if (options?.parentProjectDir) {
					groupNode.parentProjectDir = options.parentProjectDir;
				}
				if (options?.parentGroupKey) {
					groupNode.parentGroupKey = options.parentGroupKey;
				}
				return groupNode;
			})
			.filter((group): group is StatusTimeGroupNode => Boolean(group));
	}

	private getStatusGroupChildren(node: StatusGroupNode): AgentNode[] {
		if (!this.shouldUseStatusTimeGrouping(node.status, node.nodes)) {
			return this.applyAgentVisibilityCap(node.nodes, {
				parentProjectName: node.parentProjectName,
				parentProjectDir: node.parentProjectDir,
				parentGroupKey: node.parentGroupKey,
				parentStatus: node.status,
			});
		}

		return this.buildStatusTimeGroups(node.status, node.nodes, {
			parentProjectName: node.parentProjectName,
			parentProjectDir: node.parentProjectDir,
			parentGroupKey: node.parentGroupKey,
		});
	}

	private getProjectGroupChildren(node: ProjectGroupNode): AgentNode[] {
		const sorted = this.sortAgentNodes([
			...node.tasks.map(
				(task) => ({ type: "task" as const, task }) satisfies SortableAgentNode,
			),
			...(node.discoveredAgents ?? []).map(
				(agent) =>
					({
						type: "discovered" as const,
						agent,
					}) satisfies SortableAgentNode,
			),
		]);

		const parentOptions = {
			parentProjectName: node.projectName,
			parentProjectDir: node.projectDir,
			parentGroupKey: node.parentGroupKey,
		};

		// If ≤ 5 agents, show them flat (no sub-grouping needed)
		if (sorted.length <= 5) {
			return this.applyAgentVisibilityCap(sorted, parentOptions);
		}

		// > 5 agents: sub-group by status (like Git Sort's time-period groups)
		return this.buildStatusGroupNodes(sorted, parentOptions);
	}

	private statusGroupHasRecentItems(node: StatusGroupNode): boolean {
		if (node.status === "running") return true;

		const now = Date.now();
		const thresholdMs = this.getStatusGroupRecentThresholdMs(node.status);
		return node.nodes.some((child) => {
			const activityMs = this.getNodeActivityTimeMs(child);
			return activityMs > 0 && now - activityMs <= thresholdMs;
		});
	}

	private isAlwaysVisibleAgentNode(node: SortableAgentNode): boolean {
		if (node.type === "openclawTask") {
			return isOpenClawTaskActive(node.task);
		}
		return this.getNodeStatus(node) === "running";
	}

	private matchesSortableNode(
		left: SortableAgentNode,
		right: SortableAgentNode,
	): boolean {
		if (left.type !== right.type) return false;
		if (left.type === "task") {
			const rightTask = right as Extract<SortableAgentNode, { type: "task" }>;
			return left.task.id === rightTask.task.id;
		}
		if (left.type === "openclawTask") {
			const rightTask = right as Extract<
				SortableAgentNode,
				{ type: "openclawTask" }
			>;
			return left.task.taskId === rightTask.task.taskId;
		}
		if (left.type === "discovered") {
			const rightAgent = right as Extract<
				SortableAgentNode,
				{ type: "discovered" }
			>;
			return left.agent.pid === rightAgent.agent.pid;
		}
		return false;
	}

	private olderRunsContainsNode(
		node: OlderRunsNode,
		target: SortableAgentNode,
	): boolean {
		return node.hiddenNodes.some((hidden) =>
			this.matchesSortableNode(hidden, target),
		);
	}

	/** Check if a node has a capped completed status (completed or completed_dirty). */
	private isCappedCompletedNode(node: SortableAgentNode): boolean {
		const status = this.getNodeStatus(node);
		return status === "completed" || status === "completed_dirty";
	}

	private applyAgentVisibilityCap(
		nodes: SortableAgentNode[],
		options?: {
			parentProjectName?: string;
			parentProjectDir?: string;
			parentGroupKey?: string;
			parentStatus?: AgentStatusGroup;
		},
	): AgentNode[] {
		// Phase 1: Apply completed task cap — nodes are already sorted by recency.
		// Split into always-visible (running, stopped, failed, killed, completed_stale)
		// and capped (completed, completed_dirty — keep only the most recent N).
		const completedLimit = this.getCompletedTaskLimit();
		let completedSeen = 0;
		const cappedNodes: SortableAgentNode[] = [];
		const completedOverflow: SortableAgentNode[] = [];

		for (const node of nodes) {
			if (this.isCappedCompletedNode(node)) {
				completedSeen++;
				if (completedSeen <= completedLimit) {
					cappedNodes.push(node);
				} else {
					completedOverflow.push(node);
				}
			} else {
				cappedNodes.push(node);
			}
		}

		// Phase 2: Apply overall visibility cap on the remaining nodes.
		const cap = this.getMaxVisibleAgents();
		const visibleNodes: AgentNode[] = [];
		const hiddenNodes: SortableAgentNode[] = [];

		if (cappedNodes.length <= cap) {
			for (const node of cappedNodes) {
				visibleNodes.push(this.toAgentNode(node));
			}
		} else {
			for (const [index, node] of cappedNodes.entries()) {
				if (index < cap || this.isAlwaysVisibleAgentNode(node)) {
					visibleNodes.push(this.toAgentNode(node));
					continue;
				}
				hiddenNodes.push(node);
			}
		}

		// Merge both overflow sets — completed overflow first (already sorted),
		// then general overflow.
		const allHidden = [...completedOverflow, ...hiddenNodes];

		if (allHidden.length === 0) {
			return visibleNodes;
		}

		const label =
			allHidden.length === 1
				? "Show 1 older completed..."
				: `Show ${allHidden.length} older completed...`;
		return [
			...visibleNodes,
			{
				type: "olderRuns",
				label,
				hiddenNodes: allHidden,
				parentProjectName: options?.parentProjectName,
				parentProjectDir: options?.parentProjectDir,
				parentGroupKey: options?.parentGroupKey,
				parentStatus: options?.parentStatus,
			},
		];
	}

	private getProjectGroupFreshestActivityMs(group: {
		tasks: AgentTask[];
		discoveredAgents?: DiscoveredAgent[];
	}): number {
		const activityTimes = [
			...group.tasks.map((task) => this.getTaskActivityTimeMs(task)),
			...(group.discoveredAgents ?? []).map((agent) =>
				this.getDiscoveredActivityTimeMs(agent),
			),
		];
		return activityTimes.length > 0 ? Math.max(...activityTimes) : 0;
	}

	private compareProjectGroups(
		left: ProjectGroupNode,
		right: ProjectGroupNode,
	): number {
		// The UNREGISTERED PROJECTS bucket is a diagnostics surface, not a
		// project — it always sorts after real project groups.
		const leftUnregistered = left.unregistered === true;
		const rightUnregistered = right.unregistered === true;
		if (leftUnregistered !== rightUnregistered) {
			return leftUnregistered ? 1 : -1;
		}

		const leftHasRunning = this.projectGroupHasRunning(left);
		const rightHasRunning = this.projectGroupHasRunning(right);
		if (leftHasRunning !== rightHasRunning) {
			return leftHasRunning ? -1 : 1;
		}

		const activityDiff = this.compareActivityTimeDesc(
			this.getProjectGroupFreshestActivityMs(left),
			this.getProjectGroupFreshestActivityMs(right),
		);
		if (activityDiff !== 0) {
			return activityDiff;
		}
		return this.compareTaskNames(left.projectName, right.projectName);
	}

	private getFolderGroupFreshestActivityMs(group: {
		projects: ProjectGroupNode[];
	}): number {
		const activityTimes = group.projects.map((project) =>
			this.getProjectGroupFreshestActivityMs(project),
		);
		return activityTimes.length > 0 ? Math.max(...activityTimes) : 0;
	}

	private compareGroupedRoots(
		left: ProjectGroupNode | FolderGroupNode,
		right: ProjectGroupNode | FolderGroupNode,
	): number {
		const leftUnregistered =
			left.type === "projectGroup" && left.unregistered === true;
		const rightUnregistered =
			right.type === "projectGroup" && right.unregistered === true;
		if (leftUnregistered !== rightUnregistered) {
			return leftUnregistered ? 1 : -1;
		}

		const leftLabel =
			left.type === "folderGroup" ? left.groupName : left.projectName;
		const rightLabel =
			right.type === "folderGroup" ? right.groupName : right.projectName;
		const leftHasRunning =
			left.type === "folderGroup"
				? left.projects.some((project) => this.projectGroupHasRunning(project))
				: this.projectGroupHasRunning(left);
		const rightHasRunning =
			right.type === "folderGroup"
				? right.projects.some((project) => this.projectGroupHasRunning(project))
				: this.projectGroupHasRunning(right);
		if (leftHasRunning !== rightHasRunning) {
			return leftHasRunning ? -1 : 1;
		}

		const activityDiff = this.compareActivityTimeDesc(
			left.type === "folderGroup"
				? this.getFolderGroupFreshestActivityMs(left)
				: this.getProjectGroupFreshestActivityMs(left),
			right.type === "folderGroup"
				? this.getFolderGroupFreshestActivityMs(right)
				: this.getProjectGroupFreshestActivityMs(right),
		);
		if (activityDiff !== 0) {
			return activityDiff;
		}
		return this.compareTaskNames(leftLabel, rightLabel);
	}

	private projectGroupHasRunning(group: ProjectGroupNode): boolean {
		return (
			group.tasks.some((task) => task.status === "running") ||
			(group.discoveredAgents?.length ?? 0) > 0
		);
	}

	private sortTasks(tasks: AgentTask[]): AgentTask[] {
		return [...tasks].sort((a, b) => {
			return this.compareSortableAgentNodes(
				{ type: "task", task: a },
				{ type: "task", task: b },
			);
		});
	}

	/**
	 * A lane without a launcher-assigned visible_project_name is the canonical
	 * checkout for its project; worktree lanes carry a path-derived visible
	 * name and must not define the group's identity.
	 */
	private isCanonicalProjectLane(task: AgentTask): boolean {
		return !task.visible_project_name?.trim();
	}

	/**
	 * The launcher-assigned explicit project name, or null when the record's
	 * name was derived from a path basename at normalization. Derived names
	 * never label top-level project groups.
	 */
	private getExplicitTaskProjectName(task: AgentTask): string | null {
		if (task.project_name_derived === true) return null;
		return task.project_name?.trim() || null;
	}

	/**
	 * Work Registry identity for grouping: the embedded `project_ref` wins,
	 * then the launcher-stamped `project_id`, then the injectable resolver
	 * adapter (canonical project dir → project dir → execution dir → exec cwd
	 * → repo origin). Undefined means the record is not attributable to a
	 * registered project.
	 */
	private getTaskProjectIdentity(
		task: AgentTask,
	): { id: string; displayName: string | null } | undefined {
		const refId = task.project_ref?.id?.trim();
		if (refId) {
			return {
				id: refId,
				displayName: task.project_ref?.displayName?.trim() || null,
			};
		}
		const projectId = task.project_id?.trim();
		if (projectId) {
			return { id: projectId, displayName: null };
		}
		const resolved = this.projectRefResolver.resolveProjectRef({
			canonicalProjectDir: task.canonical_project_dir,
			projectDir: task.project_dir,
			executionDir: task.execution_dir,
			execCwd: task.exec_cwd,
			repoOrigins: task.project_ref?.repoOrigins ?? null,
		});
		const resolvedId = resolved?.id?.trim();
		if (resolvedId) {
			return {
				id: resolvedId,
				displayName: resolved?.displayName?.trim() || null,
			};
		}
		return undefined;
	}

	private getProjectGroupDisplayName(
		task: AgentTask,
		identity: { id: string; displayName: string | null } | undefined,
	): string {
		if (identity) {
			// Identity-keyed groups take the registry display name or the
			// project's own name — never a per-lane worktree label like
			// "command-central cc 002 ..." and never a path basename.
			return (
				identity.displayName ||
				this.getExplicitTaskProjectName(task) ||
				identity.id
			);
		}
		return this.getExplicitTaskProjectName(task) ?? task.project_name;
	}

	private buildProjectNodes(
		tasks: AgentTask[],
		discoveredAgents: DiscoveredAgent[],
	): ProjectGroupNode[] {
		const grouped = new Map<
			string,
			{
				projectName: string;
				projectDir: string;
				tasks: AgentTask[];
				discoveredAgents: DiscoveredAgent[];
				hasCanonicalIdentity: boolean;
				unregistered: boolean;
			}
		>();

		// Dirs claimed by identity lanes (project_ref/project_id/resolver)
		// route worktree lanes, legacy no-id tasks, and discovered agents in
		// the same checkout into one canonical group instead of one group per
		// worktree path.
		const identities = new Map<
			AgentTask,
			{ id: string; displayName: string | null } | undefined
		>();
		const dirToGroupKey = new Map<string, string>();
		for (const task of tasks) {
			const identity = this.getTaskProjectIdentity(task);
			identities.set(task, identity);
			if (!identity) continue;
			const groupKey = `id:${identity.id}`;
			for (const dir of [
				task.project_dir,
				task.canonical_project_dir,
				task.execution_dir,
				task.exec_cwd,
			]) {
				if (dir?.trim()) dirToGroupKey.set(dir, groupKey);
			}
		}

		for (const task of tasks) {
			const projectDir = task.project_dir || task.project_name || "";
			const identity = identities.get(task);
			const explicitName = this.getExplicitTaskProjectName(task);
			// Records with no registry identity, no claimed dir, and no
			// explicit launcher name collapse into the UNREGISTERED PROJECTS
			// bucket — a basename or worktree label never becomes a group.
			const groupKey =
				(identity ? `id:${identity.id}` : undefined) ??
				dirToGroupKey.get(projectDir) ??
				(explicitName
					? projectDir
						? `dir:${projectDir}`
						: `name:${explicitName}`
					: UNREGISTERED_PROJECT_GROUP_KEY);
			const unregistered = groupKey === UNREGISTERED_PROJECT_GROUP_KEY;
			const isCanonical = !unregistered && this.isCanonicalProjectLane(task);
			const groupName = unregistered
				? UNREGISTERED_PROJECT_GROUP_NAME
				: this.getProjectGroupDisplayName(task, identity);
			const groupDir = unregistered
				? ""
				: task.canonical_project_dir?.trim() || projectDir;
			const existing = grouped.get(groupKey);
			if (existing) {
				existing.tasks.push(task);
				if (isCanonical && !existing.hasCanonicalIdentity) {
					existing.projectName = groupName;
					existing.projectDir = groupDir;
					existing.hasCanonicalIdentity = true;
				}
			} else {
				grouped.set(groupKey, {
					projectName: groupName,
					projectDir: groupDir,
					tasks: [task],
					discoveredAgents: [],
					hasCanonicalIdentity: isCanonical,
					unregistered,
				});
			}
		}

		for (const agent of discoveredAgents) {
			const projectDir = this.getDiscoveredProjectDir(agent);
			const projectName = this.getDiscoveredProjectName(agent);
			const groupKey =
				dirToGroupKey.get(projectDir) ??
				dirToGroupKey.get(agent.projectDir) ??
				(projectDir ? `dir:${projectDir}` : `name:${projectName}`);
			const existing = grouped.get(groupKey);
			if (existing) {
				existing.discoveredAgents.push(agent);
			} else {
				grouped.set(groupKey, {
					projectName,
					projectDir,
					tasks: [],
					discoveredAgents: [agent],
					hasCanonicalIdentity: false,
					unregistered: false,
				});
			}
		}

		return Array.from(grouped.entries())
			.map(([groupKey, group]) => ({
				type: "projectGroup" as const,
				projectName: group.projectName,
				projectDir: group.projectDir,
				groupKey,
				...(group.unregistered ? { unregistered: true } : {}),
				tasks: this.sortTasks(group.tasks),
				discoveredAgents: [...group.discoveredAgents].sort((a, b) =>
					this.compareSortableAgentNodes(
						{ type: "discovered", agent: a },
						{ type: "discovered", agent: b },
					),
				),
			}))
			.sort((a, b) => this.compareProjectGroups(a, b));
	}

	private getWorkspaceParentGroups(): Map<
		string,
		{ count: number; workspaceDirs: Set<string> }
	> {
		const byParent = new Map<string, Set<string>>();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const workspaceDir = path.resolve(folder.uri.fsPath);
			const parentDir = path.dirname(workspaceDir);
			const siblingDirs = byParent.get(parentDir) ?? new Set<string>();
			siblingDirs.add(workspaceDir);
			byParent.set(parentDir, siblingDirs);
		}

		const result = new Map<
			string,
			{ count: number; workspaceDirs: Set<string> }
		>();
		for (const [parentDir, workspaceDirs] of byParent.entries()) {
			if (workspaceDirs.size >= 2) {
				result.set(parentDir, {
					count: workspaceDirs.size,
					workspaceDirs,
				});
			}
		}
		return result;
	}

	private getProjectGroupOverride(projectDir: string): string | null {
		if (!projectDir) return null;
		if (!path.isAbsolute(projectDir)) return null;
		const normalizedProjectDir = path.resolve(projectDir);
		const workspaceFolder = (vscode.workspace.workspaceFolders ?? []).find(
			(folder) => path.resolve(folder.uri.fsPath) === normalizedProjectDir,
		);
		if (workspaceFolder) {
			const workspaceOverride = vscode.workspace
				.getConfiguration("commandCentral", workspaceFolder.uri)
				.get<string>("project.group", "")
				.trim();
			if (workspaceOverride.length > 0) return workspaceOverride;
		}

		const settingsOverride = this.readProjectSettingFromFile(
			projectDir,
			"commandCentral.project.group",
		);
		return settingsOverride && settingsOverride.length > 0
			? settingsOverride
			: null;
	}

	private getAutoParentGroup(projectDir: string): {
		groupKey: string;
		groupName: string;
		projectCount: number;
	} | null {
		if (!projectDir) return null;
		if (!path.isAbsolute(projectDir)) return null;
		const normalizedProjectDir = path.resolve(projectDir);
		const parentDir = path.dirname(normalizedProjectDir);
		const workspaceParents = this.getWorkspaceParentGroups();
		const parentInfo = workspaceParents.get(parentDir);
		if (!parentInfo?.workspaceDirs.has(normalizedProjectDir)) {
			return null;
		}

		return {
			groupKey: `auto:${parentDir}`,
			groupName: path.basename(parentDir) || parentDir,
			projectCount: parentInfo.count,
		};
	}

	private buildGroupedRootNodes(
		tasks: AgentTask[],
		discoveredAgents: DiscoveredAgent[],
	): Array<ProjectGroupNode | FolderGroupNode> {
		let projectNodes = this.buildProjectNodes(tasks, discoveredAgents);

		// Apply project filter if active
		if (this._projectFilter) {
			const filterDir = this._projectFilter;
			projectNodes = projectNodes.filter((node) => {
				const dir =
					node.projectDir || node.tasks[0]?.project_dir || node.projectName;
				return dir === filterDir;
			});
		}
		const folderGroups = new Map<
			string,
			{
				groupName: string;
				projectCount: number;
				projects: ProjectGroupNode[];
			}
		>();
		const directProjects: ProjectGroupNode[] = [];

		for (const projectNode of projectNodes) {
			const projectDir =
				projectNode.projectDir ||
				projectNode.tasks[0]?.project_dir ||
				projectNode.projectName;
			const manualGroup = this.getProjectGroupOverride(projectDir);
			const autoParentGroup = manualGroup
				? null
				: this.getAutoParentGroup(projectDir);
			const targetGroup = manualGroup
				? {
						groupKey: `manual:${manualGroup.toLowerCase()}`,
						groupName: manualGroup,
						projectCount: 1,
					}
				: autoParentGroup;
			if (!targetGroup) {
				directProjects.push(projectNode);
				continue;
			}

			const existing = folderGroups.get(targetGroup.groupKey);
			if (existing) {
				existing.projects.push({
					...projectNode,
					parentGroupKey: targetGroup.groupKey,
					parentGroupName: targetGroup.groupName,
				});
				if (targetGroup.groupKey.startsWith("manual:")) {
					existing.projectCount += 1;
				}
				continue;
			}
			folderGroups.set(targetGroup.groupKey, {
				groupName: targetGroup.groupName,
				projectCount: targetGroup.projectCount,
				projects: [
					{
						...projectNode,
						parentGroupKey: targetGroup.groupKey,
						parentGroupName: targetGroup.groupName,
					},
				],
			});
		}

		const folderGroupNodes: FolderGroupNode[] = Array.from(
			folderGroups.entries(),
		)
			.map(([groupKey, entry]) => ({
				type: "folderGroup" as const,
				groupKey,
				groupName: entry.groupName,
				projectCount: entry.projectCount,
				projects: [...entry.projects].sort((a, b) =>
					this.compareProjectGroups(a, b),
				),
			}))
			.sort((a, b) => this.compareGroupedRoots(a, b));

		const sortedDirectProjects = [...directProjects].sort((a, b) =>
			this.compareProjectGroups(a, b),
		);
		return [...folderGroupNodes, ...sortedDirectProjects].sort((a, b) =>
			this.compareGroupedRoots(a, b),
		);
	}

	private getCompactChildren(t: AgentTask): DetailNode[] {
		const details: DetailNode[] = [];
		const gitInfo = this.getGitInfo(t.project_dir);
		if (gitInfo) {
			details.push({
				type: "detail",
				label: "Branch",
				value: gitInfo.branch,
				taskId: t.id,
			});
		}
		return details;
	}

	private getDetailChildren(t: AgentTask): DetailNode[] {
		const details: DetailNode[] = [];
		const rawStatus = this.registry.tasks[t.id]?.status;

		// ── 1. Result line — FIRST child, prominent ─────────────────────
		const duration = t.completed_at
			? formatDurationPrecise(t.started_at, t.completed_at)
			: null;
		const runningDuration = formatDurationPrecise(t.started_at);

		if (t.status === "failed" && t.exit_code != null) {
			const retrySuffix =
				t.attempts > 1 ? ` · Retry ${t.attempts}/${t.max_attempts}` : "";
			const durationSuffix = duration ? ` after ${duration}` : "";
			const errorMessage = t.error_message?.trim();
			details.push({
				type: "detail",
				label: `Failed (exit code ${t.exit_code})${durationSuffix}${retrySuffix}`,
				value: "",
				taskId: t.id,
				description:
					errorMessage && errorMessage.length > 0 ? errorMessage : undefined,
				icon: "error",
				iconColor: "charts.red",
			});
		} else if (
			t.exit_code != null &&
			(t.status === "completed" ||
				t.status === "completed_dirty" ||
				t.status === "stopped")
		) {
			const retrySuffix =
				t.attempts > 1 ? ` · Retry ${t.attempts}/${t.max_attempts}` : "";
			const durationSuffix = duration ? ` in ${duration}` : "";
			if (t.exit_code === 0) {
				details.push({
					type: "detail",
					label: `Completed${durationSuffix}${retrySuffix}`,
					value: "",
					taskId: t.id,
					icon: "pass",
					iconColor: "charts.green",
				});
			} else {
				details.push({
					type: "detail",
					label: `Failed (exit code ${t.exit_code})${durationSuffix}${retrySuffix}`,
					value: "",
					taskId: t.id,
					icon: "error",
					iconColor: "charts.red",
				});
			}
		} else if (t.status === "running") {
			details.push({
				type: "detail",
				label: `Running for ${runningDuration}`,
				value: "",
				taskId: t.id,
				icon: "sync~spin",
				iconColor: "charts.blue",
			});
		}

		if (rawStatus === "running" && t.status === "stopped") {
			details.push({
				type: "detail",
				label: "Agent process ended",
				value: "Click to restart or dismiss",
				taskId: t.id,
				icon: "alert",
				iconColor: "charts.yellow",
			});
		}
		if (rawStatus === "running" && t.status === "completed_stale") {
			details.push({
				type: "detail",
				label: "Stale — no completion signal",
				value: "",
				taskId: t.id,
				icon: "warning",
				iconColor: "charts.yellow",
			});
		}

		if (this.isAgentStuck(t)) {
			const thresholdMinutes = this.getStuckThresholdMinutes();
			if (this.hasPositiveLivenessEvidence(t)) {
				// Live launcher-managed lane: stream silence is most likely the
				// user composing input in an interactive REPL. Surface honestly
				// rather than warning them that their own session is stuck.
				details.push({
					type: "detail",
					label: `Interactive — no stream activity for ${thresholdMinutes} minutes`,
					value: "",
					taskId: t.id,
					icon: "comment-discussion",
					iconColor: "charts.blue",
				});
			} else {
				details.push({
					type: "detail",
					label: `No activity for ${thresholdMinutes} minutes`,
					value: "",
					taskId: t.id,
					icon: "alert",
					iconColor: "charts.yellow",
				});
			}
		}
		if (
			t.status === "completed" &&
			t.review_status !== "pending" &&
			t.review_status !== "changes_requested" &&
			this.getDeclaredHandoffState(t) !== "missing" &&
			this.isReviewQueueReceiptMissing(t)
		) {
			details.push({
				type: "detail",
				label: "Review queue receipt not yet materialized",
				value: "",
				description: t.pending_review_path ?? undefined,
				taskId: t.id,
				icon: "watch",
				iconColor: "charts.yellow",
			});
		}

		// ── 2. Prompt — smart truncation ────────────────────────────────
		const promptSummary = this.readPromptSummary(t.prompt_file);
		const isPromptFallback =
			!promptSummary || promptSummary === path.basename(t.prompt_file);
		const promptValue =
			isPromptFallback && t.prompt_summary ? t.prompt_summary : promptSummary;
		if (promptValue && promptValue !== "---" && !promptValue.endsWith(".md")) {
			const cleanedPrompt = cleanPromptForDisplay(promptValue);
			if (cleanedPrompt) {
				const truncatedPrompt =
					cleanedPrompt.length > 80
						? `${cleanedPrompt.slice(0, 79)}…`
						: cleanedPrompt;
				details.push({
					type: "detail",
					label: truncatedPrompt,
					value: "",
					taskId: t.id,
					icon: "comment",
				});
			}
		}

		// ── 3. Changes — inline file names when ≤3 files ────────────────
		const diffSummary = this.getCachedDiffSummaryForTask(t);
		if (diffSummary) {
			const changesLabel = this.formatSmartDiffLabel(t, diffSummary);
			details.push({
				type: "detail",
				label: changesLabel,
				value: "",
				taskId: t.id,
				icon: "files",
			});
		}
		// Omit diff loading placeholder — show nothing until ready

		// ── 4. Git info — branch + commit with click-to-copy ────────────
		const gitInfo = this.getGitInfo(t.project_dir);
		if (gitInfo) {
			const gitHash =
				t.status === "running"
					? extractCommitHash(gitInfo.lastCommit)
					: getTaskDiffEndCommit(t);
			const shortHash = gitHash ? shortenCommitHash(gitHash) : null;
			const gitLabel = shortHash
				? `${gitInfo.branch} · ${shortHash}`
				: gitInfo.branch;
			details.push({
				type: "detail",
				label: gitLabel,
				value: "",
				taskId: t.id,
				icon: "git-branch",
				command: gitHash
					? {
							command: "commandCentral.copyToClipboard",
							title: "Copy commit hash",
							arguments: [gitHash],
						}
					: undefined,
			});
		}

		// ── 5. Duration — only if not already shown in Result line ──────
		if (
			t.status === "running" &&
			!details.some((d) => d.icon === "sync~spin")
		) {
			details.push({
				type: "detail",
				label: runningDuration,
				value: "",
				taskId: t.id,
				icon: "clock",
			});
		}

		// PR info
		if (t.pr_number) {
			details.push({
				type: "detail",
				label: "PR",
				value: `#${t.pr_number}${t.review_status ? ` (${t.review_status})` : ""}`,
				taskId: t.id,
			});
		}

		// ── 6. Model — clean alias format ───────────────────────────────
		const detailFallback = this.getTaskFallbackInfo(t);
		const modelDisplay = this.resolveTaskModelDisplay(t);
		if (detailFallback) {
			details.push({
				type: "detail",
				label: `${detailFallback.actualAlias} (fallback from ${detailFallback.requestedAlias})`,
				value: "",
				taskId: t.id,
				icon: "hubot",
			});
		} else if (modelDisplay) {
			details.push({
				type: "detail",
				label: modelDisplay.alias,
				value: "",
				taskId: t.id,
				icon: "hubot",
			});
		}

		// Port detection — only for running tasks with a valid session (non-blocking)
		if (t.status === "running" && t.session_id) {
			const cached = this._portCache.get(t.id);
			if (cached !== undefined) {
				if (cached.length > 0) {
					details.push({
						type: "detail",
						label: "Ports",
						value: cached.map((p) => `${p.port} (${p.process})`).join(", "),
						taskId: t.id,
					});
				}
			} else if (!this._portDetecting.has(t.id)) {
				this._portDetecting.add(t.id);
				void this._detectPortsAsync(t);
			}
		}

		// ── 7. Completion routing — owner-bound vs detached ─────────────
		const routing = classifyCompletionRouting(t);
		if (routing.kind !== "not-applicable") {
			details.push({
				type: "detail",
				label: routing.label,
				value: "",
				description: routing.detail,
				taskId: t.id,
				icon: routing.icon,
				iconColor: routing.iconColor,
			});
		}

		// ── 8. Lifecycle conflict — launcher vs live process ─────────────
		const isTerminalStatus = t.status !== "running";
		const supersededByReset = isSupersededByReleaseReset(
			t,
			this.getCurrentReleaseGeneration(),
		);
		if (isTerminalStatus && !supersededByReset) {
			const liveness = this.getTerminalTaskLivenessEvidence(t);
			const conflict = classifyLifecycleConflict(
				t,
				liveness,
				this.effectiveLauncherSessionLive(t),
			);
			if (conflict.kind === "live-process-conflict") {
				details.push({
					type: "detail",
					label: conflict.label,
					value: "",
					description: conflict.detail,
					taskId: t.id,
					icon: conflict.icon,
					iconColor: conflict.iconColor,
				});
			}
		} else if (isTerminalStatus && supersededByReset) {
			// Pre-reset stale terminal app: this lane's Ghostty app/window predates
			// the current release/reset generation. Surface it as superseded (not
			// live, not killed) so the operator knows it is a leftover app whose
			// pane — even if still alive — is not a current running agent.
			details.push({
				type: "detail",
				label: "Stale terminal app",
				value: "",
				description: `Ghostty app/window belongs to a superseded release generation (${t.release_generation}); recreated on a later release — the tmux pane may still be alive but is not a current running agent`,
				taskId: t.id,
				icon: "history",
				iconColor: "disabledForeground",
			});
		}

		return details;
	}

	private getAutoReviewLaneChildren(task: AgentTask): DetailNode[] {
		const allTasks = this.getDisplayLauncherTasks();
		const reviewLanes = allTasks.filter((t) => {
			if (!isAutoReviewLane(t)) return false;
			return extractSourceTaskId(t) === task.id;
		});
		return reviewLanes.map((lane) => ({
			type: "detail" as const,
			label: `Review: ${lane.id}`,
			value: lane.status,
			taskId: task.id,
			icon: "eye",
			iconColor: lane.status === "completed" ? "charts.green" : "charts.yellow",
			command: lane.handoff_file
				? {
						command: "vscode.open",
						title: "Open review handoff",
						arguments: [vscode.Uri.file(lane.handoff_file)],
					}
				: undefined,
		}));
	}

	/**
	 * Strip boilerplate prefixes (ULTRATHINK, system-reminder lines, etc.)
	 * and return the first meaningful line, trimmed.
	 */
	/**
	 * If ≤3 files changed, show file names inline; otherwise keep the count summary.
	 * Uses cached per-file data from getFileChangeChildren to avoid extra git spawns.
	 */
	private formatSmartDiffLabel(t: AgentTask, fallbackSummary: string): string {
		// Parse the file count from the cached summary (e.g. "3 files · +100 / -20")
		const countMatch = fallbackSummary.match(/^(\d+)\s+files?\s+·/);
		const fileCount = countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : 0;

		// Only attempt inline file names for ≤3 files in valid git repos
		if (fileCount < 1 || fileCount > 3) return fallbackSummary;
		if (!fs.existsSync(t.project_dir)) return fallbackSummary;

		try {
			const startCommit = getTaskDiffStartCommit(t);
			const endCommit = getTaskDiffEndCommit(t);
			const fileDiffs = this.getPerFileDiffs(
				t.project_dir,
				startCommit,
				endCommit,
			);
			if (fileDiffs.length === 0 || fileDiffs.length > 3)
				return fallbackSummary;

			const additions = fileDiffs.reduce(
				(total, d) => total + Math.max(d.additions, 0),
				0,
			);
			const deletions = fileDiffs.reduce(
				(total, d) => total + Math.max(d.deletions, 0),
				0,
			);
			const names = fileDiffs.map((d) => path.basename(d.filePath));
			return `${names.join(", ")} · +${additions} / -${deletions}`;
		} catch {
			return fallbackSummary;
		}
	}

	private getFileChangeChildren(t: AgentTask): FileChangeNode[] {
		const startCommit = getTaskDiffStartCommit(t);
		const endCommit = getTaskDiffEndCommit(t);
		const fileDiffs = this.getPerFileDiffs(
			t.project_dir,
			startCommit,
			endCommit,
		);
		return fileDiffs.map((diff) => ({
			type: "fileChange",
			taskId: t.id,
			projectDir: t.project_dir,
			projectName: getTaskDisplayProjectName(t) || t.project_dir,
			filePath: diff.filePath,
			additions: diff.additions,
			deletions: diff.deletions,
			status: diff.status ?? deriveFallbackFileChangeStatus(diff),
			diffMode: t.status === "running" ? "workingTree" : "boundedCommit",
			startCommit,
			endCommit,
		}));
	}

	private getOpenClawTaskDetailChildren(task: OpenClawTask): DetailNode[] {
		const taskId = `openclaw-${task.taskId}`;
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Runtime",
				value: task.runtime,
				taskId,
				icon: getOpenClawRuntimeIcon(task.runtime),
			},
			{
				type: "detail",
				label: "Status",
				value: openclawStatusToLabel(task.status),
				taskId,
				icon: openclawStatusToIcon(task.status).id,
				iconColor: openclawStatusToIcon(task.status).color?.id,
			},
		];

		if (task.agentId) {
			details.push({
				type: "detail",
				label: "Agent",
				value: task.agentId,
				taskId,
				icon: "hubot",
			});
		}

		// Cross-project orchestration identity (CC-006): tracked issue, target
		// workspace, execution node, workflow contract. Empty for plain local
		// background tasks, so the common case stays noise-free.
		for (const row of classifyOpenClawCrossProjectContext(task)) {
			details.push({
				type: "detail",
				label: row.label,
				value: row.value,
				taskId,
				icon: row.icon,
				...(row.iconColor ? { iconColor: row.iconColor } : {}),
				...(row.url
					? {
							command: {
								command: "vscode.open",
								title: "Open Tracked Issue",
								arguments: [vscode.Uri.parse(row.url)],
							},
						}
					: {}),
			});
		}

		const duration = formatOpenClawTaskDuration(task);
		if (duration) {
			details.push({
				type: "detail",
				label: "Duration",
				value: duration,
				taskId,
				icon: "watch",
			});
		}

		if (task.error) {
			details.push({
				type: "detail",
				label: "Error",
				value: task.error,
				taskId,
				icon: "error",
				iconColor: "charts.red",
			});
		}

		const summary =
			task.terminalSummary?.trim() || task.progressSummary?.trim();
		if (summary) {
			details.push({
				type: "detail",
				label: "Summary",
				value: summary,
				taskId,
				icon: "note",
			});
		}

		return details;
	}

	private getSymphonyDashboardDetailChildren(
		node: SymphonyDashboardNode,
	): DetailNode[] {
		const taskId = "symphony-operations-dashboard";
		const runs = node.runs;
		const snapshot = getSymphonyRuntimeSnapshot(runs);
		const retryQueued = getSymphonyRetryQueuedRuns(runs);
		const released = getSymphonyReleasedRuns(runs);
		const notProvided = "Not provided by lifecycle owner";
		const sumProvided = (
			pick: (run: CodexRunView) => number | undefined,
		): string => {
			const provided = runs
				.map((run) => pick(run))
				.filter((value): value is number => typeof value === "number");
			if (provided.length === 0) return notProvided;
			return `${provided.reduce((total, value) => total + value, 0)}`;
		};
		const sumProvidedSeconds = (
			pick: (run: CodexRunView) => number | undefined,
		): string => {
			const provided = runs
				.map((run) => pick(run))
				.filter((value): value is number => typeof value === "number");
			if (provided.length === 0) return notProvided;
			return `${Math.round(provided.reduce((total, value) => total + value, 0))}`;
		};
		const rateLimitSnapshots = runs
			.map((run) => run.rateLimitSummary)
			.filter((value): value is string => Boolean(value));
		const rateLimitsValue =
			snapshot && snapshot.rateLimits !== undefined
				? formatSymphonySnapshotValue(snapshot.rateLimits)
				: rateLimitSnapshots.length === 0
					? notProvided
					: [...new Set(rateLimitSnapshots)].join(" · ");
		const snapshotStatusValue = snapshot
			? formatSymphonyRuntimeSnapshotStatus(snapshot)
			: notProvided;
		const snapshotCounts = snapshot?.counts;
		const snapshotCodexTotals = snapshot?.codexTotals;
		const snapshotDiagnostics = snapshot?.diagnostics;

		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Boundary",
				value:
					"Read-only Status Surface; lifecycle, retry, tracker, and scheduler state stay source-owned",
				taskId,
				icon: "shield",
			},
			{
				type: "detail",
				label: "Orchestrator Runtime State",
				value: snapshotStatusValue,
				taskId,
				icon: "broadcast",
			},
			...(snapshot?.generatedAt
				? [
						{
							type: "detail" as const,
							label: "generated_at",
							value: snapshot.generatedAt,
							taskId,
							icon: "calendar",
						},
					]
				: []),
			...(snapshot?.lastCronTick
				? [
						{
							type: "detail" as const,
							label: "last_cron_tick",
							value: snapshot.lastCronTick,
							taskId,
							icon: "clock",
						},
					]
				: []),
			...(snapshot?.workflowPath
				? [
						{
							type: "detail" as const,
							label: "workflow_path",
							value: snapshot.workflowPath,
							taskId,
							icon: "book",
						},
					]
				: []),
			...(snapshot?.pollingCadenceMs != null
				? [
						{
							type: "detail" as const,
							label: "polling_cadence_ms",
							value: `${snapshot.pollingCadenceMs}`,
							taskId,
							icon: "watch",
						},
					]
				: []),
			{
				type: "detail",
				label: "Run Attempts",
				value: `${runs.length}`,
				taskId,
				icon: "run-all",
			},
			{
				type: "detail",
				label: "Workstreams",
				value: `${node.flows.length}`,
				taskId,
				icon: "layers",
			},
			{
				type: "detail",
				label: "running",
				value:
					snapshotCounts?.running == null
						? `${getSymphonyRunningSessionRuns(runs).length}`
						: `${snapshotCounts.running}`,
				taskId,
				icon: "pulse",
			},
			{
				type: "detail",
				label: "retrying",
				value:
					snapshotCounts?.retrying == null
						? `${retryQueued.length}`
						: `${snapshotCounts.retrying}`,
				taskId,
				icon: "history",
			},
			...(snapshotCounts?.claimed != null
				? [
						{
							type: "detail" as const,
							label: "claimed",
							value: `${snapshotCounts.claimed}`,
							taskId,
							icon: "tag",
						},
					]
				: []),
			...(snapshot?.completedCount != null
				? [
						{
							type: "detail" as const,
							label: "completed",
							value: `${snapshot.completedCount}`,
							taskId,
							icon: "check-all",
						},
					]
				: []),
			...(snapshot?.completedLimit != null
				? [
						{
							type: "detail" as const,
							label: "completed_limit",
							value: `${snapshot.completedLimit}`,
							taskId,
							icon: "list-tree",
						},
					]
				: []),
			{
				type: "detail",
				label: "codex_totals.input_tokens",
				value:
					snapshotCodexTotals?.inputTokens == null
						? sumProvided((run) => run.inputTokens)
						: `${snapshotCodexTotals.inputTokens}`,
				taskId,
				icon: "arrow-down",
			},
			{
				type: "detail",
				label: "codex_totals.output_tokens",
				value:
					snapshotCodexTotals?.outputTokens == null
						? sumProvided((run) => run.outputTokens)
						: `${snapshotCodexTotals.outputTokens}`,
				taskId,
				icon: "arrow-up",
			},
			{
				type: "detail",
				label: "codex_totals.total_tokens",
				value:
					snapshotCodexTotals?.totalTokens == null
						? sumProvided((run) => run.totalTokens)
						: `${snapshotCodexTotals.totalTokens}`,
				taskId,
				icon: "dashboard",
			},
			{
				type: "detail",
				label: "codex_totals.seconds_running",
				value:
					snapshotCodexTotals?.secondsRunning == null
						? sumProvidedSeconds((run) => run.runtimeSeconds)
						: `${Math.round(snapshotCodexTotals.secondsRunning)}`,
				taskId,
				icon: "clock",
			},
			{
				type: "detail",
				label: "rate_limits",
				value: rateLimitsValue,
				taskId,
				icon: "pulse",
			},
			...(snapshotDiagnostics?.lastCronTickStatus
				? [
						{
							type: "detail" as const,
							label: "diagnostics.last_cron_tick_status",
							value: snapshotDiagnostics.lastCronTickStatus,
							taskId,
							icon: "symbol-event",
						},
					]
				: []),
			...(snapshotDiagnostics?.lastReconciliationDurationMs != null
				? [
						{
							type: "detail" as const,
							label: "diagnostics.last_reconciliation_duration_ms",
							value: `${snapshotDiagnostics.lastReconciliationDurationMs}`,
							taskId,
							icon: "dashboard",
						},
					]
				: []),
			...(snapshotDiagnostics?.lastLinearErrorAt
				? [
						{
							type: "detail" as const,
							label: "diagnostics.last_linear_error_at",
							value: snapshotDiagnostics.lastLinearErrorAt,
							taskId,
							icon: "error",
						},
					]
				: []),
			...(snapshotDiagnostics?.consecutiveLinearErrors != null
				? [
						{
							type: "detail" as const,
							label: "diagnostics.consecutive_linear_errors",
							value: `${snapshotDiagnostics.consecutiveLinearErrors}`,
							taskId,
							icon: "warning",
						},
					]
				: []),
			...(snapshotDiagnostics?.lastCallbackStatus
				? [
						{
							type: "detail" as const,
							label: "diagnostics.last_callback_status",
							value: snapshotDiagnostics.lastCallbackStatus,
							taskId,
							icon: "broadcast",
						},
					]
				: []),
			...(snapshotDiagnostics?.lastCallbackUrl
				? [
						{
							type: "detail" as const,
							label: "diagnostics.last_callback_url",
							value: snapshotDiagnostics.lastCallbackUrl,
							taskId,
							icon: "link",
						},
					]
				: []),
			...(snapshotDiagnostics?.lastWakeAt
				? [
						{
							type: "detail" as const,
							label: "diagnostics.last_wake_at",
							value: snapshotDiagnostics.lastWakeAt,
							taskId,
							icon: "bell",
						},
					]
				: []),
			...(snapshotDiagnostics?.nodeConnected != null
				? [
						{
							type: "detail" as const,
							label: "diagnostics.node_connected",
							value: formatSymphonySnapshotValue(
								snapshotDiagnostics.nodeConnected,
							),
							taskId,
							icon: snapshotDiagnostics.nodeConnected
								? "plug"
								: "debug-disconnect",
						},
					]
				: []),
		];

		if (released.length > 0) {
			details.push({
				type: "detail",
				label: "Released",
				value: `${released.length}`,
				taskId,
				icon: "check",
			});
		}
		return details;
	}

	private getCodexRunDetailChildren(run: CodexRunView): DetailNode[] {
		const taskId = `codex-run-${run.runId}`;
		const details: DetailNode[] = [];
		const pushDetail = (
			label: string,
			value: string | undefined,
			icon: string,
			command?: vscode.Command,
		): void => {
			if (!value) return;
			details.push({
				type: "detail",
				label,
				value,
				taskId,
				icon,
				command,
			});
		};

		pushDetail("Status", formatCodexRunStatus(run.status), "pulse");
		pushDetail("Owner status", run.sourceStatus, "symbol-event");
		pushDetail("Lifecycle owner", formatCodexRunAuthority(run), "shield");
		pushDetail("Projection boundary", formatCodexRunOwnership(run), "account");
		pushDetail("Mode", run.orchestrationMode, "symbol-operator");
		pushDetail("Next step", run.nextAction, "debug-step-into");
		pushDetail(
			"Automation source",
			formatCodexRunAutomationSource(run),
			"git-pull-request",
		);
		pushDetail("Tracker source", formatCodexRunTrackerSource(run), "issues");
		pushDetail("Issue", formatCodexRunIssue(run), "issue-opened");
		pushDetail(
			"Issue URL",
			run.issueUrl,
			"link-external",
			run.issueUrl
				? {
						command: "vscode.open",
						title: "Open Issue",
						arguments: [vscode.Uri.parse(run.issueUrl)],
					}
				: undefined,
		);
		pushDetail("Workflow contract", formatCodexRunWorkflow(run), "book");
		pushDetail("Role", run.role, "person");
		pushDetail("Model", run.model, "symbol-constant");
		pushDetail("Phase", run.phase, "debug-step-over");
		pushDetail("Turns", formatCodexRunTurns(run), "list-ordered");
		pushDetail("Tokens", formatCodexRunTokens(run), "dashboard");
		pushDetail("Runtime", formatCodexRunRuntime(run), "clock");
		pushDetail("Retry", formatCodexRunRetry(run), "debug-restart");
		pushDetail("Rate limits", run.rateLimitSummary, "pulse");
		pushDetail("Current/last tool", run.currentTool, "tools");
		pushDetail("Workspace", run.workspacePath, "folder");
		pushDetail("Thread", run.threadId, "comment-discussion");
		pushDetail("Turn", run.turnId, "debug-restart");
		pushDetail("Run attempt ID", run.runId, "symbol-key", {
			command: "commandCentral.copyToClipboard",
			title: "Copy Run Attempt ID",
			arguments: [run.runId],
		});
		pushDetail("Sources", formatCodexRunSource(run), "references");
		for (const provenance of formatCodexRunFieldSourceDetails(run)) {
			pushDetail(provenance.label, provenance.value, "symbol-field");
		}
		pushDetail("Last event", formatCodexRunLastEvent(run), "pulse");

		if (run.evidence?.length) {
			for (const evidence of run.evidence) {
				pushDetail(
					`Evidence: ${evidence.label}`,
					evidence.value,
					getCodexRunEvidenceIcon(evidence.kind),
					evidence.kind === "file"
						? {
								command: "vscode.open",
								title: "Open Evidence",
								arguments: [vscode.Uri.file(evidence.value)],
							}
						: {
								command: "commandCentral.copyToClipboard",
								title: "Copy Evidence",
								arguments: [evidence.value],
							},
				);
			}
		} else {
			for (const [index, artifactPath] of (run.artifactPaths ?? []).entries()) {
				pushDetail(
					index === 0 ? "Artifact" : `Artifact ${index + 1}`,
					artifactPath,
					"file",
					{
						command: "vscode.open",
						title: "Open Artifact",
						arguments: [vscode.Uri.file(artifactPath)],
					},
				);
			}
		}

		return details;
	}

	private getSymphonySnapshotEntryDetailChildren(
		node: SymphonySnapshotEntryNode,
	): DetailNode[] {
		const taskId = `symphony-${node.kind}-snapshot-${node.index}`;
		const details: DetailNode[] = [];
		const pushDetail = (
			label: string,
			value: string | number | undefined,
			icon: string,
		): void => {
			if (value == null || value === "") return;
			details.push({
				type: "detail",
				label,
				value: String(value),
				taskId,
				icon,
			});
		};

		pushDetail("Snapshot source", node.snapshot.source, "references");
		pushDetail("generated_at", node.snapshot.generatedAt, "calendar");
		pushDetail(
			"Orchestrator Runtime State",
			formatSymphonyRuntimeSnapshotStatus(node.snapshot),
			"broadcast",
		);

		if (node.kind === "running") {
			const entry = node.entry as SymphonyRunningEntryView;
			pushDetail("Issue", getSymphonySnapshotEntryIssue(entry), "issues");
			pushDetail("Run Attempt", entry.runAttempt, "run-all");
			pushDetail("Live Session", entry.sessionId, "comment-discussion");
			pushDetail("Workspace", entry.workspacePath, "folder");
			pushDetail("Phase", entry.phase, "debug-step-over");
			pushDetail("started_at", entry.startedAt, "clock");
			pushDetail("last_codex_event", entry.lastCodexEvent, "pulse");
			pushDetail("last_codex_event_at", entry.lastCodexEventAt, "calendar");
			pushDetail("last_codex_message", entry.lastCodexMessage, "note");
			pushDetail("turn_count", entry.turnCount, "list-ordered");
			pushDetail("codex_input_tokens", entry.codexInputTokens, "arrow-down");
			pushDetail("codex_output_tokens", entry.codexOutputTokens, "arrow-up");
			pushDetail("codex_total_tokens", entry.codexTotalTokens, "dashboard");
			return details;
		}

		const entry = node.entry as SymphonyRetryEntryView;
		pushDetail("Issue", getSymphonySnapshotEntryIssue(entry), "issues");
		pushDetail("Run Attempt", entry.runAttempt, "run-all");
		pushDetail("attempt", entry.attempt, "debug-restart");
		pushDetail("due_at", entry.dueAt, "clock");
		pushDetail("error", entry.error, "error");
		return details;
	}

	private getSymphonyChildren(node: SymphonyRootNode): AgentNode[] {
		const snapshot = getSymphonyRuntimeSnapshot(node.runs);
		const running = getSymphonyRunningSessionRuns(node.runs);
		const retryQueued = getSymphonyRetryQueuedRuns(node.runs);
		const released = getSymphonyReleasedRuns(node.runs);
		const children: AgentNode[] = [
			{ type: "symphonyDashboard", runs: node.runs, flows: node.flows },
			{ type: "symphonyRunGroup", kind: "running", runs: running, snapshot },
			{
				type: "symphonyRunGroup",
				kind: "retryQueued",
				runs: retryQueued,
				snapshot,
			},
		];
		if (released.length > 0) {
			children.push({
				type: "symphonyRunGroup",
				kind: "released",
				runs: released,
			});
		}
		children.push(
			{ type: "taskflows", flows: node.flows },
			{ type: "codexRuns", runs: node.runs },
		);
		return children;
	}

	/**
	 * Pinned-first warning row shown while the deprecated
	 * `legacyLauncherTasks.enabled` escape hatch is on, so a diagnostics
	 * session ingesting full launcher `tasks.json` files (stale rows included)
	 * is always visibly marked and never mistaken for registry-backed truth.
	 */
	private createLegacyDiagnosticsMarkerNodes(): AgentNode[] {
		if (!this._legacyDiagnosticsEnabled) return [];
		return [
			{
				type: "state",
				label: "Legacy launcher diagnostics (deprecated)",
				description:
					"commandCentral.legacyLauncherTasks.enabled ingests stale launcher rows — diagnostics only",
				icon: "warning",
			},
		];
	}

	/**
	 * Agent Status V2: the former "Symphony Status Surface" row is folded into a
	 * read-only **Sources** provenance feed so it stops competing as a second
	 * top-level status denominator. Symphony contributes its workstreams and run
	 * attempts as provenance, not as a rival lifecycle count. (Per-project Sources
	 * sections + the full Symphony fold are M6; this is the RC-safe reframe.)
	 */
	private formatSourcesProvenanceDescription(
		runs: CodexRunView[],
		flows: TaskFlow[],
	): string {
		const sources = V2_SECTION_HEADERS.sources;
		if (runs.length === 0 && flows.length === 0) return sources;
		const running = getSymphonyRunningSessionRuns(runs).length;
		const retryQueued = getSymphonyRetryQueuedRuns(runs).length;
		const parts = [
			flows.length > 0 ? `workstreams ${flows.length}` : null,
			`run attempts ${runs.length}`,
			running > 0 ? `${running} running` : null,
			retryQueued > 0 ? `${retryQueued} RetryQueued` : null,
		].filter((part): part is string => part !== null);
		return `${sources} · Symphony — ${parts.join(" · ")}`;
	}

	private createSourcesProvenanceSummaryNode(
		node: SymphonyRootNode,
	): SummaryNode {
		return {
			type: "summary",
			kind: "sources",
			label: this.formatSourcesProvenanceDescription(node.runs, node.flows),
			tooltip:
				"Sources — read-only provenance feed. Symphony workstreams and run attempts contribute to Agent Status as a source; they do not compete as a separate status denominator. Open the Symphony view for the read-only Operations Dashboard, Running Sessions, Retry Queue, and Workstreams.",
		};
	}

	private formatCodexRunLegacyOpenClawNote(task: OpenClawTask): string {
		return `Also shown in Symphony / Run Attempts as OpenClaw task ${task.taskId}.`;
	}

	private formatCodexRunLegacyLauncherNote(task: AgentTask): string | null {
		const codexLauncher = detectAgentType(task) === "codex";
		const matchedOwner = this.getAllOpenClawTaskSources().some((owner) =>
			openClawTaskMatchesLauncherTask(owner, task),
		);
		if (!codexLauncher && !matchedOwner) return null;
		if (matchedOwner) {
			return "Also represented in Symphony / Run Attempts through an explicit OpenClaw session join.";
		}
		return "Also shown in Symphony / Run Attempts as a launcher-owned run attempt.";
	}

	/** Kick off async port detection; fires onDidChangeTreeData when done */
	private async _detectPortsAsync(task: AgentTask): Promise<void> {
		try {
			const ports = await detectListeningPortsAsync(task.project_dir);
			// Only update if task is still running (could have finished by now)
			if (this.registry.tasks[task.id]?.status === "running") {
				this._portCache.set(task.id, ports);
				this.scheduleTreeRefresh(this.getTaskRefreshElement(task.id));
			}
		} catch {
			this._portCache.set(task.id, []);
		} finally {
			this._portDetecting.delete(task.id);
		}
	}

	resolveTreeItem(
		item: vscode.TreeItem,
		element: AgentNode,
	): Thenable<vscode.TreeItem> {
		if (element.type === "task" && element.task.status === "running") {
			const start = performance.now();
			return this.getLastOutputLine(element.task).then(
				(line) => {
					defaultTimingRecorder.record(
						"tree.resolveTreeItem.runningTask",
						performance.now() - start,
					);
					if (line) {
						item.description = `${item.description} | ${line}`;
					}
					return item;
				},
				(err) => {
					defaultTimingRecorder.record(
						"tree.resolveTreeItem.runningTask",
						performance.now() - start,
					);
					throw err;
				},
			);
		}
		return Promise.resolve(item);
	}

	getGitInfo(projectDir: string): GitInfo | null {
		try {
			const branch = execFileSync(
				"git",
				["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"],
				{
					encoding: "utf-8",
					timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
				},
			).trim();
			const lastCommit = execFileSync(
				"git",
				["-C", projectDir, "log", "-1", "--format=%h %s (%cr)"],
				{
					encoding: "utf-8",
					timeout: AgentStatusTreeProvider.GIT_DIFF_TIMEOUT_MS,
				},
			).trim();
			return { branch, lastCommit };
		} catch {
			return null;
		}
	}

	/**
	 * CCSYNC-04: build a read-only per-project sync-readiness receipt
	 * (host-labeled branch/upstream/ahead-behind/HEAD/tree/dirty-count + a
	 * prioritized blocker list). Hub-side only: a project whose known tasks ran
	 * on a remote node we cannot reach from here yields an explicit
	 * not-yet-queried card with NO fabricated git facts (cross-machine repo
	 * parity needs live node access this provider does not have).
	 *
	 * Pure git QUERY commands only — never mutates the repo.
	 */
	getSyncReadiness(projectDir: string): SyncReadinessReceipt {
		const tasks = this.getTasks().filter((t) => t.project_dir === projectDir);
		const project =
			tasks
				.map((t) => getTaskDisplayProjectName(t))
				.find((name) => name.length > 0) ?? path.basename(projectDir);

		const remoteTask = tasks.find((t) => isRemoteNodeTaskForCurrentHost(t));
		if (remoteTask) {
			return buildUnreachableNodeCard({
				project,
				projectDir,
				host: getTaskExecutionHostLabel(remoteTask) ?? "node",
				reachability: "not-yet-queried",
			});
		}

		const pendingReviewCount = tasks.filter((t) =>
			this.isReviewQueueReceiptMissing(t),
		).length;

		return collectHubSyncReadiness(projectDir, {
			project,
			pendingReviewCount,
		});
	}

	private getPromptSummaryFromPreferredSection(lines: string[]): string | null {
		const preferredSectionPatterns = [
			// rc.37: launcher (write-prompt.sh) emits `## User Prompt`
			// immediately before the user's content. Highest priority so the
			// summary always reflects user intent rather than wrapper boilerplate.
			/^#{1,6}\s+User Prompt\b/i,
			/^#{1,6}\s+Task\b/i,
			/^#{1,6}\s+Goal\b/i,
			/^#{1,6}\s+Objective\b/i,
		];

		for (const headingPattern of preferredSectionPatterns) {
			let inSection = false;
			for (const line of lines) {
				const trimmed = line.trim();
				if (headingPattern.test(trimmed)) {
					inSection = true;
					continue;
				}
				if (!inSection) continue;
				if (/^#{1,6}\s+/.test(trimmed)) break;

				const candidate = normalizePromptSummaryLine(line);
				if (!candidate || isPromptBoilerplateLine(candidate)) continue;
				return truncatePromptSummary(candidate);
			}
		}

		return null;
	}

	/** Read the first meaningful line from a prompt file as a summary */
	readPromptSummary(promptFile: string): string {
		const cached = this._promptCache.get(promptFile);
		if (cached !== undefined) return cached;

		try {
			const content = fs.readFileSync(promptFile, "utf-8");
			const lines = content.split("\n");

			const preferredSectionSummary =
				this.getPromptSummaryFromPreferredSection(lines);
			if (preferredSectionSummary) {
				this._promptCache.set(promptFile, preferredSectionSummary);
				return preferredSectionSummary;
			}

			// Look for ## Goal section first
			let inGoalSection = false;
			for (const line of lines) {
				if (/^##\s+Goal/i.test(line)) {
					inGoalSection = true;
					continue;
				}
				if (inGoalSection) {
					const trimmed = line.trim();
					if (trimmed.length === 0) continue;
					if (trimmed.startsWith("#")) break; // next section
					const result = truncatePromptSummary(trimmed);
					this._promptCache.set(promptFile, result);
					return result;
				}
			}

			// Fallback: first non-empty, non-heading, non-frontmatter line
			let inFrontmatter = false;
			let inCodeFence = false;
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed === "---") {
					inFrontmatter = !inFrontmatter;
					continue;
				}
				if (trimmed.startsWith("```")) {
					inCodeFence = !inCodeFence;
					continue;
				}
				if (inFrontmatter || inCodeFence) continue;
				if (trimmed.length === 0) continue;
				if (trimmed.startsWith("#")) continue;

				const candidate = normalizePromptSummaryLine(line);
				if (!candidate || isPromptBoilerplateLine(candidate)) continue;
				const result = truncatePromptSummary(candidate);
				this._promptCache.set(promptFile, result);
				return result;
			}

			// No meaningful content found, use basename
			const fallback = path.basename(promptFile);
			this._promptCache.set(promptFile, fallback);
			return fallback;
		} catch {
			const fallback = path.basename(promptFile);
			this._promptCache.set(promptFile, fallback);
			return fallback;
		}
	}

	/** Read a prompt summary for a discovered agent (no prompt_file available) */
	readDiscoveredPrompt(agent: DiscoveredAgent): string | null {
		const cacheKey = agent.sessionId ?? `pid:${agent.pid}`;
		const cached = this._discoveredPromptCache.get(cacheKey);
		if (cached !== undefined) return cached || null;

		// Try reading prompt.md from session directory
		if (agent.sessionId) {
			try {
				const homeDir = process.env["HOME"] ?? "";
				const claudeProjectsDir = path.join(homeDir, ".claude", "projects");
				if (fs.existsSync(claudeProjectsDir)) {
					for (const projectEntry of fs.readdirSync(claudeProjectsDir)) {
						const sessionDir = path.join(
							claudeProjectsDir,
							projectEntry,
							"sessions",
							agent.sessionId,
						);
						const promptFile = path.join(sessionDir, "prompt.md");
						if (fs.existsSync(promptFile)) {
							const content = fs.readFileSync(promptFile, "utf-8").trim();
							if (content) {
								const firstLine = content.split("\n").find((l) => l.trim());
								const trimmed = firstLine?.trim() ?? "";
								const result =
									trimmed.length > 60
										? `${trimmed.substring(0, 60)}…`
										: trimmed;
								this._discoveredPromptCache.set(cacheKey, result);
								return result;
							}
						}
						// Fall back to parsing JSONL for initial user message
						const jsonlDir = path.join(claudeProjectsDir, projectEntry);
						if (fs.existsSync(jsonlDir)) {
							const jsonlFiles = fs
								.readdirSync(jsonlDir)
								.filter((f) => f.endsWith(".jsonl"));
							for (const jsonlFile of jsonlFiles) {
								try {
									const lines = fs
										.readFileSync(path.join(jsonlDir, jsonlFile), "utf-8")
										.split("\n")
										.filter(Boolean);
									for (const line of lines) {
										const entry = JSON.parse(line) as Record<string, unknown>;
										if (
											entry["sessionId"] === agent.sessionId &&
											entry["type"] === "user"
										) {
											const msg = entry["message"] as
												| Record<string, unknown>
												| undefined;
											const contentArr = msg?.["content"] as
												| Array<Record<string, unknown>>
												| string
												| undefined;
											let text = "";
											if (typeof contentArr === "string") {
												text = contentArr;
											} else if (Array.isArray(contentArr)) {
												const textBlock = contentArr.find(
													(c) => c["type"] === "text",
												);
												text =
													(textBlock?.["text"] as string | undefined) ?? "";
											}
											if (text) {
												const trimmed = text.trim();
												const result =
													trimmed.length > 60
														? `${trimmed.substring(0, 60)}…`
														: trimmed;
												this._discoveredPromptCache.set(cacheKey, result);
												return result;
											}
										}
									}
								} catch {
									// skip malformed JSONL
								}
							}
						}
					}
				}
			} catch {
				// fall through
			}
		}

		this._discoveredPromptCache.set(cacheKey, "");
		return null;
	}

	/** Get a formatted diff summary for an agent's working directory */
	getDiffSummary(projectDir: string, task: AgentTask): string | null {
		return formatPerFileDiffSummary(
			getPerFileNumstatDiffs(
				projectDir,
				getTaskDiffStartCommit(task),
				getTaskDiffEndCommit(task),
			),
		);
	}

	/**
	 * Get per-file diff stats via `git diff --numstat`.
	 *
	 * - Running agents: compare working tree vs HEAD (`startCommit` and `endCommit` both undefined)
	 * - Completed/stopped/failed with commits: compare `startCommit..endCommit`
	 * - Terminal tasks without valid end boundary: `startCommit` set but `endCommit` undefined → empty
	 */
	getPerFileDiffs(
		projectDir: string,
		startCommit?: string,
		endCommit?: string,
	): PerFileDiff[] {
		const diffs = getPerFileNumstatDiffs(projectDir, startCommit, endCommit);
		if (diffs.length === 0) return [];

		const statuses = parsePerFileStatusesFromNameStatus(
			runGitDiffOutput(projectDir, "--name-status", startCommit, endCommit),
		);

		return diffs.map((diff) => ({
			...diff,
			status:
				statuses.get(diff.filePath) ?? deriveFallbackFileChangeStatus(diff),
		}));
	}

	private async getLastOutputLine(
		task: AgentTask,
	): Promise<string | undefined> {
		if (task.status !== "running") return undefined;
		if (isRemoteNodeTaskForCurrentHost(task)) return undefined;
		if (!task.session_id || !isValidSessionId(task.session_id))
			return undefined;
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			const { stdout: output } = await execFileAsync(
				"tmux",
				["capture-pane", "-t", task.session_id, "-p"],
				{
					encoding: "utf-8",
					timeout: 2000,
				},
			);
			const lines = output
				.trim()
				.split("\n")
				.filter((l) => l.trim());
			return lines[lines.length - 1]?.substring(0, 80);
		} catch {
			return undefined;
		}
	}

	getParent(element: AgentNode): AgentNode | undefined {
		const toSortableNode = (
			node: TaskNode | DiscoveredNode | OpenClawTaskNode,
		): SortableAgentNode => {
			if (node.type === "task") {
				return { type: "task", task: node.task };
			}
			if (node.type === "discovered") {
				return { type: "discovered", agent: node.agent };
			}
			return { type: "openclawTask", task: node.task };
		};

		if (
			element.type === "symphonyDashboard" ||
			element.type === "symphonyRunGroup" ||
			element.type === "taskflows" ||
			element.type === "codexRuns"
		) {
			return undefined;
		}
		if (element.type === "symphonySnapshotEntry") {
			const runs = this.getVisibleCodexRuns();
			const snapshot = getSymphonyRuntimeSnapshot(runs);
			return {
				type: "symphonyRunGroup",
				kind: element.kind,
				runs:
					element.kind === "running"
						? getSymphonyRunningSessionRuns(runs)
						: getSymphonyRetryQueuedRuns(runs),
				...(snapshot ? { snapshot } : {}),
			};
		}
		if (element.type === "taskFlowGroup" || element.type === "taskflow") {
			return { type: "taskflows", flows: this.getVisibleTaskFlows() };
		}
		if (element.type === "taskFlowChild") {
			const flow = this.getVisibleTaskFlows().find(
				(candidate) => candidate.flowId === element.flowId,
			);
			if (flow) return { type: "taskFlowGroup", flow };
		}
		if (element.type === "codexRun") {
			const container = element.container ?? "runs";
			const runs = this.getVisibleCodexRuns();
			if (container === "runs") {
				return { type: "codexRuns", runs };
			}
			return this.getSymphonyChildren({
				type: "symphony",
				runs,
				flows: this.getVisibleTaskFlows(),
			}).find(
				(child): child is SymphonyRunGroupNode =>
					child.type === "symphonyRunGroup" && child.kind === container,
			);
		}

		if (this.isProjectGroupingEnabled()) {
			const openclawTasks = this.getVisibleOpenClawTasks();
			const groupedRoots = this.buildGroupedRootNodes(
				this.getScopedLauncherTasks(),
				this.getScopedDiscoveredAgents(),
			);
			const projects = groupedRoots.flatMap((root) =>
				root.type === "projectGroup" ? [root] : root.projects,
			);

			const findProjectParent = (
				matcher: (project: ProjectGroupNode) => boolean,
			): ProjectGroupNode | undefined => projects.find(matcher);

			if (element.type === "openclawTask") {
				if (openclawTasks.some((task) => task.taskId === element.task.taskId)) {
					return { type: "backgroundTasks", tasks: openclawTasks };
				}
			}

			if (element.type === "projectGroup") {
				const knownParentKey = element.parentGroupKey;
				if (knownParentKey) {
					return groupedRoots.find(
						(root) =>
							root.type === "folderGroup" && root.groupKey === knownParentKey,
					);
				}

				for (const root of groupedRoots) {
					if (root.type !== "folderGroup") continue;
					const match = root.projects.some((project) => {
						const sameDir =
							(project.projectDir ?? "") === (element.projectDir ?? "");
						if (sameDir && element.projectDir) return true;
						return project.projectName === element.projectName;
					});
					if (match) return root;
				}
			}

			if (element.type === "statusGroup") {
				const targetId = this.getStableTreeItemId(element);
				return findProjectParent((project) =>
					this.getProjectGroupChildren(project).some(
						(node) =>
							node.type === "statusGroup" &&
							this.getStableTreeItemId(node) === targetId,
					),
				);
			}

			for (const project of projects) {
				const projectChildren = this.getProjectGroupChildren(project);
				const statusGroups = projectChildren.filter(
					(node): node is StatusGroupNode => node.type === "statusGroup",
				);

				for (const statusGroup of statusGroups) {
					const statusChildren = this.getStatusGroupChildren(statusGroup);

					if (element.type === "statusTimeGroup") {
						const targetId = this.getStableTreeItemId(element);
						if (
							statusChildren.some(
								(node) =>
									node.type === "statusTimeGroup" &&
									this.getStableTreeItemId(node) === targetId,
							)
						) {
							return statusGroup;
						}
					}

					if (
						element.type === "olderRuns" &&
						statusChildren.some(
							(node) =>
								node.type === "olderRuns" &&
								// Match on the one canonical identity, not the volatile
								// "Show N older completed..." label: the label re-counts on
								// every refresh, and only the stable id distinguishes sibling
								// buckets under the same project (e.g. done vs limbo).
								this.getStableTreeItemId(node) ===
									this.getStableTreeItemId(element),
						)
					) {
						return statusGroup;
					}

					if (element.type === "task" || element.type === "discovered") {
						const targetNode = toSortableNode(element);
						const olderRuns = statusChildren.find(
							(node): node is OlderRunsNode =>
								node.type === "olderRuns" &&
								this.olderRunsContainsNode(node, targetNode),
						);
						if (olderRuns) {
							return olderRuns;
						}

						const timeGroup = statusChildren.find(
							(node): node is StatusTimeGroupNode =>
								node.type === "statusTimeGroup" &&
								node.nodes.some((child) =>
									this.matchesSortableNode(child, targetNode),
								),
						);
						if (timeGroup) {
							return timeGroup;
						}

						if (
							statusChildren.some(
								(node) =>
									(node.type === "task" &&
										targetNode.type === "task" &&
										node.task.id === targetNode.task.id) ||
									(node.type === "discovered" &&
										targetNode.type === "discovered" &&
										node.agent.pid === targetNode.agent.pid),
							)
						) {
							return statusGroup;
						}
					}
				}
			}
		} else {
			const openclawTasks = this.getVisibleOpenClawTasks();
			const showOpenClawInline = true;
			const sortableNodes = this.sortAgentNodes([
				...this.getScopedLauncherTasks().map(
					(task) =>
						({ type: "task" as const, task }) satisfies SortableAgentNode,
				),
				...this.getScopedDiscoveredAgents().map(
					(agent) =>
						({
							type: "discovered" as const,
							agent,
						}) satisfies SortableAgentNode,
				),
				...(showOpenClawInline
					? openclawTasks.map(
							(task) =>
								({
									type: "openclawTask" as const,
									task,
								}) satisfies SortableAgentNode,
						)
					: []),
			]);
			const flatRootNodes = this.applyAgentVisibilityCap(sortableNodes);
			const olderRuns = flatRootNodes.find(
				(node): node is OlderRunsNode => node.type === "olderRuns",
			);
			if (
				olderRuns &&
				(element.type === "task" ||
					element.type === "discovered" ||
					element.type === "openclawTask")
			) {
				const sortableNode = toSortableNode(element);
				if (this.olderRunsContainsNode(olderRuns, sortableNode)) {
					return olderRuns;
				}
			}
		}
		if (element.type === "backgroundTasks") {
			return undefined;
		}
		if (element.type === "detail") {
			// Check if it belongs to a discovered agent
			if (element.taskId.startsWith("discovered-")) {
				const pid = Number.parseInt(
					element.taskId.replace("discovered-", ""),
					10,
				);
				const agent = this._discoveredAgents.find((a) => a.pid === pid);
				if (agent) return { type: "discovered", agent };
			}
			if (element.taskId.startsWith("openclaw-")) {
				const openclawTaskId = element.taskId.replace("openclaw-", "");
				const task = this.getVisibleOpenClawTasks().find(
					(entry) => entry.taskId === openclawTaskId,
				);
				if (task) return { type: "openclawTask", task };
			}
			const task = this.getDisplayTaskById(element.taskId);
			if (task) return { type: "task", task };
		}
		if (element.type === "fileChange") {
			const task = this.getDisplayTaskById(element.taskId);
			if (task) return { type: "task", task };
		}
		// summary and root-level nodes have no parent
		return undefined;
	}

	/** Get the full task registry */
	getRegistry(): TaskRegistry {
		return this.registry;
	}

	/** Get launcher tasks with effective runtime status applied for UI display. */
	getDisplayRegistryTasks(): Record<string, AgentTask> {
		const displayTasks: Record<string, AgentTask> = {};
		for (const task of this.getDisplayLauncherTasks()) {
			displayTasks[task.id] = task;
		}
		return displayTasks;
	}

	/** Get launcher-managed tasks only (excludes discovered agents) */
	getLauncherTasks(): AgentTask[] {
		return Object.values(this.registry.tasks);
	}

	/**
	 * Get all tasks including synthetic entries for discovered agents.
	 *
	 * Discovered agents (found via process scanning) are always running.
	 * Including them here ensures the status bar and sidebar always agree
	 * on the running count, since both sources are counted in the sidebar
	 * summary node (getChildren) but the status bar previously only received
	 * launcher tasks.
	 */
	getTasks(): AgentTask[] {
		const launcherTasks = this.getDisplayLauncherTasks().filter(
			(t) => !isAutoReviewLane(t),
		);
		const syntheticDiscovered: AgentTask[] = this._discoveredAgents.map(
			(agent) => ({
				id: `discovered-${agent.pid}`,
				status: "running" as const,
				project_dir: this.getDiscoveredProjectDir(agent),
				project_name: this.getDiscoveredProjectName(agent),
				session_id: agent.sessionId ?? `pid-${agent.pid}`,
				bundle_path: "",
				prompt_file: "",
				started_at: agent.startTime.toISOString(),
				attempts: 0,
				max_attempts: 0,
			}),
		);
		const syntheticOpenClaw = this.getVisibleOpenClawTasks().map((task) =>
			toSyntheticOpenClawTask(task),
		);
		return [...launcherTasks, ...syntheticDiscovered, ...syntheticOpenClaw];
	}

	getDiscoveryDiagnosticsReport(): string {
		const lines = ["Agent Status Discovery Diagnostics", ""];
		const displayTasks = this.getDisplayLauncherTasks();
		const runningTasks = displayTasks.filter(
			(task) => task.status === "running",
		);
		const backgroundTasks = this.getVisibleOpenClawTasks();
		const backgroundRunningCount = backgroundTasks.filter((task) =>
			isOpenClawTaskActive(task),
		).length;
		const backgroundSucceededCount = backgroundTasks.filter(
			(task) => task.status === "succeeded",
		).length;
		const backgroundOtherCount =
			backgroundTasks.length -
			backgroundRunningCount -
			backgroundSucceededCount;
		const discoveredAgents =
			this._allDiscoveredAgents.length > 0
				? this._allDiscoveredAgents
				: this._discoveredAgents;
		const runningAgentSubjects =
			discoveredAgents.length > 0 ? discoveredAgents : runningTasks;
		const now = new Date();
		const olderRegistryCount = displayTasks.filter((task) => {
			const activityMs = this.getTaskActivityTimeMs(task);
			return activityMs <= 0 || now.getTime() - activityMs > 24 * 60 * 60_000;
		}).length;
		const stuckCount = runningTasks.filter((task) =>
			this.isAgentStuck(task),
		).length;
		const healthStatus = !this._agentRegistry
			? "⚪ Discovery Disabled"
			: stuckCount > 0
				? "⚠️ Needs Attention"
				: "✅ Healthy";

		lines.push(`Agent Discovery Health: ${healthStatus}`);
		lines.push(
			`  Running agents: ${runningAgentSubjects.length} (${formatAgentTypeSummary(runningAgentSubjects)})`,
		);
		lines.push(
			`  Background tasks: ${backgroundTasks.length} (${this.formatBackgroundTaskSummary(backgroundRunningCount, backgroundSucceededCount, backgroundOtherCount)})`,
		);
		lines.push(
			`  Registry: ${displayTasks.length} tasks (${runningTasks.length} running, ${displayTasks.length - runningTasks.length} completed/archived)`,
		);

		if (!this._agentRegistry) {
			lines.push("");
			lines.push("Discovery: disabled");
			lines.push("");
			lines.push("Registry age:");
			for (const line of this.getRegistryAgeSummaryLines(displayTasks, now)) {
				lines.push(line);
			}
			lines.push("");
			lines.push("Recommendations:");
			lines.push("  ⚠️ Discovery is disabled in settings.");
			if (olderRegistryCount > 50 || displayTasks.length > 100) {
				lines.push(
					`  ⚠️ ${displayTasks.length} tasks in registry — consider: commandCentral.clearCompletedAgents`,
				);
			}
			lines.push("");
			for (const line of this.getOpenClawTaskLedgerLines()) {
				lines.push(line);
			}
			const timingLinesDisabled = defaultTimingRecorder.formatReportLines();
			if (timingLinesDisabled.length > 0) {
				lines.push("");
				for (const line of timingLinesDisabled) {
					lines.push(line);
				}
			}
			return lines.join("\n");
		}

		const diagnostics = this._agentRegistry.getDiagnostics();
		const processDiagnostics = diagnostics.processScanner;
		const processAgentCount = discoveredAgents.filter(
			(agent) => agent.source === "process",
		).length;
		const sessionFileAgentCount = discoveredAgents.filter(
			(agent) => agent.source === "session-file",
		).length;
		const filteredGroups = summarizeFilteredDiscoveryMatches(
			processDiagnostics.filtered,
		);

		lines.push(
			`  Discovery: ${processAgentCount} agents found via process scanner, ${sessionFileAgentCount} via session files`,
		);
		lines.push("");
		lines.push("Registry age:");
		for (const line of this.getRegistryAgeSummaryLines(displayTasks, now)) {
			lines.push(line);
		}

		if (filteredGroups.length > 0) {
			lines.push("");
			lines.push(`Filtered (${processDiagnostics.filtered.length} matches):`);
			for (const group of filteredGroups) {
				const detail = group.note
					? `${group.names} — ${group.note}`
					: group.names;
				lines.push(`  ${group.label}: ${group.count} (${detail})`);
			}
		}

		if (processDiagnostics.retained.length > 0) {
			lines.push("");
			lines.push(`Active agents (${processDiagnostics.retained.length}):`);
			for (const entry of processDiagnostics.retained) {
				lines.push(`  ${formatRetainedDiscoveryEntry(entry, now)}`);
			}
		}

		lines.push("");
		lines.push("Recommendations:");
		for (const line of this.getDiscoveryRecommendationLines({
			displayTasks,
			runningTasks,
			stuckCount,
			olderRegistryCount,
			filtered: processDiagnostics.filtered,
		})) {
			lines.push(line);
		}

		lines.push("");
		for (const line of this.getOpenClawTaskLedgerLines()) {
			lines.push(line);
		}

		const timingLines = defaultTimingRecorder.formatReportLines();
		if (timingLines.length > 0) {
			lines.push("");
			for (const line of timingLines) {
				lines.push(line);
			}
		}

		return lines.join("\n");
	}

	private getOpenClawTaskLedgerLines(): string[] {
		const taskService = this._openclawTaskService;
		if (!taskService || taskService.isInstalled === false) {
			return ["OpenClaw: not detected (task audit skipped)"];
		}

		const tasks = taskService.getTasks();
		const runningCount = tasks.filter(
			(task) => task.status === "queued" || task.status === "running",
		).length;
		const succeededCount = tasks.filter(
			(task) => task.status === "succeeded",
		).length;
		const failedCount = tasks.length - runningCount - succeededCount;
		const audit = this.getOpenClawTaskAuditData();
		const staleRunningCount = audit.summary.byCode["stale_running"] ?? 0;

		const lines = [
			"OpenClaw Task Ledger:",
			` Total: ${tasks.length} tasks (7-day window)`,
			` Running: ${runningCount}${staleRunningCount > 0 ? ` (${formatOpenClawAuditStatusLabel("stale_running", staleRunningCount)})` : ""}`,
			` Succeeded: ${succeededCount}`,
			` Failed: ${failedCount}`,
			"",
			"Audit findings:",
		];

		if (audit.error) {
			lines.push(` ⚠️ Task audit failed: ${audit.error}`);
			return lines;
		}

		const staleLabel =
			staleRunningCount === 1 ? "stale running task" : "stale running tasks";
		if (staleRunningCount > 0) {
			lines.push(
				` ⚠️ ${staleRunningCount} ${staleLabel} — may need manual cleanup`,
			);
		}

		const inconsistentTimestamps =
			audit.summary.byCode["inconsistent_timestamps"] ?? 0;
		if (inconsistentTimestamps > 0) {
			const label =
				inconsistentTimestamps === 1
					? "inconsistent timestamp"
					: "inconsistent timestamps";
			lines.push(
				` ℹ️ ${inconsistentTimestamps} ${label} (OpenClaw-side, cosmetic)`,
			);
		}

		const remainingErrors = Math.max(
			0,
			audit.summary.errors - staleRunningCount,
		);
		const remainingWarnings = Math.max(
			0,
			audit.summary.warnings - inconsistentTimestamps,
		);
		if (remainingErrors > 0) {
			lines.push(
				` ⚠️ ${remainingErrors} additional audit error${remainingErrors === 1 ? "" : "s"}`,
			);
		}
		if (remainingWarnings > 0) {
			lines.push(
				` ℹ️ ${remainingWarnings} additional audit warning${remainingWarnings === 1 ? "" : "s"}`,
			);
		}
		if (audit.summary.total === 0) {
			lines.push(" ✅ No audit findings");
		}

		return lines;
	}

	private getOpenClawTaskAuditData(): {
		summary: {
			total: number;
			warnings: number;
			errors: number;
			byCode: Record<string, number>;
		};
		error?: string;
	} {
		const emptySummary = {
			total: 0,
			warnings: 0,
			errors: 0,
			byCode: {
				stale_queued: 0,
				stale_running: 0,
				lost: 0,
				delivery_failed: 0,
				missing_cleanup: 0,
				inconsistent_timestamps: 0,
			} satisfies Record<string, number>,
		};

		try {
			const stdout = execFileSync("openclaw", ["tasks", "audit", "--json"], {
				encoding: "utf-8",
				timeout: AgentStatusTreeProvider.OPENCLAW_AUDIT_TIMEOUT_MS,
			});
			const parsed = JSON.parse(stdout) as {
				summary?: {
					total?: number;
					warnings?: number;
					errors?: number;
					byCode?: Record<string, number>;
				};
			};
			return {
				summary: {
					total: Number(parsed.summary?.total ?? 0),
					warnings: Number(parsed.summary?.warnings ?? 0),
					errors: Number(parsed.summary?.errors ?? 0),
					byCode: {
						...emptySummary.byCode,
						...(parsed.summary?.byCode ?? {}),
					},
				},
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException & {
				stdout?: string | Buffer;
				stderr?: string | Buffer;
			};
			if (err.code === "ENOENT") {
				return { summary: emptySummary, error: "OpenClaw is not installed" };
			}

			const detail =
				typeof err.stderr === "string" && err.stderr.trim().length > 0
					? err.stderr.trim()
					: err.message;
			return { summary: emptySummary, error: detail };
		}
	}

	private formatBackgroundTaskSummary(
		runningCount: number,
		succeededCount: number,
		otherCount: number,
	): string {
		const parts = [
			runningCount > 0 ? `${runningCount} running` : null,
			succeededCount > 0 ? `${succeededCount} succeeded` : null,
			otherCount > 0 ? `${otherCount} other` : null,
		];
		return (
			parts.filter((part): part is string => part !== null).join(", ") || "none"
		);
	}

	private getRegistryAgeSummaryLines(
		tasks: AgentTask[],
		now = new Date(),
	): string[] {
		const bucket1h = tasks.filter((task) => {
			const activityMs = this.getTaskActivityTimeMs(task);
			return activityMs > 0 && now.getTime() - activityMs <= 60 * 60_000;
		});
		const bucket24h = tasks.filter((task) => {
			const activityMs = this.getTaskActivityTimeMs(task);
			return (
				activityMs > 0 &&
				now.getTime() - activityMs > 60 * 60_000 &&
				now.getTime() - activityMs <= 24 * 60 * 60_000
			);
		});
		const older = tasks.length - bucket1h.length - bucket24h.length;

		return [
			`  Last 1h: ${bucket1h.length} tasks (${this.formatRegistryBucketStatusSummary(bucket1h)})`,
			`  Last 24h: ${bucket24h.length} tasks`,
			`  Older: ${older} tasks${older > 0 ? " (archive candidates)" : ""}`,
		];
	}

	private formatRegistryBucketStatusSummary(tasks: AgentTask[]): string {
		if (tasks.length === 0) return "0 running, 0 completed";
		const runningCount = tasks.filter(
			(task) => task.status === "running",
		).length;
		const archivedCount = tasks.length - runningCount;
		return `${runningCount} running, ${archivedCount} completed`;
	}

	private getDiscoveryRecommendationLines(args: {
		displayTasks: AgentTask[];
		runningTasks: AgentTask[];
		stuckCount: number;
		olderRegistryCount: number;
		filtered: ProcessScanDiagnosticEntry[];
	}): string[] {
		const lines: string[] = [];
		const terminalNotifierCount = args.filtered.filter(
			(entry) => entry.binaryName?.toLowerCase() === "terminal-notifier",
		).length;

		if (terminalNotifierCount > 0) {
			lines.push(
				`  ⚠️ ${terminalNotifierCount} stale terminal-notifier processes — run: pkill -f "terminal-notifier.*oste"`,
			);
		}

		if (args.olderRegistryCount > 50 || args.displayTasks.length > 100) {
			lines.push(
				`  ⚠️ ${args.displayTasks.length} tasks in registry — consider: commandCentral.clearCompletedAgents`,
			);
		}

		if (args.stuckCount > 0) {
			lines.push(
				`  ⚠️ ${args.stuckCount} running ${args.stuckCount === 1 ? "agent looks" : "agents look"} stuck — inspect the session before reusing it`,
			);
		} else {
			lines.push("  ✅ No stuck agents detected");
		}

		if (
			args.runningTasks.length > 0 &&
			args.runningTasks.every(
				(task) =>
					task.terminal_backend === "tmux" &&
					Boolean(task.session_id) &&
					!this.isAgentStuck(task),
			)
		) {
			lines.push("  ✅ All running agents have healthy tmux sessions");
		}

		if (lines.length === 0) {
			lines.push("  ✅ No action needed");
		}

		return lines;
	}

	private getDiscoveredProjectDir(agent: DiscoveredAgent): string {
		if (agent.worktree?.isLinkedWorktree) {
			return agent.worktree.mainRepoDir;
		}
		return agent.projectDir;
	}

	private getDiscoveredProjectName(agent: DiscoveredAgent): string {
		const projectDir = this.getDiscoveredProjectDir(agent);
		return path.basename(projectDir) || projectDir;
	}

	private readProjectSettingFromFile(
		projectDir: string,
		settingKey: string,
	): string | null {
		if (!projectDir) return null;
		if (!path.isAbsolute(projectDir)) return null;
		const settingsPath = path.join(projectDir, ".vscode", "settings.json");
		if (!fs.existsSync(settingsPath)) return null;
		try {
			const raw = fs.readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const value = parsed[settingKey];
			return typeof value === "string" && value.trim().length > 0
				? value.trim()
				: null;
		} catch {
			return null;
		}
	}

	private getLegacyProjectEmoji(projectDir: string): string | null {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const projects = config.get<Array<{ name: string; emoji: string }>>(
			"projects",
			[],
		);
		const dirName = path.basename(projectDir);
		const match = projects.find((p) => p.name === dirName);
		return match?.emoji ?? null;
	}

	private getProjectIcon(
		projectDir: string,
		options?: { launcherIcon?: string | null },
	): string {
		const launcherIcon = options?.launcherIcon?.trim();
		if (launcherIcon) return launcherIcon;
		if (!projectDir || !path.isAbsolute(projectDir)) {
			return this.getLegacyProjectEmoji(projectDir) ?? "📁";
		}
		const configuredIcon = this.readProjectSettingFromFile(
			projectDir,
			"commandCentral.project.icon",
		);
		if (configuredIcon) return configuredIcon;
		const legacyIcon = this.getLegacyProjectEmoji(projectDir);
		if (legacyIcon) return legacyIcon;
		return this.projectIconManager.getIconForProject(projectDir);
	}

	private createSummaryItem(node: SummaryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.iconPath = this.getSummaryIcon();
		item.contextValue = "agentSummary";
		if (node.tooltip) item.tooltip = node.tooltip;
		return item;
	}

	private createSymphonyItem(node: SymphonyRootNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			"Symphony",
			vscode.TreeItemCollapsibleState.Expanded,
		);
		item.description = formatSymphonyRootDescription(node.runs, node.flows);
		item.contextValue = "symphony";
		item.iconPath = new vscode.ThemeIcon("server-process");
		item.tooltip = new vscode.MarkdownString(
			[
				"**Symphony**",
				"Read-only Status Surface for source-owned Workstreams and Run Attempts.",
				"Command Central does not orchestrate, schedule, retry, cancel, poll Linear, or write tracker state.",
			].join("\n\n"),
		);
		return item;
	}

	private createSymphonyDashboardItem(
		node: SymphonyDashboardNode,
	): vscode.TreeItem {
		const item = new vscode.TreeItem(
			"Operations Dashboard",
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = formatSymphonyDashboardDescription(node.runs);
		item.contextValue = "symphonyDashboard";
		item.iconPath = new vscode.ThemeIcon("dashboard");
		item.tooltip = new vscode.MarkdownString(
			[
				"**Operations Dashboard**",
				"Aggregates projected source-owned state for operator visibility.",
				"All lifecycle, retry, and tracker authority stays with the source owner.",
			].join("\n\n"),
		);
		return item;
	}

	private createSymphonyRunGroupItem(
		node: SymphonyRunGroupNode,
	): vscode.TreeItem {
		const label = getSymphonyRunGroupLabel(node.kind);
		const count = getSymphonyRunGroupCount(node);
		const item = new vscode.TreeItem(
			`${label} · ${count}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = getSymphonyRunGroupSpecStatus(node.kind);
		item.contextValue = `symphonyRunGroup.${node.kind}`;
		item.iconPath = getSymphonyRunGroupIcon(node.kind);
		item.tooltip = new vscode.MarkdownString(
			[
				`**${label}**`,
				`Spec state: \`${getSymphonyRunGroupSpecStatus(node.kind)}\``,
				`${count} read-only projected ${
					count === 1 ? "Run Attempt" : "Run Attempts"
				}`,
			].join("\n\n"),
		);
		return item;
	}

	private createSymphonySnapshotEntryItem(
		node: SymphonySnapshotEntryNode,
	): vscode.TreeItem {
		const running = node.kind === "running";
		const issue = getSymphonySnapshotEntryIssue(node.entry);
		const session = running
			? (node.entry as SymphonyRunningEntryView).sessionId
			: undefined;
		const labelPrefix = running ? "Live Session" : "Retry Entry";
		const item = new vscode.TreeItem(
			`${labelPrefix}: ${session ?? issue ?? `#${node.index + 1}`}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = issue;
		item.contextValue = `symphonySnapshotEntry.${node.kind}`;
		item.iconPath = running
			? new vscode.ThemeIcon("pulse", new vscode.ThemeColor("charts.blue"))
			: new vscode.ThemeIcon("history", new vscode.ThemeColor("charts.yellow"));
		item.tooltip = new vscode.MarkdownString(
			[
				`**${labelPrefix}**`,
				"Read-only row from a source-owned Symphony runtime snapshot.",
				`Snapshot status: \`${formatSymphonyRuntimeSnapshotStatus(
					node.snapshot,
				)}\``,
			].join("\n\n"),
		);
		return item;
	}

	private createBackgroundTasksItem(
		node: BackgroundTasksNode,
	): vscode.TreeItem {
		const count = node.tasks.length;
		const item = new vscode.TreeItem(
			count === 1 ? "Background Tasks · 1" : `Background Tasks · ${count}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = count === 1 ? "1 task" : `${count} tasks`;
		item.contextValue = "backgroundTasks";
		item.iconPath = new vscode.ThemeIcon("pulse");
		return item;
	}

	private createTaskFlowsItem(node: TaskFlowsContainerNode): vscode.TreeItem {
		const count = node.flows.length;
		const activeCount = node.flows.filter(
			(f) =>
				f.status === "queued" ||
				f.status === "running" ||
				f.status === "waiting",
		).length;
		const item = new vscode.TreeItem(
			count === 1 ? "Workstreams · 1" : `Workstreams · ${count}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description =
			activeCount > 0
				? `${activeCount} active`
				: count === 1
					? "1 workstream"
					: `${count} workstreams`;
		item.contextValue = "taskflows";
		item.iconPath = new vscode.ThemeIcon("layers");
		return item;
	}

	private createCodexRunsItem(node: CodexRunsContainerNode): vscode.TreeItem {
		const count = node.runs.length;
		const item = new vscode.TreeItem(
			count === 1 ? "Run Attempts · 1" : `Run Attempts · ${count}`,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = formatCodexRunsDescription(node.runs);
		item.tooltip = createCodexRunsTooltip(node.runs);
		item.id = "symphony:codex-runs";
		item.contextValue = "codexRuns";
		item.iconPath = new vscode.ThemeIcon("run-all");
		return item;
	}

	private createCodexRunItem(node: CodexRunNode): vscode.TreeItem {
		const { run } = node;
		const container = node.container ?? "runs";
		const activity = getCodexRunActivityTimeMs(run);
		const descriptionParts = [
			formatCodexRunStatus(run.status),
			formatCodexRunOwnership(run),
			run.orchestrationMode,
			run.role,
			run.runtime,
			activity ? relativeTime(activity) : undefined,
			run.model ? getModelAlias(run.model) : undefined,
		].filter((part): part is string => Boolean(part));
		const item = new vscode.TreeItem(
			run.title,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = descriptionParts.join(" · ");
		item.id = `symphony:codex-run:${container}:${symphonyRunIdentity(run)}`;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${run.title}**`,
				`Run Attempt ID: \`${run.runId}\``,
				`Status: ${formatCodexRunStatus(run.status)}`,
				run.sourceStatus ? `Owner Status: \`${run.sourceStatus}\`` : null,
				`Lifecycle Owner: ${formatCodexRunAuthority(run)}`,
				`Projection Boundary: ${formatCodexRunOwnership(run)}`,
				run.orchestrationMode ? `Mode: \`${run.orchestrationMode}\`` : null,
				run.nextAction ? `Next Step: ${run.nextAction}` : null,
				run.role ? `Role: \`${run.role}\`` : null,
				`Sources: ${formatCodexRunSource(run)}`,
				run.execMode ? `Execution Mode: \`${run.execMode}\`` : null,
				run.execNodeName ? `Execution Node: \`${run.execNodeName}\`` : null,
				run.host ? `Host: \`${run.host}\`` : null,
				run.model ? `Model: \`${run.model}\`` : null,
				run.workspacePath ? `Workspace: \`${run.workspacePath}\`` : null,
				run.sessionKey ? `Session: \`${run.sessionKey}\`` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath = getCodexRunStatusIcon(run.status);
		item.contextValue = `codexRun.${run.status}`;
		item.resourceUri = vscode.Uri.parse(
			`codex-run:${encodeURIComponent(run.runId)}`,
		);
		const focusTask = this.resolveCodexRunFocusTask(run);
		if (focusTask) {
			item.command = {
				command: "commandCentral.focusAgentTerminal",
				title: "Focus Terminal",
				arguments: [{ type: "task" as const, task: focusTask }],
			};
		}
		return item;
	}

	private resolveCodexRunFocusTask(run: CodexRunView): AgentTask | undefined {
		const taskId =
			run.taskId ??
			(run.source.kind === "launcher" ? run.source.id : undefined);
		if (!taskId) return undefined;
		const task = this.getDisplayTaskById(taskId);
		if (!task) return undefined;
		if (task.status === "running") return task;
		if (task.session_id) return task;
		return undefined;
	}

	private createTaskFlowItem(flow: TaskFlow): vscode.TreeItem {
		const title = flow.label?.trim() || flow.flowId;
		const progressPart =
			flow.taskCount > 0
				? `${flow.completedCount}/${flow.taskCount} tasks`
				: undefined;
		const descriptionParts = [
			taskflowStatusToLabel(flow.status),
			progressPart,
			flow.failedCount > 0 ? `${flow.failedCount} failed` : undefined,
		].filter((part): part is string => Boolean(part));
		const item = new vscode.TreeItem(
			title,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = descriptionParts.join(" · ");
		item.tooltip = new vscode.MarkdownString(
			[
				`**${title}**`,
				`Flow ID: \`${flow.flowId}\``,
				`Status: ${taskflowStatusToLabel(flow.status)}`,
				flow.agentId ? `Agent: ${flow.agentId}` : null,
				flow.taskCount > 0
					? `Progress: ${flow.completedCount}/${flow.taskCount} completed`
					: null,
				flow.failedCount > 0 ? `Failed: ${flow.failedCount}` : null,
				flow.error ? `Error: ${flow.error}` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath = taskflowStatusToIcon(flow.status);
		item.contextValue = `taskflow.${flow.status}`;
		item.resourceUri = vscode.Uri.parse(`taskflow:${flow.flowId}`);
		return item;
	}

	private getTaskFlowDetailChildren(flow: TaskFlow): DetailNode[] {
		const flowId = `taskflow-${flow.flowId}`;
		const details: DetailNode[] = [
			{
				type: "detail",
				label: "Status",
				value: taskflowStatusToLabel(flow.status),
				taskId: flowId,
				icon: taskflowStatusToIcon(flow.status).id,
				iconColor: taskflowStatusToIcon(flow.status).color?.id,
			},
		];

		if (flow.agentId) {
			details.push({
				type: "detail",
				label: "Agent",
				value: flow.agentId,
				taskId: flowId,
				icon: "hubot",
			});
		}

		if (flow.taskCount > 0) {
			details.push({
				type: "detail",
				label: "Progress",
				value: `${flow.completedCount}/${flow.taskCount} completed`,
				taskId: flowId,
				icon: "checklist",
			});
		}

		if (flow.failedCount > 0) {
			details.push({
				type: "detail",
				label: "Failed",
				value: `${flow.failedCount}`,
				taskId: flowId,
				icon: "error",
				iconColor: "charts.red",
			});
		}

		const duration = this.formatTaskFlowDuration(flow);
		if (duration) {
			details.push({
				type: "detail",
				label: "Duration",
				value: duration,
				taskId: flowId,
				icon: "watch",
			});
		}

		if (flow.error) {
			details.push({
				type: "detail",
				label: "Error",
				value: flow.error,
				taskId: flowId,
				icon: "error",
				iconColor: "charts.red",
			});
		}

		return details;
	}

	private getTaskFlowChildNodes(flow: TaskFlow): AgentNode[] {
		const flowTasks = flow.tasks ?? [];
		if (flowTasks.length === 0) return [];

		const children: AgentNode[] = [];
		const seen = new Set<string>();
		for (const task of flowTasks) {
			const child = this.resolveTaskFlowChildNode(flow, task);
			const childKey = this.getTaskFlowChildNodeKey(child, task);
			if (seen.has(childKey)) continue;
			seen.add(childKey);
			children.push(child);
		}
		return children;
	}

	private resolveTaskFlowChildNode(
		flow: TaskFlow,
		task: TaskFlowTask,
	): AgentNode {
		const launcherTask = this.findLauncherTaskForFlowTask(task);
		if (launcherTask) {
			return { type: "task", task: launcherTask };
		}

		const discoveredAgent = this.findDiscoveredAgentForFlowTask(task);
		if (discoveredAgent) {
			return { type: "discovered", agent: discoveredAgent };
		}

		const openclawTask = this.findOpenClawTaskForFlowTask(task);
		if (openclawTask) {
			return { type: "openclawTask", task: openclawTask };
		}

		return {
			type: "taskFlowChild",
			taskId: task.taskId,
			flowId: flow.flowId,
			label: getOpenClawTaskDisplayTitle(task),
			status: openclawStatusToLabel(task.status),
		};
	}

	private getTaskFlowChildNodeKey(
		child: AgentNode,
		task: TaskFlowTask,
	): string {
		switch (child.type) {
			case "task":
				return `task:${child.task.id}`;
			case "discovered":
				return `discovered:${child.agent.pid}`;
			case "openclawTask":
				return `openclaw:${child.task.taskId}`;
			case "taskFlowChild":
				return `placeholder:${task.taskId}`;
			default:
				return `other:${task.taskId}`;
		}
	}

	private findLauncherTaskForFlowTask(task: TaskFlowTask): AgentTask | null {
		return (
			this.getLauncherTasks().find((launcherTask) =>
				openClawTaskMatchesLauncherTask(task, launcherTask),
			) ?? null
		);
	}

	private findDiscoveredAgentForFlowTask(
		task: TaskFlowTask,
	): DiscoveredAgent | null {
		if (!task.childSessionKey) return null;
		const discoveredAgents =
			this._allDiscoveredAgents.length > 0
				? this._allDiscoveredAgents
				: this._discoveredAgents;
		return (
			discoveredAgents.find(
				(agent) => agent.sessionId === task.childSessionKey,
			) ?? null
		);
	}

	private findOpenClawTaskForFlowTask(task: TaskFlowTask): OpenClawTask | null {
		const allOpenClawTasks = this.getNonLauncherOpenClawTasks();
		return (
			allOpenClawTasks.find(
				(openclawTask) =>
					openclawTask.taskId === task.taskId ||
					(task.childSessionKey != null &&
						openclawTask.childSessionKey === task.childSessionKey),
			) ?? null
		);
	}

	private formatTaskFlowDuration(flow: TaskFlow): string | null {
		const start = flow.startedAt ?? flow.createdAt;
		if (!start) return null;
		const end = flow.endedAt ?? Date.now();
		const durationMs = Math.max(0, end - start);
		const totalMinutes = Math.floor(durationMs / 60_000);
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
		if (hours > 0) return `${hours}h`;
		return `${minutes}m`;
	}

	private getVisibleTaskFlows(): TaskFlow[] {
		const flows = this._taskFlowService?.getFlows() ?? [];
		return [...flows].sort(
			(left, right) =>
				(right.endedAt ?? right.startedAt ?? right.createdAt ?? 0) -
				(left.endedAt ?? left.startedAt ?? left.createdAt ?? 0),
		);
	}

	private createProjectGroupItem(node: ProjectGroupNode): vscode.TreeItem {
		const projectDir =
			node.projectDir || node.tasks[0]?.project_dir || node.projectName;
		const launcherIcon =
			node.tasks.find((task) => task.project_icon)?.project_icon ?? null;
		const icon = node.unregistered
			? "⚠️"
			: this.getProjectIcon(projectDir, { launcherIcon });
		const discoveredCount = node.discoveredAgents?.length ?? 0;
		// Project-aware V2 counts: same `live · review · action · history`
		// denominator as the root, scoped to this project's lanes plus its
		// always-live discovered agents. Project grouping is preserved — these
		// counts are per-project, not a flattened global tally.
		const counts = this.computeUnifiedSectionCountsForTasks(
			node.tasks,
			discoveredCount,
		);
		const total = counts.live + counts.review + counts.action + counts.history;

		// Uppercase name + ▼ + count in parens — mirrors Git Sort section headers
		const hasRunning = counts.live > 0;
		const collapseState = hasRunning
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(
			`${icon} ${node.projectName.toUpperCase()} \u25BC (${total})`,
			collapseState,
		);

		// Description: per-project V2 status summary (all four sections, no time)
		const description = formatV2Summary(counts);
		const latestActivity = this.getProjectGroupRelativeActivity(node);
		const attentionCount = counts.action;
		if (node.unregistered) {
			item.description = `${description} · no Work Registry resolution`;
			item.tooltip = new vscode.MarkdownString(
				[
					`**${UNREGISTERED_PROJECT_GROUP_NAME}**`,
					"These records carry no Work Registry `project_ref` and could not be attributed to a registered project by directory, exec cwd, or repo origin.",
					`Agents: ${description}`,
					latestActivity ? `Latest activity: ${latestActivity}` : null,
					"Register the project in the Work Registry (oc-project) or relaunch the lane so the launcher stamps `project_ref`.",
				]
					.filter(Boolean)
					.join("\n\n"),
			);
			item.contextValue = "projectGroupUnregistered";
			return item;
		}
		item.description = description;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${node.projectName}**`,
				projectDir ? `Dir: \`${projectDir}\`` : null,
				`Agents: ${description}`,
				latestActivity ? `Latest activity: ${latestActivity}` : null,
				attentionCount > 0 ? `${attentionCount} needs attention` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.contextValue = "projectGroup";
		return item;
	}

	private createFolderGroupItem(node: FolderGroupNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			`📁 ${node.groupName} · ${node.projectCount}`,
			vscode.TreeItemCollapsibleState.Expanded,
		);
		item.contextValue = "folderGroup";
		return item;
	}

	private createStatusGroupItem(node: StatusGroupNode): vscode.TreeItem {
		const count = node.nodes.length;
		const collapsibleState =
			node.status !== "done" && this.statusGroupHasRecentItems(node)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		// Agent Status V2 section header: locked `Live · N` / `Needs Review · N` /
		// `Action Required · N` / `History · N` format (label · count). The count
		// word ("agent"/"agents") stays in the tooltip for accessibility.
		const item = new vscode.TreeItem(
			`${STATUS_GROUP_LABELS[node.status]} · ${count}`,
			collapsibleState,
		);
		item.contextValue = "statusGroup";
		item.iconPath = STATUS_GROUP_ICONS[node.status];
		item.tooltip = `${STATUS_GROUP_LABELS[node.status]} • ${count} ${count === 1 ? "agent" : "agents"}`;
		return item;
	}

	private createStatusTimeGroupItem(
		node: StatusTimeGroupNode,
	): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, node.collapsibleState);
		item.contextValue = "statusTimeGroup";
		item.iconPath = new vscode.ThemeIcon("calendar");
		item.tooltip = `${STATUS_GROUP_LABELS[node.status]} • ${node.label}`;
		return item;
	}

	/** Compute summary icon based on aggregate agent state */
	private getSummaryIcon(): vscode.ThemeIcon {
		const tasks = this.getScopedLauncherTasks();
		const discovered = this.getScopedDiscoveredAgents();
		const openclawTasks = this.getVisibleOpenClawTasks();

		const hasRunning =
			tasks.some((t) => t.status === "running") ||
			discovered.length > 0 ||
			openclawTasks.some((task) => isOpenClawTaskActive(task));
		const hasFailed =
			tasks.some((t) => t.status === "failed" || t.status === "killed") ||
			openclawTasks.some(
				(task) => task.status === "failed" || task.status === "timed_out",
			);
		const hasContractFailure = tasks.some(
			(t) => t.status === "contract_failure",
		);
		const hasStopped =
			tasks.some((t) => t.status === "stopped") ||
			openclawTasks.some(
				(task) => task.status === "blocked" || task.status === "lost",
			);

		if (hasFailed) {
			return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
		}
		if (hasContractFailure) {
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.orange"),
			);
		}
		if (hasStopped) {
			return new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("charts.yellow"),
			);
		}
		if (hasRunning) {
			return new vscode.ThemeIcon(
				"sync~spin",
				new vscode.ThemeColor("charts.yellow"),
			);
		}
		return new vscode.ThemeIcon(
			"check-all",
			new vscode.ThemeColor("charts.green"),
		);
	}

	private getTaskActivityDescription(task: AgentTask): string {
		const reference =
			task.status === "running"
				? task.started_at
				: (task.completed_at ?? task.updated_at ?? task.started_at ?? null);
		return relativeTime(reference);
	}

	private getTaskDuration(task: AgentTask): string | null {
		if (!task.started_at) return null;
		const startedAt = new Date(task.started_at).getTime();
		if (!Number.isFinite(startedAt)) return null;
		const endedAt = task.completed_at
			? new Date(task.completed_at).getTime()
			: Date.now();
		if (!Number.isFinite(endedAt)) return null;
		return formatElapsed(
			task.started_at,
			new Date(Math.max(startedAt, endedAt)),
		);
	}

	private getProjectGroupRelativeActivity(
		node: ProjectGroupNode,
	): string | null {
		const freshestActivityMs = this.getProjectGroupFreshestActivityMs(node);
		return freshestActivityMs > 0 ? relativeTime(freshestActivityMs) : null;
	}

	private getStuckThresholdMinutes(): number {
		const config = vscode.workspace.getConfiguration("commandCentral");
		const raw = config.get<number>(
			"agentStatus.stuckThresholdMinutes",
			AgentStatusTreeProvider.STUCK_THRESHOLD_DEFAULT_MINUTES,
		);
		const clamped = Math.max(
			AgentStatusTreeProvider.STUCK_THRESHOLD_MIN_MINUTES,
			Math.min(
				AgentStatusTreeProvider.STUCK_THRESHOLD_MAX_MINUTES,
				Number.isFinite(raw)
					? raw
					: AgentStatusTreeProvider.STUCK_THRESHOLD_DEFAULT_MINUTES,
			),
		);
		return clamped;
	}

	public getStreamFileCandidates(task: AgentTask): string[] {
		const explicitStreamFile = (
			task as AgentTask & { stream_file?: string | null }
		).stream_file;
		const prefixes = new Set<string>();
		if (task.agent_backend) prefixes.add(task.agent_backend);
		for (const backend of AgentStatusTreeProvider.STREAM_BACKEND_PREFIXES) {
			prefixes.add(backend);
		}
		const candidates = Array.from(prefixes).map(
			(backend) => `/tmp/${backend}-stream-${task.id}.jsonl`,
		);
		if (explicitStreamFile) {
			candidates.unshift(explicitStreamFile);
		}
		return candidates;
	}

	public resolveStreamFilePath(task: AgentTask): string | null {
		const now = Date.now();
		const cached = this._streamFilePathCache.get(task.id);
		if (cached && now - cached.checkedAt < 5_000) {
			return cached.path;
		}
		let resolved: string | null = null;
		for (const candidate of this.getStreamFileCandidates(task)) {
			if (fs.existsSync(candidate)) {
				resolved = candidate;
				break;
			}
		}
		this._streamFilePathCache.set(task.id, { path: resolved, checkedAt: now });
		return resolved;
	}

	public isAgentStuck(task: AgentTask): boolean {
		if (task.status !== "running") return false;

		const startedMs = new Date(task.started_at).getTime();
		if (!Number.isFinite(startedMs)) return false;

		const now = Date.now();
		const thresholdMs = this.getStuckThresholdMinutes() * 60_000;
		if (now - startedMs < thresholdMs) return false;

		const streamFile = this.resolveStreamFilePath(task);
		if (!streamFile) {
			// No stream file: fall back to elapsed runtime only.
			return true;
		}

		try {
			const stat = fs.statSync(streamFile);
			return now - stat.mtimeMs >= thresholdMs;
		} catch {
			// Stream stat failed: use runtime fallback.
			return true;
		}
	}

	private createTaskItem(task: AgentTask): vscode.TreeItem {
		const roleIcon = task.role ? ROLE_ICONS[task.role] : null;
		const modelDisplay = this.resolveTaskModelDisplay(task);
		const projectIcon = this.getProjectIcon(task.project_dir, {
			launcherIcon: task.project_icon,
		});
		const labelParts = [projectIcon, roleIcon, task.id].filter(Boolean);
		const label = labelParts.join(" ");
		const stuckRaw = this.isAgentStuck(task);
		const interactiveAwaiting =
			stuckRaw && this.hasPositiveLivenessEvidence(task);
		// Only surface "(possibly stuck)" when stuck heuristics fire AND we have
		// no positive liveness evidence. Live launcher-managed interactive
		// Claude lanes get the more honest "(interactive)" hint instead.
		const isStuck = stuckRaw && !interactiveAwaiting;
		// A `running` lane whose live work CC cannot prove (launcher projected
		// attach-unavailable / visibility-degraded, or a session-less projection
		// row with no probe channel) must not imply ongoing work with the
		// animated spinner. Gate on the live probe so a worktree-discovered live
		// agent — or a launcher-flagged row CC can locally confirm alive — still
		// wins and keeps its spinner. "Detached" here is a visibility badge, not
		// a lifecycle state: the row stays `running` and in its status group.
		const livenessUnobservable =
			isLivenessUnobservableRunningLane(task) &&
			!this.hasPositiveLivenessEvidence(task);
		const livenessUnobservableReason = livenessUnobservable
			? (task.launcher_visibility_reason ??
				task.launcher_attach_reason ??
				(task.lane_projection
					? "projection-reported running; no session to attach or probe"
					: "no attach or liveness evidence"))
			: null;
		const diffSummaryInline = this.getCachedDiffSummaryForTask(task);
		const descriptionParts: string[] = [];
		if (!this.isProjectGroupingEnabled()) {
			descriptionParts.push(getTaskDisplayProjectName(task));
		}
		if (task.status === "completed_stale") {
			descriptionParts.push("stale");
		}
		const missingHandoffRelpath =
			task.status === "completed" &&
			task.review_status !== "pending" &&
			task.review_status !== "changes_requested" &&
			task.handoff_file &&
			this.getDeclaredHandoffState(task) === "missing"
				? task.handoff_file
				: null;
		if (missingHandoffRelpath) {
			descriptionParts.push(`missing handoff: ${missingHandoffRelpath}`);
		}
		const reviewQueuePending =
			(task.status === "completed" ||
				task.status === "completed_dirty" ||
				task.status === "completed_stale") &&
			task.review_status !== "pending" &&
			task.review_status !== "changes_requested" &&
			!missingHandoffRelpath &&
			this.isReviewQueueReceiptMissing(task);
		if (reviewQueuePending) {
			descriptionParts.push("review receipt missing");
		}
		if (diffSummaryInline) {
			descriptionParts.push(diffSummaryInline);
		}
		// Omit diff loading placeholder — show nothing until ready (no flicker)
		const fallback = this.getTaskFallbackInfo(task);
		if (fallback) {
			descriptionParts.push(`${fallback.actualAlias} (fallback)`);
		} else if (modelDisplay?.alias) {
			descriptionParts.push(modelDisplay.alias);
		}
		const isDoneStatus =
			task.status === "completed" ||
			task.status === "completed_dirty" ||
			task.status === "completed_stale" ||
			task.status === "failed" ||
			task.status === "contract_failure" ||
			task.status === "stopped" ||
			task.status === "killed";
		const isReviewed = isDoneStatus && this.isTaskReviewed(task);
		if (task.status === "running") {
			if (descriptionParts.length === 0) {
				descriptionParts.push(this.getTaskActivityDescription(task));
			}
		} else {
			descriptionParts.push(relativeTime(this.getTaskActivityTimeMs(task)));
		}
		if (isReviewed) {
			descriptionParts.push("✓");
		}
		const taskRouting = classifyCompletionRouting(task);
		if (
			taskRouting.kind === "detached" &&
			isDoneStatus &&
			task.role !== "reviewer" &&
			!isSymphonyLane(task)
		) {
			descriptionParts.push("⚠ detached");
		}
		// Release-hygiene: a lane whose Ghostty app/window is from a superseded
		// generation is a pre-reset leftover (its pane may still be a live orphan).
		// It must not read as a current live agent, so its liveness-conflict badge
		// is suppressed in favour of an explicit "stale (pre-release)" badge below.
		// No-op until a current generation is known (getCurrentReleaseGeneration
		// null today).
		const supersededByReset = isSupersededByReleaseReset(
			task,
			this.getCurrentReleaseGeneration(),
		);
		const lifecycleLiveness =
			isDoneStatus && !supersededByReset
				? this.getTerminalTaskLivenessEvidence(task)
				: ("not-checked" as const);
		const lifecycleConflict = classifyLifecycleConflict(
			task,
			lifecycleLiveness,
			// Corroborate with the launcher's own session_live so a terminal-but-
			// alive lane is badged even when the live probe could not decide
			// (remote-node lane we cannot probe locally, cold cache). The probe
			// still wins when it has a verdict — see classifyLifecycleConflict.
			// Suppressed for superseded lanes (effectiveLauncherSessionLive).
			isDoneStatus ? this.effectiveLauncherSessionLive(task) : null,
		);
		// CCSYNC-03 (PAR-228): warm the live-pane attention classification while we
		// have already paid for the liveness probe, so getNodeStatusGroup can read
		// it cache-only. Only when a conflict actually fired (otherwise there is no
		// "alive" pane worth capturing) and the probe did not positively confirm an
		// agent (a confirmed agent is genuine live work, never benign).
		const paneAttention =
			lifecycleConflict.kind === "live-process-conflict" &&
			lifecycleLiveness !== "alive"
				? this.getTerminalTaskPaneAttention(task)
				: ("unknown" as PaneAttentionState);
		const benignLivePane =
			lifecycleConflict.kind === "live-process-conflict" &&
			lifecycleLiveness !== "alive" &&
			isBenignLivePane(paneAttention);
		if (supersededByReset) {
			// Pre-reset stale terminal — leftover from before the release recreated
			// terminals. Explicitly distinct from a current running/live lane.
			descriptionParts.push("stale (pre-release)");
		} else if (benignLivePane) {
			// CCSYNC-03: the launcher recorded the session as live but the pane is a
			// finished command at its prompt or a bare/idle shell — the agent is gone
			// and nothing is blocked. Not attention; badge it as a benign leftover so
			// the contradiction stays visible without inflating the action count.
			descriptionParts.push(
				paneAttention === "completed-at-prompt"
					? "live shell · completed at prompt"
					: "live shell · idle",
			);
		} else if (lifecycleConflict.kind === "live-process-conflict") {
			// "live attention required" — the launcher marked this lane terminal
			// but it is still alive. Loud, un-buried, and distinct from a genuine
			// `running` lane (which renders Live with a spinner, never this badge).
			descriptionParts.push("⚠ live · lifecycle conflict");
		}
		// Agent Team lead badge: teammates are subagents of this lead's Claude
		// session (not sibling launcher tasks), so the fan-out is invisible unless
		// the lead row says so. Metadata-only (no pane probe) — cheap and truthful.
		if (isAgentTeamLead(task)) {
			const template = task.team_template?.trim();
			descriptionParts.push(template ? `team: ${template}` : "team");
		}
		const surfaceSummary = classifyTaskSurface(task);
		// Surface tags are the loudest signal for running tasks — a click
		// routes to a different strategy depending on kind. Skip for done
		// tasks: the click opens a QuickPick, not a focus, so the surface is
		// not the actionable fact. Launcher-bundle tasks get a null tag so
		// the common case stays clean.
		if (task.status === "running" && surfaceSummary.shortTag) {
			descriptionParts.push(surfaceSummary.shortTag);
		}
		// At-a-glance "Resume will hit the exact conversation" indicator.
		// Presence of the link emoji + first 8 chars of the UUID = a
		// task-specific resume target exists; absence on a Claude row = the
		// resume will fall through to `claude --continue` (project-scoped,
		// shared across sibling tasks).
		//
		// Note: codicon `$(name)` shortcodes auto-expand in `TreeItem.label`
		// and in `MarkdownString` (with `supportThemeIcons=true`), but NOT
		// in `TreeItem.description` — the raw `$(link)` text leaks to the
		// UI there. We use the unicode link emoji 🔗 instead so the glyph
		// renders natively without VS Code-specific expansion machinery.
		const claudeResumeBackend = resolveResumeBackend(task);
		const claudeUuid =
			claudeResumeBackend === "claude" || claudeResumeBackend === "unknown"
				? getValidClaudeSessionId(task.claude_session_id)
				: null;
		const hasClaudeUuidLink = claudeUuid !== null;
		if (claudeUuid) {
			descriptionParts.push(`🔗 ${claudeUuid.slice(0, 8)}`);
		}
		const rawDescription = livenessUnobservable
			? `${descriptionParts.join(" · ")} (detached)`
			: isStuck
				? `${descriptionParts.join(" · ")} (possibly stuck)`
				: interactiveAwaiting
					? `${descriptionParts.join(" · ")} (interactive)`
					: descriptionParts.join(" · ");
		const description =
			rawDescription.length > 80
				? `${rawDescription.slice(0, 79)}…`
				: rawDescription;
		const duration = this.getTaskDuration(task);
		const runtimeBreadcrumb = this.getTaskRuntimeIdentityBreadcrumb(task);
		const transcriptBreadcrumb = this.getTaskTranscriptBreadcrumb(task);

		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = description;
		const codexRunNote = this.formatCodexRunLegacyLauncherNote(task);
		const resumeTargetLine =
			claudeResumeBackend === "claude" || claudeResumeBackend === "unknown"
				? claudeUuid
					? `**Resume target:** \`claude --resume ${claudeUuid}\``
					: `**Resume target:** \`claude --continue\` _(no session UUID captured — resumes the most-recent conversation in this directory; may collide with sibling tasks)_`
				: null;
		const routingInfo = classifyCompletionRouting(task);
		const routingLine =
			routingInfo.kind === "owner-bound"
				? `**Routing:** $(radio-tower) Owner-bound — ${routingInfo.detail}`
				: routingInfo.kind === "detached"
					? `**Routing:** $(debug-disconnect) Detached — ${routingInfo.detail}`
					: null;
		const lifecycleConflictLine =
			lifecycleConflict.kind === "live-process-conflict"
				? `**$(warning) Lifecycle conflict:** ${lifecycleConflict.detail}`
				: null;
		const detachedLivenessLine = livenessUnobservable
			? `**$(debug-disconnect) Liveness:** Detached — running state not locally observable${
					livenessUnobservableReason ? ` (${livenessUnobservableReason})` : ""
				}`
			: null;
		item.tooltip = new vscode.MarkdownString(
			[
				`**${task.id}**`,
				`Status: ${getStatusDisplayLabel(task.status)}`,
				lifecycleConflictLine,
				detachedLivenessLine,
				codexRunNote,
				fallback
					? `Model: ${fallback.actualFull} (fallback from ${fallback.requestedFull})`
					: modelDisplay
						? `Model: ${modelDisplay.fullName}`
						: null,
				task.started_at ? `Started: ${task.started_at}` : null,
				task.completed_at ? `Completed: ${task.completed_at}` : null,
				duration ? `Duration: ${duration}` : null,
				runtimeBreadcrumb ? `Runtime: ${runtimeBreadcrumb}` : null,
				transcriptBreadcrumb ? `Transcript: ${transcriptBreadcrumb}` : null,
				resumeTargetLine,
				routingLine,
				surfaceSummary.tooltipLine,
				task.project_dir ? `Dir: \`${task.project_dir}\`` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath =
			lifecycleConflict.kind === "live-process-conflict"
				? new vscode.ThemeIcon(
						"warning",
						new vscode.ThemeColor("charts.orange"),
					)
				: livenessUnobservable
					? // Running, but CC has no evidence of live work (launcher
						// reported attach-unavailable / visibility-degraded, or a
						// session-less projection row with nothing to probe). Swap the
						// animated sync~spin for a static "disconnected" icon so the row
						// stops implying ongoing work it can't substantiate.
						new vscode.ThemeIcon(
							"debug-disconnect",
							new vscode.ThemeColor("charts.yellow"),
						)
					: task.status === "completed_stale" || isStuck
						? new vscode.ThemeIcon(
								"warning",
								new vscode.ThemeColor("charts.yellow"),
							)
						: interactiveAwaiting
							? // Idle interactive REPL: positive pane evidence proves the
								// lane is alive, but the stream has been silent past the
								// stuck threshold — so it's awaiting input, not churning.
								// Swap the animated sync~spin for a static "chat awaiting
								// reply" icon so the row stops implying ongoing work.
								new vscode.ThemeIcon(
									"comment-discussion",
									new vscode.ThemeColor("charts.yellow"),
								)
							: isReviewed
								? new vscode.ThemeIcon(
										"pass",
										new vscode.ThemeColor("charts.green"),
									)
								: getStatusThemeIcon(task.status);
		// `.linked` contextValue suffix is added only when a Claude session
		// UUID is recorded — mirrors the at-a-glance description indicator
		// (presence = task-specific resume target; absence = `--continue`).
		// Future `view/item/context` entries that should only appear when a
		// UUID is captured can gate on `viewItem =~ /\.linked$/`. No
		// `.unlinked` is emitted: absence carries the same semantic and
		// keeps the contextValue space tighter for non-claude rows.
		const contextParts = [`agentTask.${task.status}`];
		const hasFocusSurface = hasFirstClassTerminalFocusSurface(task);
		if (hasFocusSurface) contextParts.push("focusable");
		if (isReviewed) contextParts.push("reviewed");
		if (hasClaudeUuidLink) contextParts.push("linked");
		item.contextValue = contextParts.join(".");
		item.resourceUri = vscode.Uri.parse(`agent-task:${task.id}`);
		const isRunning = task.status === "running";
		const primaryActionIsFocus = isRunning || hasFocusSurface;
		item.command = {
			command: "commandCentral.defaultAgentAction",
			title: primaryActionIsFocus ? "Focus Terminal" : "View Changes",
			arguments: [{ type: "task" as const, task }],
		};
		return item;
	}

	private createOpenClawTaskItem(task: OpenClawTask): vscode.TreeItem {
		const title = getOpenClawTaskDisplayTitle(task);
		const activity = relativeTime(getOpenClawTaskActivityTimeMs(task));
		const summary =
			task.status === "queued" || task.status === "running"
				? task.progressSummary?.trim()
				: task.error?.trim() || task.terminalSummary?.trim();
		const descriptionParts = [
			task.runtime,
			openclawStatusToLabel(task.status),
			activity,
			summary,
		].filter((part): part is string => Boolean(part));
		const item = new vscode.TreeItem(
			title,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.description = descriptionParts.join(" · ");
		item.tooltip = new vscode.MarkdownString(
			[
				`**${title}**`,
				`Task ID: \`${task.taskId}\``,
				this.formatCodexRunLegacyOpenClawNote(task),
				`Runtime: ${task.runtime}`,
				`Status: ${openclawStatusToLabel(task.status)}`,
				`Owner: ${task.ownerKey}`,
				`Scope: ${task.scopeKind}`,
				task.agentId ? `Agent: ${task.agentId}` : null,
				task.runId ? `Run: ${task.runId}` : null,
				...classifyOpenClawCrossProjectContext(task).map(
					(row) => `${row.label}: ${row.value}`,
				),
				task.childSessionKey
					? `Child Session: \`${task.childSessionKey}\``
					: null,
				task.error ? `Error: ${task.error}` : null,
				task.terminalSummary ? `Summary: ${task.terminalSummary}` : null,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		item.iconPath = openclawStatusToIcon(task.status);
		item.contextValue = `openclawTask.${task.status}`;
		item.resourceUri = vscode.Uri.parse(`openclaw-task:${task.taskId}`);
		item.command = {
			command: "commandCentral.showOpenClawTaskDetail",
			title: "Show Details",
			arguments: [{ type: "openclawTask" as const, task }],
		};
		return item;
	}

	private createStateItem(node: StateNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "agentState";
		if (node.description) item.description = node.description;
		if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
		return item;
	}

	private createOlderRunsItem(node: OlderRunsNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		item.contextValue = "olderRuns";
		item.iconPath = new vscode.ThemeIcon(
			"history",
			new vscode.ThemeColor("descriptionForeground"),
		);
		// Build a description from the hidden node statuses
		const hasCompleted = node.hiddenNodes.some(
			(n) =>
				n.type === "task" &&
				(n.task.status === "completed" ||
					n.task.status === "completed_dirty" ||
					n.task.status === "completed_stale"),
		);
		const hasStopped = node.hiddenNodes.some(
			(n) => n.type === "task" && n.task.status === "stopped",
		);
		const statusParts: string[] = [];
		if (hasCompleted) statusParts.push("completed");
		if (hasStopped) statusParts.push("stopped");
		if (statusParts.length > 0) {
			item.description = statusParts.join(" · ");
		}
		return item;
	}

	private createFileChangeItem(node: FileChangeNode): vscode.TreeItem {
		const { filename } = getFileChangePathParts(node.filePath);
		const item = new vscode.TreeItem(
			filename,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description = formatFileChangeDescription(node);
		item.tooltip = path.join(node.projectDir, node.filePath);
		item.resourceUri = vscode.Uri.file(
			path.join(node.projectDir, node.filePath),
		);
		item.contextValue = "agentFileChange";
		item.command = {
			command: "commandCentral.smartOpenFile",
			title: "Open File",
			arguments: [node],
		};
		return item;
	}

	private createDetailItem(node: DetailNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.value ? `${node.label}: ${node.value}` : node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "agentTaskDetail";
		if (node.description) {
			item.description = node.description;
		}
		if (node.icon) {
			item.iconPath = new vscode.ThemeIcon(
				node.icon,
				node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
			);
		}
		if (node.command) {
			item.command = node.command;
		}
		return item;
	}

	private createDiscoveredItem(node: DiscoveredNode): vscode.TreeItem {
		const agent = node.agent;
		const projectName = this.getDiscoveredProjectName(agent);
		const projectDir = this.getDiscoveredProjectDir(agent);
		const projectIcon = this.getProjectIcon(projectDir);
		const uptime = formatElapsed(agent.startTime.toISOString());
		const worktreeLabel = agent.worktree?.isLinkedWorktree
			? `${agent.worktree.branch} · worktree`
			: null;
		const label = `${projectIcon} ${projectName}`;
		const item = new vscode.TreeItem(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
		);
		const discoveredDiff = this.getCachedDiffSummaryForDiscovered(agent);
		const descriptionParts = ["running", uptime];
		if (worktreeLabel) descriptionParts.push(worktreeLabel);
		if (discoveredDiff) {
			descriptionParts.push(discoveredDiff);
		}
		// Omit diff loading placeholder — show nothing until ready (no flicker)
		item.description = descriptionParts.join(" · ");
		item.iconPath = getStatusThemeIcon("running");
		item.contextValue = "discoveredAgent.running";
		item.command = {
			command: "commandCentral.focusAgentTerminal",
			title: "Focus Terminal",
			arguments: [{ type: "discovered" as const, agent }],
		};
		item.tooltip = new vscode.MarkdownString(
			[
				`**Discovered Agent** — PID ${agent.pid}`,
				`Project: \`${agent.projectDir}\``,
				agent.worktree?.isLinkedWorktree
					? `Worktree: \`${agent.worktree.branch}\` in \`${agent.worktree.worktreeDir}\` (main repo: \`${agent.worktree.mainRepoDir}\`)`
					: null,
				`Source: ${agent.source}`,
				agent.model ? `Model: ${agent.model}` : null,
				agent.sessionId ? `Session: ${agent.sessionId}` : null,
				`Started: ${agent.startTime.toISOString()}`,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		return item;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		this._onAgentEvent.dispose();
		if (this.ownsActivityBadge) {
			if (process.platform === "darwin") {
				const windowWithBadge = vscode.window as typeof vscode.window & {
					badge?: vscode.ViewBadge;
				};
				try {
					windowWithBadge.badge = undefined;
				} catch {
					// Best-effort only.
				}
			}
			if (this._agentStatusView) {
				this._agentStatusView.badge = undefined;
			}
		}
		for (const watcher of this.fileWatchers) {
			watcher.dispose();
		}
		this.fileWatchers = [];
		for (const watcher of this._nativeWatchers) {
			watcher.close();
		}
		this._nativeWatchers = [];
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.treeRefreshTimer) {
			clearTimeout(this.treeRefreshTimer);
			this.treeRefreshTimer = null;
		}
		if (this.autoRefreshTimer) {
			clearInterval(this.autoRefreshTimer);
			this.autoRefreshTimer = null;
		}
		if (this._agentRegistry) {
			this._agentRegistry.dispose();
			this._agentRegistry = null;
		}
		this.tmuxLiveness.clear();
		this._persistSessionHealthCache.clear();
		this._streamFilePathCache.clear();
		this._streamTerminalStateCache.clear();
		this._commitsSinceStartCache.clear();
		this._displayTasksRenderCache = null;
		this._displayTasksCachedRegistry = null;
		for (const d of this.disposables) d.dispose();
	}
}
