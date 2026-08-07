#!/bin/bash
#
# review-recovery.sh — Recover a lane stranded by a dead fixup delivery
# (PAR-595).
#
# `awaiting_fixup` had no exit. That is correct for a live attempt — the fixup
# owns the verdict until it lands — but it is a trap for an attempt whose
# delivery is provably dead. The fixup orchestrator documents two delivery
# verdicts it will never re-probe and never promote: `failed` (spawn returned
# nonzero) and `indeterminate` (the orchestrator died at the delivery boundary).
# Both settle the queue projection under `unpublished/` and stay there forever,
# and `pending_review_materialize_fixup_intent` refuses to re-project any attempt
# that already settled. So the receipt kept a live-looking `awaiting_fixup` state,
# `retry_disabled`, and an intent bound to an attempt that could never run again —
# and no review, no fixup, and no owner decision could ever be considered.
#
# Recovery is therefore a single CAS'd `failed_attempt_recovery` transition
# authored here and adjudicated inside review_lifecycle_transition. This library
# only *validates* and *assembles*; it never writes a receipt, an attempt, or an
# owner request itself, exactly as review-import.sh does for adoption.
#
# What it deliberately does NOT do:
#
#   - it never replays the dead attempt: nothing is spawned, no lane is
#     dispatched, no queue projection is written
#   - it never publishes the dead attempt: the settled `unpublished/` record is
#     read and digested, never moved, rewritten, or promoted to `dispatched/`
#   - it never touches an issue tracker or enables any daemon
#
# What it requires, all fail-closed:
#
#   - lifecycle  — the receipt is still in `awaiting_fixup`
#   - lineage    — the caller's task generation, review revision, review attempt
#                  (number AND id), and the outstanding owner request all still
#                  match the durable receipt
#   - evidence   — the settled audit record for THAT exact attempt exists, is
#                  bound to the same task/generation/attempt, and carries a
#                  terminal delivery verdict; no publication exists for it; and
#                  no live queue entry is still in flight
#   - reason     — a documented dead-delivery reason that equals the verdict the
#                  evidence actually records, plus concrete detail
#
# On success the lifecycle archives the stranded receipt, drops every handle that
# could still act on the dead attempt (its intent, attempt id, handoff, artifact
# digest), keeps the attempt counters monotonic, mints a FRESH owner-review
# request id, and lands in `owner_waiting`. Nothing is dispatchable again until a
# fresh owner decision is made against that new request id — recovery buys the
# lane a new decision point, never a retry.
#
# There is no idempotent replay: a committed recovery leaves the lane in
# `owner_waiting` and supersedes the revision, attempt id, and owner request the
# request names, so an exact replay is refused as an illegal transition (4) —
# there is no longer a stranded lane to recover — rather than silently recovering
# a second time. A caller that lost a race to a concurrent recovery sees the same
# code for the same reason.
#
# Return codes:
#   0  recovered
#   1  malformed request, or an undocumented/unsupported reason
#   2  precondition mismatch against the durable receipt or the delivery evidence
#   3  lost CAS / task-row generation drift
#   4  illegal transition (the receipt is not a stranded awaiting_fixup lane)

[[ -n "${__OSTE_REVIEW_RECOVERY_SH:-}" ]] && return 0
__OSTE_REVIEW_RECOVERY_SH=1

_review_recovery_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! declare -f pending_review_materialize_fixup_intent >/dev/null 2>&1; then
	# shellcheck source=pending-review.sh
	source "${_review_recovery_lib_dir}/pending-review.sh"
fi
unset _review_recovery_lib_dir

review_recovery_queue_dir() {
	printf '%s' "${OSTE_PENDING_FIXUP_DIR:-/tmp/oste-pending-fixup}"
}

# The settled audit record for one attempt, in this queue's own directories. Both
# names are composed from the queue root plus the validated task id and attempt
# number — never from a path the receipt or the evidence document supplies — so
# no document can address a file outside the queue.
review_recovery_settled_path() {
	local kind="$1" task_id="$2" attempt="$3"
	_review_lifecycle_validate_task_id "$task_id" || return 1
	[[ "$attempt" =~ ^[0-9]+$ ]] || return 1
	case "$kind" in
		unpublished | dispatched) ;;
		*) return 1 ;;
	esac
	printf '%s/%s/%s-attempt-%s.json' "$(review_recovery_queue_dir)" "$kind" "$task_id" "$attempt"
}

_review_recovery_request_is_wellformed() {
	jq -e '
		type == "object" and
		.version == 1 and
		(.task_id | type == "string" and length > 0) and
		(.task_generation | type == "string" and length > 0) and
		(.expected_review_revision | type == "number" and floor == . and . >= 0) and
		(.expected_review_attempt | type == "number" and floor == . and . >= 0) and
		# An empty attempt id is well-formed but can never match a stranded
		# receipt, so it is rejected as a lost CAS rather than as a malformed
		# document — naming no attempt is a stale claim, not a syntax error.
		(.expected_review_attempt_id | type == "string") and
		(.expected_owner_review_request_id | type == "string") and
		(.reason | type == "string" and length > 0) and
		(.detail | type == "string" and length > 0)
	' >/dev/null 2>&1 <<<"${1:-null}"
}

# The dead attempt's own audit record, validated as evidence rather than trusted
# as a claim. It must be bound to the exact task, generation, and attempt the
# caller named, and it must carry one of the two delivery verdicts the
# orchestrator documents as permanently unpublished. Echoes the record.
review_recovery_read_terminal_evidence() {
	local task_id="$1" task_generation="$2" attempt="$3" attempt_id="$4"
	local path evidence
	path=$(review_recovery_settled_path unpublished "$task_id" "$attempt") || return 1
	if [[ ! -s "$path" ]]; then
		echo "Error: no settled fixup audit record for ${task_id} attempt ${attempt}: ${path}" >&2
		return 1
	fi
	evidence=$(jq -c . "$path" 2>/dev/null || true)
	[[ -n "$evidence" ]] || {
		echo "Error: unreadable settled fixup audit record: ${path}" >&2
		return 1
	}
	if ! jq -e \
		--arg task_id "$task_id" \
		--arg task_generation "$task_generation" \
		--arg attempt_id "$attempt_id" \
		--argjson attempt "$attempt" '
		.task_id == $task_id and
		(.task_generation // "") == $task_generation and
		(.review_attempt_id // "") == $attempt_id and
		(.attempt // -1) == $attempt and
		((.delivery_state // "") | IN("failed", "indeterminate")) and
		(.settled_at | type == "string" and length > 0)
	' >/dev/null 2>&1 <<<"$evidence"; then
		echo "Error: settled record for ${task_id} attempt ${attempt} is not a terminally dead delivery for this lineage" >&2
		return 1
	fi
	printf '%s' "$evidence"
}

review_recovery_recover_failed_attempt() {
	local request="${1:-}"
	local task_id task_generation expected_revision expected_attempt expected_attempt_id
	local owner_request_id reason detail receipt_path receipt receipt_state
	local evidence evidence_path evidence_digest delivery_state expected_delivery_state
	local queue_dir recovery patch committed rc=0

	_review_recovery_request_is_wellformed "$request" || {
		echo "Error: malformed recovery request" >&2
		return 1
	}
	task_id=$(jq -r '.task_id' <<<"$request")
	task_generation=$(jq -r '.task_generation' <<<"$request")
	expected_revision=$(jq -r '.expected_review_revision' <<<"$request")
	expected_attempt=$(jq -r '.expected_review_attempt' <<<"$request")
	expected_attempt_id=$(jq -r '.expected_review_attempt_id' <<<"$request")
	owner_request_id=$(jq -r '.expected_owner_review_request_id' <<<"$request")
	reason=$(jq -r '.reason' <<<"$request")
	detail=$(jq -r '.detail' <<<"$request")

	if ! _review_lifecycle_recovery_reason_allowed "$reason"; then
		echo "Error: ${reason} is not a documented dead-delivery reason" >&2
		return 1
	fi
	expected_delivery_state=$(_review_lifecycle_recovery_reason_delivery_state "$reason") || return 1

	receipt_path=$(review_lifecycle_receipt_path "$task_id") || return 1
	if [[ ! -s "$receipt_path" ]]; then
		echo "Error: no pending-review receipt for ${task_id}" >&2
		return 2
	fi
	receipt=$(jq -c . "$receipt_path" 2>/dev/null || true)
	[[ -n "$receipt" ]] || {
		echo "Error: unreadable pending-review receipt for ${task_id}" >&2
		return 2
	}

	# Recovery is defined over a stranded fixup lane and nothing else. Every other
	# state either has a live attempt that owns the verdict or is already terminal
	# with its own sanctioned exit.
	receipt_state=$(jq -r '.review_state // "pending"' <<<"$receipt")
	if [[ "$receipt_state" != "awaiting_fixup" ]]; then
		echo "Error: recovery is only defined from review_state=awaiting_fixup (receipt is ${receipt_state})" >&2
		return 4
	fi

	# Lineage is checked here against the unlocked read so a stale caller fails
	# before any evidence is read, and the same coordinates are re-checked under
	# the review lock by the transition itself.
	if ! jq -e \
		--arg task_generation "$task_generation" \
		--arg attempt_id "$expected_attempt_id" \
		--arg owner_request_id "$owner_request_id" \
		--argjson revision "$expected_revision" '
		(.task_generation // "") == $task_generation and
		(.review_revision // 0) == $revision and
		(.review_attempt_id // "") == $attempt_id and
		(.owner_review_request_id // "") == $owner_request_id
	' >/dev/null 2>&1 <<<"$receipt"; then
		echo "Error: recovery request does not name the live lineage (generation/revision/attempt/owner request)" >&2
		return 3
	fi
	if [[ "$(jq -r '.review_attempt // 0' <<<"$receipt")" != "$expected_attempt" ]]; then
		echo "Error: receipt attempt is $(jq -r '.review_attempt // 0' <<<"$receipt"), request names ${expected_attempt}" >&2
		return 2
	fi

	# The stranded intent proves this receipt really is a fixup lane and names the
	# queue the attempt was published into. It must be the queue this process is
	# configured for, so nothing can point the evidence lookup elsewhere.
	queue_dir=$(review_recovery_queue_dir)
	if ! jq -e --arg path "${queue_dir}/${task_id}.json" \
		'(.fixup_intent | type == "object") and .fixup_intent.fixup_path == $path' \
		>/dev/null 2>&1 <<<"$receipt"; then
		echo "Error: ${task_id} carries no fixup intent for this queue; there is no dead attempt to recover" >&2
		return 2
	fi

	# A live queue entry means the attempt has not been consumed yet: it may still
	# be adjudicated, so it is not dead and is never recovered.
	if [[ -e "${queue_dir}/${task_id}.json" ]]; then
		echo "Error: ${task_id} still has a live fixup queue entry; the attempt is not settled" >&2
		return 2
	fi
	# A publication is the opposite of a dead delivery. If the attempt reached
	# dispatched/ it produced a lane, and recovering it would fork the lineage.
	if [[ -e "$(review_recovery_settled_path dispatched "$task_id" "$expected_attempt")" ]]; then
		echo "Error: ${task_id} attempt ${expected_attempt} was published; a dispatched attempt is never recovered" >&2
		return 2
	fi

	evidence=$(review_recovery_read_terminal_evidence "$task_id" "$task_generation" \
		"$expected_attempt" "$expected_attempt_id") || return 2
	delivery_state=$(jq -r '.delivery_state' <<<"$evidence")
	if [[ "$delivery_state" != "$expected_delivery_state" ]]; then
		echo "Error: ${reason} is defined over delivery_state=${expected_delivery_state}, but the record says ${delivery_state}" >&2
		return 2
	fi
	evidence_path=$(review_recovery_settled_path unpublished "$task_id" "$expected_attempt")
	evidence_digest=$(review_lifecycle_fixup_projection_digest "$evidence") || {
		echo "Error: could not digest the settled audit record" >&2
		return 2
	}

	recovery=$(jq -cn \
		--arg task_id "$task_id" \
		--arg task_generation "$task_generation" \
		--arg attempt_id "$expected_attempt_id" \
		--arg owner_request_id "$owner_request_id" \
		--arg evidence_path "$evidence_path" \
		--arg evidence_digest "$evidence_digest" \
		--arg delivery_state "$delivery_state" \
		--arg delivery_detail "$(jq -r '.delivery_detail // ""' <<<"$evidence")" \
		--arg settled_at "$(jq -r '.settled_at' <<<"$evidence")" \
		--arg reason "$reason" \
		--arg detail "$detail" \
		--arg requested_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		--argjson prior_review_revision "$expected_revision" \
		--argjson prior_review_attempt "$expected_attempt" '
		{
			version: 1,
			task_id: $task_id,
			task_generation: $task_generation,
			prior_review_revision: $prior_review_revision,
			prior_review_attempt: $prior_review_attempt,
			prior_review_attempt_id: $attempt_id,
			prior_owner_review_request_id: $owner_request_id,
			evidence_path: $evidence_path,
			evidence_digest: $evidence_digest,
			delivery_state: $delivery_state,
			delivery_detail: (if $delivery_detail == "" then null else $delivery_detail end),
			settled_at: $settled_at,
			reason: $reason,
			detail: $detail,
			requested_at: $requested_at
		}') || return 1

	patch=$(jq -cn --argjson recovery "$recovery" '{review_failed_attempt_recovery: $recovery}') || return 1

	committed=$(review_lifecycle_transition "$task_id" failed_attempt_recovery \
		"$expected_revision" "$expected_attempt_id" "$patch" "$owner_request_id") || rc=$?
	[[ "$rc" -eq 0 ]] || return "$rc"
	printf '%s\n' "$committed"
}
