#!/bin/bash
#
# review-lifecycle.sh — Atomic per-task review state transitions.
#
# The pending-review receipt is the queue payload; tasks.json is the durable
# launcher projection used by LaneRef.  Every transition updates both through a
# small write-ahead transaction.  A process that dies after either write leaves
# enough intent for the next reader/writer to finish the same revision.
#
# Lock order:
#   completion-state (when applicable) -> review lifecycle -> tasks -> bridge
# Never acquire the review lock while already holding the tasks lock.

[[ -n "${__OSTE_REVIEW_LIFECYCLE_SH:-}" ]] && return 0
__OSTE_REVIEW_LIFECYCLE_SH=1

_review_lifecycle_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! declare -f task_id_validate >/dev/null 2>&1 && [[ -f "${_review_lifecycle_lib_dir}/task-id.sh" ]]; then
	# shellcheck source=task-id.sh
	source "${_review_lifecycle_lib_dir}/task-id.sh"
fi
unset _review_lifecycle_lib_dir

_review_lifecycle_validate_task_id() {
	if declare -f task_id_validate >/dev/null 2>&1; then
		task_id_validate "$1"
	else
		[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
	fi
}

_review_lifecycle_tasks_file() {
	printf '%s' "${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
}

_review_lifecycle_pending_dir() {
	printf '%s' "${PENDING_REVIEW_DIR:-${OSTE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}}"
}

_review_lifecycle_safe_id() {
	printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

review_lifecycle_receipt_path() {
	_review_lifecycle_validate_task_id "$1" || return 1
	printf '%s/%s.json' "$(_review_lifecycle_pending_dir)" "$1"
}

review_lifecycle_lock_path() {
	local task_id="$1" tasks_file safe_id
	_review_lifecycle_validate_task_id "$task_id" || return 1
	tasks_file=$(_review_lifecycle_tasks_file)
	safe_id=$(_review_lifecycle_safe_id "$task_id")
	printf '%s.review-locks/%s.lock' "$tasks_file" "$safe_id"
}

review_lifecycle_wal_path() {
	local task_id="$1" tasks_file safe_id
	_review_lifecycle_validate_task_id "$task_id" || return 1
	tasks_file=$(_review_lifecycle_tasks_file)
	safe_id=$(_review_lifecycle_safe_id "$task_id")
	printf '%s.review-transactions/%s.json' "$tasks_file" "$safe_id"
}

_review_lifecycle_process_start() {
	ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'
}

# macOS system Bash has no BASHPID, while $$ remains the parent shell PID in a
# background subshell. Ask a directly spawned child for its PPID so concurrent
# claimers record their own process generation instead of sharing an owner.
_review_lifecycle_capture_current_pid() {
	if [[ -n "${BASHPID:-}" ]]; then
		_REVIEW_LIFECYCLE_CALLER_PID="$BASHPID"
	else
		local probe
		probe=$(mktemp "${TMPDIR:-/tmp}/oste-review-lock-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _REVIEW_LIFECYCLE_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_REVIEW_LIFECYCLE_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_review_lifecycle_mtime() {
	stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

_review_lifecycle_new_id() {
	local value=""
	if command -v uuidgen >/dev/null 2>&1; then
		value=$(uuidgen 2>/dev/null | LC_ALL=C tr '[:upper:]' '[:lower:]')
	fi
	if [[ -z "$value" ]]; then
		value=$(printf '%s' "$(date +%s)-${BASHPID:-$$}-${RANDOM:-0}-${RANDOM:-0}" |
			shasum -a 256 2>/dev/null | awk '{print $1}')
	fi
	printf '%s' "$value"
}

_review_lifecycle_lock_is_stale() {
	local lockdir="$1" ownerfile="$2" stale_age="$3"
	[[ -d "$lockdir" ]] || return 1

	local pid="" recorded_start="" current_start="" age
	if [[ -f "$ownerfile" ]]; then
		pid=$(jq -r '.pid // empty' "$ownerfile" 2>/dev/null || true)
		recorded_start=$(jq -r '.process_start // empty' "$ownerfile" 2>/dev/null || true)
	fi
	age=$(($(date +%s) - $(_review_lifecycle_mtime "$lockdir")))
	if [[ "$pid" =~ ^[0-9]+$ ]]; then
		if ! kill -0 "$pid" 2>/dev/null; then
			return 0
		fi
		current_start=$(_review_lifecycle_process_start "$pid")
		if [[ -n "$recorded_start" && -n "$current_start" && "$recorded_start" != "$current_start" ]]; then
			return 0
		fi
		return 1
	fi
	[[ "$age" -ge "$stale_age" ]]
}

review_lifecycle_lock_acquire() {
	local task_id="$1" lockdir ownerfile root max_wait stale_age waited=0
	_review_lifecycle_validate_task_id "$task_id" || return 1
	lockdir=$(review_lifecycle_lock_path "$task_id")
	ownerfile="${lockdir}/owner.json"
	root=$(dirname "$lockdir")
	max_wait="${OSTE_REVIEW_LOCK_MAX_WAIT:-10}"
	stale_age="${OSTE_REVIEW_LOCK_STALE_AGE:-60}"
	mkdir -p "$root" 2>/dev/null || return 1
	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			local token owner_tmp pid process_start
			_review_lifecycle_capture_current_pid || {
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			}
			token=$(_review_lifecycle_new_id)
			pid="$_REVIEW_LIFECYCLE_CALLER_PID"
			process_start=$(_review_lifecycle_process_start "$pid")
			if [[ -z "$process_start" ]]; then
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
			owner_tmp="${ownerfile}.tmp.${pid}"
			if jq -cn --argjson pid "$pid" --arg start "$process_start" --arg token "$token" \
				'{pid:$pid,process_start:$start,token:$token}' >"$owner_tmp" 2>/dev/null &&
				mv "$owner_tmp" "$ownerfile"; then
				_REVIEW_LIFECYCLE_LOCK_OWNED="$lockdir"
				_REVIEW_LIFECYCLE_LOCK_TOKEN="$token"
				return 0
			fi
			rm -f "$owner_tmp"
			rmdir "$lockdir" 2>/dev/null || true
			return 1
		fi

		if _review_lifecycle_lock_is_stale "$lockdir" "$ownerfile" "$stale_age"; then
			local reapdir="${lockdir}.reap"
			if mkdir "$reapdir" 2>/dev/null; then
				if _review_lifecycle_lock_is_stale "$lockdir" "$ownerfile" "$stale_age"; then
					rm -rf "$lockdir"
				fi
				rm -rf "$reapdir"
			else
				local reap_age
				reap_age=$(($(date +%s) - $(_review_lifecycle_mtime "$reapdir")))
				[[ "$reap_age" -ge 5 ]] && rm -rf "$reapdir"
			fi
		fi
		sleep 0.1
		waited=$((waited + 1))
		if [[ "$waited" -ge $((max_wait * 10)) ]]; then
			echo "Error: review lifecycle lock timeout for ${task_id} after ${max_wait}s" >&2
			return 1
		fi
	done
}

review_lifecycle_lock_release() {
	local task_id="$1" lockdir ownerfile held_token
	lockdir=$(review_lifecycle_lock_path "$task_id")
	ownerfile="${lockdir}/owner.json"
	[[ "${_REVIEW_LIFECYCLE_LOCK_OWNED:-}" == "$lockdir" ]] || return 0
	held_token=$(jq -r '.token // empty' "$ownerfile" 2>/dev/null || true)
	_REVIEW_LIFECYCLE_LOCK_OWNED=""
	if [[ -n "$held_token" && "$held_token" == "${_REVIEW_LIFECYCLE_LOCK_TOKEN:-}" ]]; then
		rm -rf "$lockdir" 2>/dev/null || true
	fi
	_REVIEW_LIFECYCLE_LOCK_TOKEN=""
}

_review_lifecycle_atomic_json_write() {
	local path="$1" json="$2" dir tmp
	dir=$(dirname "$path")
	mkdir -p "$dir" 2>/dev/null || return 1
	tmp=$(mktemp "${path}.tmp.XXXXXX") || return 1
	if printf '%s\n' "$json" | jq -c . >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$path"
		return 0
	fi
	rm -f "$tmp"
	return 1
}

# Move a stale lifecycle artifact out of the active namespace with one rename.
# The caller must hold the per-task review lock. Receipt and WAL quarantine
# directories live beside their respective active files, so mv(1) remains an
# atomic same-filesystem operation. Unique names preserve evidence across task
# ID reuse instead of allowing a later generation to overwrite the audit copy.
_review_lifecycle_quarantine_artifact_locked() {
	local task_id="$1" path="$2" kind="$3" reason="$4"
	local quarantine_dir safe_task safe_reason stamp nonce destination
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ -f "$path" ]] || return 0
	case "$kind" in
		receipt) quarantine_dir="$(_review_lifecycle_pending_dir)/quarantined" ;;
		wal) quarantine_dir="$(dirname "$path")/quarantined" ;;
		*) return 1 ;;
	esac
	safe_task=$(_review_lifecycle_safe_id "$task_id")
	safe_reason=$(_review_lifecycle_safe_id "$reason")
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	nonce=$(_review_lifecycle_new_id)
	destination="${quarantine_dir}/${safe_task}.${kind}.${safe_reason}.${stamp}.${nonce}.json"
	mkdir -p "$quarantine_dir" 2>/dev/null || return 1
	mv "$path" "$destination" || return 1
	printf '%s\n' "$destination"
}

_review_lifecycle_status_for_state() {
	case "$1" in
		reviewed) printf 'approved' ;;
		awaiting_fixup) printf 'changes_requested' ;;
		blocked) printf 'blocked' ;;
		*) printf 'pending' ;;
	esac
}

_review_lifecycle_task_projection() {
	jq -c '
		# Completion-owned commit metadata is copied only when the receipt has a
		# concrete value. Review lifecycle fields are different: the receipt is
		# authoritative, so null is a meaningful value that clears a prior claim,
		# reviewer task, artifact, failure, or fixup projection.
		. as $receipt
		| {
			review_last_commit: (.last_commit // null),
			review_end_commit: (.end_commit // null),
			agent_commit,
			manager_commit
		} | with_entries(select(.value != null)) as $metadata
		| ($receipt | {
			review_state,
			review_status,
			review_revision,
			review_attempt,
			review_dispatch_attempts,
			review_attempt_id,
			review_task_id,
			review_handoff_file,
			review_backend,
			review_mode,
			review_started_at,
			review_started_at_epoch,
			review_completed_at,
			review_blocker_count,
			reviewed,
			retry_disabled,
			retry_disabled_reason,
			retry_disabled_detail,
			retry_disabled_at,
			owner_review_gate,
			owner_review_state,
			owner_review_authorized,
			owner_review_authorized_at,
			owner_review_requested_at,
			owner_review_request_id,
			owner_review_reason,
			owner_review_blocked_at,
			review_dispatch_failed,
			review_dispatch_failed_at,
			review_dispatch_failed_reason,
			review_dispatch_failed_detail,
			review_dispatch_failed_log,
			review_artifact_sha256,
			pending_fixup_path: (.fixup_intent.fixup_path // null),
			review_fixup_intent: (.fixup_intent // null),
			review_transition_event,
			review_transition_at
		}) as $owned
		| $metadata + {review_task_generation: ($receipt.task_generation // null)} + $owned + {
			review: $owned,
			fixup_state: (if $owned.review_state == "awaiting_fixup" then "pending" else "none" end)
		}
	' 2>/dev/null
}

_review_lifecycle_source_dependencies() {
	local lib_dir
	lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
	if [[ -z "${TASKS_FILE+x}" ]]; then
		TASKS_FILE="${HOME}/.config/ghostty-launcher/tasks.json"
	fi
	if ! declare -f lock_tasks >/dev/null 2>&1; then
		# shellcheck source=tasks-lock.sh
		source "${lib_dir}/tasks-lock.sh"
	fi
	if ! declare -f work_system_emit_lane_ref_for_task >/dev/null 2>&1 && [[ -f "${lib_dir}/work-system-bridge.sh" ]]; then
		# shellcheck source=work-system-bridge.sh
		source "${lib_dir}/work-system-bridge.sh"
	fi
}

_review_lifecycle_sync_tasks_locked() {
	local task_id="$1" projection="$2" expected_generation="${3:-}" tasks_file
	tasks_file=$(_review_lifecycle_tasks_file)
	[[ -f "$tasks_file" ]] || return 1
	_tasks_json_apply --arg id "$task_id" --arg expected_generation "$expected_generation" --argjson review_projection "$projection" '
		if (.tasks[$id] // null) == null then error("missing task row for review lifecycle")
		elif ((.tasks[$id].task_generation // "") != $expected_generation) then error("task generation changed or was not supplied")
		else
			# Use a shallow merge for top-level lifecycle fields and replace the
			# nested review projection wholesale. Recursive multiplication would
			# retain keys omitted by older/newer receipts and defeats null clears.
			.tasks[$id] = ((.tasks[$id] + $review_projection) | .review = $review_projection.review)
		end
	'
}

# Prepare a terminal-task + review-publication transaction before the task row
# becomes terminal. The settle condition is generation-bound and lives in the
# same discoverable WAL namespace as ordinary review transitions. Recovery may
# therefore finish the terminal CAS, task projection, and receipt publication
# after the producer dies at any later point.
_review_lifecycle_prepare_terminal_locked() {
	local task_id="$1" receipt_json="$2" settle_condition="$3"
	local receipt_path wal_path projection wal_json task_generation input_generation
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	wal_path=$(review_lifecycle_wal_path "$task_id")
	_review_lifecycle_source_dependencies
	lock_tasks || return 1
	task_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$TASKS_FILE" 2>/dev/null || true)
	if ! jq -e --arg id "$task_id" '.tasks[$id] != null and (.tasks[$id].status // "") == "running"' "$TASKS_FILE" >/dev/null 2>&1; then
		unlock_tasks
		return 1
	fi
	input_generation=$(jq -r '.task_generation // empty' <<<"$receipt_json" 2>/dev/null || true)
	if [[ -n "$input_generation" && "$input_generation" != "$task_generation" ]]; then
		unlock_tasks
		return 3
	fi
	if ! jq -e --arg generation "$task_generation" '
		type == "object" and
		.task_generation == $generation and
		(.status | IN("completed", "failed")) and
		(.exit_code | type == "number" and floor == .) and
		(.completed_at | type == "string" and length > 0) and
		(.start_commit | type == "string") and
		(.end_commit | type == "string")
	' >/dev/null 2>&1 <<<"$settle_condition"; then
		unlock_tasks
		return 1
	fi
	receipt_json=$(jq -c --arg generation "$task_generation" '.task_generation = (if $generation == "" then null else $generation end)' <<<"$receipt_json") || {
		unlock_tasks
		return 1
	}
	if ! jq -e --argjson condition "$settle_condition" '
		.status == $condition.status and
		.exit_code == $condition.exit_code and
		.completed_at == $condition.completed_at
	' >/dev/null 2>&1 <<<"$receipt_json"; then
		unlock_tasks
		return 1
	fi
	projection=$(printf '%s\n' "$receipt_json" | _review_lifecycle_task_projection) || {
		unlock_tasks
		return 1
	}
	wal_json=$(jq -cn \
		--arg task_id "$task_id" \
		--arg receipt_path "$receipt_path" \
		--argjson receipt "$receipt_json" \
		--argjson projection "$projection" \
		--argjson settle_condition "$settle_condition" \
		'{version:2,transaction_kind:"terminal_review_publish",task_id:$task_id,receipt_path:$receipt_path,receipt:$receipt,task_projection:$projection,settle_condition:$settle_condition}') || {
		unlock_tasks
		return 1
	}
	if ! _review_lifecycle_atomic_json_write "$wal_path" "$wal_json"; then
		unlock_tasks
		return 1
	fi
	unlock_tasks
	[[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "wal" ]] && return 75
	printf '%s\n' "$receipt_json"
}

_review_lifecycle_commit_locked() {
	local task_id="$1" receipt_json="$2" receipt_path wal_path projection wal_json task_generation input_generation
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	wal_path=$(review_lifecycle_wal_path "$task_id")
	_review_lifecycle_source_dependencies
	lock_tasks || return 1
	task_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$TASKS_FILE" 2>/dev/null || true)
	if ! jq -e --arg id "$task_id" '.tasks[$id] != null' "$TASKS_FILE" >/dev/null 2>&1; then
		unlock_tasks
		return 1
	fi
	input_generation=$(jq -r '.task_generation // empty' <<<"$receipt_json" 2>/dev/null || true)
	if [[ -n "$input_generation" && "$input_generation" != "$task_generation" ]]; then
		unlock_tasks
		return 3
	fi
	receipt_json=$(jq -c --arg generation "$task_generation" '.task_generation = (if $generation == "" then null else $generation end)' <<<"$receipt_json") || {
		unlock_tasks
		return 1
	}
	projection=$(printf '%s\n' "$receipt_json" | _review_lifecycle_task_projection) || {
		unlock_tasks
		return 1
	}
	wal_json=$(jq -cn \
		--arg task_id "$task_id" \
		--arg receipt_path "$receipt_path" \
		--argjson receipt "$receipt_json" \
		--argjson projection "$projection" \
		'{version:1,task_id:$task_id,receipt_path:$receipt_path,receipt:$receipt,task_projection:$projection}') || {
		unlock_tasks
		return 1
	}
	if ! _review_lifecycle_atomic_json_write "$wal_path" "$wal_json"; then
		unlock_tasks
		return 1
	fi
	if [[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "wal" ]]; then
		unlock_tasks
		return 75
	fi
	if ! _review_lifecycle_sync_tasks_locked "$task_id" "$projection" "$task_generation"; then
		unlock_tasks
		return 1
	fi
	unlock_tasks
	[[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "tasks" ]] && return 75

	_review_lifecycle_atomic_json_write "$receipt_path" "$receipt_json" || return 1
	[[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "receipt" ]] && return 75
	rm -f "$wal_path"
	return 0
}

_review_lifecycle_recover_locked() {
	local task_id="$1" wal_path wal_task receipt_path expected_receipt_path receipt projection task_generation row_generation settle_condition wal_kind wal_version
	wal_path=$(review_lifecycle_wal_path "$task_id")
	[[ -f "$wal_path" ]] || return 0
	wal_task=$(jq -r '.task_id // empty' "$wal_path" 2>/dev/null || true)
	[[ "$wal_task" == "$task_id" ]] || return 1
	receipt_path=$(jq -r '.receipt_path // empty' "$wal_path" 2>/dev/null || true)
	expected_receipt_path=$(review_lifecycle_receipt_path "$task_id")
	receipt=$(jq -c '.receipt' "$wal_path" 2>/dev/null || true)
	projection=$(jq -c '.task_projection' "$wal_path" 2>/dev/null || true)
	settle_condition=$(jq -c '.settle_condition // null' "$wal_path" 2>/dev/null || true)
	wal_kind=$(jq -r '.transaction_kind // empty' "$wal_path" 2>/dev/null || true)
	wal_version=$(jq -r '.version // empty' "$wal_path" 2>/dev/null || true)
	task_generation=$(jq -r '.receipt.task_generation // empty' "$wal_path" 2>/dev/null || true)
	[[ -n "$receipt_path" && -n "$receipt" && -n "$projection" && -n "$settle_condition" ]] || return 1
	[[ "$receipt_path" == "$expected_receipt_path" ]] || return 1
	jq -e --arg task_id "$task_id" '.task_id == $task_id' >/dev/null 2>&1 <<<"$receipt" || return 1

	_review_lifecycle_source_dependencies
	lock_tasks || return 1
	if ! jq -e --arg id "$task_id" '.tasks[$id] != null' "$TASKS_FILE" >/dev/null 2>&1; then
		unlock_tasks
		return 1
	fi
	row_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ "$task_generation" != "$row_generation" ]]; then
		unlock_tasks
		# A WAL belongs to exactly one task generation. Empty/empty retains the
		# legacy-row contract; an unbound WAL can never enter a generated row.
		_review_lifecycle_quarantine_artifact_locked "$task_id" "$wal_path" wal "stale-task-generation" >/dev/null || return 1
		if [[ -f "$receipt_path" ]]; then
			local active_receipt_generation
			active_receipt_generation=$(jq -r '.task_generation // empty' "$receipt_path" 2>/dev/null || true)
			if [[ -z "$active_receipt_generation" || "$active_receipt_generation" != "$row_generation" ]]; then
				_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "stale-task-generation" >/dev/null || return 1
			fi
		fi
		return 0
	fi
	if [[ "$settle_condition" != "null" ]]; then
		[[ "$wal_version" == "2" && "$wal_kind" == "terminal_review_publish" ]] || {
			unlock_tasks
			return 1
		}
		if ! jq -e --arg generation "$task_generation" '
			type == "object" and
			.task_generation == $generation and
			(.status | IN("completed", "failed")) and
			(.exit_code | type == "number" and floor == .) and
			(.completed_at | type == "string" and length > 0) and
			(.start_commit | type == "string") and
			(.end_commit | type == "string")
		' >/dev/null 2>&1 <<<"$settle_condition"; then
			unlock_tasks
			return 1
		fi
		if ! jq -e --argjson condition "$settle_condition" '
			.status == $condition.status and
			.exit_code == $condition.exit_code and
			.completed_at == $condition.completed_at
		' >/dev/null 2>&1 <<<"$receipt"; then
			unlock_tasks
			return 1
		fi
		if ! _tasks_json_apply \
			--arg id "$task_id" \
			--arg generation "$task_generation" \
			--argjson condition "$settle_condition" '
			if (.tasks[$id] // null) == null then error("missing task row")
			elif ((.tasks[$id].task_generation // "") != $generation) then error("task generation changed")
			elif ((.tasks[$id].status // "") == "running") then
				.tasks[$id].status=$condition.status |
				.tasks[$id].exit_code=$condition.exit_code |
				.tasks[$id].completed_at=$condition.completed_at |
				.tasks[$id].start_commit=(if $condition.start_commit=="" then null else $condition.start_commit end) |
				.tasks[$id].end_commit=(if $condition.end_commit=="" then null else $condition.end_commit end)
			elif ((.tasks[$id].status // "") == $condition.status and
				(.tasks[$id].exit_code // null) == $condition.exit_code and
				(.tasks[$id].completed_at // "") == $condition.completed_at and
				(.tasks[$id].start_commit // "") == $condition.start_commit and
				(.tasks[$id].end_commit // "") == $condition.end_commit) then .
			else error("task terminal state conflicts with prepared review publication")
			end
		'; then
			unlock_tasks
			return 1
		fi
		if [[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "terminal" ]]; then
			unlock_tasks
			return 75
		fi
	fi
	if ! _review_lifecycle_sync_tasks_locked "$task_id" "$projection" "$task_generation"; then
		unlock_tasks
		return 1
	fi
	unlock_tasks
	[[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "tasks" ]] && return 75
	_review_lifecycle_atomic_json_write "$receipt_path" "$receipt" || return 1
	[[ "${OSTE_REVIEW_LIFECYCLE_FAIL_AFTER:-}" == "receipt" ]] && return 75
	rm -f "$wal_path"
}

_review_lifecycle_emit_after_settle() {
	local task_id="$1" tasks_file status
	_review_lifecycle_source_dependencies
	declare -f work_system_emit_lane_ref_for_task >/dev/null 2>&1 || return 0
	tasks_file=$(_review_lifecycle_tasks_file)
	status=$(jq -r --arg id "$task_id" '.tasks[$id].status // empty' "$tasks_file" 2>/dev/null || true)
	[[ -n "$status" ]] || return 0
	work_system_emit_lane_ref_for_task "$tasks_file" "$task_id" "$status" || true
}

review_lifecycle_recover() {
	local task_id="$1" rc=0
	_review_lifecycle_validate_task_id "$task_id" || return 1
	review_lifecycle_lock_acquire "$task_id" || return 1
	_review_lifecycle_recover_locked "$task_id" || rc=$?
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	_review_lifecycle_emit_after_settle "$task_id"
}

# Persist the complete review receipt and its terminal task-state precondition
# before a synchronous producer publishes the terminal row. No receipt becomes
# visible here. review_lifecycle_recover performs (or verifies) the terminal CAS
# and then publishes the task projection and receipt from this WAL.
review_lifecycle_prepare_terminal_publish() {
	local task_id="$1" input_json="$2" settle_condition="$3"
	local receipt_path wal_path current_state status now request_id receipt current_generation existing_generation rc=0
	_review_lifecycle_validate_task_id "$task_id" || return 1
	review_lifecycle_lock_acquire "$task_id" || return 1
	_review_lifecycle_recover_locked "$task_id" || {
		rc=$?
		review_lifecycle_lock_release "$task_id"
		return "$rc"
	}
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	wal_path=$(review_lifecycle_wal_path "$task_id")
	if [[ -f "$wal_path" ]]; then
		# A transaction that recovery could not settle must not be overwritten by
		# a second intent for the same task generation.
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ -f "$receipt_path" ]]; then
		current_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$(_review_lifecycle_tasks_file)" 2>/dev/null || true)
		existing_generation=$(jq -r '.task_generation // empty' "$receipt_path" 2>/dev/null || true)
		if ! jq -e --arg id "$task_id" '.task_id == $id' "$receipt_path" >/dev/null 2>&1 ||
			[[ -z "$existing_generation" || "$existing_generation" != "$current_generation" ]]; then
			_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "stale-terminal-publish" >/dev/null || {
				review_lifecycle_lock_release "$task_id"
				return 1
			}
		else
			review_lifecycle_lock_release "$task_id"
			return 3
		fi
	fi
	current_state=$(jq -r '.review_state // "pending"' <<<"$input_json" 2>/dev/null || true)
	case "$current_state" in
		pending | owner_waiting | blocked) ;;
		*)
			review_lifecycle_lock_release "$task_id"
			return 1
			;;
	esac
	status=$(_review_lifecycle_status_for_state "$current_state")
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	request_id=""
	[[ "$current_state" == "owner_waiting" ]] && request_id=$(_review_lifecycle_new_id)
	receipt=$(jq -c \
		--arg task_id "$task_id" \
		--arg state "$current_state" \
		--arg status "$status" \
		--arg now "$now" \
		--arg request_id "$request_id" '
		.task_id = $task_id |
		.review_state = $state |
		.review_status = $status |
		.review_revision = 1 |
		.review_attempt = 0 |
		.review_attempt_id = null |
		.reviewed = false |
		.retry_disabled = ($state == "blocked") |
		.owner_review_request_id = (if $request_id == "" then (.owner_review_request_id // null) else $request_id end) |
		.review_transition_event = "publish" |
		.review_transition_at = $now
	' <<<"$input_json" 2>/dev/null) || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	_review_lifecycle_prepare_terminal_locked "$task_id" "$receipt" "$settle_condition" || rc=$?
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	printf '%s\n' "$receipt"
}

review_lifecycle_publish_json() {
	local task_id="$1" input_json="$2" receipt_path current_state status now request_id receipt rc=0
	local reuse_publish=false
	_review_lifecycle_validate_task_id "$task_id" || return 1
	review_lifecycle_lock_acquire "$task_id" || return 1
	_review_lifecycle_recover_locked "$task_id" || {
		rc=$?
		review_lifecycle_lock_release "$task_id"
		return "$rc"
	}
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	if [[ -f "$receipt_path" ]] && ! jq -e . "$receipt_path" >/dev/null 2>&1; then
		_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "malformed-receipt" >/dev/null || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		reuse_publish=true
	fi
	if [[ -f "$receipt_path" ]] && jq -e . "$receipt_path" >/dev/null 2>&1; then
		receipt=$(jq -c . "$receipt_path")
		_review_lifecycle_source_dependencies
		lock_tasks || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		local current_task_generation receipt_task_generation task_row receipt_task_id receipt_state
		current_task_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$TASKS_FILE" 2>/dev/null || true)
		receipt_task_generation=$(jq -r '.task_generation // empty' <<<"$receipt")
		task_row=$(jq -c --arg id "$task_id" '.tasks[$id] // null' "$TASKS_FILE" 2>/dev/null || true)
		receipt_task_id=$(jq -r '.task_id // empty' <<<"$receipt")
		receipt_state=$(jq -r '.review_state // "pending"' <<<"$receipt")
		if [[ -z "$task_row" || "$task_row" == "null" ]]; then
			unlock_tasks
			review_lifecycle_lock_release "$task_id"
			return 3
		fi
		if [[ "$receipt_task_id" != "$task_id" ]]; then
			unlock_tasks
			_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "task-identity-mismatch" >/dev/null || {
				review_lifecycle_lock_release "$task_id"
				return 1
			}
			reuse_publish=true
		elif [[ -n "$receipt_task_generation" && "$current_task_generation" != "$receipt_task_generation" ]]; then
			unlock_tasks
			_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "stale-task-generation" >/dev/null || {
				review_lifecycle_lock_release "$task_id"
				return 1
			}
			reuse_publish=true
		elif [[ -z "$receipt_task_generation" && -n "$current_task_generation" && "$receipt_state" != "owner_waiting" ]]; then
			unlock_tasks
			_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "unbound-legacy-receipt" >/dev/null || {
				review_lifecycle_lock_release "$task_id"
				return 1
			}
			reuse_publish=true
		# Migrate a same-task legacy owner wait only when a concrete route exists
		# and agrees with the current task owner. Migration never authorizes it.
		elif [[ -z "$receipt_task_generation" && "$receipt_state" == "owner_waiting" ]]; then
			local row_session row_workroom row_work_item receipt_session receipt_workroom receipt_work_item request_id
			row_session=$(jq -r '.session_key // empty' <<<"$task_row")
			row_workroom=$(jq -r '.workroom_ref // empty' <<<"$task_row")
			row_work_item=$(jq -r '.work_item_ref // empty' <<<"$task_row")
			receipt_session=$(jq -r '.session_key // empty' <<<"$receipt")
			receipt_workroom=$(jq -r '.workroom_ref // empty' <<<"$receipt")
			receipt_work_item=$(jq -r '.work_item_ref // empty' <<<"$receipt")
			if [[ -z "$row_session" || (-z "$row_workroom" && -z "$row_work_item") ]] ||
				[[ -n "$receipt_session" && "$receipt_session" != "$row_session" ]] ||
				[[ -n "$receipt_workroom" && "$receipt_workroom" != "$row_workroom" ]] ||
				[[ -n "$receipt_work_item" && "$receipt_work_item" != "$row_work_item" ]]; then
				unlock_tasks
				review_lifecycle_lock_release "$task_id"
				return 3
			fi
			request_id=$(jq -r '.owner_review_request_id // empty' <<<"$receipt")
			[[ -n "$request_id" ]] || request_id=$(_review_lifecycle_new_id)
			receipt=$(jq -c --arg session "$row_session" --arg workroom "$row_workroom" --arg work_item "$row_work_item" --arg request_id "$request_id" '
				.session_key=$session |
				.workroom_ref=(if $workroom=="" then null else $workroom end) |
				.work_item_ref=(if $work_item=="" then null else $work_item end) |
				.owner_review_gate=true |
				.owner_review_state="waiting" |
				.owner_review_authorized=false |
				.owner_review_authorized_at=null |
				.owner_review_request_id=$request_id
			' <<<"$receipt") || {
				unlock_tasks
				review_lifecycle_lock_release "$task_id"
				return 1
			}
		fi
		[[ "$reuse_publish" == "true" ]] || unlock_tasks
		if [[ "$reuse_publish" == "true" ]]; then
			receipt=""
		else
			# Re-commit even an already generated receipt: this repairs a missing or
			# stale tasks.json projection through the same WAL protocol as mutations.
			_review_lifecycle_commit_locked "$task_id" "$receipt" || rc=$?
			review_lifecycle_lock_release "$task_id"
			[[ "$rc" -eq 0 ]] || return "$rc"
			_review_lifecycle_emit_after_settle "$task_id"
			receipt=$(jq -c . "$receipt_path" 2>/dev/null || printf '%s' "$receipt")
			printf '%s\n' "$receipt"
			return 0
		fi
	fi
	current_state=$(jq -r '.review_state // "pending"' <<<"$input_json" 2>/dev/null || true)
	case "$current_state" in
		pending | owner_waiting | blocked) ;;
		*)
			review_lifecycle_lock_release "$task_id"
			return 1
			;;
	esac
	status=$(_review_lifecycle_status_for_state "$current_state")
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	request_id=""
	[[ "$current_state" == "owner_waiting" ]] && request_id=$(_review_lifecycle_new_id)
	receipt=$(jq -c \
		--arg task_id "$task_id" \
		--arg state "$current_state" \
		--arg status "$status" \
		--arg now "$now" \
		--arg request_id "$request_id" '
		.task_id = $task_id |
		.review_state = $state |
		.review_status = $status |
		.review_revision = 1 |
		.review_attempt = 0 |
		.review_attempt_id = null |
		.reviewed = false |
		.retry_disabled = ($state == "blocked") |
		.owner_review_request_id = (if $request_id == "" then (.owner_review_request_id // null) else $request_id end) |
		.review_transition_event = "publish" |
		.review_transition_at = $now
	' <<<"$input_json" 2>/dev/null) || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	_review_lifecycle_commit_locked "$task_id" "$receipt" || rc=$?
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	_review_lifecycle_emit_after_settle "$task_id"
	printf '%s\n' "$receipt"
}

_review_lifecycle_target_for_event() {
	local current="$1" event="$2"
	case "${current}:${event}" in
		owner_waiting:owner_wait) printf 'owner_waiting' ;;
		owner_waiting:owner_ready) printf 'pending' ;;
		owner_waiting:owner_block | pending:owner_block) printf 'blocked' ;;
		pending:claim) printf 'reviewing' ;;
		reviewing:spawn_failed | reviewing:watchdog_reset) printf 'pending' ;;
		reviewing:approve) printf 'reviewed' ;;
		reviewing:request_fixup) printf 'awaiting_fixup' ;;
		pending:legacy_fixup) printf 'awaiting_fixup' ;;
		pending:invalidate | owner_waiting:invalidate | reviewing:invalidate) printf 'blocked' ;;
		pending:legacy_approve) printf 'reviewed' ;;
		owner_waiting:legacy_route_repair | blocked:legacy_route_repair) printf 'owner_waiting' ;;
		owner_waiting:legacy_unroutable) printf 'blocked' ;;
		owner_waiting:owner_sla_expired) printf 'blocked' ;;
		pending:quarantine) printf 'blocked' ;;
		pending:metadata | owner_waiting:metadata | reviewing:metadata | reviewed:metadata | awaiting_fixup:metadata | blocked:metadata) printf '%s' "$current" ;;
		*) return 1 ;;
	esac
}

# review_lifecycle_transition TASK EVENT EXPECTED_REV EXPECTED_ATTEMPT_ID PATCH_JSON
# Prints the committed receipt.  Return 3 is a lost CAS; return 4 is an illegal
# transition.  Callers must treat both as a no-op, never retry with weaker CAS.
review_lifecycle_transition() {
	local task_id="$1" event="$2" expected_revision="${3:-}" expected_attempt_id="${4:-}" patch_json="${5:-}" expected_owner_request_id="${6:-}"
	local receipt_path current current_state current_revision current_attempt_id target status now receipt rc=0
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ -n "$patch_json" ]] || patch_json='{}'
	review_lifecycle_lock_acquire "$task_id" || return 1
	_review_lifecycle_recover_locked "$task_id" || {
		rc=$?
		review_lifecycle_lock_release "$task_id"
		return "$rc"
	}
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	[[ -f "$receipt_path" ]] || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	current=$(jq -c . "$receipt_path" 2>/dev/null || true)
	[[ -n "$current" ]] || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	# A mutation can never bind an ungenerated legacy receipt to a newer task
	# generation. The only compatibility binding is the routed owner-wait
	# migration in review_lifecycle_publish_json above.
	_review_lifecycle_source_dependencies
	lock_tasks || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	local row_generation receipt_generation task_row
	row_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_row=$(jq -c --arg id "$task_id" '.tasks[$id] // null' "$TASKS_FILE" 2>/dev/null || true)
	receipt_generation=$(jq -r '.task_generation // empty' <<<"$current")
	if ! jq -e --arg id "$task_id" '.tasks[$id] != null' "$TASKS_FILE" >/dev/null 2>&1; then
		unlock_tasks
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ "$row_generation" != "$receipt_generation" ]]; then
		unlock_tasks
		_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "stale-task-generation" >/dev/null || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ "$event" == "legacy_route_repair" || "$event" == "legacy_unroutable" ]]; then
		local row_session row_workroom row_work_item receipt_session receipt_workroom receipt_work_item route_conflict=false
		row_session=$(jq -r '.session_key // empty' <<<"$task_row")
		row_workroom=$(jq -r '.workroom_ref // empty' <<<"$task_row")
		row_work_item=$(jq -r '.work_item_ref // empty' <<<"$task_row")
		receipt_session=$(jq -r '.session_key // empty' <<<"$current")
		receipt_workroom=$(jq -r '.workroom_ref // empty' <<<"$current")
		receipt_work_item=$(jq -r '.work_item_ref // empty' <<<"$current")
		if [[ -n "$receipt_session" && "$receipt_session" != "$row_session" ]] ||
			[[ -n "$receipt_workroom" && "$receipt_workroom" != "$row_workroom" ]] ||
			[[ -n "$receipt_work_item" && "$receipt_work_item" != "$row_work_item" ]]; then
			route_conflict=true
		fi
		if ! jq -e \
			--arg generation "$row_generation" \
			--arg session "$row_session" \
			--arg workroom "$row_workroom" \
			--arg work_item "$row_work_item" '
			.owner_route_snapshot.task_generation == $generation and
			.owner_route_snapshot.session_key == $session and
			.owner_route_snapshot.workroom_ref == $workroom and
			.owner_route_snapshot.work_item_ref == $work_item
		' >/dev/null 2>&1 <<<"$patch_json"; then
			unlock_tasks
			review_lifecycle_lock_release "$task_id"
			return 3
		fi
		if [[ "$event" == "legacy_route_repair" ]]; then
			if [[ -z "$row_session" || (-z "$row_workroom" && -z "$row_work_item") || "$route_conflict" == "true" ]]; then
				unlock_tasks
				review_lifecycle_lock_release "$task_id"
				return 4
			fi
		elif [[ -n "$row_session" && (-n "$row_workroom" || -n "$row_work_item") && "$route_conflict" == "false" ]]; then
			unlock_tasks
			review_lifecycle_lock_release "$task_id"
			return 4
		fi
	fi
	unlock_tasks
	current_state=$(jq -r '.review_state // "pending"' <<<"$current")
	current_revision=$(jq -r '.review_revision // 0' <<<"$current")
	current_attempt_id=$(jq -r '.review_attempt_id // empty' <<<"$current")
	if [[ ! "$expected_revision" =~ ^[0-9]+$ ]] || [[ "$expected_revision" != "$current_revision" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ "$current_state" == "reviewing" ]] && [[ "$event" =~ ^(approve|request_fixup|spawn_failed|watchdog_reset|invalidate|metadata)$ ]] &&
		[[ -z "$expected_attempt_id" ]] && [[ -n "$receipt_generation" || "$event" != "metadata" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ -n "$expected_attempt_id" && "$expected_attempt_id" != "$current_attempt_id" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ "$event" =~ ^owner_(wait|ready|block)$ ]] && [[ -z "$expected_owner_request_id" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ -n "$expected_owner_request_id" ]] && [[ "$expected_owner_request_id" != "$(jq -r '.owner_review_request_id // empty' <<<"$current")" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	target=$(_review_lifecycle_target_for_event "$current_state" "$event") || {
		review_lifecycle_lock_release "$task_id"
		return 4
	}
	if [[ "$event" == "owner_block" && "$current_state" == "pending" ]] &&
		! jq -e '.owner_review_state == "authorized" and .owner_review_authorized == true' >/dev/null <<<"$current"; then
		review_lifecycle_lock_release "$task_id"
		return 4
	fi
	if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$patch_json"; then
		review_lifecycle_lock_release "$task_id"
		return 1
	fi
	if [[ "$event" == "request_fixup" ]] && ! jq -e \
		--arg task_id "$task_id" \
		--arg attempt_id "$current_attempt_id" \
		--arg task_generation "$receipt_generation" '
		.fixup_intent as $intent |
		($intent | type == "object") and
		($intent.version == 1) and
		($intent.task_id == $task_id) and
		($intent.task_generation == $task_generation) and
		($intent.review_attempt_id == $attempt_id) and
		($intent.fixup_path | type == "string" and length > 0) and
		($intent.payload | type == "object") and
		($intent.payload.task_id == $task_id) and
		($intent.payload.task_generation == $task_generation) and
		($intent.payload.review_attempt_id == $attempt_id) and
		($intent.payload.project_path | type == "string" and length > 0) and
		($intent.payload.review_file | type == "string" and length > 0) and
		($intent.payload.blocker_count | type == "number" and floor == . and . > 0) and
		($intent.payload.attempt | type == "number" and floor == . and . > 0)
	' >/dev/null 2>&1 <<<"$patch_json"; then
		# Do not enter awaiting_fixup until the WAL/receipt has a complete,
		# attempt-bound payload from which the external queue can be repaired.
		review_lifecycle_lock_release "$task_id"
		return 1
	fi
	status=$(_review_lifecycle_status_for_state "$target")
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	receipt=$(jq -c \
		--argjson patch "$(jq -c 'del(.owner_route_snapshot)' <<<"$patch_json")" \
		--arg state "$target" \
		--arg status "$status" \
		--arg event "$event" \
		--arg now "$now" \
		--argjson revision "$((current_revision + 1))" '
		. * $patch |
		.review_state = $state |
		.review_status = $status |
		.review_revision = $revision |
		.review_transition_event = $event |
		.review_transition_at = $now |
		if $state == "reviewed" then
			.reviewed = true |
			.review_completed_at = (.review_completed_at // $now) |
			.review_blocker_count = 0 |
			.retry_disabled = false |
			.retry_disabled_reason = null |
			.retry_disabled_detail = null |
			.retry_disabled_at = null
		elif $state == "awaiting_fixup" then
			.reviewed = false |
			.review_completed_at = (.review_completed_at // $now) |
			.retry_disabled = true |
			.retry_disabled_reason = "awaiting_fixup" |
			.retry_disabled_at = $now
		elif $state == "blocked" then
			.reviewed = false |
			.review_completed_at = (.review_completed_at // $now) |
			.retry_disabled = true |
			.retry_disabled_at = (.retry_disabled_at // $now)
		elif $state == "pending" then
			.reviewed = false |
			.review_completed_at = null |
			.review_blocker_count = null |
			.review_attempt_id = null |
			.review_task_id = null |
			.review_handoff_file = null
		else . end
	' <<<"$current" 2>/dev/null) || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	_review_lifecycle_commit_locked "$task_id" "$receipt" || rc=$?
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	_review_lifecycle_emit_after_settle "$task_id"
	printf '%s\n' "$receipt"
}

review_lifecycle_claim() {
	local task_id="$1" review_backend="${2:-}" review_mode="${3:-}" expected_revision="${4:-}" requested_task_id="${5:-}"
	local receipt_path current current_revision attempt attempt_id review_task_id now now_epoch patch
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	[[ -f "$receipt_path" ]] || return 1
	[[ "$expected_revision" =~ ^[0-9]+$ ]] || return 3
	current=$(jq -c . "$receipt_path" 2>/dev/null || true)
	current_revision=$(jq -r '.review_revision // 0' <<<"$current")
	attempt=$(($(jq -r '.review_attempt // 0' <<<"$current") + 1))
	attempt_id=$(_review_lifecycle_new_id)
	local slug hash
	if [[ -n "$requested_task_id" ]]; then
		slug=$(printf '%s' "${requested_task_id#review-}" | LC_ALL=C sed -E 's/[^A-Za-z0-9._-]+/-/g' | cut -c1-72)
	else
		slug=$(printf '%s' "$task_id" | LC_ALL=C sed -E 's/[^A-Za-z0-9._-]+/-/g' | cut -c1-72)
	fi
	hash=$(printf '%s' "$task_id" | shasum -a 256 | awk '{print substr($1,1,10)}')
	review_task_id="review-${slug}-${hash}-a${attempt}"
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	now_epoch=$(date -u +%s)
	patch=$(jq -cn \
		--argjson attempt "$attempt" \
		--arg attempt_id "$attempt_id" \
		--arg review_task_id "$review_task_id" \
		--arg backend "$review_backend" \
		--arg mode "$review_mode" \
		--arg now "$now" \
		--argjson now_epoch "$now_epoch" '
		{
			review_attempt:$attempt,
			review_dispatch_attempts:$attempt,
			review_attempt_id:$attempt_id,
			review_task_id:$review_task_id,
			review_backend:(if $backend == "" then null else $backend end),
			review_mode:(if $mode == "" then null else $mode end),
			review_started_at:$now,
			review_started_at_epoch:$now_epoch,
			review_completed_at:null,
			review_blocker_count:null,
			review_dispatch_failed:false,
			review_dispatch_failed_at:null,
			review_dispatch_failed_reason:null,
			review_dispatch_failed_detail:null,
			review_dispatch_failed_log:null
		}')
	review_lifecycle_transition "$task_id" claim "$expected_revision" "" "$patch"
}
