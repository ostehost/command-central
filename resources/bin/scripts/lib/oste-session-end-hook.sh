#!/bin/bash
#
# oste-session-end-hook.sh — Claude Code SessionEnd safety-net handler
#
# Fires oste-complete.sh if the normal completion chain did not run.
# This hook must stay fast: it resolves task_id, checks idempotency marker,
# and backgrounds completion work without waiting.
#
# Input (JSON on stdin from Claude Code):
#   session_id, reason, cwd
#

set -u

# Skip all processing during test runs unless explicitly disabled in tests.
[[ "${OSTE_TEST_MODE:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/hook-trace.sh
source "${SCRIPT_DIR}/lib/hook-trace.sh"
# shellcheck source=lib/task-id.sh
source "${SCRIPT_DIR}/lib/task-id.sh"

input=$(cat) || exit 0
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null) || cwd=""
hook_session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null) || hook_session_id=""
hook_trace_append "session-end-hook-entry" "$input" "$(jq -cn \
	--arg hook_event "SessionEnd" \
	--arg cwd "$cwd" \
	'{hook_event: $hook_event, cwd: $cwd}')"

# Resolve task_id: prefer explicit env var set by oste-spawn.sh.
task_id="${OSTE_TASK_ID:-}"
resolution_source="env"
if [[ -z "$task_id" ]]; then
	if [[ -n "$cwd" ]]; then
		cwd_hash=$(echo -n "$cwd" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || echo -n "$cwd" | md5 -q 2>/dev/null) || exit 0
		task_file="/tmp/oste-stop-map-${cwd_hash}"
		if [[ -f "$task_file" ]]; then
			map_content=$(head -1 "$task_file") || exit 0
			task_id="${map_content%%:*}"
			resolution_source="cwd-map"
		fi
	fi
fi

[[ -n "$task_id" ]] || {
	hook_trace_append "session-end-hook-resolved" "$input" "$(jq -cn \
		--arg resolved_task_id "" \
		--arg resolution_source "none" \
		'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}')"
	exit 0
}
task_id_validate "$task_id" >/dev/null 2>&1 || exit 0

# Snapshot the generation currently registered for this task. Normal spawned
# lanes supply OSTE_TASK_GENERATION directly, but cwd-map recovery can run
# without the lane environment. Binding the background finalizer to this
# snapshot preserves its CAS guarantee: a replacement between this read and
# publication rejects the old SessionEnd attempt. Generationless rows retain
# their legacy empty-generation contract.
effective_tasks_file="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
task_generation="${OSTE_TASK_GENERATION:-}"
if [[ -f "$effective_tasks_file" ]]; then
	task_row=$(jq -ce --arg id "$task_id" '.tasks[$id] // empty' "$effective_tasks_file" 2>/dev/null || true)
	if [[ -n "$task_row" ]]; then
		row_generation=$(printf '%s' "$task_row" | jq -r '.task_generation // ""' 2>/dev/null || true)
		row_claude_session_id=$(printf '%s' "$task_row" | jq -r '.claude_session_id // ""' 2>/dev/null || true)
		# A supplied but different generation identifies a stale hook event. A
		# generated row may fill an omitted value for cwd-map fallback only when
		# Claude's immutable session identity also matches. This prevents a late
		# generationless SessionEnd from attaching itself to a reused task ID. A
		# legacy row and its caller may both remain generationless.
		if [[ -n "$task_generation" && "$task_generation" != "$row_generation" ]]; then
			exit 0
		fi
		if [[ -z "$task_generation" && -n "$row_generation" ]] &&
			[[ -z "$hook_session_id" || "$hook_session_id" != "$row_claude_session_id" ]]; then
			exit 0
		fi
		task_generation="$row_generation"
	fi
fi

hook_trace_append "session-end-hook-resolved" "$input" "$(jq -cn \
	--arg resolved_task_id "$task_id" \
	--arg resolution_source "$resolution_source" \
	'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}')"

# Idempotency guard: stop if completion already fired.
if task_completion_marker_matches_generation "$task_id" "${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"; then
	exit 0
fi

complete_script="${OSTE_COMPLETE_SCRIPT:-${SCRIPT_DIR}/oste-complete.sh}"
[[ -x "$complete_script" ]] || exit 0

# Prefer real exit code when wrapper receipt exists, otherwise fall back to 0.
exit_code="0"
receipt_file="/tmp/oste-receipt-${task_id}"
if [[ -f "$receipt_file" ]]; then
	receipt_exit=$(jq -r '.exit_code // empty' "$receipt_file" 2>/dev/null || true)
	if [[ "$receipt_exit" =~ ^[0-9]+$ ]]; then
		exit_code="$receipt_exit"
	fi
fi

# Keep the generation binding explicit at this process boundary. Hook
# environment values are inherited by child shells, but spelling it out here
# makes the fail-closed contract resilient to future wrappers that construct a
# reduced environment for the background finalizer.
OSTE_TASK_GENERATION="$task_generation" \
	bash "$complete_script" "$task_id" "$exit_code" >/dev/null 2>&1 &
disown $! 2>/dev/null || true

exit 0
