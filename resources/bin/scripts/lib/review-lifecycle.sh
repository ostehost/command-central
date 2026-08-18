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

# PAR-595: the immutable source envelope that every downstream dispatch of this
# task's review outcome (fixup, retry, replay) must carry and revalidate.
#
# Derived ONLY from the durable receipt plus the caller's already-validated
# lifecycle coordinates — never from ambient env. A cron-invoked consumer
# inherits whatever workroom/session/callback its own process happened to have;
# treating that as the routing for someone else's issue is precisely the
# cross-workroom leak PAR-595 closes. Empty strings normalize to null so a
# "present but blank" route can never read as bound.
review_lifecycle_source_envelope() {
	local task_id="$1" task_generation="$2" review_attempt_id="$3" receipt_path="${4:-}"
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ -n "$task_generation" && -n "$review_attempt_id" ]] || return 1
	[[ -n "$receipt_path" ]] || receipt_path=$(review_lifecycle_receipt_path "$task_id") || return 1
	[[ -s "$receipt_path" ]] || return 1
	jq -ce \
		--arg task_id "$task_id" \
		--arg task_generation "$task_generation" \
		--arg review_attempt_id "$review_attempt_id" '
		def blank_to_null: if . == null or . == "" then null else . end;
		{
			version: 1,
			task_id: $task_id,
			task_generation: $task_generation,
			review_attempt_id: $review_attempt_id,
			work_item_ref: (.work_item_ref | blank_to_null),
			workroom_ref: (.workroom_ref | blank_to_null),
			session_key: (.session_key | blank_to_null),
			callback_url: (.callback_url | blank_to_null)
		}' "$receipt_path" 2>/dev/null
}

# A source lane that carries an issue or a workroom is workroom-bound: its
# fixup must be able to report back into the same issue/workroom through the
# same owning session. A lane with neither is a detached local lane and stays
# dispatchable without owner routing.
review_lifecycle_envelope_is_workroom_bound() {
	jq -e '((.work_item_ref // "") != "") or ((.workroom_ref // "") != "")' \
		>/dev/null 2>&1 <<<"${1:-null}"
}

# Routing completeness for a workroom-bound envelope: the issue, the workroom,
# the owning session, and the callback that wakes it must ALL be present. A
# partial route is what produced an orphaned fixup nobody could review.
review_lifecycle_envelope_routing_complete() {
	local envelope="${1:-null}"
	review_lifecycle_envelope_is_workroom_bound "$envelope" || return 0
	jq -e '
		((.work_item_ref // "") != "") and
		((.workroom_ref // "") != "") and
		((.session_key // "") != "") and
		((.callback_url // "") != "")' >/dev/null 2>&1 <<<"$envelope"
}

# ── Fixup quarantine tombstones (PAR-595) ───────────────────────────
#
# Quarantining a fixup queue projection is a verdict, not a pause. Nothing
# durable used to record that verdict, so the rejection was invisible to
# everyone else: `pending_review_materialize_fixup_intent` re-projected the very
# same payload from the receipt on the next watchdog tick, the orchestrator
# rejected it again, and the two churned forever — and any replay of the
# rejected payload got a fresh adjudication it had already been denied.
#
# A tombstone is keyed by the immutable lineage (task + generation + review
# attempt) AND by a canonical digest of the rejected document. That is the whole
# rule: re-presenting the same bytes for the same lineage is a replay and is
# refused without a claim, a spawn, or a publication. A genuinely different
# projection — a repaired envelope, say — is a different document and is
# adjudicated on its own merits rather than being condemned by lineage alone.
review_lifecycle_fixup_claim_dir() {
	printf '%s' "${OSTE_FIXUP_CLAIM_DIR:-$(_review_lifecycle_tasks_file).review-fixup-claims}"
}

review_lifecycle_fixup_projection_digest() {
	local projection="${1:-}" canonical digest
	canonical=$(jq -S -c . <<<"$projection" 2>/dev/null) || return 1
	[[ -n "$canonical" && "$canonical" != "null" ]] || return 1
	digest=$(printf '%s' "$canonical" | shasum -a 256 | awk '{print substr($1,1,24)}')
	[[ -n "$digest" ]] || return 1
	printf '%s' "$digest"
}

# Tombstones live in their own subdirectory of the claim directory: they are
# verdicts, not delivery claims, and every scan of the claim directory reads
# exactly one kind of record.
review_lifecycle_fixup_quarantine_path() {
	local task_id="$1" task_generation="$2" review_attempt_id="$3" projection_digest="$4"
	local safe_id lineage
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ -n "$task_generation" && -n "$review_attempt_id" && -n "$projection_digest" ]] || return 1
	safe_id=$(_review_lifecycle_safe_id "$task_id")
	# Same lineage digest the dispatch claim path uses, so a claim and its
	# quarantine verdicts always share one key.
	lineage=$(printf '%s\n%s\n' "$task_generation" "$review_attempt_id" | shasum -a 256 | awk '{print substr($1,1,24)}')
	[[ -n "$lineage" ]] || return 1
	printf '%s/quarantined/%s.%s.%s.json' \
		"$(review_lifecycle_fixup_claim_dir)" "$safe_id" "$lineage" "$projection_digest"
}

review_lifecycle_fixup_projection_is_quarantined() {
	local task_id="$1" task_generation="$2" review_attempt_id="$3" projection="${4:-}"
	local digest path
	digest=$(review_lifecycle_fixup_projection_digest "$projection") || return 1
	path=$(review_lifecycle_fixup_quarantine_path "$task_id" "$task_generation" "$review_attempt_id" "$digest") || return 1
	[[ -f "$path" ]]
}

review_lifecycle_record_fixup_quarantine() {
	local task_id="$1" task_generation="$2" review_attempt_id="$3" projection="${4:-}" reason="${5:-}"
	local digest path json now
	digest=$(review_lifecycle_fixup_projection_digest "$projection") || return 1
	path=$(review_lifecycle_fixup_quarantine_path "$task_id" "$task_generation" "$review_attempt_id" "$digest") || return 1
	# The first verdict is the record. A replay of the same document must not
	# rewrite when or why it was condemned.
	if [[ -f "$path" ]]; then
		return 0
	fi
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	json=$(jq -cn \
		--arg task_id "$task_id" \
		--arg task_generation "$task_generation" \
		--arg review_attempt_id "$review_attempt_id" \
		--arg projection_digest "$digest" \
		--arg reason "$reason" \
		--arg quarantined_at "$now" '
		{
			version:1,
			task_id:$task_id,
			task_generation:$task_generation,
			review_attempt_id:$review_attempt_id,
			projection_digest:$projection_digest,
			reason:(if $reason == "" then null else $reason end),
			quarantined_at:$quarantined_at
		}') || return 1
	(umask 077 && _review_lifecycle_atomic_json_write "$path" "$json")
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

# Documented degraded-authority reasons (PAR-551). A `reviewed` receipt is
# terminal review truth: the ONLY sanctioned way to retry it is a replacement
# request that names which review authority was proven degraded. Blind retries
# stay impossible — an unlisted reason fails closed.
#
#   degraded_engine_receipt  — the reviewer engine receipt itself is degraded
#                              (for example verdict: unknown, a no-op session
#                              id), so the approval rests on no real evidence
#   degraded_reviewer_verdict — the reviewer produced a verdict its own artifact
#                              does not support
#   degraded_review_evidence — the attempt's artifact/commit evidence is missing
#                              or unreadable after the fact
#   degraded_review_session  — the reviewer session died or was replaced before
#                              it could produce authoritative output
_review_lifecycle_replacement_reason_allowed() {
	case "$1" in
		degraded_engine_receipt | degraded_reviewer_verdict | degraded_review_evidence | degraded_review_session) return 0 ;;
		*) return 1 ;;
	esac
}

# Documented dead-delivery reasons (PAR-595). `awaiting_fixup` had no exit at
# all, so an attempt whose fixup delivery died stranded its lane forever. The
# two reasons below name the exact two delivery verdicts the fixup orchestrator
# documents as never re-probed and never promoted:
#
#   failed_fixup_delivery        — spawn returned nonzero, so the delivery never
#                                  produced a lane and a row bearing this lane
#                                  id would not prove that it did
#   indeterminate_fixup_delivery — the orchestrator died at the delivery
#                                  boundary; whether spawn ran at all is never
#                                  re-decided
#
# Every other verdict is either still live (`delivery_started`), still
# re-probable (`no_task_row`, `row_unverified`), or a real publication
# (`dispatched`), and none of those is recoverable here. The reason is not a
# label: it must equal the verdict the settled audit record carries, so an
# operator cannot recover an attempt by asserting a death it did not observe.
_review_lifecycle_recovery_reason_allowed() {
	case "$1" in
		failed_fixup_delivery | indeterminate_fixup_delivery) return 0 ;;
		*) return 1 ;;
	esac
}

# The delivery verdict each recovery reason is defined over. Prints the verdict
# the settled audit record must carry for that reason to be usable.
_review_lifecycle_recovery_reason_delivery_state() {
	case "$1" in
		failed_fixup_delivery) printf 'failed' ;;
		indeterminate_fixup_delivery) printf 'indeterminate' ;;
		*) return 1 ;;
	esac
}

# Identity a generic metadata patch may never reassign: minting a fresh owner
# request, clearing `reviewed`, or re-pointing attempt/reviewer-task/replacement
# identity belongs to the dedicated lifecycle operations (claim,
# replacement_request) alone. These keys are dropped from every metadata patch
# rather than rejected — reconcile/repair callers legitimately pass whole-receipt
# patches authored before the lock, so a patch that merely *carries* a now-stale
# identity is a normal repair, not a forgery attempt, and must still settle.
# Dropping them leaves the locked receipt's own identity authoritative.
#
# `review_attempt` and `review_dispatch_attempts` are frozen here for the same
# reason but protect a distinct invariant: they are monotonic counters that only
# `claim` may advance. A metadata patch that lowered them would (a) re-arm the
# dispatch circuit breaker into unbounded retries, and (b) make the next claim
# re-derive an ALREADY-USED `review-<slug>-<hash>-a<attempt>` identity — so a
# superseded reviewer task id (and its `-attempt-N` handoff path) could be
# reused, colliding with the immutable archive that supersedes it. A stale
# whole-receipt reconcile patch authored before a claim carries exactly such a
# lower value, so this is a live ordering hazard and not only a forgery guard.
_REVIEW_LIFECYCLE_METADATA_FROZEN_FIELDS='[
	"autoreview_evidence",
	"issue_scheduler",
	"reviewed",
	"review_attempt",
	"review_dispatch_attempts",
	"review_attempt_id",
	"review_claim_revision",
	"review_task_id",
	"review_execution_mode",
	"review_execution_node",
	"review_artifact_path",
	"review_artifact_source_path",
	"review_artifact_sha256",
	"owner_review_request_id",
	"review_replacement_count",
	"review_replacement_of_attempt_id",
	"review_replacement_reason",
	"review_replacement_detail",
	"review_replacement_requested_at",
	"review_replacement_request_id",
	"review_replacement_history",
	"review_failed_attempt_recovery_count",
	"review_recovered_from_attempt_id",
	"review_recovery_reason",
	"review_recovery_request_id",
	"review_failed_attempt_recovery_history"
]'

_review_lifecycle_hash_regular_file_nofollow() {
	python3 - "$1" <<'PY'
import hashlib
import os
import stat
import sys

fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise OSError("not a regular file")
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
    ):
        raise OSError("file changed while hashing")
    print(digest.hexdigest())
finally:
    os.close(fd)
PY
}

# Preserve a superseded terminal receipt as uniquely named historical evidence
# before any successor state can be authorized or dispatched. The caller must
# hold the per-task review lock. The archive lives beside the active receipt so
# the publishing rename stays atomic on one filesystem, is read-only so a later
# replacement cycle cannot overwrite or silently mutate the original
# approval/attempt/request identity it records, and is nonce-named so repeated
# replacement cycles (or task ID reuse) each keep their own copy.
#
# The third argument is the state the receipt must still be in — it names the
# archive and is re-verified on the published copy. It defaults to `reviewed`
# (the PAR-551 replacement path); `awaiting_fixup` is the PAR-595 failed-attempt
# recovery path, whose stranded receipt is preserved by exactly this mechanism.
_review_lifecycle_archive_reviewed_locked() {
	local task_id="$1" receipt_json="$2" archived_state="${3:-reviewed}"
	local history_dir safe_task safe_attempt safe_state attempt_id stamp nonce destination
	_review_lifecycle_validate_task_id "$task_id" || return 1
	history_dir="$(_review_lifecycle_pending_dir)/history"
	attempt_id=$(jq -r '.review_attempt_id // "no-attempt"' <<<"$receipt_json" 2>/dev/null || true)
	[[ -n "$attempt_id" ]] || return 1
	safe_task=$(_review_lifecycle_safe_id "$task_id")
	safe_attempt=$(_review_lifecycle_safe_id "$attempt_id")
	safe_state=$(_review_lifecycle_safe_id "$archived_state")
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	nonce=$(_review_lifecycle_new_id)
	[[ -n "$nonce" ]] || return 1
	destination="${history_dir}/${safe_task}.${safe_state}.${safe_attempt}.${stamp}.${nonce}.json"
	mkdir -p "$history_dir" 2>/dev/null || return 1
	[[ -e "$destination" ]] && return 1
	_review_lifecycle_atomic_json_write "$destination" "$receipt_json" || return 1
	chmod 444 "$destination" 2>/dev/null || true
	# Re-read the published copy: a successor state is only allowed to proceed
	# once the preserved evidence is provably on disk and identity-complete.
	jq -e --arg id "$task_id" --arg state "$archived_state" \
		'.task_id == $id and .review_state == $state and (.review_attempt_id | type == "string")' \
		"$destination" >/dev/null 2>&1 || return 1
	printf '%s\n' "$destination"
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
		} | with_entries(select(.value != null and .value != "")) as $metadata
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
			review_dispatch_cleared,
			review_artifact_sha256,
			review_replacement_count,
			review_replacement_of_attempt_id,
			review_replacement_reason,
			review_replacement_requested_at,
			review_replacement_history,
			review_failed_attempt_recovery_count,
			review_recovered_from_attempt_id,
			review_recovery_reason,
			review_failed_attempt_recovery_history,
			review_autoreview_evidence: (.autoreview_evidence // null),
			# Type gate: every other .fixup_intent consumer gates first, and an
			# ungated index on a scalar/array aborts this whole projection — both
			# call sites turn that into `return 1`, failing the entire review
			# publish for the task with no diagnostic (stderr is swallowed below).
			pending_fixup_path: (if (.fixup_intent | type) == "object"
				then (.fixup_intent.fixup_path // null) else null end),
			review_fixup_intent: (.fixup_intent // null),
			review_external_adoption: (.external_review_adoption // null),
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
		# The ONLY sanctioned import of an out-of-band review result (PAR-595).
		# It consumes the outstanding owner request, mints one attempt, and lands
		# attempt-bound in awaiting_fixup in a single CAS'd transaction.
		owner_waiting:external_review_adopt) printf 'awaiting_fixup' ;;
		# The ONLY exit from awaiting_fixup (PAR-595). Reachable only for an
		# attempt whose fixup delivery is provably dead and unpublished. Like
		# replacement_request it lands in owner_waiting, never in a dispatchable
		# state: recovery buys a fresh owner decision, not a retry.
		awaiting_fixup:failed_attempt_recovery) printf 'owner_waiting' ;;
		pending:invalidate | owner_waiting:invalidate | reviewing:invalidate) printf 'blocked' ;;
		pending:legacy_approve) printf 'reviewed' ;;
		# The only exit from terminal `reviewed` (PAR-551). It lands in
		# owner_waiting, never directly in a dispatchable state: a replacement
		# review always costs a fresh owner decision.
		reviewed:replacement_request) printf 'owner_waiting' ;;
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
	# Canonical autoreview evidence is NEVER a generic transition: its payload
	# byte authentication, helper value pinning, and replay adjudication all
	# happen inside the one dedicated lock-owning persistence operation
	# (review_lifecycle_record_autoreview_evidence). A direct caller of this
	# public entry point carries no authenticated payload, so the event is
	# rejected outright as an illegal transition.
	if [[ "$event" == "autoreview_evidence" ]]; then
		return 4
	fi
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
	# A replacement supersedes one specific completed attempt. Without the prior
	# attempt identity there is nothing to supersede, so it can never be a
	# revision-only reopen of whatever happens to be terminal right now.
	if [[ "$event" == "replacement_request" ]] && [[ -z "$expected_attempt_id" || -z "$expected_owner_request_id" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	# A recovery supersedes one specific dead attempt. Without both the attempt
	# identity and the owner request it consumes there is nothing to supersede,
	# so it can never become a revision-only reopen of whatever happens to be
	# stranded right now.
	if [[ "$event" == "failed_attempt_recovery" ]] && [[ -z "$expected_attempt_id" || -z "$expected_owner_request_id" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ -n "$expected_attempt_id" && "$expected_attempt_id" != "$current_attempt_id" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ "$event" =~ ^(owner_(wait|ready|block)|external_review_adopt|failed_attempt_recovery)$ ]] && [[ -z "$expected_owner_request_id" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	if [[ -n "$expected_owner_request_id" ]] && [[ "$expected_owner_request_id" != "$(jq -r '.owner_review_request_id // empty' <<<"$current")" ]]; then
		review_lifecycle_lock_release "$task_id"
		return 3
	fi
	# Duplicate-dispatch guard (plan step 4): once the CURRENT attempt holds a
	# recorded autoreview evidence record, neither a watchdog reset nor a
	# spawn-failure retry may tear the attempt down — that teardown is exactly
	# how a settled review got re-dispatched. Distinct rc 6 so the watchdog
	# observes an evidence-guard refusal (and skips) rather than a lost CAS;
	# consuming the evidence into a terminal state stays a separately
	# authorized workroom decision.
	if [[ "$event" =~ ^(watchdog_reset|spawn_failed)$ ]] &&
		jq -e --arg attempt_id "$current_attempt_id" \
			'.autoreview_evidence != null and .autoreview_evidence.review_attempt_id == $attempt_id' \
			>/dev/null 2>&1 <<<"$current"; then
		review_lifecycle_lock_release "$task_id"
		return 6
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
	# A replacement request must prove, under the lock, that it was authored
	# against this exact terminal attempt: revision, attempt id, reviewer task
	# id, and the consumed owner request all have to match the live receipt, and
	# the degraded-authority reason has to be one of the documented codes.
	if [[ "$event" == "replacement_request" ]] && ! jq -e \
		--arg task_id "$task_id" \
		--arg task_generation "$receipt_generation" \
		--arg attempt_id "$current_attempt_id" \
		--arg review_task_id "$(jq -r '.review_task_id // empty' <<<"$current")" \
		--arg owner_request_id "$expected_owner_request_id" \
		--argjson revision "$current_revision" '
		.review_replacement_request as $request |
		($request | type == "object") and
		($request.version == 1) and
		($request.task_id == $task_id) and
		($request.task_generation == $task_generation) and
		($request.prior_review_revision == $revision) and
		($request.prior_review_attempt_id == $attempt_id) and
		($request.prior_review_task_id == $review_task_id) and
		($request.prior_owner_review_request_id == $owner_request_id) and
		($request.reason | type == "string" and length > 0) and
		($request.detail | type == "string" and length > 0) and
		($request.requested_at | type == "string" and length > 0)
	' >/dev/null 2>&1 <<<"$patch_json"; then
		review_lifecycle_lock_release "$task_id"
		return 1
	fi
	if [[ "$event" == "replacement_request" ]] &&
		! _review_lifecycle_replacement_reason_allowed "$(jq -r '.review_replacement_request.reason // empty' <<<"$patch_json")"; then
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
	# PAR-595: adopting an out-of-band review is a lifecycle-authored transition,
	# never a hand-edited receipt. Under the lock the patch must prove it was
	# authored against THIS receipt — generation, end commit, prior attempt
	# lineage, and the owner request it consumes — and must carry both the
	# adoption record and the fixup intent bound to the SAME newly minted
	# attempt. Anything less would let an import mint an attempt or an intent the
	# lifecycle never authorized.
	if [[ "$event" == "external_review_adopt" ]] && ! jq -e \
		--arg task_id "$task_id" \
		--arg task_generation "$receipt_generation" \
		--arg end_commit "$(jq -r '.end_commit // empty' <<<"$current")" \
		--arg prior_attempt_id "$current_attempt_id" \
		--arg owner_request_id "$expected_owner_request_id" \
		--argjson prior_attempt "$(jq -r '.review_attempt // 0' <<<"$current")" '
		.external_review_adoption as $adoption |
		($adoption | type == "object") and
		($adoption.version == 1) and
		($adoption.task_id == $task_id) and
		($adoption.task_generation == $task_generation) and
		($adoption.source_end_commit == $end_commit) and
		($adoption.source_end_commit | type == "string" and length > 0) and
		(($adoption.prior_review_attempt_id // "") == $prior_attempt_id) and
		($adoption.prior_review_attempt == $prior_attempt) and
		($adoption.owner_review_request_id == $owner_request_id) and
		($adoption.artifact_sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
		($adoption.adoption_key | type == "string" and test("^[0-9a-f]{64}$")) and
		($adoption.artifact_path | type == "string" and length > 0) and
		($adoption.source_artifact_path | type == "string" and length > 0) and
		($adoption.finding_count | type == "number" and floor == . and . > 0) and
		($adoption.review_attempt_id | type == "string" and length > 0) and
		($adoption.review_attempt == ($prior_attempt + 1)) and
		(.review_attempt == $adoption.review_attempt) and
		(.review_dispatch_attempts == $adoption.review_attempt) and
		(.review_attempt_id == $adoption.review_attempt_id) and
		(.review_blocker_count == $adoption.finding_count) and
		(.review_artifact_sha256 == $adoption.artifact_sha256) and
		(.fixup_intent | type == "object") and
		(.fixup_intent.version == 1) and
		(.fixup_intent.task_id == $task_id) and
		(.fixup_intent.task_generation == $task_generation) and
		(.fixup_intent.review_attempt_id == $adoption.review_attempt_id) and
		(.fixup_intent.fixup_path | type == "string" and length > 0) and
		(.fixup_intent.payload | type == "object") and
		(.fixup_intent.payload.task_id == $task_id) and
		(.fixup_intent.payload.task_generation == $task_generation) and
		(.fixup_intent.payload.review_attempt_id == $adoption.review_attempt_id) and
		(.fixup_intent.payload.review_file == $adoption.artifact_path) and
		(.fixup_intent.payload.project_path | type == "string" and length > 0) and
		(.fixup_intent.payload.blocker_count == $adoption.finding_count) and
		(.fixup_intent.payload.attempt == $adoption.review_attempt)
	' >/dev/null 2>&1 <<<"$patch_json"; then
		review_lifecycle_lock_release "$task_id"
		return 1
	fi
	# PAR-595: recovering a stranded awaiting_fixup lane is a lifecycle-authored
	# transition, never a hand-edited receipt. Under the lock the patch must prove
	# it was authored against THIS receipt — generation, revision, the exact dead
	# attempt (number AND id), and the owner request it consumes — and must name
	# the settled audit record and terminal delivery verdict it acted on. The
	# evidence document itself is read and digested by review-recovery.sh, exactly
	# as the adopted artifact is read by review-import.sh; what this layer
	# adjudicates is that the recovery record is bound to the live lineage and
	# that its reason is one the delivery verdict actually supports.
	if [[ "$event" == "failed_attempt_recovery" ]]; then
		if ! jq -e \
			--arg task_id "$task_id" \
			--arg task_generation "$receipt_generation" \
			--arg attempt_id "$current_attempt_id" \
			--arg owner_request_id "$expected_owner_request_id" \
			--argjson revision "$current_revision" \
			--argjson attempt "$(jq -r '.review_attempt // 0' <<<"$current")" '
			.review_failed_attempt_recovery as $recovery |
			($recovery | type == "object") and
			($recovery.version == 1) and
			($recovery.task_id == $task_id) and
			($recovery.task_generation == $task_generation) and
			($recovery.prior_review_revision == $revision) and
			($recovery.prior_review_attempt == $attempt) and
			($recovery.prior_review_attempt_id == $attempt_id) and
			($recovery.prior_owner_review_request_id == $owner_request_id) and
			($recovery.evidence_path | type == "string" and length > 0) and
			($recovery.evidence_digest | type == "string" and length > 0) and
			($recovery.delivery_state | type == "string" and length > 0) and
			($recovery.settled_at | type == "string" and length > 0) and
			($recovery.reason | type == "string" and length > 0) and
			($recovery.detail | type == "string" and length > 0) and
			($recovery.requested_at | type == "string" and length > 0) and
			(.fixup_intent == null or (.fixup_intent | type == "object"))
		' >/dev/null 2>&1 <<<"$patch_json"; then
			review_lifecycle_lock_release "$task_id"
			return 1
		fi
		local recovery_reason recovery_delivery_state
		recovery_reason=$(jq -r '.review_failed_attempt_recovery.reason' <<<"$patch_json")
		recovery_delivery_state=$(jq -r '.review_failed_attempt_recovery.delivery_state' <<<"$patch_json")
		if ! _review_lifecycle_recovery_reason_allowed "$recovery_reason" ||
			[[ "$(_review_lifecycle_recovery_reason_delivery_state "$recovery_reason")" != "$recovery_delivery_state" ]]; then
			review_lifecycle_lock_release "$task_id"
			return 1
		fi
	fi
	status=$(_review_lifecycle_status_for_state "$target")
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	local merge_patch
	merge_patch=$(jq -c 'del(.owner_route_snapshot)' <<<"$patch_json") || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	# The evidence object has exactly one writer: the dedicated lock-owning
	# persistence operation (review_lifecycle_record_autoreview_evidence).
	# Every event through this generic entry point — including whole-receipt
	# repair patches routed through metadata — has it stripped from the patch,
	# so a stale or forged copy can neither overwrite nor delete the record.
	merge_patch=$(jq -c 'del(.autoreview_evidence)' <<<"$merge_patch") || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	if [[ "$event" == "metadata" ]]; then
		merge_patch=$(jq -c --argjson frozen "$_REVIEW_LIFECYCLE_METADATA_FROZEN_FIELDS" \
			'delpaths([$frozen[] | [.]])' <<<"$merge_patch") || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
	fi
	receipt=$(jq -c \
		--argjson patch "$merge_patch" \
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
			.review_handoff_file = null |
			.review_claim_revision = null |
			# Attempt-scoped execution and artifact authority must die with the
			# attempt that minted it. record_artifact is first-write-wins (rc=5
			# when any artifact field is already set), so a receipt reset back to
			# pending while still carrying the previous authority can never have
			# the next artifact recorded: the lane wedges permanently, costing a
			# real reviewer spawn and an orphaned mode-400 artifact per retry.
			# The two sibling reset paths below already clear exactly these.
			.review_execution_mode = null |
			.review_execution_node = null |
			.review_artifact_path = null |
			.review_artifact_source_path = null |
			.review_artifact_sha256 = null
		else . end |
		# D7/H13: the immutable claim-era revision binding. Stamped ONLY here,
		# under the claim CAS, as the exact revision this attempt starts at;
		# evidence persistence requires evidence.review_revision to equal it
		# exactly. Cleared whenever the attempt identity is cleared.
		(if $event == "claim" then .review_claim_revision = $revision else . end)
	' <<<"$current" 2>/dev/null) || {
		review_lifecycle_lock_release "$task_id"
		return 1
	}
	if [[ "$event" == "replacement_request" ]]; then
		local replacement_archive replacement_request_id
		# Historical evidence first: the prior reviewed receipt is preserved (and
		# proven readable) before the replacement receipt is written at all, so no
		# crash ordering can produce an active replacement whose superseded
		# approval was never archived. A failed archive fails the transition.
		replacement_archive=$(_review_lifecycle_archive_reviewed_locked "$task_id" "$current") || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		# The fresh owner request id is minted here, never supplied by the caller:
		# the previously consumed request must lose the owner CAS from this point
		# on, and only this operation may allocate its successor.
		replacement_request_id=$(_review_lifecycle_new_id)
		[[ -n "$replacement_request_id" ]] || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		receipt=$(jq -c \
			--argjson prior "$current" \
			--arg archive "$replacement_archive" \
			--arg request_id "$replacement_request_id" \
			--arg now "$now" '
			.review_replacement_request as $request |
			del(.review_replacement_request) |
			# Reviewer identity is cleared so the replacement claim must allocate a
			# new attempt id and derive a new review task id. review_attempt and
			# review_dispatch_attempts stay monotonic: the dispatch circuit breaker
			# keeps counting, so this is one sanctioned attempt, not a retry reset.
			.reviewed = false |
			.review_completed_at = null |
			.review_blocker_count = null |
			.review_attempt_id = null |
			.review_task_id = null |
			.review_handoff_file = null |
			.review_claim_revision = null |
			.review_backend = null |
			.review_mode = null |
			.review_started_at = null |
			.review_started_at_epoch = null |
			.review_execution_mode = null |
			.review_execution_node = null |
			.review_artifact_path = null |
			.review_artifact_source_path = null |
			.review_artifact_sha256 = null |
			.fixup_delivery_attempt = null |
			.fixup_delivery_task_id = null |
			.fixup_delivery_state = null |
			.fixup_delivery_detail = null |
			.fixup_delivery_receipt_path = null |
			.fixup_delivery_receipt = null |
			.fixup_delivery_settled_at = null |
			.review_dispatch_failed = false |
			.review_dispatch_failed_at = null |
			.review_dispatch_failed_reason = null |
			.review_dispatch_failed_detail = null |
			.review_dispatch_failed_log = null |
			.retry_disabled = false |
			.retry_disabled_reason = null |
			.retry_disabled_detail = null |
			.retry_disabled_at = null |
			# Authorization resets to waiting/false against a brand new request id.
			.owner_review_gate = true |
			.owner_review_state = "waiting" |
			.owner_review_authorized = false |
			.owner_review_authorized_at = null |
			.owner_review_blocked_at = null |
			.owner_review_request_id = $request_id |
			.owner_review_requested_at = $now |
			.owner_review_reason = ($request.reason + ": " + $request.detail) |
			.review_replacement_count = (($prior.review_replacement_count // 0) + 1) |
			.review_replacement_of_attempt_id = $request.prior_review_attempt_id |
			.review_replacement_reason = $request.reason |
			.review_replacement_detail = $request.detail |
			.review_replacement_requested_at = $request.requested_at |
			.review_replacement_request_id = $request_id |
			.review_replacement_history = (($prior.review_replacement_history // []) + [{
				review_revision: $request.prior_review_revision,
				review_attempt: ($prior.review_attempt // null),
				review_attempt_id: $request.prior_review_attempt_id,
				review_task_id: $request.prior_review_task_id,
				owner_review_request_id: $request.prior_owner_review_request_id,
				owner_review_authorized_at: ($prior.owner_review_authorized_at // null),
				review_state: ($prior.review_state // null),
				review_status: ($prior.review_status // null),
				reviewed: ($prior.reviewed // null),
				review_completed_at: ($prior.review_completed_at // null),
				review_backend: ($prior.review_backend // null),
				review_mode: ($prior.review_mode // null),
				review_handoff_file: ($prior.review_handoff_file // null),
				prior_receipt_archive: $archive,
				replacement_reason: $request.reason,
				replacement_detail: $request.detail,
				replacement_request_id: $request_id,
				replaced_at: $now
			}])
		' <<<"$receipt" 2>/dev/null) || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
	fi
	if [[ "$event" == "failed_attempt_recovery" ]]; then
		local recovery_archive recovery_request_id
		# Historical evidence first, exactly as a replacement does: the stranded
		# awaiting_fixup receipt — the only receipt-side record of the dead attempt
		# and its intent — is preserved and proven readable before any recovered
		# state is written. A failed archive fails the transition.
		recovery_archive=$(_review_lifecycle_archive_reviewed_locked "$task_id" "$current" awaiting_fixup) || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		# Fresh authority is minted here, never supplied by the caller: the owner
		# request the dead attempt consumed must lose the owner CAS from this point
		# on, and only this operation may allocate its successor.
		recovery_request_id=$(_review_lifecycle_new_id)
		[[ -n "$recovery_request_id" ]] || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
		receipt=$(jq -c \
			--argjson prior "$current" \
			--arg archive "$recovery_archive" \
			--arg request_id "$recovery_request_id" \
			--arg now "$now" '
			.review_failed_attempt_recovery as $recovery |
			del(.review_failed_attempt_recovery) |
			# The dead attempt keeps its immutable audit record in the fixup queue;
			# what is dropped here is every handle that could still ACT on it. The
			# intent goes first: while it survives, any repair tick could re-project
			# the dead attempt back into the queue.
			del(.fixup_intent) |
			.reviewed = false |
			.review_completed_at = null |
			.review_blocker_count = null |
			.review_attempt_id = null |
			.review_task_id = null |
			.review_handoff_file = null |
			.review_claim_revision = null |
			.review_backend = null |
			.review_mode = null |
			.review_started_at = null |
			.review_started_at_epoch = null |
			.review_execution_mode = null |
			.review_execution_node = null |
			.review_artifact_path = null |
			.review_artifact_source_path = null |
			.review_artifact_sha256 = null |
			.fixup_delivery_attempt = null |
			.fixup_delivery_task_id = null |
			.fixup_delivery_state = null |
			.fixup_delivery_detail = null |
			.fixup_delivery_receipt_path = null |
			.fixup_delivery_receipt = null |
			.fixup_delivery_settled_at = null |
			.review_dispatch_failed = false |
			.review_dispatch_failed_at = null |
			.review_dispatch_failed_reason = null |
			.review_dispatch_failed_detail = null |
			.review_dispatch_failed_log = null |
			# review_attempt and review_dispatch_attempts stay monotonic: the
			# dispatch circuit breaker keeps counting, so this is one sanctioned
			# recovery, not a retry reset.
			.retry_disabled = false |
			.retry_disabled_reason = null |
			.retry_disabled_detail = null |
			.retry_disabled_at = null |
			# Authorization resets to waiting/false against a brand new request id,
			# so nothing downstream can be reviewed or fixed up under the authority
			# the dead attempt already consumed.
			.owner_review_gate = true |
			.owner_review_state = "waiting" |
			.owner_review_authorized = false |
			.owner_review_authorized_at = null |
			.owner_review_blocked_at = null |
			.owner_review_request_id = $request_id |
			.owner_review_requested_at = $now |
			.owner_review_reason = ($recovery.reason + ": " + $recovery.detail) |
			.review_failed_attempt_recovery_count = (($prior.review_failed_attempt_recovery_count // 0) + 1) |
			.review_recovered_from_attempt_id = $recovery.prior_review_attempt_id |
			.review_recovery_reason = $recovery.reason |
			.review_recovery_request_id = $request_id |
			.review_failed_attempt_recovery_history = (($prior.review_failed_attempt_recovery_history // []) + [{
				prior_review_revision: $recovery.prior_review_revision,
				prior_review_attempt: $recovery.prior_review_attempt,
				prior_review_attempt_id: $recovery.prior_review_attempt_id,
				prior_owner_review_request_id: $recovery.prior_owner_review_request_id,
				prior_review_state: ($prior.review_state // null),
				prior_review_status: ($prior.review_status // null),
				prior_review_handoff_file: ($prior.review_handoff_file // null),
				prior_fixup_path: ($prior.fixup_intent.fixup_path // null),
				evidence_path: $recovery.evidence_path,
				evidence_digest: $recovery.evidence_digest,
				delivery_state: $recovery.delivery_state,
				delivery_detail: ($recovery.delivery_detail // null),
				settled_at: $recovery.settled_at,
				prior_receipt_archive: $archive,
				recovery_reason: $recovery.reason,
				recovery_detail: $recovery.detail,
				recovery_requested_at: $recovery.requested_at,
				recovery_request_id: $request_id,
				recovered_at: $now
			}])
		' <<<"$receipt" 2>/dev/null) || {
			review_lifecycle_lock_release "$task_id"
			return 1
		}
	fi
	_review_lifecycle_commit_locked "$task_id" "$receipt" || rc=$?
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	_review_lifecycle_emit_after_settle "$task_id"
	printf '%s\n' "$receipt"
}

# Lazy, fail-closed loader for the shared autoreview contract. The contract
# lives adjacent to this file (the deployment closure carries both together)
# and is consumed ONLY at the autoreview-evidence boundary, so legacy
# lifecycle behavior never depends on it. The guard is a namespaced function
# plus readonly-definition check, never an environment flag: inherited
# environment variables show as `declare -x`, and an exported function cannot
# fake the readonly attribute, so ambient environment can neither suppress
# loading nor satisfy it. A missing, unreadable, or incoherent contract makes
# every evidence persistence attempt fail closed.
_review_lifecycle_load_autoreview_contract() {
	if declare -f autoreview_contract_loaded >/dev/null 2>&1 &&
		[[ "$(declare -p AUTOREVIEW_CONTRACT_SHA256 2>/dev/null)" == "declare -r"* ]]; then
		return 0
	fi
	local lib_dir
	lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
	[[ -f "${lib_dir}/autoreview-contract.sh" ]] || return 1
	# shellcheck source=autoreview-contract.sh
	source "${lib_dir}/autoreview-contract.sh" || return 1
	declare -f autoreview_contract_loaded >/dev/null 2>&1 || return 1
}

# Persist the immutable review artifact authority under the attempt lock. Generic
# metadata cannot write these fields; the exact source and durable bytes must both
# match the claimed digest before the first record wins permanently.
review_lifecycle_record_artifact() {
	local task_id="$1" expected_revision="${2:-}" expected_attempt_id="${3:-}"
	local durable_path="${4:-}" source_path="${5:-}" expected_digest="${6:-}"
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ "$expected_revision" =~ ^[0-9]+$ && -n "$expected_attempt_id" ]] || return 3
	[[ "$durable_path" == /* && "$source_path" == /* && "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	review_lifecycle_lock_acquire "$task_id" || return 1
	local rc=0 receipt_path current current_revision current_attempt_id durable_digest source_digest durable_mode now receipt
	_review_lifecycle_recover_locked "$task_id" || rc=$?
	if [[ "$rc" -eq 0 ]]; then
		receipt_path=$(review_lifecycle_receipt_path "$task_id")
		[[ -f "$receipt_path" ]] || rc=1
	fi
	if [[ "$rc" -eq 0 ]]; then
		current=$(jq -c . "$receipt_path" 2>/dev/null || true)
		[[ -n "$current" ]] || rc=1
	fi
	if [[ "$rc" -eq 0 ]]; then
		current_revision=$(jq -r '.review_revision // 0' <<<"$current")
		current_attempt_id=$(jq -r '.review_attempt_id // empty' <<<"$current")
		durable_mode=$(stat -f '%Lp' "$durable_path" 2>/dev/null || true)
		durable_digest=$(_review_lifecycle_hash_regular_file_nofollow "$durable_path" 2>/dev/null || true)
		source_digest=$(_review_lifecycle_hash_regular_file_nofollow "$source_path" 2>/dev/null || true)
		if [[ "$durable_mode" != "400" || "$durable_digest" != "$expected_digest" || "$source_digest" != "$expected_digest" ]]; then
			rc=1
		elif jq -e --arg path "$durable_path" --arg source "$source_path" --arg digest "$expected_digest" \
			--arg attempt "$expected_attempt_id" '
			.review_attempt_id == $attempt and
			.review_artifact_path == $path and
			.review_artifact_source_path == $source and
			.review_artifact_sha256 == $digest
		' >/dev/null 2>&1 <<<"$current"; then
			receipt="$current"
		elif [[ "$(jq -r '.review_state // empty' <<<"$current")" != "reviewing" ]]; then
			rc=4
		elif [[ "$current_revision" != "$expected_revision" || "$current_attempt_id" != "$expected_attempt_id" ]]; then
			rc=3
		elif jq -e '(.review_artifact_path // null) != null or
			(.review_artifact_source_path // null) != null or
			(.review_artifact_sha256 // null) != null' >/dev/null 2>&1 <<<"$current"; then
			rc=5
		else
			now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
			receipt=$(jq -c --arg path "$durable_path" --arg source "$source_path" \
				--arg digest "$expected_digest" --arg now "$now" \
				--argjson revision "$((current_revision + 1))" '
					.review_artifact_path = $path |
					.review_artifact_source_path = $source |
					.review_artifact_sha256 = $digest |
					.review_revision = $revision |
					.review_transition_event = "review_artifact" |
					.review_transition_at = $now
				' <<<"$current" 2>/dev/null) || rc=1
			if [[ "$rc" -eq 0 ]]; then
				_review_lifecycle_commit_locked "$task_id" "$receipt" || rc=$?
			fi
		fi
	fi
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	_review_lifecycle_emit_after_settle "$task_id"
	printf '%s\n' "$receipt"
}

# review_lifecycle_record_autoreview_evidence TASK EXPECTED_REV EXPECTED_ATTEMPT_ID \
#     EXPECTED_OWNER_REQUEST_ID EVIDENCE_JSON PAYLOAD_FILE
#
# The ONE autoreview-evidence persistence authority. The public
# review_lifecycle_transition rejects the autoreview_evidence event outright;
# this operation owns the per-task lock for the whole chain instead: recover
# -> generation/state/revision/attempt/owner CAS -> hash the exact payload
# bytes -> re-prove receipt semantics and all nine bindings from those bytes
# -> enforce the canonical helper policy by VALUE against the shared contract
# -> adjudicate replay/collision -> commit + project. Nothing checked before
# the lock is trusted after it; every proof above happens under the same lock
# that commits.
#
# The caller cannot claim verification by digest alone: the exact
# authenticated payload bytes must be presented and are hashed exactly as
# stored — never parsed and re-serialized. Helper identity is value-pinned:
# policy_version, normalized origin, revision, relpath, and executable
# SHA-256 must equal the contract exactly; realpath stays shape-only
# (absolute, ends with /relpath) because checkout roots legitimately differ
# per host. Evidence must also carry review_revision equal to the immutable
# claim-stamped review_claim_revision of the live attempt (D7/H13).
#
# This records EVIDENCE, not a verdict: state stays `reviewing`, `reviewed`
# stays false, and a clean receipt becomes closeout-ELIGIBLE only — the
# workroom keeps the final receipt-gated decision.
#
# rc 0 committed, or byte-equivalent replay of the committed record; rc 1
# schema, payload-authentication, contract-availability, or helper-policy
# failure; rc 3 lost CAS (stale revision/attempt/owner-request/generation,
# coordinates that do not match the live receipt, or a claim-revision
# mismatch); rc 4 illegal state; rc 5 authority collision — the same attempt
# already holds different evidence, and the first record wins.
review_lifecycle_record_autoreview_evidence() {
	local task_id="$1" expected_revision="${2:-}" expected_attempt_id="${3:-}"
	local expected_owner_request_id="${4:-}" evidence_json="${5:-}" payload_file="${6:-}"
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ -n "$expected_attempt_id" && -n "$expected_owner_request_id" ]] || return 1
	jq -e 'type == "object"' >/dev/null 2>&1 <<<"$evidence_json" || return 1
	[[ -s "$payload_file" ]] || return 1
	_review_lifecycle_load_autoreview_contract || return 1
	review_lifecycle_lock_acquire "$task_id" || return 1
	local rc=0 committed
	committed=$(_review_lifecycle_record_autoreview_evidence_locked "$task_id" \
		"$expected_revision" "$expected_attempt_id" "$expected_owner_request_id" \
		"$evidence_json" "$payload_file") || rc=$?
	review_lifecycle_lock_release "$task_id"
	[[ "$rc" -eq 0 ]] || return "$rc"
	_review_lifecycle_emit_after_settle "$task_id"
	printf '%s\n' "$committed"
}

# The lock-held autoreview persistence primitive. Callable only with the
# authenticated payload bytes in hand — there is no digest-only entry — and
# only while review_lifecycle_record_autoreview_evidence holds the per-task
# lock. Prints the committed (or replay-committed) receipt.
_review_lifecycle_record_autoreview_evidence_locked() {
	local task_id="$1" expected_revision="${2:-}" expected_attempt_id="${3:-}"
	local expected_owner_request_id="${4:-}" evidence_json="${5:-}" payload_file="${6:-}"
	local rc=0
	_review_lifecycle_recover_locked "$task_id" || return $?
	local receipt_path current
	receipt_path=$(review_lifecycle_receipt_path "$task_id")
	[[ -f "$receipt_path" ]] || return 1
	current=$(jq -c . "$receipt_path" 2>/dev/null || true)
	[[ -n "$current" ]] || return 1
	# Generation CAS against the task row, identical in effect to the generic
	# transition's: a receipt from a superseded generation is quarantined, and
	# the write loses.
	_review_lifecycle_source_dependencies
	lock_tasks || return 1
	local row_generation receipt_generation
	row_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$TASKS_FILE" 2>/dev/null || true)
	receipt_generation=$(jq -r '.task_generation // empty' <<<"$current")
	if ! jq -e --arg id "$task_id" '.tasks[$id] != null' "$TASKS_FILE" >/dev/null 2>&1; then
		unlock_tasks
		return 3
	fi
	unlock_tasks
	if [[ "$row_generation" != "$receipt_generation" ]]; then
		_review_lifecycle_quarantine_artifact_locked "$task_id" "$receipt_path" receipt "stale-task-generation" >/dev/null || return 1
		return 3
	fi
	# Evidence records only against a live claimed attempt.
	[[ "$(jq -r '.review_state // "pending"' <<<"$current")" == "reviewing" ]] || return 4
	# Authenticate the payload bytes UNDER THE LOCK: the digest is computed
	# from the presented file here and now, and both evidence digest fields
	# must equal it.
	local payload_digest
	payload_digest=$(shasum -a 256 "$payload_file" 2>/dev/null | awk '{print $1}')
	[[ "$payload_digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	jq -e --arg digest "$payload_digest" \
		'.stdout_artifact_digest == $digest and .payload_sha256 == $digest' \
		>/dev/null 2>&1 <<<"$evidence_json" || return 1
	# Exact allowlisted schema, sourced from the shared contract: twenty
	# evidence keys, six helper keys, distinct version axes, and the
	# conservative status→posture map.
	jq -e \
		--argjson evidence_keys "$AUTOREVIEW_CONTRACT_EVIDENCE_KEYS_JSON" \
		--argjson helper_keys "$AUTOREVIEW_CONTRACT_HELPER_KEYS_JSON" \
		--argjson posture_map "$AUTOREVIEW_CONTRACT_POSTURE_MAP_JSON" \
		--argjson schema_version "$AUTOREVIEW_CONTRACT_EVIDENCE_SCHEMA_VERSION" \
		--argjson receipt_version "$AUTOREVIEW_CONTRACT_RECEIPT_VERSION" '
		type == "object" and
		(keys == $evidence_keys) and
		(.version == $schema_version) and
		(.receipt_version == $receipt_version) and
		(.helper | type == "object" and keys == $helper_keys) and
		(.stdout_artifact_digest | type == "string" and test("^[0-9a-f]{64}$")) and
		(.payload_sha256 == .stdout_artifact_digest) and
		(.status | IN("clean", "findings", "error")) and
		(.posture == $posture_map[.status]) and
		(.blocker_count | type == "number" and . == floor and . >= 0) and
		(if .status == "findings" then .blocker_count >= 1
			else .blocker_count == 0 end) and
		(if .status == "error" then
			.target_commit == null and .changed_paths_digest == null and
			.scope_digest == null
		else
			(.target_commit | type == "string" and test("^[0-9a-f]{40}$")) and
			(.target_commit == .end_commit) and
			(.changed_paths_digest | type == "string" and test("^[0-9a-f]{64}$")) and
			(.scope_digest | type == "string" and test("^[0-9a-f]{64}$"))
		end) and
		(.review_revision | type == "number") and
		([.task_id, .task_generation, .review_attempt_id,
			.owner_review_request_id, .end_commit] |
			all(type == "string" and length > 0)) and
		([.work_item_ref, .workroom_ref, .session_key] |
			all(type == "string"))
	' >/dev/null 2>&1 <<<"$evidence_json" || return 1
	# Canonical helper policy by VALUE (policy 1, the only authorized policy):
	# exact equality on policy_version, normalized origin identity, revision,
	# relpath, and executable SHA-256 against the contract. realpath stays
	# shape-only — root allowlisting belongs to host-owned checkout resolution
	# in the production-wiring slice.
	jq -e \
		--argjson policy_version "$AUTOREVIEW_CONTRACT_HELPER_POLICY_VERSION" \
		--arg origin "$AUTOREVIEW_CONTRACT_ORIGIN_IDENTITY" \
		--arg revision "$AUTOREVIEW_CONTRACT_REVISION" \
		--arg relpath "$AUTOREVIEW_CONTRACT_RELPATH" \
		--arg sha256 "$AUTOREVIEW_CONTRACT_SHA256" '
		(.helper.policy_version == $policy_version) and
		(.helper.origin == $origin) and
		(.helper.revision == $revision) and
		(.helper.relpath == $relpath) and
		(.helper.sha256 == $sha256) and
		(.helper.realpath | type == "string" and startswith("/") and
			endswith("/" + $relpath))
	' >/dev/null 2>&1 <<<"$evidence_json" || return 1
	# Re-prove every payload-derived evidence field from the authenticated
	# bytes: receipt version, status, blocker count, target commit,
	# changed-path/scope digests, and the full nine-coordinate binding.
	local expected_binding
	expected_binding=$(jq -c '{task_id, task_generation,
		review_revision: (.review_revision | tostring),
		review_attempt_id, owner_review_request_id, end_commit,
		work_item_ref, workroom_ref, session_key}' <<<"$evidence_json" 2>/dev/null) || return 1
	jq -e --argjson evidence "$evidence_json" --argjson binding "$expected_binding" \
		--argjson receipt_version "$AUTOREVIEW_CONTRACT_RECEIPT_VERSION" '
		(.receipt_version == $receipt_version) and
		(.status == $evidence.status) and
		(.binding == $binding) and
		(if .status == "error" then
			(.report == null) and ($evidence.blocker_count == 0)
		else
			((.report.findings | length) == $evidence.blocker_count) and
			(.target.reviewed_commit == $evidence.target_commit) and
			(.target.changed_paths_digest == $evidence.changed_paths_digest) and
			(.target.scope_digest == $evidence.scope_digest)
		end)
	' "$payload_file" >/dev/null 2>&1 || return 1
	# Replay adjudication under the same lock: if the receipt already holds
	# this EXACT record — same bytes minus the lifecycle's own stamps, bound
	# to the expected attempt — the submission is durably committed and this
	# replay is an idempotent no-op regardless of how far the live revision
	# has advanced since. Evidence embeds its attempt id, so a byte-equivalent
	# match can never launder a prior attempt's record into a replacement.
	local stored
	stored=$(jq -c '.autoreview_evidence // null |
		if . == null then null
		else del(.recorded_at, .auto_approved, .final_decision_authority) end' \
		<<<"$current" 2>/dev/null) || return 1
	if [[ -n "$stored" && "$stored" != "null" ]] &&
		[[ "$(jq -S -c . <<<"$stored")" == "$(jq -S -c . <<<"$evidence_json")" ]] &&
		[[ "$(jq -r '.review_attempt_id' <<<"$evidence_json")" == "$expected_attempt_id" ]]; then
		printf '%s\n' "$current"
		return 0
	fi
	# Caller CAS: expected revision, attempt, and owner request against the
	# live receipt.
	local current_revision current_attempt_id
	current_revision=$(jq -r '.review_revision // 0' <<<"$current")
	current_attempt_id=$(jq -r '.review_attempt_id // empty' <<<"$current")
	if [[ ! "$expected_revision" =~ ^[0-9]+$ ]] || [[ "$expected_revision" != "$current_revision" ]]; then
		return 3
	fi
	[[ -n "$expected_attempt_id" && "$expected_attempt_id" == "$current_attempt_id" ]] || return 3
	[[ "$expected_owner_request_id" == "$(jq -r '.owner_review_request_id // empty' <<<"$current")" ]] || return 3
	# Every evidence coordinate must equal the LIVE receipt under this lock —
	# identity is never taken from the caller or the ambient environment.
	jq -e \
		--arg task_id "$task_id" \
		--arg task_generation "$receipt_generation" \
		--arg attempt_id "$current_attempt_id" \
		--arg owner_request_id "$expected_owner_request_id" \
		--arg end_commit "$(jq -r '.end_commit // empty' <<<"$current")" \
		--arg work_item "$(jq -r '.work_item_ref // empty' <<<"$current")" \
		--arg workroom "$(jq -r '.workroom_ref // empty' <<<"$current")" \
		--arg session "$(jq -r '.session_key // empty' <<<"$current")" '
		(.task_id == $task_id) and
		(.task_generation == $task_generation) and
		(.review_attempt_id == $attempt_id) and
		(.owner_review_request_id == $owner_request_id) and
		($end_commit != "" and .end_commit == $end_commit) and
		(.work_item_ref == $work_item) and
		(.workroom_ref == $workroom) and
		(.session_key == $session)
	' >/dev/null 2>&1 <<<"$evidence_json" || return 3
	# D7/H13: exact claim-revision binding. The claim stamped the immutable
	# revision this attempt started at; evidence must carry exactly that
	# value. A receipt with no stamp (never claimed under this contract)
	# fails closed.
	jq -e --argjson current "$current" '
		($current.review_claim_revision | type == "number") and
		(.review_revision == $current.review_claim_revision)
	' >/dev/null 2>&1 <<<"$evidence_json" || return 3
	# One evidence record exists per attempt, forever: a second submission for
	# the same attempt is an authority collision and never overwrites. A
	# record from a superseded attempt is replaced wholesale by the live
	# attempt's evidence (its lineage is preserved in the receipt history).
	if jq -e --arg attempt_id "$current_attempt_id" \
		'.autoreview_evidence != null and .autoreview_evidence.review_attempt_id == $attempt_id' \
		>/dev/null 2>&1 <<<"$current"; then
		return 5
	fi
	# Commit: reviewing self-loop, one revision advance, lifecycle-stamped
	# non-authority markers. Wholesale evidence replacement, never a recursive
	# merge, so a superseded prior attempt's record leaves no residual keys.
	local now receipt
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	receipt=$(jq -c \
		--arg now "$now" \
		--argjson revision "$((current_revision + 1))" \
		--argjson evidence "$evidence_json" '
		.review_state = "reviewing" |
		.review_status = "pending" |
		.review_revision = $revision |
		.review_transition_event = "autoreview_evidence" |
		.review_transition_at = $now |
		.autoreview_evidence = ($evidence + {
			recorded_at: $now,
			auto_approved: false,
			final_decision_authority: "workroom"
		})' <<<"$current" 2>/dev/null) || return 1
	_review_lifecycle_commit_locked "$task_id" "$receipt" || rc=$?
	[[ "$rc" -eq 0 ]] || return "$rc"
	printf '%s\n' "$receipt"
}

# review_lifecycle_request_replacement TASK EXPECTED_REV PRIOR_ATTEMPT_ID
#                                      REASON DETAIL PRIOR_OWNER_REQUEST_ID
#
# Request ONE replacement review from a terminal `reviewed` receipt whose review
# authority was proven degraded (PAR-551). Prints the committed receipt.
#
# This is the only sanctioned exit from `reviewed`. It is deliberately not a
# reopen: every input is a CAS on the exact superseded attempt (revision, prior
# attempt id, prior reviewer task id, consumed owner request id) plus a
# documented degraded-authority reason code and concrete detail. The operation
# archives the prior reviewed receipt, mints a fresh owner-review request id,
# resets authorization to waiting/false, and lands in owner_waiting — so the
# replacement is only dispatchable after a fresh owner decision bound to the new
# request id. Return 3 is a lost CAS, 4 an illegal transition (for example a
# receipt that is not terminal reviewed); both are no-ops that must never be
# retried with weaker inputs.
review_lifecycle_request_replacement() {
	local task_id="$1" expected_revision="${2:-}" prior_attempt_id="${3:-}"
	local reason="${4:-}" detail="${5:-}" prior_owner_request_id="${6:-}"
	local receipt_path current now request_json
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ "$expected_revision" =~ ^[0-9]+$ ]] || return 3
	[[ -n "$prior_attempt_id" && -n "$prior_owner_request_id" ]] || return 3
	_review_lifecycle_replacement_reason_allowed "$reason" || return 1
	[[ -n "$detail" ]] || return 1
	receipt_path=$(review_lifecycle_receipt_path "$task_id") || return 1
	[[ -f "$receipt_path" ]] || return 1
	current=$(jq -c . "$receipt_path" 2>/dev/null || true)
	[[ -n "$current" ]] || return 1
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	# Built from an unlocked read, exactly like review_lifecycle_claim: every
	# field below is re-verified against the locked receipt, so a concurrent
	# writer turns this into a lost CAS rather than a weaker mutation.
	request_json=$(jq -cn \
		--arg task_id "$task_id" \
		--arg task_generation "$(jq -r '.task_generation // empty' <<<"$current")" \
		--arg attempt_id "$prior_attempt_id" \
		--arg review_task_id "$(jq -r '.review_task_id // empty' <<<"$current")" \
		--arg owner_request_id "$prior_owner_request_id" \
		--argjson revision "$expected_revision" \
		--arg reason "$reason" \
		--arg detail "$detail" \
		--arg now "$now" '
		{
			review_replacement_request: {
				version: 1,
				task_id: $task_id,
				task_generation: $task_generation,
				prior_review_revision: $revision,
				prior_review_attempt_id: $attempt_id,
				prior_review_task_id: $review_task_id,
				prior_owner_review_request_id: $owner_request_id,
				reason: $reason,
				detail: $detail,
				requested_at: $now
			}
		}') || return 1
	review_lifecycle_transition "$task_id" replacement_request "$expected_revision" \
		"$prior_attempt_id" "$request_json" "$prior_owner_request_id"
}

review_lifecycle_claim() {
	local task_id="$1" review_backend="${2:-}" review_mode="${3:-}" expected_revision="${4:-}" requested_task_id="${5:-}"
	local execution_mode="${6:-}" execution_node="${7:-}"
	local receipt_path current current_revision attempt attempt_id review_task_id now now_epoch patch
	case "$execution_mode" in
		"") ;;
		local) execution_node="" ;;
		remote) [[ -n "$execution_node" ]] || return 1 ;;
		*) return 1 ;;
	esac
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
	# A successful (re)dispatch clears the ACTIONABLE stale fields left by the
	# previous attempt — the dispatch-failure reason/detail/log and the
	# authorization prompt the owner has now answered — while preserving what they
	# said as non-actionable historical evidence in review_dispatch_cleared
	# (PAR-595). Clear and evidence land in ONE CAS'd transition, so no reader can
	# observe a claim whose stale failure fields survived, or evidence that was
	# dropped: same WAL, same receipt+projection commit. Empty history is omitted
	# from the patch rather than nulled, so an earlier cleared record is never
	# erased by a later clean attempt.
	local cleared_evidence
	cleared_evidence=$(jq -c --arg now "$now" --argjson attempt "$attempt" '
		if ((.review_dispatch_failed // false) == true)
			or ((.review_dispatch_failed_reason // "") != "")
			or ((.owner_review_reason // "") != "")
		then {
			at: $now,
			cleared_for_attempt: $attempt,
			prior_dispatch_failed: (.review_dispatch_failed // false),
			prior_dispatch_failed_at: (.review_dispatch_failed_at // null),
			prior_dispatch_failed_reason: (.review_dispatch_failed_reason // null),
			prior_dispatch_failed_detail: (.review_dispatch_failed_detail // null),
			prior_dispatch_failed_log: (.review_dispatch_failed_log // null),
			prior_owner_review_reason: (.owner_review_reason // null)
		}
		else null end' <<<"$current" 2>/dev/null) || cleared_evidence="null"
	[[ -n "$cleared_evidence" ]] || cleared_evidence="null"
	patch=$(jq -cn \
		--argjson attempt "$attempt" \
		--arg attempt_id "$attempt_id" \
		--arg review_task_id "$review_task_id" \
		--arg backend "$review_backend" \
		--arg mode "$review_mode" \
		--arg execution_mode "$execution_mode" \
		--arg execution_node "$execution_node" \
		--arg now "$now" \
		--argjson now_epoch "$now_epoch" \
		--argjson cleared "$cleared_evidence" '
		{
			review_attempt:$attempt,
			review_dispatch_attempts:$attempt,
			review_attempt_id:$attempt_id,
			review_task_id:$review_task_id,
			review_backend:(if $backend == "" then null else $backend end),
			review_mode:(if $mode == "" then null else $mode end),
			review_execution_mode:(if $execution_mode == "" then null else $execution_mode end),
			review_execution_node:(if $execution_mode == "remote" then $execution_node else null end),
			review_started_at:$now,
			review_started_at_epoch:$now_epoch,
			review_completed_at:null,
			review_blocker_count:null,
			review_dispatch_failed:false,
			review_dispatch_failed_at:null,
			review_dispatch_failed_reason:null,
			review_dispatch_failed_detail:null,
			review_dispatch_failed_log:null,
			owner_review_reason:null
		}
		+ (if $cleared == null then {} else {review_dispatch_cleared:$cleared} end)')
	review_lifecycle_transition "$task_id" claim "$expected_revision" "" "$patch"
}
