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

input=$(cat) || exit 0
cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null) || cwd=""
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

hook_trace_append "session-end-hook-resolved" "$input" "$(jq -cn \
	--arg resolved_task_id "$task_id" \
	--arg resolution_source "$resolution_source" \
	'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}')"

# Idempotency guard: stop if completion already fired.
if [[ -f "/tmp/oste-complete-${task_id}" ]]; then
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

bash "$complete_script" "$task_id" "$exit_code" >/dev/null 2>&1 &
disown $! 2>/dev/null || true

exit 0
