import * as path from "node:path";
import { canonicalizeProjectDir } from "../utils/project-scope.js";
import {
	isReconciledGcVerdict,
	type LaneProjectionGcReceipt,
	lookupGcRowVerdict,
} from "../utils/review-queue-health.js";
import {
	asNullableNumber,
	asNumber,
	asString,
} from "../utils/value-coercion.js";
import type {
	AgentTask,
	AgentTaskProjectRef,
	AgentTaskStatus,
} from "./agent-status-tree-provider.js";
import { canonicalGenerationToken } from "./agent-task-classification.js";

// NOTE: a byte-identical twin lives in agent-status-tree-provider.ts — keep
// both in sync. A status missing from this set is coerced to "stopped" below
// (a `paused` row would land in Action instead of Needs Review).
const VALID_TASK_STATUSES = new Set<AgentTaskStatus>([
	"running",
	"paused",
	"stopped",
	"killed",
	"completed",
	"completed_dirty",
	"completed_stale",
	"failed",
	"contract_failure",
]);

/**
 * A registry-backed LaneRef record carries the Work Registry resolution
 * (`project_ref.id`) stamped by the launcher at spawn time. Stale
 * launcher-era rows predate the registry and never have it.
 */
export function isRegistryBackedLaneTask(
	task: Pick<AgentTask, "project_ref">,
): boolean {
	return Boolean(task.project_ref?.id?.trim());
}

function normalizeTaskProjectRef(value: unknown): AgentTaskProjectRef | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const id = asString(raw["id"]);
	if (!id) return null;
	const repoOriginsRaw = raw["repoOrigins"] ?? raw["repo_origins"];
	return {
		id,
		displayName: asString(raw["displayName"] ?? raw["display_name"]) ?? null,
		status: asString(raw["status"]) ?? null,
		registry_status:
			asString(raw["registry_status"] ?? raw["registryStatus"]) ?? null,
		repoOrigins: Array.isArray(repoOriginsRaw)
			? repoOriginsRaw.filter(
					(origin): origin is string => typeof origin === "string",
				)
			: null,
	};
}

export function normalizeTask(
	taskKey: string,
	raw: Record<string, unknown>,
): AgentTask | null {
	const sessionId = asString(raw["session_id"] ?? raw["tmux_session"]);
	if (!sessionId) return null;

	const id = asString(raw["id"]) ?? taskKey;
	const statusRaw = asString(raw["status"]);
	const status: AgentTaskStatus =
		!statusRaw || statusRaw === "active"
			? "running"
			: VALID_TASK_STATUSES.has(statusRaw as AgentTaskStatus)
				? (statusRaw as AgentTaskStatus)
				: "stopped";
	const projectDir = canonicalizeProjectDir(asString(raw["project_dir"]) ?? "");
	const explicitProjectName = asString(raw["project_name"]);
	const projectName =
		explicitProjectName ?? (path.basename(projectDir) || "(unknown project)");
	const visibleProjectName = asString(raw["visible_project_name"]) ?? null;
	const bundlePath = asString(raw["bundle_path"]) ?? "(unknown)";
	const promptFile = asString(raw["prompt_file"]) ?? "";
	const canonicalProjectDirRaw = asString(raw["canonical_project_dir"]);

	return {
		task_id: asString(raw["task_id"]) ?? null,
		id,
		flow_id: asString(raw["flow_id"]) ?? null,
		project_id: asString(raw["project_id"]) ?? null,
		project_ref: normalizeTaskProjectRef(raw["project_ref"]),
		lane_kind: asString(raw["lane_kind"]) ?? null,
		lane_kind_source: asString(raw["lane_kind_source"]) ?? null,
		canonical_project_dir: canonicalProjectDirRaw
			? canonicalizeProjectDir(canonicalProjectDirRaw)
			: null,
		execution_dir: asString(raw["execution_dir"]) ?? null,
		...(explicitProjectName ? {} : { project_name_derived: true }),
		source_authority: asString(raw["source_authority"]) ?? null,
		owner_kind: asString(raw["owner_kind"]) ?? null,
		owner_actions: Array.isArray(raw["owner_actions"])
			? raw["owner_actions"]
			: null,
		workflow_run:
			raw["workflow_run"] && typeof raw["workflow_run"] === "object"
				? raw["workflow_run"]
				: undefined,
		provenance:
			raw["provenance"] && typeof raw["provenance"] === "object"
				? raw["provenance"]
				: undefined,
		tracker_kind: asString(raw["tracker_kind"]) ?? null,
		issue_id: asString(raw["issue_id"]) ?? null,
		issue_identifier: asString(raw["issue_identifier"]) ?? null,
		issue_state: asString(raw["issue_state"]) ?? null,
		issue_url: asString(raw["issue_url"]) ?? null,
		workflow_run_id: asString(raw["workflow_run_id"]) ?? null,
		workflow_path: asString(raw["workflow_path"]) ?? null,
		workflow_file: asString(raw["workflow_file"]) ?? null,
		workflow_name: asString(raw["workflow_name"]) ?? null,
		team: asString(raw["team"]) ?? null,
		team_template: asString(raw["team_template"]) ?? null,
		team_requested:
			typeof raw["team_requested"] === "boolean" ? raw["team_requested"] : null,
		agent_mode: asString(raw["agent_mode"]) ?? null,
		orchestration_mode: asString(raw["orchestration_mode"]) ?? null,
		status,
		project_dir: projectDir,
		project_name: projectName,
		visible_project_name: visibleProjectName,
		session_id: sessionId,
		stream_file: asString(raw["stream_file"]) ?? null,
		agent_backend: asString(raw["agent_backend"]) ?? null,
		claude_session_id: asString(raw["claude_session_id"]) ?? null,
		cli_name: asString(raw["cli_name"]) ?? null,
		persist_socket: asString(raw["persist_socket"]) ?? null,
		tmux_socket: asString(raw["tmux_socket"]) ?? null,
		tmux_conf: asString(raw["tmux_conf"]) ?? null,
		tmux_session: asString(raw["tmux_session"]),
		tmux_window_id: asString(raw["tmux_window_id"]) ?? null,
		tmux_window_name: asString(raw["tmux_window_name"]) ?? null,
		tmux_pane_id: asString(raw["tmux_pane_id"]) ?? null,
		bundle_path: bundlePath,
		handoff_file: asString(raw["handoff_file"]) ?? null,
		prompt_file: promptFile,
		started_at: asString(raw["started_at"]) ?? new Date().toISOString(),
		start_sha: asString(raw["start_sha"]) ?? null,
		start_commit: asString(raw["start_commit"]) ?? null,
		end_commit: asString(raw["end_commit"]) ?? null,
		attempts: Math.max(0, asNumber(raw["attempts"], 0)),
		max_attempts: Math.max(0, asNumber(raw["max_attempts"], 0)),
		pr_number: asNullableNumber(raw["pr_number"]) ?? null,
		review_status:
			raw["review_status"] === "pending" ||
			raw["review_status"] === "approved" ||
			raw["review_status"] === "changes_requested"
				? raw["review_status"]
				: null,
		role:
			raw["role"] === "developer" ||
			raw["role"] === "planner" ||
			raw["role"] === "reviewer" ||
			raw["role"] === "test"
				? raw["role"]
				: null,
		terminal_backend:
			raw["terminal_backend"] === "tmux" ||
			raw["terminal_backend"] === "persist" ||
			raw["terminal_backend"] === "applescript"
				? raw["terminal_backend"]
				: undefined,
		ghostty_bundle_id: asString(raw["ghostty_bundle_id"]) ?? null,
		release_generation:
			canonicalGenerationToken(raw["app_stamp"]) ??
			canonicalGenerationToken(
				raw["release_generation"] ?? raw["source_version"],
			),
		exec_mode: asString(raw["exec_mode"]) ?? null,
		exec_node: asString(raw["exec_node"]) ?? null,
		exec_host: asString(raw["exec_host"]) ?? null,
		exec_visible:
			typeof raw["exec_visible"] === "boolean" ? raw["exec_visible"] : null,
		exec_cwd: asString(raw["exec_cwd"]) ?? null,
		callback_url: asString(raw["callback_url"]) ?? null,
		session_live:
			typeof raw["session_live"] === "boolean" ? raw["session_live"] : null,
		session_key: asString(raw["session_key"]) ?? null,
		pending_review_path: asString(raw["pending_review_path"]) ?? null,
		pending_fixup_path: asString(raw["pending_fixup_path"]) ?? null,
		artifact_paths: Array.isArray(raw["artifact_paths"])
			? raw["artifact_paths"].filter(
					(value): value is string => typeof value === "string",
				)
			: null,
		review_state: asString(raw["review_state"]) ?? null,
		fixup_state: asString(raw["fixup_state"]) ?? null,
		project_icon: asString(raw["project_icon"]) ?? null,
		exit_code: asNullableNumber(raw["exit_code"]) ?? null,
		error_message: asString(raw["error_message"]) ?? null,
		completed_at: asString(raw["completed_at"]) ?? null,
		updated_at: asString(raw["updated_at"]) ?? null,
		model: asString(raw["model"]) ?? null,
		actual_model: asString(raw["actual_model"]) ?? null,
		thinking_budget: asNullableNumber(raw["thinking_budget"]) ?? null,
		prompt_summary: asString(raw["prompt_summary"]) ?? null,
		turn_count: asNullableNumber(raw["turn_count"]) ?? null,
		codex_input_tokens:
			asNullableNumber(raw["codex_input_tokens"] ?? raw["input_tokens"]) ??
			null,
		codex_output_tokens:
			asNullableNumber(raw["codex_output_tokens"] ?? raw["output_tokens"]) ??
			null,
		codex_total_tokens:
			asNullableNumber(raw["codex_total_tokens"] ?? raw["total_tokens"]) ??
			null,
		runtime_seconds:
			asNullableNumber(raw["runtime_seconds"] ?? raw["seconds_running"]) ??
			null,
		retry_attempt: asNullableNumber(raw["retry_attempt"]) ?? null,
		retry_due_at: asString(raw["retry_due_at"] ?? raw["due_at"]) ?? null,
		retry_error: asString(raw["retry_error"]) ?? null,
		rate_limit_summary: asString(raw["rate_limit_summary"]) ?? null,
		rate_limits: raw["rate_limits"] ?? raw["rateLimits"],
		symphony_runtime_snapshot:
			raw["symphony_runtime_snapshot"] ?? raw["symphonyRuntimeSnapshot"],
		workroom_ref: asString(raw["workroom_ref"]) ?? null,
		work_item_ref: asString(raw["work_item_ref"]) ?? null,
	};
}

export function normalizeRegistryTasks(
	tasks: unknown,
): Record<string, AgentTask> | null {
	if (!tasks || typeof tasks !== "object") {
		return null;
	}

	const normalized: Record<string, AgentTask> = {};
	for (const [key, raw] of Object.entries(tasks)) {
		if (!raw || typeof raw !== "object") continue;
		const task = normalizeTask(key, raw as Record<string, unknown>);
		if (task) normalized[key] = task;
	}

	return normalized;
}

/**
 * Self-describing `kind` of the transitional Work System lanes
 * read-model/projection (`~/.config/openclaw/lanes.json`): `{version: 1,
 * kind: "work-system-lanes-projection", lanes: {<lane_ref.id>:
 * <lane_ref_update>}, updated_at}`, as written by the Ghostty Launcher
 * work-system bridge in outbox mode. Ingesting it is BRIDGE COMPATIBILITY
 * ONLY — the long-term primary source stays the OpenClaw-native Work System
 * plugin/API (`workSystem.lanes.list` + per-session `workSystem`
 * projection), and the projection is never authoritative truth.
 */
export const WORK_SYSTEM_LANES_PROJECTION_KIND = "work-system-lanes-projection";

/**
 * Transform one `lane_ref_update` envelope from the Work System lanes
 * projection into the raw record shape {@link normalizeTask} understands.
 * Returns null for rows that are not lane_ref_update envelopes or carry no
 * task id.
 *
 * Field mapping (per ghostty-launcher `scripts/laneref-update-schema.json`):
 * - `lane_ref.task` → `id` / `task_id`: the launcher task id correlates
 *   stream files and pending-review receipts; the provider-scoped
 *   `lane_ref.id` (`launcher:<task_id>`) is kept as `provenance.source_ref`.
 * - `lane_ref.status` → `status` verbatim — the launcher-native enum matches
 *   {@link AgentTaskStatus}; unknown values normalize to `stopped`.
 * - `lane_ref.lane_kind` / `lane_ref.lane_kind_source` → preserved as-is
 *   (canonical kind plus the verbatim native kind when they differ, e.g.
 *   `review` + `release-proof`).
 * - `lane_ref.session` → `session_id`; a session-less envelope falls back to
 *   `lane_ref.id`, which fails `isValidSessionId` by construction (it
 *   contains `:`), so focus actions refuse loudly instead of acting on a
 *   fabricated session name.
 * - `lane_ref.worktree` → `execution_dir` / `exec_cwd` and the best-effort
 *   `project_dir` (registry-backed rows group by `project_ref.id` anyway).
 * - `lane_ref.updatedAt` → `updated_at` and `started_at` — the only
 *   timestamp the projection carries; for running lanes it is the spawn
 *   emission, for terminal lanes the settle emission. Stable across reads,
 *   unlike the wall-clock default.
 * - `project_ref` → passed through; `project_ref.id` also backfills the
 *   legacy `project_id` (the contract states they are equal for registered
 *   lanes). Envelopes with `project_ref: null` (legacy / resolution-skipped
 *   lanes) stay quarantined by the `lane-records-only` filter.
 */
function laneRefUpdateToTaskRecord(
	envelope: Record<string, unknown>,
): Record<string, unknown> | null {
	if (envelope["kind"] !== "lane_ref_update") return null;
	const laneRefRaw = envelope["lane_ref"];
	if (
		!laneRefRaw ||
		typeof laneRefRaw !== "object" ||
		Array.isArray(laneRefRaw)
	) {
		return null;
	}
	const laneRef = laneRefRaw as Record<string, unknown>;
	const taskId = asString(laneRef["task"]);
	if (!taskId) return null;
	const laneId = asString(laneRef["id"]) ?? `launcher:${taskId}`;
	const projectRefRaw = envelope["project_ref"];
	const projectRef =
		projectRefRaw &&
		typeof projectRefRaw === "object" &&
		!Array.isArray(projectRefRaw)
			? (projectRefRaw as Record<string, unknown>)
			: null;
	const worktree = asString(laneRef["worktree"]);
	const updatedAt = asString(laneRef["updatedAt"]);
	return {
		id: taskId,
		task_id: taskId,
		status: asString(laneRef["status"]),
		project_ref: projectRef,
		project_id: projectRef ? (asString(projectRef["id"]) ?? null) : null,
		lane_kind: asString(laneRef["lane_kind"]),
		lane_kind_source: asString(laneRef["lane_kind_source"]),
		session_id: asString(laneRef["session"]) ?? laneId,
		terminal_backend: asString(laneRef["surface"]),
		execution_dir: worktree,
		exec_cwd: worktree,
		project_dir: worktree,
		started_at: updatedAt,
		updated_at: updatedAt,
		source_authority: asString(laneRef["provider"]),
		workroom_ref: asString(envelope["workroom_ref"]),
		work_item_ref: asString(envelope["work_item_ref"]),
		provenance: {
			source_ref: laneId,
			adapter_kind: WORK_SYSTEM_LANES_PROJECTION_KIND,
		},
	};
}

/**
 * Normalize the `lanes` collection of a `work-system-lanes-projection`
 * document. Every admitted row is marked `lane_projection: true` so the
 * registry merge never lets the read-model displace or duplicate a primary
 * task-registry record (transitional bridge compatibility only).
 */
export function normalizeProjectionLanes(
	lanes: unknown,
): Record<string, AgentTask> | null {
	if (!lanes || typeof lanes !== "object" || Array.isArray(lanes)) return null;

	const normalized: Record<string, AgentTask> = {};
	for (const [laneKey, rawEnvelope] of Object.entries(lanes)) {
		if (
			!rawEnvelope ||
			typeof rawEnvelope !== "object" ||
			Array.isArray(rawEnvelope)
		) {
			continue;
		}
		const record = laneRefUpdateToTaskRecord(
			rawEnvelope as Record<string, unknown>,
		);
		if (!record) continue;
		const task = normalizeTask(laneKey, record);
		if (task) normalized[laneKey] = { ...task, lane_projection: true };
	}

	return normalized;
}

/**
 * Resolve the provider-scoped lane id (`launcher:<task_id>`) a projection row
 * was admitted under. `normalizeProjectionLanes` preserves it as
 * `provenance.source_ref`; the GC receipt may key rows by it or by the bare
 * task id.
 */
function laneIdFromTask(task: AgentTask): string | null {
	const provenance = task.provenance;
	if (
		provenance &&
		typeof provenance === "object" &&
		!Array.isArray(provenance)
	) {
		const ref = (provenance as Record<string, unknown>)["source_ref"];
		if (typeof ref === "string" && ref.length > 0) return ref;
	}
	return null;
}

/**
 * CCSYNC-02: reconcile lane-projection rows against a lane-projection GC
 * receipt. Pure — does not read the filesystem (callers inject the receipt via
 * {@link readLaneProjectionGcReceipt}). For every projection row the GC pass
 * classified as no longer live attention work (`downgraded`/`archived`/
 * `removed`), stamp the row with a `gc_reconcile` marker so the tree provider
 * routes it to reconciliation backlog (Needs Review) instead of the
 * attention/action badge — the receipt is the authoritative reconciliation
 * verdict, complementing the per-render `isStaleReviewProjection` heuristic.
 *
 * Non-projection rows and rows the receipt keeps (or does not cover) pass
 * through untouched: the receipt only ever downgrades a row, never promotes one.
 */
export function applyGcReceiptReconciliation(
	tasks: Record<string, AgentTask>,
	receipt: LaneProjectionGcReceipt | null,
): Record<string, AgentTask> {
	if (!receipt) return tasks;

	const reconciled: Record<string, AgentTask> = {};
	for (const [key, task] of Object.entries(tasks)) {
		if (task.lane_projection !== true) {
			reconciled[key] = task;
			continue;
		}
		const row = lookupGcRowVerdict(receipt, {
			laneId: laneIdFromTask(task),
			taskId: task.id,
		});
		if (!row || !isReconciledGcVerdict(row.verdict)) {
			reconciled[key] = task;
			continue;
		}
		reconciled[key] = {
			...task,
			gc_reconcile: row.verdict,
			gc_reconcile_reason: row.reason,
		};
	}
	return reconciled;
}

export function warnTaskRegistryFallback(
	filePath: string,
	reason: string,
): void {
	console.warn(
		`[Command Central] Falling back to an empty tasks registry for ${filePath}: ${reason}`,
	);
}
