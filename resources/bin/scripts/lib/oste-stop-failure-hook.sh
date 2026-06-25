#!/bin/bash
#
# oste-stop-failure-hook.sh — Claude Code StopFailure observability handler
#
# StopFailure fires when a turn ends due to a Claude API/runtime error
# (rate_limit, overloaded, server_error, ...). Per the Claude Code hook model
# this event is OBSERVABILITY-ONLY: its stdout and exit code are ignored, so it
# can never block a lane. This hook does NOT complete the lane (a StopFailure is
# a FAILED turn, not finished work — it never calls oste-complete.sh); it only
# records a lane-keyed marker /tmp/oste-stop-failure-<task_id>.json that the
# symphony daemon reads to route the lane to a SYSTEM-scoped retryable BLOCKER
# (escalate to main) instead of demoting an infrastructure stall to an
# issue-scoped coder fixup. Fail-open: any error exits 0 and never wedges a lane.
#
# Input (JSON on stdin from Claude Code):
#   hook_event_name, session_id, cwd, error, error_details
#

set -u

# Skip all processing during test runs unless explicitly disabled in tests.
[[ "${OSTE_TEST_MODE:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/hook-trace.sh
source "${SCRIPT_DIR}/lib/hook-trace.sh" 2>/dev/null || true
_trace() { command -v hook_trace_append >/dev/null 2>&1 && hook_trace_append "$@" >/dev/null 2>&1 || true; }

input=$(cat) || exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || cwd=""
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null) || session_id=""
hook_event=$(printf '%s' "$input" | jq -r '.hook_event_name // "StopFailure"' 2>/dev/null) || hook_event="StopFailure"
error=$(printf '%s' "$input" | jq -r '.error // empty' 2>/dev/null) || error=""
error_details=$(printf '%s' "$input" | jq -r '(.error_details // "") | if type=="string" then . else tojson end' 2>/dev/null) || error_details=""

_trace "stop-failure-hook-entry" "$input" "$(jq -cn \
	--arg hook_event "$hook_event" --arg cwd "$cwd" \
	'{hook_event: $hook_event, cwd: $cwd}' 2>/dev/null)"

# Resolve task_id: prefer the explicit env var set by oste-spawn.sh, else the
# cwd→task_id stop-map the other hooks share.
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
	_trace "stop-failure-hook-resolved" "$input" "$(jq -cn \
		--arg resolved_task_id "" --arg resolution_source "none" \
		'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source}' 2>/dev/null)"
	exit 0
}

recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
marker="/tmp/oste-stop-failure-${task_id}.json"

# Observability-only: write the lane-keyed marker. NEVER complete the lane.
jq -cn \
	--arg hook_event_name "$hook_event" \
	--arg task_id "$task_id" \
	--arg session_id "$session_id" \
	--arg cwd "$cwd" \
	--arg error "$error" \
	--arg error_details "$error_details" \
	--arg recorded_at "$recorded_at" \
	'{hook_event_name: $hook_event_name, task_id: $task_id, session_id: $session_id, cwd: $cwd, error: $error, error_details: $error_details, recorded_at: $recorded_at}' \
	>"$marker" 2>/dev/null || true

_trace "stop-failure-hook-resolved" "$input" "$(jq -cn \
	--arg resolved_task_id "$task_id" --arg resolution_source "$resolution_source" --arg marker "$marker" \
	'{resolved_task_id: $resolved_task_id, resolution_source: $resolution_source, marker: $marker}' 2>/dev/null)"

exit 0
