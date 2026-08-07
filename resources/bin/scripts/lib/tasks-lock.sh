#!/bin/bash
#
# tasks-lock.sh — Shared lock/unlock helpers for tasks.json
#
# Source this file from any script that needs to lock tasks.json.
# The sourcing script must set TASKS_FILE before calling lock_tasks().
# One sourced helper instance owns at most one lock at a time. The API is
# intentionally non-reentrant: acquire/release a registry before locking a
# different explicit path, because ownership is tracked in one process-global
# token slot so EXIT traps can release the exact lock that was acquired.
#
# Stale lock detection:
#   - Every new holder records PID + process-start identity + a random token.
#   - A live holder is never stolen merely because the directory is old.
#   - A dead holder or a reused PID (different process-start identity) is stale.
#   - Legacy/pid-less locks retain an age fallback for compatibility.
#   - Removal is serialized through a reap mutex and re-verified under it, so
#     a waiter that judged the lock stale can never delete a lock that a
#     faster waiter already reaped and re-acquired
#

# Return a stable, portable-enough process generation identity. BSD and GNU ps
# both expose lstart; collapsing whitespace makes their presentation comparable.
_tasks_lock_process_start() {
	local pid="$1"
	ps -p "$pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}'
}

# Bash 3.2 (the macOS system Bash) has no BASHPID. A short child process can
# portably report the PID of the shell that invoked it through PPID, including
# when lock_tasks runs inside a background subshell.
_tasks_lock_capture_current_pid() {
	if [[ -n "${BASHPID:-}" ]]; then
		_TASKS_LOCK_CALLER_PID="$BASHPID"
	else
		# Capturing command output would insert another Bash subshell and report
		# that intermediary. Have a directly spawned child write its PPID to a
		# private probe file instead.
		local probe
		probe=$(mktemp "${TMPDIR:-/tmp}/oste-lock-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _TASKS_LOCK_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_TASKS_LOCK_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_tasks_lock_mtime() {
	local path="$1"
	stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null || echo 0
}

_tasks_lock_new_token() {
	local pid="${1:-$$}"
	printf '%s' "${pid}-$(date +%s)-${RANDOM:-0}-${RANDOM:-0}"
}

# Acquire the tasks.json lock with stale lock detection. The owner record is
# published atomically after mkdir; waiters give that initialization window the
# same stale-age grace as a legacy pid-less lock.
# Returns 0 on success, 1 on timeout (10 seconds; TASKS_LOCK_MAX_WAIT overrides for tests).
lock_tasks() {
	local tasks_file="${1:-${TASKS_FILE}}"
	local lockdir="${tasks_file}.lock"
	local pidfile="${lockdir}/pid"
	local ownerfile="${lockdir}/owner"
	local max_wait="${TASKS_LOCK_MAX_WAIT:-10}" # seconds
	local stale_age="${TASKS_LOCK_STALE_AGE:-60}"
	local waited=0 # counted in 100ms increments
	local owner_pid
	_tasks_lock_capture_current_pid || return 1
	owner_pid="$_TASKS_LOCK_CALLER_PID"

	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			local token process_start owner_tmp
			token=$(_tasks_lock_new_token "$owner_pid")
			process_start=$(_tasks_lock_process_start "$owner_pid")
			if [[ -z "$process_start" ]]; then
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
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
			_TASKS_LOCK_OWNED="$lockdir"
			_TASKS_LOCK_TOKEN="$token"
			return 0
		fi

		# Check for and remove any stale lock before retrying
		_tasks_lock_stale_check "$lockdir" "$pidfile" "$ownerfile" "$stale_age"

		sleep 0.1
		waited=$((waited + 1))
		if [[ $waited -ge $((max_wait * 10)) ]]; then
			echo "Error: tasks.json lock timeout after ${max_wait}s" >&2
			return 1
		fi
	done
}

# Internal helper: report whether the lock looks stale right now.
# Stale means: lock dir older than $stale_age seconds, OR its PID file
# references a dead process. Prints the reason on stdout when stale.
_tasks_lock_is_stale() {
	local lockdir="$1"
	local pidfile="$2"
	local ownerfile="$3"
	local stale_age="$4"

	[[ -d "$lockdir" ]] || return 1

	local lock_mtime now age
	lock_mtime=$(_tasks_lock_mtime "$lockdir")
	now=$(date +%s)
	age=$((now - lock_mtime))

	local held_pid="" recorded_start=""
	if [[ -f "$ownerfile" ]]; then
		held_pid=$(awk -F= '$1 == "pid" {print substr($0, index($0, "=") + 1); exit}' "$ownerfile" 2>/dev/null || true)
		recorded_start=$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "$ownerfile" 2>/dev/null || true)
	elif [[ -f "$pidfile" ]]; then
		held_pid=$(cat "$pidfile" 2>/dev/null || true)
	fi

	if [[ "$held_pid" =~ ^[0-9]+$ ]]; then
		if ! kill -0 "$held_pid" 2>/dev/null; then
			echo "dead PID ${held_pid}"
			return 0
		fi
		# A live PID with a different start identity is a different process. This
		# is the reused-PID case that PID-only locks cannot recover from.
		if [[ -n "$recorded_start" ]]; then
			local current_start
			current_start=$(_tasks_lock_process_start "$held_pid")
			if [[ -n "$current_start" && "$current_start" != "$recorded_start" ]]; then
				echo "reused PID ${held_pid}"
				return 0
			fi
		fi
		# Live matching holders, including legacy PID-only holders, are never
		# stolen based on elapsed wall time.
		return 1
	fi

	if [[ $age -ge $stale_age ]]; then
		echo "unowned age: ${age}s"
		return 0
	fi

	return 1
}

# Internal helper: detect and remove a stale lock directory.
#
# Removal is a two-phase claim: waiters that judge the lock stale race for a
# reap mutex (mkdir, atomic), and only the winner re-verifies staleness and
# removes the lock. Without the mutex two waiters can both judge the old lock
# stale, the faster one removes and immediately re-acquires it, and the slower
# one's rm then destroys that fresh lock — leaving two processes inside the
# critical section.
# shellcheck disable=SC2154  # TASKS_FILE is set by the sourcing script
_tasks_lock_stale_check() {
	local lockdir="$1"
	local pidfile="$2"
	local ownerfile="$3"
	local stale_age="$4"

	# Cheap pre-check without the mutex: most waits are on a healthy lock.
	_tasks_lock_is_stale "$lockdir" "$pidfile" "$ownerfile" "$stale_age" >/dev/null || return 0

	local reapdir="${lockdir}.reap"
	if ! mkdir "$reapdir" 2>/dev/null; then
		# Another waiter is reaping. If that reaper died mid-section, clear
		# its mutex once it is clearly abandoned; the next iteration retries.
		# Threshold must sit well below lock_tasks' 10s budget — the reap
		# critical section is milliseconds, so 5s is already generous — or an
		# abandoned mutex could absorb a caller's entire wait.
		local reap_mtime reap_age
		reap_mtime=$(_tasks_lock_mtime "$reapdir")
		reap_age=$(($(date +%s) - reap_mtime))
		[[ $reap_age -ge 5 ]] && rm -rf "$reapdir"
		return 0
	fi

	# Re-verify under the mutex: the lock we judged stale may have been
	# reaped and re-acquired by a faster waiter while we raced for the mutex.
	local reason
	if reason=$(_tasks_lock_is_stale "$lockdir" "$pidfile" "$ownerfile" "$stale_age"); then
		echo "Warning: removing stale tasks.json lock (${reason})" >&2
		rm -rf "$lockdir"
	fi
	rm -rf "$reapdir"
}

# Release the tasks.json lock.
# Only removes the lock this process actually acquired: a trap that fires
# after a failed/timed-out lock_tasks must not evict a live foreign holder.
unlock_tasks() {
	local tasks_file="${1:-${TASKS_FILE}}"
	local lockdir="${tasks_file}.lock"
	local owner_pid
	_tasks_lock_capture_current_pid || return 0
	owner_pid="$_TASKS_LOCK_CALLER_PID"
	[[ "${_TASKS_LOCK_OWNED:-}" == "$lockdir" ]] || return 0

	# Compare both process generation and the unguessable acquisition token. If
	# our lock was reaped and reacquired, neither a recycled PID nor a stale trap
	# can remove the new holder.
	local held_pid held_start held_token current_start
	held_pid=$(cat "${lockdir}/pid" 2>/dev/null || echo "")
	held_start=$(awk -F= '$1 == "process_start" {print substr($0, index($0, "=") + 1); exit}' "${lockdir}/owner" 2>/dev/null || true)
	held_token=$(awk -F= '$1 == "token" {print substr($0, index($0, "=") + 1); exit}' "${lockdir}/owner" 2>/dev/null || true)
	current_start=$(_tasks_lock_process_start "$owner_pid")
	_TASKS_LOCK_OWNED=""
	if [[ "$held_pid" != "$owner_pid" || -z "$held_token" || "$held_token" != "${_TASKS_LOCK_TOKEN:-}" ]]; then
		_TASKS_LOCK_TOKEN=""
		return 0
	fi
	if [[ -n "$held_start" && -n "$current_start" && "$held_start" != "$current_start" ]]; then
		_TASKS_LOCK_TOKEN=""
		return 0
	fi
	_TASKS_LOCK_TOKEN=""
	rm -rf "$lockdir" 2>/dev/null || true
}

# Apply a jq program to TASKS_FILE in place (write-or-rollback).
#
# Args are passed verbatim to jq, followed by TASKS_FILE — call as
# `_tasks_json_apply --arg id "$id" '<filter>'`. The file is replaced only when
# jq succeeds AND produces non-empty output; otherwise the original is left
# intact. The temp file is always cleaned up (callers no longer need their own
# mktemp/mv/rm ceremony). Returns 0 on a successful write, 1 otherwise.
#
# Locking is the caller's responsibility: this helper does NOT acquire the tasks
# lock, so a sequence of calls inside one held lock stays a single critical
# section (as the completion path requires).
# shellcheck disable=SC2154  # TASKS_FILE is set by the sourcing script
_tasks_json_apply() {
	local _tmp
	# Keep the temporary adjacent to tasks.json so the final mv is one atomic
	# rename even when HOME and /tmp are on different filesystems.
	_tmp=$(mktemp "${TASKS_FILE}.tmp.XXXXXX") || return 1
	if jq "$@" "$TASKS_FILE" >"$_tmp" 2>/dev/null && [[ -s "$_tmp" ]]; then
		mv "$_tmp" "$TASKS_FILE"
		return 0
	fi
	rm -f "$_tmp"
	return 1
}
