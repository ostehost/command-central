/**
 * Pure task-classification helpers for the Agent Status tree.
 *
 * Extracted from agent-status-tree-provider.ts: everything here derives
 * presentation-ready summaries from launcher-recorded task metadata without
 * touching vscode APIs or probing runtime state. Three classifiers live here:
 *
 * - Terminal surface ({@link classifyTaskSurface}): what "Focus Terminal"
 *   will target, from static metadata only.
 * - Completion routing ({@link classifyCompletionRouting}): whether a task's
 *   completion reports back to an orchestrator or requires manual observation.
 * - Lifecycle conflict ({@link classifyLifecycleConflict}): terminal-status
 *   tasks whose process is still alive.
 *
 * Host identity (local vs remote node) is also resolved here because surface
 * classification depends on it; tests override it via
 * {@link __setCurrentMachineHostOverrideForTests}.
 */

import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentTask,
	AgentTaskStatus,
} from "./agent-status-tree-provider.js";

/**
 * Static classification of a task's terminal surface, derived only from the
 * launcher-recorded metadata (terminal_backend, ghostty_bundle_id,
 * bundle_path). Used to narrate — in tree item labels and tooltips — what
 * clicking "Focus Terminal" will actually target, BEFORE the user clicks.
 *
 * This is complementary to the runtime-truth gate (shouldTrustBundleSurface)
 * in extension.ts: that gate probes tmux liveness at click time to decide
 * between bundle focus and fresh attach. This classifier only reads static
 * metadata, so it is cheap enough to run on every tree render. Liveness is
 * intentionally NOT probed here — a launcher-bundle task with a dead tmux
 * session is still classified as "launcher-bundle", because metadata is what
 * the task declares; liveness shapes *which* open strategy wins, not *what*
 * surface the task authoritatively owns.
 *
 * See 98caa1e (fresh-attach notification) and 1a52857 (bundle-trust gate) for
 * the full backend-truthful contract.
 */
export type TaskSurfaceKind =
	| "launcher-bundle"
	| "node-launcher-bundle"
	| "node-tmux-fresh-attach"
	| "tmux-fresh-attach"
	| "persist"
	| "applescript"
	| "unknown";

export interface TaskSurfaceSummary {
	kind: TaskSurfaceKind;
	/** Full sentence for the tooltip. Always non-empty. */
	tooltipLine: string;
	/**
	 * Compact inline tag for the tree item description. Null for the
	 * happy-path launcher-bundle surface (no noise on the common case).
	 */
	shortTag: string | null;
}

function firstNonEmptyTaskString(
	...values: Array<string | null | undefined>
): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

export function getTaskExecutionHostLabel(task: AgentTask): string | null {
	return firstNonEmptyTaskString(task.exec_host, task.exec_node);
}

function hasNodeExecutionMetadata(task: AgentTask): boolean {
	const execMode = task.exec_mode?.trim().toLowerCase();
	// rc.37: path heuristic removed — the old `exec_cwd?.startsWith("/Users/ostehost/")`
	// branch (and the parallel isPathUnderLocalHome check below) misclassified
	// any task with project_dir outside $HOME (/tmp, /Volumes, /opt, /private/var
	// …) as remote. Classification is now host-based — see isLocalExecutionHost.
	return Boolean(
		firstNonEmptyTaskString(task.exec_node, task.exec_host) ||
			execMode === "spoke" ||
			execMode === "node" ||
			execMode === "remote",
	);
}

/**
 * Cache + test seam for the current machine's friendly name (used to compare
 * against the launcher's `OSTE_EXEC_HOST` value when classifying tasks as
 * local vs remote).
 *
 * The launcher writes `scutil --get ComputerName 2>/dev/null || hostname -s`
 * (see oste-spawn.sh near line 2737), so we mirror that lookup chain here.
 * Cached on first read; tests override via {@link __setCurrentMachineHostOverrideForTests}.
 */
let __cachedCurrentMachineHost: string | null = null;
let __currentMachineHostOverrideForTests: string | null = null;

/** @internal Test-only seam. Pass null to restore the real machine host. */
export function __setCurrentMachineHostOverrideForTests(
	host: string | null,
): void {
	__currentMachineHostOverrideForTests = host;
	__cachedCurrentMachineHost = null;
}

function getCurrentMachineHost(): string {
	if (__currentMachineHostOverrideForTests !== null) {
		return __currentMachineHostOverrideForTests;
	}
	if (__cachedCurrentMachineHost !== null) return __cachedCurrentMachineHost;
	const { spawnSync } =
		require("node:child_process") as typeof import("node:child_process");
	try {
		const r = spawnSync("scutil", ["--get", "ComputerName"], {
			encoding: "utf-8",
			timeout: 1500,
		});
		if (r.status === 0 && r.stdout.trim()) {
			__cachedCurrentMachineHost = r.stdout.trim();
			return __cachedCurrentMachineHost;
		}
	} catch {
		// fall through
	}
	try {
		const r = spawnSync("hostname", ["-s"], {
			encoding: "utf-8",
			timeout: 1500,
		});
		if (r.status === 0 && r.stdout.trim()) {
			__cachedCurrentMachineHost = r.stdout.trim();
			return __cachedCurrentMachineHost;
		}
	} catch {
		// fall through
	}
	__cachedCurrentMachineHost = os.hostname() || "unknown";
	return __cachedCurrentMachineHost;
}

function normalizeHostName(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/\.local$/, "")
		.replace(/\s+/g, " ");
}

function isLocalExecutionHost(task: AgentTask): boolean {
	const taskHost = task.exec_host?.trim();
	// No host metadata recorded → degrade to "local" rather than surfacing a
	// remote-only action menu the user can't follow.
	if (!taskHost) return true;
	return (
		normalizeHostName(taskHost) === normalizeHostName(getCurrentMachineHost())
	);
}

export function isRemoteNodeTaskForCurrentHost(task: AgentTask): boolean {
	if (!hasNodeExecutionMetadata(task)) return false;
	return !isLocalExecutionHost(task);
}

/**
 * Whether probing THIS machine's filesystem can prove anything about the
 * task's advertised artifact paths (pending_review_path, handoff_file, …).
 *
 * Source-of-truth rule: local file probes are only valid for tasks that
 * executed on the current host. Remote/node-origin launcher records carry
 * absolute paths (`/tmp/oste-pending-review/…`) that are meaningful on the
 * machine that ran the task — the same path being absent here is not
 * evidence of anything. Such tasks must be judged by their recorded
 * metadata (review_state / review_status / end_commit / completion fields)
 * instead.
 *
 * The fail direction deliberately differs from {@link isRemoteNodeTaskForCurrentHost}:
 * a task carrying node-execution metadata but no exec_host degrades to
 * "local" for surface classification (so the user is not shown an
 * unfollowable remote action menu), but degrades to "not authoritative"
 * here (so a missing local file is never read as truth about another
 * machine). Tasks with no node-execution metadata at all are plain local
 * records and stay fully probe-able.
 *
 * TODO(work-system): the durable fix is a hub-readable Work System /
 * OpenClaw-native projection of per-task review state instead of raw
 * per-machine launcher files — once lanes carry review lifecycle in the
 * projection, this host check becomes a fallback rather than the gate.
 */
export function isLocalFileProbeAuthoritative(task: AgentTask): boolean {
	if (!hasNodeExecutionMetadata(task)) return true;
	const taskHost = task.exec_host?.trim();
	if (!taskHost) return false;
	return (
		normalizeHostName(taskHost) === normalizeHostName(getCurrentMachineHost())
	);
}

export function getTaskDisplayProjectName(task: AgentTask): string {
	return (
		firstNonEmptyTaskString(task.visible_project_name, task.project_name) ??
		path.basename(task.project_dir) ??
		"(unknown project)"
	);
}

export function classifyTaskSurface(task: AgentTask): TaskSurfaceSummary {
	const hasLauncherBundle =
		Boolean(task.ghostty_bundle_id) ||
		(Boolean(task.bundle_path) &&
			task.bundle_path !== "(tmux-mode)" &&
			task.bundle_path !== "(test-mode)");
	const hostLabel = getTaskExecutionHostLabel(task);
	const remoteNode = isRemoteNodeTaskForCurrentHost(task);

	if (task.terminal_backend === "tmux") {
		if (remoteNode) {
			if (hasLauncherBundle) {
				return {
					kind: "node-launcher-bundle",
					tooltipLine: `Surface: launcher Ghostty bundle on ${hostLabel ?? "node"} · tmux session (focus must execute on that node)`,
					shortTag: "node · visible",
				};
			}
			return {
				kind: "node-tmux-fresh-attach",
				tooltipLine: `Surface: tmux session on ${hostLabel ?? "node"} — no hub-local terminal should be opened`,
				shortTag: "node · tmux",
			};
		}
		if (hasLauncherBundle) {
			return {
				kind: "launcher-bundle",
				tooltipLine:
					"Surface: launcher Ghostty bundle · tmux session (focus raises the bundle window)",
				shortTag: null,
			};
		}
		return {
			kind: "tmux-fresh-attach",
			tooltipLine:
				"Surface: tmux session only — no launcher bundle; focus spawns a fresh Ghostty attach",
			shortTag: "tmux · fresh attach",
		};
	}
	if (task.terminal_backend === "persist") {
		return {
			kind: "persist",
			tooltipLine:
				"Surface: persist backend — no visible Ghostty window (headless socket lane)",
			shortTag: "persist",
		};
	}
	if (task.terminal_backend === "applescript") {
		return {
			kind: "applescript",
			tooltipLine: "Surface: AppleScript Ghostty (no launcher bundle)",
			shortTag: "applescript",
		};
	}
	if (hasLauncherBundle) {
		return {
			kind: "launcher-bundle",
			tooltipLine: "Surface: launcher Ghostty bundle",
			shortTag: null,
		};
	}
	return {
		kind: "unknown",
		tooltipLine: "Surface: no authoritative terminal surface recorded",
		shortTag: "surface?",
	};
}

// ── Symphony lane predicate ──────────────────────────────────────────

/**
 * Whether this task is a Symphony-orchestrated lane.
 *
 * A Symphony lane is launched by the Symphony daemon, which owns completion
 * via the launcher wrapper / receipt / oste-complete.sh — NOT via a
 * session_key/callback_url. So a completed Symphony lane is transport-level
 * "detached" yet fully orchestrated; it never needs manual observation.
 *
 * Canonical signal: launcher id matches `symphony-<ticket>-<hash>`.
 * Corroborating signal: `orchestration_mode === "symphony"`.
 */
export function isSymphonyLane(
	task: Pick<AgentTask, "id" | "orchestration_mode">,
): boolean {
	if (typeof task.id === "string" && /^symphony-/.test(task.id)) return true;
	const mode = task.orchestration_mode?.trim().toLowerCase();
	return mode === "symphony";
}

// ── Completion routing classification ───────────────────────────────

export type CompletionRoutingKind =
	| "owner-bound"
	| "detached"
	| "not-applicable";

export interface CompletionRoutingInfo {
	kind: CompletionRoutingKind;
	label: string;
	detail: string;
	icon: string;
	iconColor?: string;
}

export function classifyCompletionRouting(
	task: AgentTask,
): CompletionRoutingInfo {
	const isTerminal =
		task.status === "completed" ||
		task.status === "completed_dirty" ||
		task.status === "completed_stale" ||
		task.status === "failed" ||
		task.status === "contract_failure" ||
		task.status === "stopped" ||
		task.status === "killed";
	if (!isTerminal) {
		const hasSessionKey = Boolean(task.session_key?.trim());
		const hasCallback = Boolean(task.callback_url?.trim());
		if (hasSessionKey || hasCallback) {
			return {
				kind: "owner-bound",
				label: "Owner-bound",
				detail: "Completion will route back to orchestrator",
				icon: "radio-tower",
				iconColor: "charts.green",
			};
		}
		return {
			kind: "detached",
			label: "Detached",
			detail:
				"No session_key or callback_url — completion will not auto-report",
			icon: "debug-disconnect",
			iconColor: "charts.yellow",
		};
	}

	const hasSessionKey = Boolean(task.session_key?.trim());
	const hasCallback = Boolean(task.callback_url?.trim());
	if (hasSessionKey || hasCallback) {
		return {
			kind: "owner-bound",
			label: "Owner-bound completion",
			detail: hasCallback
				? `Routed via callback: ${task.callback_url}`
				: `Routed via session_key: ${task.session_key}`,
			icon: "radio-tower",
			iconColor: "charts.green",
		};
	}
	if (task.role === "reviewer") {
		return {
			kind: "detached",
			label: "Detached — no action needed",
			detail:
				"Standalone reviewer lane — launched without orchestrator callback; completion was local",
			icon: "debug-disconnect",
			iconColor: "disabledForeground",
		};
	}
	if (isSymphonyLane(task)) {
		return {
			kind: "detached",
			label: "Detached — orchestrated (no action needed)",
			detail:
				"Symphony-orchestrated lane — completion is reported by the launcher wrapper/finalizer (oste-complete), not a session_key/callback_url",
			icon: "debug-disconnect",
			iconColor: "disabledForeground",
		};
	}
	return {
		kind: "detached",
		label: "Detached — manual observation required",
		detail:
			"No session_key or callback_url at launch — completion was not auto-reported to orchestrator",
		icon: "debug-disconnect",
		iconColor: "charts.yellow",
	};
}

// ── Lifecycle conflict classification ────────────────────────────────

export type LifecycleConflictKind = "live-process-conflict" | "none";

export interface LifecycleConflictInfo {
	kind: LifecycleConflictKind;
	label: string;
	detail: string;
	icon: string;
	iconColor?: string;
}

const CONFLICT_ELIGIBLE_STATUSES = new Set<AgentTaskStatus>([
	"completed",
	"completed_dirty",
	"completed_stale",
	"failed",
	"contract_failure",
	"stopped",
	"killed",
]);

/**
 * Detect a "terminal status but provably alive" lane.
 *
 * Two evidence sources are consulted, in strict precedence:
 *
 *  1. `livenessEvidence` — a REAL-TIME tmux-pane probe verdict. When it is
 *     conclusive ("alive"/"dead") it always wins: a positively-dead pane
 *     overrides a stale `session_live: true`, and a live pane is ground truth.
 *  2. `launcherSessionLive` — the launcher's own `session_live` field recorded
 *     on the task. Consulted ONLY when the probe could not decide
 *     ("unknown"/"not-checked": cold hot-path cache, remote-node lane whose
 *     host we cannot probe, or an unrecognized pane command). `true` here on a
 *     terminal-status row is the launcher contradicting itself — it finalized
 *     the lane while recording the session as live.
 *
 * The detail wording is provenance-honest: a live probe says the process "is
 * still alive in terminal"; a launcher-record-only verdict says the launcher
 * "recorded the session as still live" and to verify on the host — so a stale
 * `session_live` never masquerades as a real-time confirmation (truthful status
 * over pretty status).
 */
export function classifyLifecycleConflict(
	task: Pick<AgentTask, "status" | "error_message">,
	livenessEvidence: "alive" | "dead" | "unknown" | "not-checked",
	launcherSessionLive?: boolean | null,
): LifecycleConflictInfo {
	if (!CONFLICT_ELIGIBLE_STATUSES.has(task.status)) {
		return { kind: "none", label: "", detail: "", icon: "" };
	}

	const probeAlive = livenessEvidence === "alive";
	// The launcher's recorded liveness only fills the gap when the live probe
	// has no verdict — a confirmed-dead pane (probe "dead") beats a stale
	// session_live:true.
	const launcherAlive =
		!probeAlive && livenessEvidence !== "dead" && launcherSessionLive === true;

	if (!probeAlive && !launcherAlive) {
		return { kind: "none", label: "", detail: "", icon: "" };
	}

	const reason = task.error_message ? ` (${task.error_message})` : "";
	const evidenceClause = probeAlive
		? "but process is still alive in terminal"
		: "but the launcher recorded the session as still live (session_live) — verify on host";
	return {
		kind: "live-process-conflict",
		label: "Lifecycle conflict",
		detail: `Launcher marked ${task.status}${reason} ${evidenceClause}`,
		icon: "warning",
		iconColor: "charts.orange",
	};
}
