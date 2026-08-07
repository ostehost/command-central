#!/bin/bash
#
# review-projection.sh — Derive the workroom-facing review phase (PAR-595)
#
# `review_state` alone does not tell a workroom what to do next: a receipt in
# state `pending` may mean "the review instruction was accepted and is queued"
# OR "a dispatch just failed and something must be repaired", and `reviewing`
# does not say whether a reviewer lane was actually registered. The workroom
# read-model therefore carries an explicit phase derived from the same row/receipt
# fields, so every consumer classifies identically.
#
# Phases (most-settled first — this IS the precedence order):
#   review_terminal        reviewed | awaiting_fixup | blocked — the review has a
#                          settled disposition; nothing is in flight
#   reviewer_running       a reviewer lane is registered and claimed (review_task_id)
#   reviewer_registered    claimed, but no reviewer lane id was recorded (legacy
#                          claim) — registered without a nameable reviewer
#   dispatch_failed        the last dispatch attempt failed and its actionable
#                          reason/detail/log fields are still live
#   authorization_pending  owner_waiting — the workroom owes an authorize decision
#   instruction_accepted   pending — the review instruction is accepted, queued,
#                          and dispatchable
#   none                   no review lifecycle on this lane
#
# Precedence rationale: an in-flight or settled reviewer outranks a historical
# dispatch failure (the failure fields are cleared on the next claim), and a live
# dispatch failure outranks an authorization prompt because repair, not
# authorization, is the actionable next step.
#
# The derivation reads only fields that appear with identical names in BOTH the
# pending-review receipt and the tasks.json review projection, so one program
# serves the bridge read-model and any receipt readback.

[[ -n "${_OSTE_REVIEW_PROJECTION_SH_LOADED:-}" ]] && return 0
readonly _OSTE_REVIEW_PROJECTION_SH_LOADED=1

# Emit the jq `def review_phase:` program so callers can embed it in a larger
# filter instead of shelling out per row.
review_projection_phase_program() {
	cat <<'JQEOF'
def review_phase:
	(.review_state // "") as $state
	| ((.review_dispatch_failed // false) == true) as $dispatch_failed
	| ((.review_task_id // "") != "") as $has_reviewer
	| if $state == "" or $state == "null" then "none"
	elif ($state == "reviewed" or $state == "awaiting_fixup" or $state == "blocked") then "review_terminal"
	elif $state == "reviewing" then (if $has_reviewer then "reviewer_running" else "reviewer_registered" end)
	elif $dispatch_failed then "dispatch_failed"
	elif $state == "owner_waiting" then "authorization_pending"
	elif $state == "pending" then "instruction_accepted"
	else "none" end;
JQEOF
}

# review_projection_phase <json>  — print the phase for one row/receipt object.
review_projection_phase() {
	local row="${1:-null}"
	local program
	program=$(review_projection_phase_program)
	jq -r "${program} (if type == \"object\" then review_phase else \"none\" end)" \
		<<<"$row" 2>/dev/null || printf 'none'
}
