#!/bin/bash
#
# oste-task-completed-hook.sh — Claude Code TaskCompleted hook handler
#
# Called by Claude Code when a task is marked complete via TaskUpdate.
# This is a compatibility/safety-net trigger, not the primary lifecycle path.
# The native launcher path is: agent process exits -> wrapper writes receipt ->
# oste-complete.sh updates tasks.json, writes pending-review, notifies, and wakes
# the orchestrator. Do not prompt agents to call TaskUpdate solely to trigger
# completion.
#
# Works in both single-agent and Agent Teams sessions when Claude emits the hook.
#
# Input (JSON on stdin from Claude Code):
#   task_id        (internal task ID, may differ from oste task_id)
#   task_subject   (subject string set by agent on TaskCreate)
#   task_description, cwd
#   teammate_name, team_name  (Agent Teams only, may be absent)
#
# Output:
#   Exit 0 = allow task completion
#   Exit 2 = reject completion and send feedback (stdout → feedback message)
#
# Decision control:
#   This is a quality gate — exit 2 blocks task completion and sends
#   stdout back to the agent as feedback.
#
set -euo pipefail

# Skip all processing during test runs — prevents workspace JSONL pollution
# and unnecessary notify calls from test-exercised completion paths.
[[ "${OSTE_TEST_MODE:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/pending-review.sh
source "${SCRIPT_DIR}/lib/pending-review.sh"
# shellcheck source=lib/hook-trace.sh
source "${SCRIPT_DIR}/lib/hook-trace.sh"
# shellcheck source=lib/permission-broker.sh
source "${SCRIPT_DIR}/lib/permission-broker.sh"
# shellcheck source=lib/task-id.sh
source "${SCRIPT_DIR}/lib/task-id.sh"
# shellcheck source=lib/task-owner-identity.sh
source "${SCRIPT_DIR}/lib/task-owner-identity.sh"

task_completed_owner_lock_held=false
release_task_completed_owner_lock() {
	if [[ "$task_completed_owner_lock_held" == "true" ]]; then
		task_owner_transition_lock_release >/dev/null 2>&1 || true
		task_completed_owner_lock_held=false
	fi
}
trap release_task_completed_owner_lock EXIT

publish_generation_bound_completion_snapshot() {
	local task_id_arg="$1"
	local project_dir_arg="$2"
	local start_sha_arg="$3"
	local task_generation_arg="$4"
	local snapshot_file snapshot_stage current_row current_generation current_status

	snapshot_file=$(pending_review_snapshot_file "$task_id_arg")
	snapshot_stage="${snapshot_file}.candidate.${BASHPID:-$$}.${RANDOM:-0}"
	rm -f "$snapshot_stage"
	# Git inspection can be slow and must not hold the global owner lease. Build a
	# private candidate first; only the final generation CAS + rename is locked.
	if ! pending_review_capture_completion_snapshot "$task_id_arg" "$project_dir_arg" "$start_sha_arg" \
		"$task_generation_arg" "$snapshot_stage" 2>/dev/null; then
		rm -f "$snapshot_stage"
		return 1
	fi

	if [[ -n "${OSTE_TEST_TASK_COMPLETED_SNAPSHOT_PAUSE:-}" ]]; then
		: >"${OSTE_TEST_TASK_COMPLETED_SNAPSHOT_PAUSE}.ready"
		while [[ ! -e "${OSTE_TEST_TASK_COMPLETED_SNAPSHOT_PAUSE}.release" ]]; do sleep 0.02; done
	fi

	task_owner_transition_lock_acquire "$task_id_arg" || {
		rm -f "$snapshot_stage"
		return 1
	}
	task_completed_owner_lock_held=true
	current_row=$(jq -ce --arg id "$task_id_arg" '.tasks[$id] // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ -n "$current_row" ]]; then
		current_generation=$(printf '%s' "$current_row" | jq -r '.task_generation // ""' 2>/dev/null || echo "__missing__")
	else
		current_generation="__missing__"
	fi
	current_status=$(printf '%s' "$current_row" | jq -r '.status // ""' 2>/dev/null || true)
	if [[ "$current_generation" != "$task_generation_arg" || "$current_status" != "running" ]]; then
		rm -f "$snapshot_stage"
		release_task_completed_owner_lock
		return 2
	fi
	if ! mv "$snapshot_stage" "$snapshot_file"; then
		rm -f "$snapshot_stage"
		release_task_completed_owner_lock
		return 1
	fi
	release_task_completed_owner_lock
	return 0
}

input=$(cat)

# Resolve oste task_id — prefer OSTE_TASK_ID env var (set by oste-spawn.sh)
oste_task_id="${OSTE_TASK_ID:-}"
resolution_source="env"
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
hook_trace_append "task-completed-hook-entry" "$input" "$(jq -cn \
	--arg hook_event "TaskCompleted" \
	--arg cwd "$cwd" \
	'{hook_event: $hook_event, cwd: $cwd}')"

if [[ -z "$oste_task_id" && -n "$cwd" ]]; then
	# Fallback: CWD-based marker file
	cwd_hash=$(echo -n "$cwd" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || echo -n "$cwd" | md5 -q 2>/dev/null)
	task_file="/tmp/oste-stop-map-${cwd_hash}"
	if [[ -f "$task_file" ]]; then
		# Read first line and parse task_id:role:session format
		map_content=$(head -1 "$task_file")
		oste_task_id="${map_content%%:*}"
		resolution_source="cwd-map"
	fi
fi

if [[ -z "$oste_task_id" ]]; then
	# No oste task to complete — allow the task
	hook_trace_append "task-completed-hook-resolved" "$input" "$(jq -cn \
		--arg resolved_task_id "" \
		--arg resolution_source "none" \
		'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}')"
	exit 0
fi
task_id_validate "$oste_task_id" >/dev/null 2>&1 || exit 0
effective_tasks_file="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
TASKS_FILE="$effective_tasks_file"
[[ -f "$TASKS_FILE" ]] || exit 0
task_owner_transition_lock_acquire "$oste_task_id" || exit 0
task_completed_owner_lock_held=true
task_row=$(jq -ce --arg id "$oste_task_id" '.tasks[$id] // empty' "$TASKS_FILE" 2>/dev/null) || exit 0
row_generation=$(printf '%s' "$task_row" | jq -r '.task_generation // ""' 2>/dev/null || true)
[[ "$row_generation" == "${OSTE_TASK_GENERATION:-}" ]] || exit 0
[[ "$(printf '%s' "$task_row" | jq -r '.status // ""' 2>/dev/null || true)" == "running" ]] || exit 0
release_task_completed_owner_lock

hook_trace_append "task-completed-hook-resolved" "$input" "$(jq -cn \
	--arg resolved_task_id "$oste_task_id" \
	--arg resolution_source "$resolution_source" \
	'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}')"

project_dir="$cwd"
if [[ -z "$project_dir" || ! -d "$project_dir" ]]; then
	project_dir=$(printf '%s' "$task_row" | jq -r '.project_dir // empty' 2>/dev/null || true)
fi

start_sha=$(printf '%s' "$task_row" | jq -r '.start_commit // .start_sha // empty' 2>/dev/null || true)

# Snapshot canonical review metadata now, before later safety-net commits or
# housekeeping edits can move HEAD away from the task-complete state.
if [[ -n "$project_dir" && -d "$project_dir" ]]; then
	snapshot_rc=0
	publish_generation_bound_completion_snapshot "$oste_task_id" "$project_dir" "$start_sha" "$row_generation" || snapshot_rc=$?
	# A replacement that won while Git metadata was computed makes this entire
	# hook event stale, not merely its snapshot. Never continue into completion.
	[[ "$snapshot_rc" != "2" ]] || exit 0
fi

# Don't double-fire if already completed
if task_completion_marker_matches_generation "$oste_task_id" "${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"; then
	exit 0
fi

# Agent Team lead intermediate-completion guard (symphony team incidents
# 2026-06-15, 2026-06-25). A lead's TaskCompleted hook can fire while teammates
# are still working and while the lead Claude process remains live. Finalizing
# from this hook is unsafe even when the declared handoff file already exists:
# the lead may still be coordinating, reconciling teammate commits, or rewriting
# the final report. Defer all team-lead TaskCompleted events; normal visible-lane
# completion comes from the satisfied Stop-hook artifact contract, with
# process-exit / SessionEnd reserved for sessions that actually terminate
# (oste-complete.sh remains the second line of defence for non-team and
# live-session cases).
if [[ -n "${TASKS_FILE:-}" && -f "${TASKS_FILE:-}" ]]; then
	team_requested=$(jq -r --arg id "$oste_task_id" '.tasks[$id].team_requested // false' "$TASKS_FILE" 2>/dev/null || echo "false")
	handoff_decl=$(jq -r --arg id "$oste_task_id" '.tasks[$id].handoff_file // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ "$team_requested" == "true" ]]; then
		hook_trace_append "task-completed-hook-deferred-team-lead" "$input" "$(jq -cn \
			--arg task_id "$oste_task_id" --arg handoff "$handoff_decl" \
			'{task_id: $task_id, handoff_file: $handoff, reason: "team_lead_task_completed_is_intermediate"}')"
		exit 0
	fi
fi

# Permission-pending lifecycle gate (PAR-85 regression guard).
# Blocks completion while a permission prompt is awaiting resolution.
if permission_broker_pending "$oste_task_id"; then
	hook_trace_append "task-completed-hook-deferred-permission-pending" "$input" "$(jq -cn \
		--arg task_id "$oste_task_id" '{task_id: $task_id, reason: "permission_prompt_pending"}')"
	printf 'A permission prompt is still pending for this task; resolve it before completing.\n'
	exit 2
fi

complete_script="${OSTE_COMPLETE_SCRIPT:-${SCRIPT_DIR}/oste-complete.sh}"
review_script="${SCRIPT_DIR}/oste-review-agent.sh"
review_marker="/tmp/oste-review-fired-${oste_task_id}"

# When OSTE_REVIEW_ENABLED=1, chain oste-complete.sh → oste-review-agent.sh in
# a single background subshell so the reviewer reads the pending-review JSON
# only after oste-complete.sh has written it. The chain is gated on the
# review script being executable, an idempotency marker not yet existing, and
# a non-empty cwd to pass to the reviewer. If any precondition fails the
# original (review-disabled) behavior is preserved.
if [[ -x "$complete_script" ]]; then
	if [[ "${OSTE_REVIEW_ENABLED:-0}" == "1" ]] &&
		[[ -x "$review_script" ]] &&
		[[ ! -f "$review_marker" ]] &&
		[[ -n "$cwd" ]]; then
		(
			OSTE_COMPLETION_TRIGGER=task-completed-hook bash "$complete_script" "$oste_task_id" "0"
			touch "$review_marker"
			bash "$review_script" "$cwd" --source-task-id "$oste_task_id" \
				>>"/tmp/oste-review-${oste_task_id}.log" 2>&1
		) &
		disown $! 2>/dev/null || true
	else
		OSTE_COMPLETION_TRIGGER=task-completed-hook bash "$complete_script" "$oste_task_id" "0" &
		disown $! 2>/dev/null || true
	fi
fi

# Allow the task to complete (exit 0)
exit 0
