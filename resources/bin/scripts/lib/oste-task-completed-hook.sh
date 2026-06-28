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

hook_trace_append "task-completed-hook-resolved" "$input" "$(jq -cn \
	--arg resolved_task_id "$oste_task_id" \
	--arg resolution_source "$resolution_source" \
	'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}')"

project_dir="$cwd"
if [[ -z "$project_dir" || ! -d "$project_dir" ]] && [[ -n "${TASKS_FILE:-}" && -f "${TASKS_FILE:-}" ]]; then
	project_dir=$(jq -r --arg id "$oste_task_id" '.tasks[$id].project_dir // empty' "$TASKS_FILE" 2>/dev/null || true)
fi

start_sha=""
if [[ -n "${TASKS_FILE:-}" && -f "${TASKS_FILE:-}" ]]; then
	start_sha=$(jq -r --arg id "$oste_task_id" '.tasks[$id].start_commit // .tasks[$id].start_sha // empty' "$TASKS_FILE" 2>/dev/null || true)
fi

# Snapshot canonical review metadata now, before later safety-net commits or
# housekeeping edits can move HEAD away from the task-complete state.
if [[ -n "$project_dir" && -d "$project_dir" ]]; then
	pending_review_capture_completion_snapshot "$oste_task_id" "$project_dir" "$start_sha" 2>/dev/null || true
fi

# Don't double-fire if already completed
if [[ -f "/tmp/oste-complete-${oste_task_id}" ]]; then
	exit 0
fi

# Agent Team lead intermediate-completion guard (symphony team incidents
# 2026-06-15, 2026-06-25). A lead's TaskCompleted hook can fire while teammates
# are still working and while the lead Claude process remains live. Finalizing
# from this hook is unsafe even when the declared handoff file already exists:
# the lead may still be coordinating, reconciling teammate commits, or rewriting
# the final report. Defer all team-lead TaskCompleted events; the real terminal
# completion comes from the lead's process-exit / SessionEnd hook once the
# session actually ends (oste-complete.sh remains the second line of defence for
# non-team and live-session cases).
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
