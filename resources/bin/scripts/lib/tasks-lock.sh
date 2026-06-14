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
#   - Removal is serialized through a reap mutex and re-verified under it, so
#     a waiter that judged the lock stale can never delete a lock that a
#     faster waiter already reaped and re-acquired
#

# Acquire the tasks.json lock with stale lock detection.
# Writes the caller's PID into the lock dir so future callers can detect dead holders.
# Returns 0 on success, 1 on timeout (10 seconds; TASKS_LOCK_MAX_WAIT overrides for tests).
lock_tasks() {
	local lockdir="${TASKS_FILE}.lock"
	local pidfile="${lockdir}/pid"
	local max_wait="${TASKS_LOCK_MAX_WAIT:-10}" # seconds
	local stale_age=60                          # seconds — tasks.json ops should be fast
	local waited=0                              # counted in 100ms increments

	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			# Lock acquired — record our PID for dead-holder detection
			echo "$$" >"$pidfile"
			_TASKS_LOCK_OWNED="$lockdir"
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

# Internal helper: report whether the lock looks stale right now.
# Stale means: lock dir older than $stale_age seconds, OR its PID file
# references a dead process. Prints the reason on stdout when stale.
_tasks_lock_is_stale() {
	local lockdir="$1"
	local pidfile="$2"
	local stale_age="$3"

	[[ -d "$lockdir" ]] || return 1

	local lock_mtime now age
	lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || echo 0)
	now=$(date +%s)
	age=$((now - lock_mtime))
	if [[ $age -ge $stale_age ]]; then
		echo "age: ${age}s"
		return 0
	fi

	if [[ -f "$pidfile" ]]; then
		local held_pid
		held_pid=$(cat "$pidfile" 2>/dev/null || echo "")
		if [[ -n "$held_pid" ]] && ! kill -0 "$held_pid" 2>/dev/null; then
			echo "dead PID ${held_pid}"
			return 0
		fi
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
	local stale_age="$3"

	# Cheap pre-check without the mutex: most waits are on a healthy lock.
	_tasks_lock_is_stale "$lockdir" "$pidfile" "$stale_age" >/dev/null || return 0

	local reapdir="${lockdir}.reap"
	if ! mkdir "$reapdir" 2>/dev/null; then
		# Another waiter is reaping. If that reaper died mid-section, clear
		# its mutex once it is clearly abandoned; the next iteration retries.
		# Threshold must sit well below lock_tasks' 10s budget — the reap
		# critical section is milliseconds, so 5s is already generous — or an
		# abandoned mutex could absorb a caller's entire wait.
		local reap_mtime reap_age
		reap_mtime=$(stat -f %m "$reapdir" 2>/dev/null || echo 0)
		reap_age=$(($(date +%s) - reap_mtime))
		[[ $reap_age -ge 5 ]] && rm -rf "$reapdir"
		return 0
	fi

	# Re-verify under the mutex: the lock we judged stale may have been
	# reaped and re-acquired by a faster waiter while we raced for the mutex.
	local reason
	if reason=$(_tasks_lock_is_stale "$lockdir" "$pidfile" "$stale_age"); then
		echo "Warning: removing stale tasks.json lock (${reason})" >&2
		rm -rf "$lockdir"
	fi
	rm -rf "$reapdir"
}

# Release the tasks.json lock.
# Only removes the lock this process actually acquired: a trap that fires
# after a failed/timed-out lock_tasks must not evict a live foreign holder.
unlock_tasks() {
	local lockdir="${TASKS_FILE}.lock"
	[[ "${_TASKS_LOCK_OWNED:-}" == "$lockdir" ]] || return 0
	_TASKS_LOCK_OWNED=""

	# Only remove a lock whose pid file names this exact process. A missing
	# pid file is NOT proof of ownership: if our lock was stale-reaped and
	# another process re-acquired it, its pid write may not have landed yet —
	# removing then would evict the new owner. If our own pid write failed,
	# the orphaned lock degrades to age-based reaping (60s), which fails safe.
	local held_pid
	held_pid=$(cat "${lockdir}/pid" 2>/dev/null || echo "")
	[[ "$held_pid" == "$$" ]] || return 0
	rm -rf "$lockdir" 2>/dev/null || true
}
