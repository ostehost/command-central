#!/bin/bash
#
# oste-review-gate-hook.sh — Claude Code Stop/SubagentStop review-gate handler.
#
# PAR-290 / LANE-HOOK-02. Snapshots the lane's CURRENT review verdict into
# /tmp/oste-review-verdict-<task_id>.json (the structured marker the symphony
# daemon ingests) and, ONLY for a COMPLETED changes_requested/blocked verdict,
# blocks the stop EXACTLY ONCE to nudge a fixup.
#
# DOCTRINE (honored, see research/REVIEW-GATE-VERDICT-MARKER-NONEXIT-2026-06-26.md):
# the launcher's Stop hooks are fail-open / NONEXIT — they never wedge a lane.
# This hook is fail-open too: it exits 0 on every path EXCEPT the single,
# provably-bounded one-shot block below. It deliberately does NOT reintroduce
# "block until review completes" — that fights the launcher's async review model
# and Claude Code's 8-consecutive-block cap. The authoritative verdict marker is
# also emitted by pending-review.sh when the review actually lands; this hook is
# the Stop/SubagentStop snapshot.
#
# Provable non-loop. A block fires only when ALL hold:
#   verdict ∈ {changes_requested, blocked}   (a COMPLETED review verdict)
#   review_completed_at is set                (review actually finished)
#   stop_hook_active != true                  (not already re-firing in a loop)
#   an ATOMIC block-slot claim succeeds       (mkdir; ≤ MAX slots, default 1)
# The claim is the ONLY gate on printing decision:block — it is recorded
# atomically (mkdir create-or-fail) BEFORE the block is emitted, so two
# overlapping Stop/SubagentStop hooks can never both block and a failed claim
# (unwritable/full state dir) yields exit 0 with NO block. Total blocks per task
# therefore ≤ MAX ≪ 8 (the platform cap), and the stop_hook_active re-fire is
# guarded out — looping is impossible.
#
# Input (JSON on stdin): hook_event_name, session_id, cwd, stop_hook_active
#   (SubagentStop also carries agent_id, agent_type — unused here).

set -u

# Skip during the launcher's own test runs (tests set OSTE_TEST_MODE=0 to
# exercise the real logic), matching the other oste-*-hook.sh handlers.
[[ "${OSTE_TEST_MODE:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/review-verdict.sh
source "${SCRIPT_DIR}/review-verdict.sh" 2>/dev/null || true

# Any unexpected failure → exit 0 (fail-open; never wedge a lane).
trap 'exit 0' ERR

input=$(cat) || exit 0
stop_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null) || stop_active="false"
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || cwd=""
hook_event=$(printf '%s' "$input" | jq -r '.hook_event_name // "Stop"' 2>/dev/null) || hook_event="Stop"

# Resolve task_id: prefer the explicit env var set by oste-spawn.sh, else the
# shared cwd→task stop-map the other hooks use (pod-mode backward compat).
task_id="${OSTE_TASK_ID:-}"
if [[ -z "$task_id" && -n "$cwd" ]]; then
	cwd_hash=$(printf '%s' "$cwd" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || printf '%s' "$cwd" | md5 -q 2>/dev/null) || cwd_hash=""
	if [[ -n "$cwd_hash" && -f "/tmp/oste-stop-map-${cwd_hash}" ]]; then
		map_content=$(head -1 "/tmp/oste-stop-map-${cwd_hash}" 2>/dev/null) || map_content=""
		task_id="${map_content%%:*}"
	fi
fi
[[ -n "$task_id" ]] || exit 0

# No review context yet (review not dispatched) → fast no-op. This keeps the
# hook a cheap no-op on ordinary mid-task turns; it only does work once the
# lane has completed and a pending-review record exists.
pending_dir="${OSTE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}"
pending_file="${pending_dir}/${task_id}.json"
[[ -f "$pending_file" ]] || exit 0

# Bounded, cheap poll for a near-instant completion (env-tunable; default ~2s).
# Mostly a no-op: at first completion the review is still "pending" and will not
# finish within the budget, so we just snapshot whatever state exists now. Once
# review_completed_at is set the loop breaks immediately (no wait).
poll_seconds="${OSTE_REVIEW_GATE_POLL_SECONDS:-2}"
[[ "$poll_seconds" =~ ^[0-9]+$ ]] || poll_seconds=2
deadline=$(($(date +%s) + poll_seconds))
review_completed_at=""
while :; do
	review_completed_at=$(jq -r '.review_completed_at // empty' "$pending_file" 2>/dev/null) || review_completed_at=""
	[[ -n "$review_completed_at" ]] && break
	[[ "$(date +%s)" -ge "$deadline" ]] && break
	sleep 0.2 2>/dev/null || break
done

review_state=$(jq -r '.review_state // empty' "$pending_file" 2>/dev/null) || review_state=""
blocker_count=$(jq -r '.review_blocker_count // 0' "$pending_file" 2>/dev/null) || blocker_count=0
[[ "$blocker_count" =~ ^[0-9]+$ ]] || blocker_count=0

verdict=$(oste_review_verdict_from_state "$review_state" "$blocker_count")
summary=""
if [[ "$verdict" == "changes_requested" ]]; then
	if [[ "$blocker_count" -gt 0 ]]; then
		summary="${blocker_count} review blocker(s)"
	else
		summary="review requested changes"
	fi
fi

# Always snapshot the marker (fail-open; the writer never throws).
if command -v oste_review_verdict_write >/dev/null 2>&1; then
	oste_review_verdict_write "$task_id" "$verdict" "$blocker_count" "$summary" "review_gate_hook" "$review_state" "$hook_event"
fi

# One-shot fixup nudge: block EXACTLY ONCE for a COMPLETED changes_requested /
# blocked verdict. The block is printed ONLY after an ATOMIC claim is durably
# recorded (oste_review_gate_claim_block via mkdir): concurrent Stop/SubagentStop
# hooks can never both claim, and a failed claim (unwritable/full state dir) is
# fail-open — we exit 0 WITHOUT printing decision:block rather than block without
# a record. Provably bounded (see header). Every other path exits 0.
if [[ -n "$review_completed_at" ]] && { [[ "$verdict" == "changes_requested" ]] || [[ "$verdict" == "blocked" ]]; }; then
	if [[ "$stop_active" != "true" ]]; then
		state_dir="${OSTE_REVIEW_GATE_STATE_DIR:-/tmp}"
		max_blocks="${OSTE_REVIEW_GATE_MAX_BLOCKS:-1}"
		[[ "$max_blocks" =~ ^[0-9]+$ ]] || max_blocks=1
		if command -v oste_review_gate_claim_block >/dev/null 2>&1 &&
			oste_review_gate_claim_block "$state_dir" "$task_id" "$max_blocks"; then
			reason="Auto-review found ${blocker_count} blocker(s) (review_state=${review_state}). Address them before finishing — this review-gate blocks once, then yields."
			jq -cn --arg reason "$reason" '{decision: "block", reason: $reason}' 2>/dev/null ||
				printf '{"decision":"block","reason":"review gate: address the blockers before finishing"}'
			exit 0
		fi
	fi
fi

exit 0
