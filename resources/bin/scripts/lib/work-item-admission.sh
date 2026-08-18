#!/bin/bash
# work-item-admission.sh — the work-item-scoped admission lease.
#
# ── The one invariant ────────────────────────────────────────────────
# Two different task IDs representing the same `work_item_ref` must not both
# pass admission, allocate, spawn, or register. The façade's admission check is
# lock -> scan -> unlock and registration happens much later, so without this
# lease both processes legitimately observe "no in-flight peer" and both
# proceed. This closes exactly that window and nothing else.
#
# It is NOT a scheduler, queue, parking system, cleanup daemon, generalized
# lease framework, or database. It has one key, one holder, and one lifetime.
#
# ── Identity ─────────────────────────────────────────────────────────
# The key is a digest of the work-item ref EXACTLY as the façade already
# validated and compares it. There is no normalization here, deliberately: the
# registry scan matches `work_item_ref` byte-for-byte, so folding case or
# resolving aliases here would invent a SECOND identity contract that disagrees
# with the scan it is protecting. Two spellings that the scan treats as
# different work items are different work items here too.
#
# ── Where it lives ───────────────────────────────────────────────────
# Beside the registry it protects, mirroring the existing owner-transition lock
# convention (`${TASKS_FILE}.owner-transition.lock`). That inherits the
# Launcher state root and every fixture's isolation automatically, and claims no
# global `/tmp` authority. One directory per key, so unrelated work items never
# serialize against each other.
#
# ── Stale owners: positively proven, never age-only ──────────────────
# A holder is stale only when its PID no longer exists OR its process-start
# stamp no longer matches — the same positively authoritative test the
# owner-transition lock uses. Age is consulted ONLY when the owner record is
# missing or unparseable, i.e. when there is no identity to test at all. A live
# holder is never reaped for being slow.
#
# ── Lock ordering ────────────────────────────────────────────────────
# This lease is the OUTERMOST lock on the launch path. It is acquired at exactly
# one site, before the registry lock, and released at process exit. Nothing
# inside the launch path — the tasks lock, the journal, the allocator, the
# owner-transition lock — ever acquires it, so no reverse-order acquisition and
# therefore no cycle is possible.

: "${OSTE_WORK_ITEM_ADMISSION_STALE:=900}"

_WORK_ITEM_ADMISSION_PATH=""
_WORK_ITEM_ADMISSION_TOKEN=""

work_item_admission_key() {
	printf '%s' "${1:-}" | shasum -a 256 | awk '{print $1}'
}

work_item_admission_dir() {
	printf '%s.admission' "${TASKS_FILE:?TASKS_FILE is required}"
}

work_item_admission_path() {
	printf '%s/%s.lock' "$(work_item_admission_dir)" "$1"
}

_work_item_admission_process_start() {
	LC_ALL=C ps -p "${1:-}" -o lstart= 2>/dev/null |
		sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

_work_item_admission_field() {
	jq -r --arg k "$2" 'if type == "object" then (.[$k] // empty) else empty end' \
		"$1/owner.json" 2>/dev/null
}

_work_item_admission_age() {
	local mtime now
	mtime=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0)
	now=$(date +%s)
	printf '%s' "$((now - mtime))"
}

# Stale iff the recorded owner is provably gone. Age is the fallback ONLY when
# there is no owner identity to test.
_work_item_admission_is_stale() {
	local path="$1" pid start current
	[[ -d "$path" ]] || return 1
	pid=$(_work_item_admission_field "$path" owner_pid)
	start=$(_work_item_admission_field "$path" owner_process_start)
	if [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]]; then
		current=$(_work_item_admission_process_start "$pid")
		[[ -z "$current" || "$current" != "$start" ]]
		return
	fi
	[[ "$(_work_item_admission_age "$path")" -ge "$OSTE_WORK_ITEM_ADMISSION_STALE" ]]
}

# Acquire. Returns 0 held-by-us, 1 held by a live holder, 2 unusable.
# Deliberately does NOT wait: admission is concurrency-one, so a live holder is
# an immediate refusal rather than a queue.
work_item_admission_acquire() {
	local ref="$1" task_id="$2" lrid="$3" epoch="${4:-0}"
	local key dir path pid start token json attempt=0
	[[ -n "$ref" ]] || return 2
	key=$(work_item_admission_key "$ref") || return 2
	dir=$(work_item_admission_dir) || return 2
	path=$(work_item_admission_path "$key")
	(umask 077 && mkdir -p "$dir") 2>/dev/null || return 2
	pid="${BASHPID:-$$}"
	start=$(_work_item_admission_process_start "$pid")
	[[ -n "$start" ]] || return 2

	while ((attempt < 2)); do
		if (umask 077 && mkdir "$path") 2>/dev/null; then
			token="${pid}-$(date +%s)-${RANDOM:-0}${RANDOM:-0}"
			json=$(jq -cn --arg schema "oste-work-item-admission/v1" \
				--arg ref "$ref" --arg digest "$key" --arg task "$task_id" \
				--arg lrid "$lrid" --arg epoch "$epoch" --arg pid "$pid" \
				--arg start "$start" --arg token "$token" \
				--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
				{schema:$schema, work_item_ref:$ref, work_item_digest:$digest,
				 task_id:$task, launch_request_id:$lrid, launch_attempt_epoch:$epoch,
				 owner_pid:$pid, owner_process_start:$start, token:$token,
				 acquired_at:$at, state:"held"}') || {
				rmdir "$path" 2>/dev/null
				return 2
			}
			if ! (umask 077 && printf '%s\n' "$json" >"${path}/owner.json"); then
				rm -rf "$path" 2>/dev/null
				return 2
			fi
			_WORK_ITEM_ADMISSION_PATH="$path"
			_WORK_ITEM_ADMISSION_TOKEN="$token"
			return 0
		fi
		# Someone holds it. Reap ONLY on proven death, then retry exactly once.
		if _work_item_admission_is_stale "$path"; then
			rm -rf "$path" 2>/dev/null
			attempt=$((attempt + 1))
			continue
		fi
		return 1
	done
	return 1
}

# Release, but only what we actually own: the token must still match, so a lease
# reaped and re-acquired by someone else is never deleted out from under them.
work_item_admission_release() {
	local path="${_WORK_ITEM_ADMISSION_PATH:-}"
	[[ -n "$path" && -d "$path" ]] || {
		_WORK_ITEM_ADMISSION_PATH=""
		return 0
	}
	if [[ "$(_work_item_admission_field "$path" token)" == "${_WORK_ITEM_ADMISSION_TOKEN:-}" ]]; then
		rm -rf "$path" 2>/dev/null || true
	fi
	_WORK_ITEM_ADMISSION_PATH=""
	_WORK_ITEM_ADMISSION_TOKEN=""
	return 0
}

work_item_admission_held() { [[ -n "${_WORK_ITEM_ADMISSION_PATH:-}" ]]; }

# The holder record, for reconstruction/inspection. Never used as control state.
work_item_admission_holder() {
	local path
	path=$(work_item_admission_path "$(work_item_admission_key "$1")")
	[[ -f "${path}/owner.json" ]] && cat "${path}/owner.json" 2>/dev/null
}
