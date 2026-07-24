#!/bin/bash
# completion-state-lock.sh — Per-task serialization for completion markers.
#
# This lock protects the task's completion-state side channel:
#   /tmp/oste-complete-<task_id>
#   /tmp/oste-receipt-<task_id>
# and any watchdog advisory projection that depends on those markers being
# absent. It is intentionally separate from the tasks.json lock because the
# marker files live outside tasks.json.
#
# Lock ordering (deadlock invariant):
#   1. global task-owner transition lock, when needed
#   2. per-task completion idempotency/generation lease, when needed
#   3. completion-state lock for the task
#   4. tasks.json lock, when needed
#   5. work-system bridge/outbox lock, when needed
# Never acquire this lock while already holding tasks.json. Watchdog/finalizer
# paths that need both must acquire completion-state before tasks. Paths that
# also need the completion generation lease acquire that lease first and retain
# it while narrow state sections are released for Git/network work.

_completion_state_lock_root() {
	printf '%s' "${OSTE_COMPLETION_STATE_LOCK_DIR:-${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}.completion-state-locks}"
}

_completion_state_lock_safe_id() {
	local task_id="$1"
	printf '%s' "$task_id" | tr -c 'A-Za-z0-9._-' '_'
}

completion_state_lock_path() {
	local task_id="$1"
	local root safe_id
	root=$(_completion_state_lock_root)
	safe_id=$(_completion_state_lock_safe_id "$task_id")
	printf '%s/%s.lock' "$root" "$safe_id"
}

_completion_state_process_start() {
	local pid="$1"
	LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}'
}

_completion_state_capture_current_pid() {
	if [[ -n "${BASHPID:-}" ]]; then
		_COMPLETION_STATE_CALLER_PID="$BASHPID"
	else
		local probe
		probe=$(mktemp "${TMPDIR:-/tmp}/oste-completion-lock-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _COMPLETION_STATE_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_COMPLETION_STATE_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_completion_state_lock_mtime() {
	local path="$1"
	stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null || echo 0
}

completion_state_lock_acquire() {
	local task_id="$1"
	local root lockdir pidfile ownerfile max_wait stale_age waited owner_pid
	root=$(_completion_state_lock_root)
	lockdir=$(completion_state_lock_path "$task_id")
	pidfile="${lockdir}/pid"
	ownerfile="${lockdir}/owner"
	max_wait="${OSTE_COMPLETION_STATE_LOCK_MAX_WAIT:-10}"
	stale_age="${OSTE_COMPLETION_STATE_LOCK_STALE:-600}"
	waited=0
	_completion_state_capture_current_pid || return 1
	owner_pid="$_COMPLETION_STATE_CALLER_PID"

	mkdir -p "$root" 2>/dev/null || return 1
	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			local process_start token owner_tmp
			process_start=$(_completion_state_process_start "$owner_pid")
			if [[ -z "$process_start" ]]; then
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
			token="${owner_pid}-$(date +%s)-${RANDOM:-0}-${RANDOM:-0}"
			owner_tmp="${ownerfile}.tmp.${owner_pid}"
			if ! printf '%s\n' "$owner_pid" >"$pidfile" || ! {
				printf 'pid=%s\n' "$owner_pid"
				printf 'process_start=%s\n' "$process_start"
				printf 'token=%s\n' "$token"
			} >"$owner_tmp" || ! mv "$owner_tmp" "$ownerfile"; then
				rm -f "$owner_tmp"
				rm -rf "$lockdir"
				return 1
			fi
			_COMPLETION_STATE_LOCK_OWNED="$lockdir"
			_COMPLETION_STATE_LOCK_TOKEN="$token"
			return 0
		fi

		_completion_state_lock_reap_if_stale "$lockdir" "$pidfile" "$ownerfile" "$stale_age"
		sleep 0.1
		waited=$((waited + 1))
		if [[ $waited -ge $((max_wait * 10)) ]]; then
			echo "Warning: completion-state lock timeout for ${task_id} after ${max_wait}s" >&2
			return 1
		fi
	done
}

_completion_state_lock_is_stale() {
	local lockdir="$1" pidfile="$2" ownerfile="$3" stale_age="$4"
	[[ -d "$lockdir" ]] || return 1

	local lock_mtime now age
	lock_mtime=$(_completion_state_lock_mtime "$lockdir")
	now=$(date +%s)
	age=$((now - lock_mtime))

	local held_pid="" recorded_start=""
	if [[ -f "$ownerfile" ]]; then
		held_pid=$(awk -F= '$1 == "pid" {print substr($0, index($0, "=") + 1); exit}' "$ownerfile" 2>/dev/null || true)
		recorded_start=$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "$ownerfile" 2>/dev/null || true)
	elif [[ -f "$pidfile" ]]; then
		held_pid=$(cat "$pidfile" 2>/dev/null || echo "")
	fi

	# A live recorded owner always wins over wall-clock age. Long-running
	# completion writers/watchdogs may legitimately hold this lock for more than
	# the stale threshold; age alone must never let another process steal it.
	if [[ "$held_pid" =~ ^[0-9]+$ ]]; then
		if ! kill -0 "$held_pid" 2>/dev/null; then
			echo "dead PID ${held_pid}"
			return 0
		fi
		if [[ -n "$recorded_start" ]]; then
			local current_start
			current_start=$(_completion_state_process_start "$held_pid")
			if [[ -n "$current_start" && "$current_start" != "$recorded_start" ]]; then
				echo "reused PID ${held_pid}"
				return 0
			fi
		fi
		return 1
	fi

	[[ $age -ge $stale_age ]] || return 1

	if [[ -z "$held_pid" ]]; then
		echo "missing PID (age: ${age}s)"
	elif [[ ! "$held_pid" =~ ^[0-9]+$ ]]; then
		echo "invalid PID ${held_pid} (age: ${age}s)"
	else
		echo "dead PID ${held_pid} (age: ${age}s)"
	fi
	return 0
}

_completion_state_lock_reap_if_stale() {
	local lockdir="$1" pidfile="$2" ownerfile="$3" stale_age="$4"
	_completion_state_lock_is_stale "$lockdir" "$pidfile" "$ownerfile" "$stale_age" >/dev/null || return 0

	local reapdir="${lockdir}.reap"
	if ! mkdir "$reapdir" 2>/dev/null; then
		local reap_mtime reap_age
		reap_mtime=$(_completion_state_lock_mtime "$reapdir")
		reap_age=$(($(date +%s) - reap_mtime))
		[[ $reap_age -ge 5 ]] && rm -rf "$reapdir"
		return 0
	fi

	local reason
	if reason=$(_completion_state_lock_is_stale "$lockdir" "$pidfile" "$ownerfile" "$stale_age"); then
		echo "Warning: removing stale completion-state lock (${reason})" >&2
		rm -rf "$lockdir"
	fi
	rm -rf "$reapdir"
}

completion_state_unlock() {
	local task_id="${1:-}"
	local lockdir
	if [[ -n "$task_id" ]]; then
		lockdir=$(completion_state_lock_path "$task_id")
	else
		lockdir="${_COMPLETION_STATE_LOCK_OWNED:-}"
	fi
	[[ -n "$lockdir" ]] || return 0
	[[ "${_COMPLETION_STATE_LOCK_OWNED:-}" == "$lockdir" ]] || return 0
	local held_pid held_start held_token current_start current_pid
	_completion_state_capture_current_pid || return 0
	current_pid="$_COMPLETION_STATE_CALLER_PID"
	held_pid=$(cat "${lockdir}/pid" 2>/dev/null || echo "")
	held_start=$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "${lockdir}/owner" 2>/dev/null || true)
	held_token=$(awk -F= '$1 == "token" {print substr($0, index($0, "=") + 1); exit}' "${lockdir}/owner" 2>/dev/null || true)
	current_start=$(_completion_state_process_start "$current_pid")
	_COMPLETION_STATE_LOCK_OWNED=""
	if [[ "$held_pid" != "$current_pid" || -z "$held_token" || "$held_token" != "${_COMPLETION_STATE_LOCK_TOKEN:-}" ]]; then
		_COMPLETION_STATE_LOCK_TOKEN=""
		return 0
	fi
	if [[ -n "$held_start" && -n "$current_start" && "$held_start" != "$current_start" ]]; then
		_COMPLETION_STATE_LOCK_TOKEN=""
		return 0
	fi
	_COMPLETION_STATE_LOCK_TOKEN=""
	rm -rf "$lockdir" 2>/dev/null || true
}
