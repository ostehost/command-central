#!/bin/bash
# completion-idempotency-lock.sh — Generation-bound completion side-effect lease.
#
# The lease spans every task-ID-keyed completion side effect, including review
# projection, callbacks, notifications, and final WAL cleanup. Spawn checks the
# same lease before reusing a task ID. Each holder records a portable process
# generation plus an acquisition token so neither a recycled PID nor a stale
# RETURN trap can remove a replacement holder's lease.

completion_idempotency_lock_path() {
	local task_id="$1"
	printf '/tmp/oste-complete-lock-%s' "$task_id"
}

_completion_idempotency_process_start() {
	local pid="$1"
	LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}'
}

_completion_idempotency_capture_current_pid() {
	if [[ -n "${BASHPID:-}" ]]; then
		_COMPLETION_IDEMPOTENCY_CALLER_PID="$BASHPID"
	else
		# macOS system Bash is 3.2 and has no BASHPID. A direct child can
		# report this shell's PID through PPID without a command-substitution
		# subshell changing the identity being recorded.
		local probe
		probe=$(mktemp "${TMPDIR:-/tmp}/oste-completion-idempotency-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _COMPLETION_IDEMPOTENCY_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_COMPLETION_IDEMPOTENCY_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_completion_idempotency_mtime() {
	local path="$1"
	stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null || echo 0
}

_completion_idempotency_owner_field() {
	local ownerfile="$1" field="$2"
	awk -F= -v wanted="$field" '$1 == wanted {print substr($0, index($0, "=") + 1); exit}' "$ownerfile" 2>/dev/null || true
}

_completion_idempotency_lock_is_stale() {
	local lockdir="$1" stale_age="$2"
	[[ -d "$lockdir" ]] || return 1

	local ownerfile="${lockdir}/owner" pidfile="${lockdir}/pid"
	local held_pid="" recorded_start="" age
	if [[ -f "$ownerfile" ]]; then
		held_pid=$(_completion_idempotency_owner_field "$ownerfile" pid)
		recorded_start=$(_completion_idempotency_owner_field "$ownerfile" process_start)
	elif [[ -f "$pidfile" ]]; then
		held_pid=$(cat "$pidfile" 2>/dev/null || true)
	fi
	age=$(($(date +%s) - $(_completion_idempotency_mtime "$lockdir")))

	if [[ "$held_pid" =~ ^[0-9]+$ ]]; then
		if ! kill -0 "$held_pid" 2>/dev/null; then
			echo "dead PID ${held_pid}"
			return 0
		fi
		if [[ -n "$recorded_start" ]]; then
			local current_start
			current_start=$(_completion_idempotency_process_start "$held_pid")
			if [[ -n "$current_start" && "$current_start" != "$recorded_start" ]]; then
				echo "reused PID ${held_pid}"
				return 0
			fi
		fi
		# A live process generation is authoritative regardless of age.
		return 1
	fi

	[[ "$age" -ge "$stale_age" ]] || return 1
	if [[ -z "$held_pid" ]]; then
		echo "missing PID (age: ${age}s)"
	else
		echo "invalid PID ${held_pid} (age: ${age}s)"
	fi
	return 0
}

completion_idempotency_lock_reap_stale() {
	local task_id="$1"
	local lockdir stale_age reapdir
	lockdir=$(completion_idempotency_lock_path "$task_id")
	stale_age="${OSTE_IDEMPOTENCY_LOCK_STALE:-600}"
	_completion_idempotency_lock_is_stale "$lockdir" "$stale_age" >/dev/null || return 1

	reapdir="${lockdir}.reap"
	if ! mkdir "$reapdir" 2>/dev/null; then
		local reap_age
		reap_age=$(($(date +%s) - $(_completion_idempotency_mtime "$reapdir")))
		[[ "$reap_age" -ge 5 ]] && rm -rf "$reapdir"
		return 1
	fi

	local reason reaped=false
	if reason=$(_completion_idempotency_lock_is_stale "$lockdir" "$stale_age"); then
		echo "Warning: removing stale idempotency lock for ${task_id} (${reason})" >&2
		rm -rf "$lockdir"
		reaped=true
	fi
	rm -rf "$reapdir"
	[[ "$reaped" == "true" ]]
}

# Return success while a live/fresh lease exists. A verified stale holder is
# reaped first, which lets spawn distinguish safe same-ID reuse from overlap
# with the prior generation's still-running completion postwork.
completion_idempotency_lock_is_live() {
	local task_id="$1" lockdir
	lockdir=$(completion_idempotency_lock_path "$task_id")
	[[ -d "$lockdir" ]] || return 1
	completion_idempotency_lock_reap_stale "$task_id" >/dev/null 2>&1 || true
	[[ -d "$lockdir" ]]
}

completion_idempotency_lock_acquire() {
	local task_id="$1" task_generation="${2:-}"
	local lockdir ownerfile pidfile
	lockdir=$(completion_idempotency_lock_path "$task_id")
	ownerfile="${lockdir}/owner"
	pidfile="${lockdir}/pid"

	if ! mkdir "$lockdir" 2>/dev/null; then
		completion_idempotency_lock_reap_stale "$task_id" || true
		if ! mkdir "$lockdir" 2>/dev/null; then
			echo "Warning: completion already in progress for ${task_id}, skipping" >&2
			return 1
		fi
	fi

	local owner_pid process_start token owner_tmp
	if ! _completion_idempotency_capture_current_pid; then
		rmdir "$lockdir" 2>/dev/null || true
		return 1
	fi
	owner_pid="$_COMPLETION_IDEMPOTENCY_CALLER_PID"
	process_start=$(_completion_idempotency_process_start "$owner_pid")
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
		printf 'task_generation=%s\n' "$task_generation"
	} >"$owner_tmp" || ! mv "$owner_tmp" "$ownerfile"; then
		rm -f "$owner_tmp" "$pidfile"
		rmdir "$lockdir" 2>/dev/null || true
		return 1
	fi

	_COMPLETION_IDEMPOTENCY_LOCK_OWNED="$lockdir"
	_COMPLETION_IDEMPOTENCY_LOCK_TOKEN="$token"
	_COMPLETION_IDEMPOTENCY_LOCK_GENERATION="$task_generation"
	return 0
}

# Release only the exact acquisition owned by this shell. Files are removed
# before rmdir, so another generation cannot create the same directory until
# this holder has completely relinquished it. A stale RETURN trap therefore
# cannot delete a replacement lease.
completion_idempotency_lock_release() {
	local task_id="$1" lockdir ownerfile held_token held_generation
	lockdir=$(completion_idempotency_lock_path "$task_id")
	ownerfile="${lockdir}/owner"
	[[ "${_COMPLETION_IDEMPOTENCY_LOCK_OWNED:-}" == "$lockdir" ]] || return 0
	held_token=$(_completion_idempotency_owner_field "$ownerfile" token)
	held_generation=$(_completion_idempotency_owner_field "$ownerfile" task_generation)
	_COMPLETION_IDEMPOTENCY_LOCK_OWNED=""
	if [[ -z "$held_token" || "$held_token" != "${_COMPLETION_IDEMPOTENCY_LOCK_TOKEN:-}" ||
		"$held_generation" != "${_COMPLETION_IDEMPOTENCY_LOCK_GENERATION:-}" ]]; then
		_COMPLETION_IDEMPOTENCY_LOCK_TOKEN=""
		_COMPLETION_IDEMPOTENCY_LOCK_GENERATION=""
		return 0
	fi
	_COMPLETION_IDEMPOTENCY_LOCK_TOKEN=""
	_COMPLETION_IDEMPOTENCY_LOCK_GENERATION=""
	rm -f "$ownerfile" "${lockdir}/pid" 2>/dev/null || true
	rmdir "$lockdir" 2>/dev/null || true
}
