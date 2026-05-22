#!/bin/bash
#
# agent-backend.sh — Shared utilities for Multi-Model Agent resolution
#
# This library provides centralized logic for identifying which AI CLI backend
# is responsible for a given task or session, and where its stream files live.
#
# Supported: claude, gemini, codex

# List of all supported agent backends in priority order for detection
readonly SUPPORTED_AGENT_BACKENDS=("claude" "gemini" "codex")
readonly _AGENT_BACKEND_DEFAULT_TASKS_DIR="${HOME}/.config/ghostty-launcher"

_agent_backend_tasks_file() {
	echo "${TASKS_FILE:-${_AGENT_BACKEND_DEFAULT_TASKS_DIR}/tasks.json}"
}

# Resolve the stream file path and backend type for a task
# Usage: resolve_agent_stream <task_id>
# Returns (stdout): stream_file|backend
resolve_agent_stream() {
	local task_id="$1"
	[[ -n "$task_id" ]] || return 1

	local stream_file=""
	local backend=""
	local tasks_file=""

	tasks_file=$(_agent_backend_tasks_file)

	# Priority 1: Check filesystem for known stream prefixes
	for b in "${SUPPORTED_AGENT_BACKENDS[@]}"; do
		local candidate="/tmp/${b}-stream-${task_id}.jsonl"
		if [[ -f "$candidate" ]]; then
			stream_file="$candidate"
			backend="$b"
			break
		fi
	done

	# Priority 2: Fallback to tasks.json if file is missing (e.g. task just started)
	if [[ -z "$backend" ]] && [[ -f "$tasks_file" ]]; then
		backend=$(jq -r --arg id "$task_id" '.tasks[$id].agent_backend // empty' "$tasks_file" 2>/dev/null || echo "")
		if [[ -n "$backend" && "$backend" != "null" ]]; then
			stream_file=$(jq -r --arg id "$task_id" '.tasks[$id].stream_file // empty' "$tasks_file" 2>/dev/null || echo "")
			if [[ -z "$stream_file" || "$stream_file" == "null" ]]; then
				stream_file="/tmp/${backend}-stream-${task_id}.jsonl"
			fi
		fi
	fi

	if [[ -n "$backend" ]]; then
		echo "${stream_file}|${backend}"
		return 0
	fi

	return 1
}

# Resolve the backend for a session when task_id is unknown
# Usage: resolve_agent_backend <session_name> [task_id]
resolve_agent_backend() {
	local session="$1"
	local task_id="${2:-}"
	local backend=""
	local tasks_file=""

	tasks_file=$(_agent_backend_tasks_file)

	# Layer 1: Exact task_id resolution from TASKS_FILE
	if [[ -n "$task_id" ]] && [[ -f "$tasks_file" ]]; then
		backend=$(jq -r --arg id "$task_id" '.tasks[$id].agent_backend // empty' "$tasks_file" 2>/dev/null || echo "")
		if [[ -n "$backend" && "$backend" != "null" && "$backend" != "empty" ]]; then
			echo "$backend"
			return 0
		fi
	fi

	# Layer 2: Task-specific stream/task fallback
	if [[ -n "$task_id" ]]; then
		local stream_info
		if stream_info=$(resolve_agent_stream "$task_id"); then
			echo "${stream_info#*|}"
			return 0
		fi
	fi

	# Layer 3: Registry lookup via session name
	if [[ -f "$tasks_file" ]]; then
		# Find the most recent task for this session
		backend=$(jq -r --arg sess "$session" '[.tasks[] | select(.session_id == $sess)] | sort_by(.started_at) | last | .agent_backend // empty' "$tasks_file" 2>/dev/null || echo "")
		if [[ -n "$backend" && "$backend" != "null" && "$backend" != "empty" ]]; then
			echo "$backend"
			return 0
		fi
	fi

	# Layer 4: Heuristics / Defaults — warn so silent misrouting is debuggable
	echo "[agent-backend] WARNING: no backend resolved for session '${session}', defaulting to claude" >&2
	echo "claude"
}
