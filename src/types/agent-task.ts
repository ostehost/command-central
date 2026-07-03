/**
 * Foundational task-registry domain types for the Agent Status views.
 *
 * Leaf data types describing an agent lane record (`AgentTask`) and the
 * registry that holds them. They carry NO dependency on VS Code or the tree
 * provider, so every layer can import them without pulling in provider state.
 * The provider re-exports them for backward compatibility with existing import
 * sites.
 */

import type { ReconciledGcVerdict } from "../utils/review-queue-health.js";

export interface TaskRegistry {
	version: number;
	tasks: Record<string, AgentTask>;
}

export function createEmptyTaskRegistry(): TaskRegistry {
	return { version: 2, tasks: {} };
}

export type AgentTaskStatus =
	| "running"
	// Intentionally parked by an operator (or a cooperating agent), awaiting
	// relaunch. NON-TERMINAL: the process may still be alive or may later die,
	// but the lane is never auto-flipped to another status — its only exits are
	// kill (→ killed) or an explicit same-id relaunch (→ running). Buckets to
	// Needs Review (limbo). See research/DESIGN-paused-lane-lifecycle-v2.
	| "paused"
	| "stopped"
	| "killed"
	| "completed"
	| "completed_dirty"
	| "completed_stale"
	| "failed"
	| "contract_failure";

export type AgentRole = "developer" | "planner" | "reviewer" | "test";
export type AgentStatusSortMode = "status-recency";

/**
 * OpenClaw/Symphony-native visible-lane attention verdict, projected verbatim
 * from the daemon's durable receipt vocabulary (`visible_lane.awaiting_input` /
 * `visible_lane.attention`). Command Central PROJECTS this — it never authors it
 * and it never changes lane lifecycle state (the row keeps its `status`).
 *
 *  - "awaiting_input" — the daemon confirmed the visible lane is BLOCKED at a
 *    permission/input prompt a human must answer. Authoritative: CC renders
 *    "(awaiting input)" from this alone, without reading the pane itself.
 *  - "attention"      — the lane needs a look but is NOT a confirmed input wait
 *    (degraded on-screen visibility, stale AX/tmux capture, etc.). Renders as
 *    visibility-degraded / needs-attention, NEVER as an input wait by itself.
 */
export type VisibleLaneAttention = "awaiting_input" | "attention";

/**
 * Embedded Work Registry resolution stamped on a lane record at spawn time.
 * Presence of a non-empty `id` is what marks a record as registry-backed —
 * the discriminator between active LaneRef records and stale launcher-era
 * rows (see {@link isRegistryBackedLaneTask}).
 */
export interface AgentTaskProjectRef {
	id: string;
	displayName?: string | null;
	status?: string | null;
	registry_status?: string | null;
	repoOrigins?: string[] | null;
}

export interface AgentTask {
	task_id?: string | null;
	id: string;
	flow_id?: string | null;
	project_id?: string | null;
	project_ref?: AgentTaskProjectRef | null;
	lane_kind?: string | null;
	/**
	 * Launcher-native lane kind retained verbatim when it differs from the
	 * canonical `lane_kind` (e.g. `lane_kind: "review"` with
	 * `lane_kind_source: "release-proof"`); null when the native kind is
	 * already canonical or unset. Emitted by Work System `lane_ref_update`
	 * envelopes and tolerated on plain task-registry rows.
	 */
	lane_kind_source?: string | null;
	canonical_project_dir?: string | null;
	execution_dir?: string | null;
	/**
	 * Internal normalization marker: `project_name` was derived from the
	 * project_dir basename because the record carried no explicit name.
	 * Derived names may label an individual lane but must never define a
	 * top-level project group.
	 */
	project_name_derived?: boolean;
	/**
	 * Internal normalization marker: this row was transformed from a
	 * `work-system-lanes-projection` `lane_ref_update` envelope. The
	 * projection is a TRANSITIONAL bridge read-model, never authoritative
	 * truth — a primary task-registry record with the same task id always
	 * wins the merge over a projection row (see `readRegistry`).
	 */
	lane_projection?: boolean;
	/**
	 * CCSYNC-02 reconciliation marker: a lane-projection GC pass
	 * (`scripts/oste-lanes-gc.sh`) classified this row as no longer live
	 * attention work. `downgraded` means receipt-missing + no live evidence
	 * (reconcile-needed limbo); `archived`/`removed` mean the GC pass took the
	 * row out of the live read-model. Stamped by
	 * {@link applyGcReceiptReconciliation} from the GC receipt; absent when no
	 * authoritative GC pass covered the row (the row stays authoritative).
	 */
	gc_reconcile?: ReconciledGcVerdict;
	/** Verbatim GC verdict reason from the receipt (audit detail). */
	gc_reconcile_reason?: string | null;
	/**
	 * Launcher-projected attach affordance, mapped from a `lane_ref_update`
	 * `attach` object (ghostty-launcher `scripts/laneref-update-schema.json`):
	 * the writer-host `tmux has-session` probe result at emission time.
	 * `false` means the executor could not attach (no session recorded /
	 * session not found); `null` (or absent) when the backend was not probed.
	 * The schema is explicit that consumers gate attach affordances on this,
	 * never on a session id merely existing — so a `running` row reporting
	 * `false` here has no live terminal to imply ongoing work in.
	 */
	launcher_attach_available?: boolean | null;
	/** `attach.reason_if_unavailable` verbatim (e.g. `no-session-recorded`,
	 *  `tmux-session-not-found`, `unprobed-backend:<backend>`). */
	launcher_attach_reason?: string | null;
	/**
	 * Launcher-projected visibility verification, mapped from a
	 * `lane_ref_update` `visibility` object: `degraded === true` means a
	 * visible-bundle lane could not confirm an on-screen, focusable window
	 * (e.g. AX/assistive-access denied); `null` (or absent) when the lane made
	 * no visibility claim (tmux/headless lanes).
	 */
	launcher_visibility_degraded?: boolean | null;
	/** `visibility.reason` verbatim (e.g. `ax_error_…`,
	 *  `tmux_no_attached_clients`); null when no claim was made. */
	launcher_visibility_reason?: string | null;
	/**
	 * OpenClaw/Symphony-native visible-lane attention verdict, projected from the
	 * daemon's durable receipt (`visible_lane.awaiting_input` /
	 * `visible_lane.attention`). When present it is the authoritative basis for
	 * the row's attention badge: `awaiting_input` renders "(awaiting input)" even
	 * when CC cannot read the pane locally; `attention` renders as
	 * visibility-degraded / needs-attention and NEVER as an input wait by itself
	 * (that is what `launcher_visibility_degraded` also feeds). A PROJECTION only —
	 * CC never writes it and it never changes lane lifecycle `status`. Absent/null
	 * when the daemon made no visible-lane attention claim (the pane heuristic
	 * remains the local fallback). See {@link VisibleLaneAttention}.
	 */
	visible_lane_attention?: VisibleLaneAttention | null;
	/** Verbatim native detail for the attention claim (audit + tooltip); null
	 *  when the receipt carried no reason. */
	visible_lane_attention_reason?: string | null;
	/** Work System workroom binding. Persisted in the task row at spawn from
	 *  OSTE_WORKROOM_REF and row-backed at env-less emission points (hook/reaper). */
	workroom_ref?: string | null;
	/** Work System work-item binding. Persisted in the task row at spawn from
	 *  OSTE_WORK_ITEM_REF and row-backed at env-less emission points (hook/reaper). */
	work_item_ref?: string | null;
	source_authority?: string | null;
	owner_kind?: string | null;
	owner_actions?: unknown[] | null;
	workflow_run?: unknown;
	provenance?: unknown;
	tracker_kind?: string | null;
	issue_id?: string | null;
	issue_identifier?: string | null;
	issue_state?: string | null;
	issue_url?: string | null;
	workflow_run_id?: string | null;
	workflow_path?: string | null;
	workflow_file?: string | null;
	workflow_name?: string | null;
	team?: string | null;
	team_template?: string | null;
	/**
	 * Launcher flag: this lane was spawned as an Agent Teams lead (the launcher
	 * passed `--team`). The teammates run as subagents of the lead's Claude
	 * session (`--parent-session-id`), NOT as independent launcher tasks, so the
	 * team never appears as sibling rows — only the lead carries this marker.
	 * Used to badge the lead row as an Agent Team so an operator can tell a
	 * solo lane from a fan-out lead at a glance.
	 */
	team_requested?: boolean | null;
	agent_mode?: string | null;
	orchestration_mode?: string | null;
	status: AgentTaskStatus;
	project_dir: string;
	project_name: string;
	visible_project_name?: string | null;
	session_id: string;
	stream_file?: string | null;
	agent_backend?: string | null;
	claude_session_id?: string | null;
	cli_name?: string | null;
	persist_socket?: string | null;
	tmux_socket?: string | null;
	tmux_conf?: string | null;
	tmux_session?: string;
	tmux_window_id?: string | null;
	tmux_window_name?: string | null;
	tmux_pane_id?: string | null;
	bundle_path: string;
	handoff_file?: string | null;
	prompt_file: string;
	started_at: string;
	start_sha?: string | null;
	start_commit?: string | null;
	end_commit?: string | null;
	attempts: number;
	max_attempts: number;
	pr_number?: number | null;
	review_status?: "pending" | "approved" | "changes_requested" | null;
	role?: AgentRole | null;
	terminal_backend?: "tmux" | "persist" | "applescript";
	ghostty_bundle_id?: string | null;
	exec_mode?: string | null;
	exec_node?: string | null;
	exec_host?: string | null;
	exec_visible?: boolean | null;
	/**
	 * Launcher-recorded liveness of the lane's terminal session at the moment
	 * the launcher last wrote this record (it writes `tmux has-session` / window
	 * presence here). The signal that matters most: a TERMINAL-status row
	 * (`contract_failure`, `failed`, …) that still carries `session_live: true`
	 * is the launcher contradicting itself — it finalized the lane while its
	 * session was provably alive (premature/ races-the-handoff finalization).
	 * CC consumes this as a CHEAP, host-agnostic corroboration of a lifecycle
	 * conflict when no live tmux probe verdict is available (remote-node lanes,
	 * cold hot-path cache). A real-time probe ("alive"/"dead") always wins over
	 * this recorded belief — see {@link classifyLifecycleConflict}.
	 */
	session_live?: boolean | null;
	/**
	 * Release-hygiene marker: the canonical token identifying the GHOSTTY TERMINAL
	 * APP / window generation this lane was created in. Normalized by
	 * {@link canonicalGenerationToken} from, in order of preference, the
	 * launcher's real per-lane `app_stamp` OBJECT (launcher_version / git_sha /
	 * rc_version / template_generation — see
	 * `ghostty-launcher/scripts/oste-terminal-generation.sh`), or the simpler
	 * `release_generation` / `source_version` string forms. The unit recreated on
	 * release is the actual Ghostty `.app`/window/bundle — NOT the tmux pane — so
	 * a lane's tmux pane can be alive while its host Ghostty app belongs to a
	 * prior release. When the CURRENT generation is known (the launcher's
	 * `release-generation.json` baseline) and a lane carries a DIFFERENT token,
	 * its Ghostty app/window is a pre-reset leftover: the pane inside it may still
	 * be a live orphan, but it is NOT current work. CC uses this to keep stale
	 * app/windows from being mistaken for current running agents (it never kills
	 * them — see {@link isSupersededByReleaseReset}). The lane's per-app identity
	 * is `ghostty_bundle_id`/`bundle_path`; this token is the cross-lane
	 * generation they share. Absent on either side → not judged.
	 */
	release_generation?: string | null;
	exec_cwd?: string | null;
	callback_url?: string | null;
	session_key?: string | null;
	pending_review_path?: string | null;
	pending_fixup_path?: string | null;
	artifact_paths?: string[] | null;
	review_state?: string | null;
	fixup_state?: string | null;
	project_icon?: string | null;
	exit_code?: number | null;
	error_message?: string | null;
	completed_at?: string | null;
	updated_at?: string | null;
	model?: string | null;
	actual_model?: string | null;
	thinking_budget?: number | null;
	prompt_summary?: string | null;
	turn_count?: number | null;
	codex_input_tokens?: number | null;
	codex_output_tokens?: number | null;
	codex_total_tokens?: number | null;
	runtime_seconds?: number | null;
	retry_attempt?: number | null;
	retry_due_at?: string | null;
	retry_error?: string | null;
	rate_limit_summary?: string | null;
	rate_limits?: unknown;
	symphony_runtime_snapshot?: unknown;
}
