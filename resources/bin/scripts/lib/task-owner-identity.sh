#!/bin/bash
# shellcheck shell=bash
#
# task-owner-identity.sh — Canonical identity for a task's live terminal owner.
#
# Permission decisions validate a tasks.json row before claiming a prompt, while
# oste-steer resolves the terminal target immediately before sending the bounded
# key. Both sides hash exactly the same routing and process-generation fields so
# a reused task ID, resumed Claude session, or replaced tmux pane fails closed.

: "${OSTE_TASK_OWNER_LOCK_WAIT:=15}"
: "${OSTE_TASK_OWNER_LOCK_STALE:=30}"

task_owner_identity_json() {
	local task_row="${1:-}"
	[[ -n "$task_row" ]] || task_row='{}'
	printf '%s' "$task_row" | jq -cS '
		{
			id: (.id // null),
			task_id: (.task_id // null),
			task_generation: (.task_generation // null),
			started_at: (.started_at // null),
			status: (.status // null),
			workroom_ref: (.workroom_ref // null),
			session_key: (.session_key // null),
			claude_session_id: (.claude_session_id // null),
			session_id: (.session_id // null),
			tmux_pane_id: (.tmux_pane_id // null),
			tmux_window_id: (.tmux_window_id // null),
			tmux_socket: (.tmux_socket // null),
			tmux_conf: (.tmux_conf // null),
			terminal_backend: (.terminal_backend // null)
		}
	' 2>/dev/null
}

task_owner_identity_hash() {
	local canonical
	canonical=$(task_owner_identity_json "${1:-}") || return 1
	printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}'
}

# Owner transitions are intentionally serialized through one registry lock,
# rather than a PID-only per-task lock. register_task can retire a different
# task row when a pane/session is reused, so a per-ID lock would not cover the
# complete mutation set. The registry lease is held only across owner metadata
# reads/writes or bounded raw input delivery; tasks.json and network waits stay
# outside it.
_task_owner_lock_process_start() {
	local pid="$1"
	LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null |
		sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

_task_owner_lock_capture_pid() {
	local parent="$1" probe
	if [[ -n "${BASHPID:-}" ]]; then
		_TASK_OWNER_LOCK_CALLER_PID="$BASHPID"
	else
		probe=$(mktemp "${parent}/.owner-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _TASK_OWNER_LOCK_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_TASK_OWNER_LOCK_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_task_owner_lock_path() {
	printf '%s.owner-transition.lock' "${TASKS_FILE:?TASKS_FILE is required}"
}

_task_owner_lock_age() {
	local path="$1" mtime now
	mtime=$(stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null || echo 0)
	now=$(date +%s 2>/dev/null || echo 0)
	printf '%s' "$((now - mtime))"
}

_task_owner_lock_is_stale() {
	local path="$1" pid start current age
	[[ -d "$path" ]] || return 1
	pid=$(awk -F= '$1 == "pid" {print substr($0, index($0, "=") + 1); exit}' "$path/owner" 2>/dev/null || true)
	start=$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "$path/owner" 2>/dev/null || true)
	if [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]]; then
		current=$(_task_owner_lock_process_start "$pid")
		[[ -z "$current" || "$current" != "$start" ]]
		return
	fi
	age=$(_task_owner_lock_age "$path")
	[[ "$age" -ge "$OSTE_TASK_OWNER_LOCK_STALE" ]]
}

_task_owner_lock_reap() {
	local path="$1" reap="${1}.reap"
	_task_owner_lock_is_stale "$path" || return 0
	if ! mkdir "$reap" 2>/dev/null; then
		[[ "$(_task_owner_lock_age "$reap")" -ge 5 ]] && rm -rf "$reap"
		return 0
	fi
	_task_owner_lock_is_stale "$path" && rm -rf "$path"
	rm -rf "$reap"
}

task_owner_transition_lock_acquire() {
	local task_id="$1" path parent pid start token tmp waited=0
	path=$(_task_owner_lock_path)
	parent=$(dirname "$path")
	(umask 077 && mkdir -p "$parent") 2>/dev/null || return 1
	_task_owner_lock_capture_pid "$parent" || return 1
	pid="$_TASK_OWNER_LOCK_CALLER_PID"
	while true; do
		if (umask 077 && mkdir "$path") 2>/dev/null; then
			start=$(_task_owner_lock_process_start "$pid")
			token="${pid}-$(date +%s)-${RANDOM:-0}-${RANDOM:-0}"
			[[ -n "$start" ]] || {
				rm -rf "$path"
				return 1
			}
			tmp="${path}/owner.tmp.${pid}"
			if ! {
				printf 'pid=%s\nprocess_start=%s\ntoken=%s\ntask_id=%s\n' "$pid" "$start" "$token" "$task_id" >"$tmp" &&
					mv "$tmp" "$path/owner"
			}; then
				rm -rf "$path"
				return 1
			fi
			_TASK_OWNER_LOCK_PATH="$path"
			_TASK_OWNER_LOCK_PID="$pid"
			_TASK_OWNER_LOCK_START="$start"
			_TASK_OWNER_LOCK_TOKEN="$token"
			_TASK_OWNER_LOCK_TASK_ID="$task_id"
			_TASK_OWNER_LOCK_BORROWED=0
			_TASK_OWNER_LOCK_DEPTH=1
			return 0
		fi
		_task_owner_lock_reap "$path"
		sleep 0.1
		waited=$((waited + 1))
		[[ "$waited" -lt $((OSTE_TASK_OWNER_LOCK_WAIT * 10)) ]] || return 1
	done
}

task_owner_transition_lock_assert_lease() {
	local task_id="$1" path pid start token owner_task
	path="${OSTE_TASK_OWNER_LOCK_PATH:-}"
	pid="${OSTE_TASK_OWNER_LOCK_PID:-}"
	start="${OSTE_TASK_OWNER_LOCK_START:-}"
	token="${OSTE_TASK_OWNER_LOCK_TOKEN:-}"
	[[ -n "$path" && "$path" == "$(_task_owner_lock_path)" && -f "$path/owner" ]] || return 1
	[[ "$pid" =~ ^[0-9]+$ && -n "$start" && -n "$token" ]] || return 1
	[[ "$(_task_owner_lock_process_start "$pid")" == "$start" ]] || return 1
	[[ "$(awk -F= '$1 == "pid" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$pid" ]] || return 1
	[[ "$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$start" ]] || return 1
	[[ "$(awk -F= '$1 == "token" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$token" ]] || return 1
	owner_task=$(awk -F= '$1 == "task_id" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")
	[[ "$owner_task" == "$task_id" ]]
}

_task_owner_lock_clear_local() {
	_TASK_OWNER_LOCK_PATH=""
	_TASK_OWNER_LOCK_PID=""
	_TASK_OWNER_LOCK_START=""
	_TASK_OWNER_LOCK_TOKEN=""
	_TASK_OWNER_LOCK_TASK_ID=""
	_TASK_OWNER_LOCK_BORROWED=0
	_TASK_OWNER_LOCK_DEPTH=0
}

_task_owner_lock_local_is_valid() {
	local path="${_TASK_OWNER_LOCK_PATH:-}" pid="${_TASK_OWNER_LOCK_PID:-}"
	local start="${_TASK_OWNER_LOCK_START:-}" token="${_TASK_OWNER_LOCK_TOKEN:-}" task_id="${_TASK_OWNER_LOCK_TASK_ID:-}"
	[[ -n "$path" && "$path" == "$(_task_owner_lock_path)" && -f "$path/owner" ]] || return 1
	[[ "$pid" =~ ^[0-9]+$ && -n "$start" && -n "$token" && -n "$task_id" ]] || return 1
	[[ "$(_task_owner_lock_process_start "$pid")" == "$start" ]] || return 1
	[[ "$(awk -F= '$1 == "pid" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$pid" ]] || return 1
	[[ "$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$start" ]] || return 1
	[[ "$(awk -F= '$1 == "token" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$token" ]] || return 1
	[[ "$(awk -F= '$1 == "task_id" {print substr($0, index($0, "=") + 1); exit}' "$path/owner")" == "$task_id" ]]
}

task_owner_transition_lock_enter() {
	local task_id="$1"
	if [[ -n "${_TASK_OWNER_LOCK_PATH:-}" && "${_TASK_OWNER_LOCK_TASK_ID:-}" == "$task_id" ]]; then
		if _task_owner_lock_local_is_valid; then
			_TASK_OWNER_LOCK_DEPTH=$((${_TASK_OWNER_LOCK_DEPTH:-1} + 1))
			return 0
		fi
		_task_owner_lock_clear_local
	fi
	if task_owner_transition_lock_assert_lease "$task_id" 2>/dev/null; then
		_TASK_OWNER_LOCK_PATH="$OSTE_TASK_OWNER_LOCK_PATH"
		_TASK_OWNER_LOCK_PID="$OSTE_TASK_OWNER_LOCK_PID"
		_TASK_OWNER_LOCK_START="$OSTE_TASK_OWNER_LOCK_START"
		_TASK_OWNER_LOCK_TOKEN="$OSTE_TASK_OWNER_LOCK_TOKEN"
		_TASK_OWNER_LOCK_TASK_ID="$task_id"
		_TASK_OWNER_LOCK_BORROWED=1
		_TASK_OWNER_LOCK_DEPTH=1
		return 0
	fi
	task_owner_transition_lock_acquire "$task_id"
}

task_owner_transition_lock_release() {
	local path="${_TASK_OWNER_LOCK_PATH:-}"
	[[ -n "$path" ]] || return 0
	if ! _task_owner_lock_local_is_valid; then
		_task_owner_lock_clear_local
		return 1
	fi
	if [[ "${_TASK_OWNER_LOCK_DEPTH:-1}" -gt 1 ]]; then
		_TASK_OWNER_LOCK_DEPTH=$((${_TASK_OWNER_LOCK_DEPTH:-1} - 1))
		return 0
	fi
	if [[ "${_TASK_OWNER_LOCK_BORROWED:-0}" != "0" ]]; then
		_task_owner_lock_clear_local
		return 0
	fi
	rm -rf "$path"
	_task_owner_lock_clear_local
}

task_owner_transition_lock_leave() {
	if [[ -n "${_TASK_OWNER_LOCK_PATH:-}" ]]; then
		task_owner_transition_lock_release
	fi
}
