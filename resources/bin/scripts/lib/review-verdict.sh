#!/bin/bash
#
# review-verdict.sh — shared writer for the symphony review-gate verdict marker.
#
# PAR-290 / LANE-HOOK-02. The symphony daemon ingests a structured review
# verdict from /tmp/oste-review-verdict-<task_id>.json (readReviewGateVerdict /
# deriveReviewGateVerdict in symphony-daemon: src/daemon/cliRun.ts +
# src/v2/visibleLaneCloseout.ts). This library is the SINGLE source of truth for
# that marker's path + shape, sourced by both writers:
#   - scripts/lib/oste-review-gate-hook.sh  (Stop/SubagentStop snapshot)
#   - scripts/lib/pending-review.sh         (authoritative emit at the review
#                                            completion transitions)
#
# Pure function definitions; sourcing has NO side effects. Every write is atomic
# (mktemp + mv) and FAIL-OPEN: a jq / filesystem failure is swallowed and the
# function returns 0, so it can never break a Claude Code hook or the review
# pipeline. The launcher's Stop-hook NONEXIT doctrine is preserved.

# Double-source guard — defining the functions twice is harmless, but this keeps
# repeated sourcing (pending-review.sh + the hook in one process) cheap.
[[ -n "${__OSTE_REVIEW_VERDICT_SH:-}" ]] && return 0
__OSTE_REVIEW_VERDICT_SH=1

# Marker directory. Default /tmp — the daemon reads /tmp then /private/tmp, and
# on macOS /tmp is a symlink to /private/tmp. Override for tests via
# OSTE_REVIEW_VERDICT_DIR.
oste_review_verdict_dir() {
	printf '%s' "${OSTE_REVIEW_VERDICT_DIR:-/tmp}"
}

oste_review_verdict_path() {
	local task_id="$1"
	printf '%s/oste-review-verdict-%s.json' "$(oste_review_verdict_dir)" "$task_id"
}

# Map a launcher review_state (+ blocker count) to the daemon verdict vocabulary
# consumed by deriveReviewGateVerdict:
#   reviewed                          -> approved
#   awaiting_fixup | blocker_count>0  -> changes_requested
#   blocked                           -> blocked            (daemon: changes_requested)
#   pending | reviewing | other       -> pending            (daemon: unknown, non-blocking)
oste_review_verdict_from_state() {
	local review_state="$1"
	local blocker_count="${2:-0}"
	[[ "$blocker_count" =~ ^[0-9]+$ ]] || blocker_count=0
	case "$review_state" in
		reviewed) printf 'approved' ;;
		awaiting_fixup) printf 'changes_requested' ;;
		blocked) printf 'blocked' ;;
		*)
			if [[ "$blocker_count" -gt 0 ]]; then
				printf 'changes_requested'
			else
				printf 'pending'
			fi
			;;
	esac
}

# Atomically write the review-gate verdict marker. FAIL-OPEN: always returns 0.
# Usage:
#   oste_review_verdict_write <task_id> <verdict> <blocker_count> <summary> \
#                             <source> <review_state> <hook_event>
oste_review_verdict_write() {
	local task_id="$1"
	local verdict="$2"
	local blocker_count="${3:-0}"
	local summary="${4:-}"
	local src="${5:-review_gate}"
	local review_state="${6:-}"
	local hook_event="${7:-}"

	[[ -n "$task_id" ]] || return 0
	[[ "$blocker_count" =~ ^[0-9]+$ ]] || blocker_count=0
	command -v jq >/dev/null 2>&1 || return 0

	local dir path now tmp
	dir="$(oste_review_verdict_dir)"
	path="$(oste_review_verdict_path "$task_id")"
	mkdir -p "$dir" 2>/dev/null || return 0
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || printf '')
	tmp=$(mktemp "${dir}/.oste-review-verdict-${task_id}.XXXXXX" 2>/dev/null) || return 0

	if jq -n \
		--arg task_id "$task_id" \
		--arg verdict "$verdict" \
		--argjson blocker_count "$blocker_count" \
		--arg summary "$summary" \
		--arg source "$src" \
		--arg review_state "$review_state" \
		--arg hook_event "$hook_event" \
		--arg recorded_at "$now" \
		'{
			task_id: $task_id,
			verdict: $verdict,
			blocker_count: $blocker_count,
			summary: (if $summary == "" then null else $summary end),
			source: $source,
			review_state: (if $review_state == "" then null else $review_state end),
			hook_event: (if $hook_event == "" then null else $hook_event end),
			recorded_at: $recorded_at
		}' >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$path" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
	else
		rm -f "$tmp" 2>/dev/null || true
	fi
	return 0
}

# Atomically claim ONE of <max_blocks> one-shot review-gate block slots for
# <task_id>. mkdir(2) is an atomic create-or-fail, so:
#   - two overlapping Stop/SubagentStop hooks can NEVER both claim the same slot
#     (the loser's mkdir returns EEXIST), and
#   - an unwritable / full state dir makes the claim FAIL (mkdir non-zero), so
#     the caller must fail OPEN and never print decision:block without a durably
#     recorded claim.
# Returns 0 ONLY when a slot was newly and atomically claimed; returns non-zero
# on a lost race, an exhausted budget, or any filesystem failure.
oste_review_gate_claim_block() {
	local state_dir="$1"
	local task_id="$2"
	local max_blocks="${3:-1}"
	[[ -n "$task_id" ]] || return 1
	[[ "$max_blocks" =~ ^[0-9]+$ ]] || max_blocks=1
	[[ "$max_blocks" -ge 1 ]] || return 1

	# The claim directory IS the record — no read-then-write window. If the base
	# cannot be created (unwritable/full state dir) the claim fails, so the gate
	# stays NONEXIT (no block) rather than blocking without recording.
	local base="${state_dir}/oste-review-gate-blocks-${task_id}.d"
	mkdir -p "$base" 2>/dev/null || return 1

	local i
	for ((i = 0; i < max_blocks; i++)); do
		if mkdir "${base}/slot-${i}" 2>/dev/null; then
			return 0
		fi
	done
	return 1
}
