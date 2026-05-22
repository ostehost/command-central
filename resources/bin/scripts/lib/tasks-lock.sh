#!/bin/bash
#
# tasks-lock.sh — Shared lock/unlock helpers for tasks.json
#
# Source this file from any script that needs to lock tasks.json.
# The sourcing script must set TASKS_FILE before calling lock_tasks().
#
# Stale lock detection:
#   - Lock dir older than 60 seconds is automatically removed
#   - Lock dir whose PID file refers to a dead process is automatically removed
#

# Acquire the tasks.json lock with stale lock detection.
# Writes the caller's PID into the lock dir so future callers can detect dead holders.
# Returns 0 on success, 1 on timeout (10 seconds).
lock_tasks() {
	local lockdir="${TASKS_FILE}.lock"
	local pidfile="${lockdir}/pid"
	local max_wait=10  # seconds
	local stale_age=60 # seconds — tasks.json ops should be fast
	local waited=0     # counted in 100ms increments

	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			# Lock acquired — record our PID for dead-holder detection
			echo "$$" >"$pidfile"
			return 0
		fi

		# Check for and remove any stale lock before retrying
		_tasks_lock_stale_check "$lockdir" "$pidfile" "$stale_age"

		sleep 0.1
		waited=$((waited + 1))
		if [[ $waited -ge $((max_wait * 10)) ]]; then
			echo "Error: tasks.json lock timeout after ${max_wait}s" >&2
			return 1
		fi
	done
}

# Internal helper: detect and remove a stale lock directory.
# A lock is considered stale if:
#   - The lock dir is older than $stale_age seconds, OR
#   - The lock dir contains a PID file referencing a dead process
# shellcheck disable=SC2154  # TASKS_FILE is set by the sourcing script
_tasks_lock_stale_check() {
	local lockdir="$1"
	local pidfile="$2"
	local stale_age="$3"

	[[ -d "$lockdir" ]] || return 0

	# Age-based staleness: remove locks older than stale_age seconds
	local lock_mtime now age
	lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || echo 0)
	now=$(date +%s)
	age=$((now - lock_mtime))
	if [[ $age -ge $stale_age ]]; then
		echo "Warning: removing stale tasks.json lock (age: ${age}s)" >&2
		rm -rf "$lockdir"
		return 0
	fi

	# PID-based staleness: remove lock if the holding process is dead
	if [[ -f "$pidfile" ]]; then
		local held_pid
		held_pid=$(cat "$pidfile" 2>/dev/null || echo "")
		if [[ -n "$held_pid" ]] && ! kill -0 "$held_pid" 2>/dev/null; then
			echo "Warning: removing tasks.json lock held by dead PID ${held_pid}" >&2
			rm -rf "$lockdir"
		fi
	fi
}

# Release the tasks.json lock (removes the lock dir and its PID file).
unlock_tasks() {
	rm -rf "${TASKS_FILE}.lock" 2>/dev/null || true
}
