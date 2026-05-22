#!/bin/bash
# shellcheck shell=bash
# hook-trace.sh — best-effort JSONL tracing for launcher hooks/completion

hook_trace_file_path() {
	echo "${OSTE_HOOK_TRACE_FILE:-${HOME}/.openclaw/logs/hook-trace.jsonl}"
}

hook_trace_append() {
	local event="${1:-}"
	local payload="${2:-}"
	local extra_json="${3:-}"
	[[ -n "$extra_json" ]] || extra_json='{}'
	[[ -n "$event" ]] || return 0
	command -v jq >/dev/null 2>&1 || return 0

	local trace_file trace_dir timestamp host_name pwd_value
	trace_file=$(hook_trace_file_path)
	trace_dir=$(dirname "$trace_file")
	mkdir -p "$trace_dir" 2>/dev/null || return 0
	timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	host_name=$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo "unknown")
	pwd_value=$(pwd 2>/dev/null || echo "")

	jq -cn \
		--arg timestamp "$timestamp" \
		--arg event "$event" \
		--arg pid "$$" \
		--arg ppid "${PPID:-}" \
		--arg host "$host_name" \
		--arg lane_type "${OSTE_LANE_TYPE:-unknown}" \
		--arg oste_task_id "${OSTE_TASK_ID:-}" \
		--arg oste_session_id "${OSTE_SESSION_ID:-}" \
		--arg cwd "$pwd_value" \
		--arg payload "$payload" \
		--argjson extra "$extra_json" \
		'($extra // {}) + {
			timestamp: $timestamp,
			event: $event,
			pid: ($pid | tonumber?),
			ppid: ($ppid | tonumber?),
			host: $host,
			lane_type: $lane_type,
			oste_task_id: $oste_task_id,
			oste_session_id: $oste_session_id,
			process_cwd: $cwd,
			payload: $payload
		}' >>"$trace_file" 2>/dev/null || true
}
