#!/bin/bash
#
# oste-lanes-gc.sh — Lane-projection rebuild/GC receipt emitter (CCSYNC-02).
#
# Reconciles the Work System lanes projection (~/.config/openclaw/lanes.json,
# kind: work-system-lanes-projection) against authoritative pending-review
# receipts and live tmux evidence, then writes a machine-readable GC receipt
# enumerating what each lane row should become so Command Central can clear
# stale rows safely instead of re-deriving the verdict on every render.
#
# Per-row verdict taxonomy (consumed by command-central
# src/utils/review-queue-health.ts parseLaneProjectionGcReceipt):
#   - kept       : row is live/valid (receipt present, or pane alive) — untouched.
#   - downgraded : review pending but receipt missing AND no live pane — stale
#                  read-model; downgraded to reconcile-needed limbo (not removed).
#   - archived   : terminal + reviewed/settled — moved to the archive.
#   - removed    : orphan with no backing evidence — dropped from the projection.
#
# SAFETY CONTRACT (mirrors oste-repair-pending-review.sh):
#   - Dry-run by DEFAULT: it computes verdicts and writes ONLY the receipt; it
#     NEVER rewrites lanes.json unless --apply is passed.
#   - --apply backs lanes.json up to <file>.gc.bak before any rewrite and
#     rewrites the whole snapshot atomically via tmp+mv.
#   - The receipt is always written (dry-run and apply) so the projection can be
#     reconciled against the most recent pass either way.
#
# Usage:
#   oste-lanes-gc.sh [--apply] [--lanes FILE] [--receipt FILE]
#                    [--pending-review-dir DIR] [--quiet]
#
# Exit codes (dry-run): 0 = nothing to reconcile, 2 = stale rows found.
# Exit codes (--apply): 0 = rebuilt (or nothing to do), 1 = a rewrite failed.
#
set -euo pipefail

LANES_FILE="${OSTE_LANES_FILE:-${HOME}/.config/openclaw/lanes.json}"
RECEIPT_FILE="${CC_LANE_GC_RECEIPT:-/tmp/oste-pending-review/lane-projection-gc.json}"
PENDING_REVIEW_DIR="${OSTE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}"
APPLY=0
QUIET=0

usage() {
	grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--apply)
			APPLY=1
			shift
			;;
		--quiet)
			QUIET=1
			shift
			;;
		--lanes)
			LANES_FILE="${2:-}"
			[[ -n "$LANES_FILE" ]] || {
				echo "error: --lanes requires a path" >&2
				exit 64
			}
			shift 2
			;;
		--receipt)
			RECEIPT_FILE="${2:-}"
			[[ -n "$RECEIPT_FILE" ]] || {
				echo "error: --receipt requires a path" >&2
				exit 64
			}
			shift 2
			;;
		--pending-review-dir)
			PENDING_REVIEW_DIR="${2:-}"
			[[ -n "$PENDING_REVIEW_DIR" ]] || {
				echo "error: --pending-review-dir requires a path" >&2
				exit 64
			}
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "error: unknown option: $1" >&2
			exit 64
			;;
	esac
done

log() { [[ "$QUIET" == "1" ]] || echo "$@"; }

[[ -f "$LANES_FILE" ]] || {
	log "No lanes projection: $LANES_FILE"
	exit 0
}
if ! jq -e '.kind == "work-system-lanes-projection"' "$LANES_FILE" >/dev/null 2>&1; then
	log "Not a work-system-lanes-projection: $LANES_FILE"
	exit 0
fi

# review_state values that mean the review cycle is settled (mirrors
# command-central review-queue-health.ts RESOLVED_REVIEW_STATES).
is_settled_state() {
	case "$1" in
		reviewed | no_review_expected) return 0 ;;
		*) return 1 ;;
	esac
}

# Does a live tmux session exist for this lane? Cache-free best-effort probe;
# absence of tmux is treated as "no live evidence" (the GC then relies on the
# receipt + status fields, exactly like the read-only Command Central probe).
tmux_session_alive() {
	local session="$1"
	[[ -n "$session" ]] || return 1
	command -v tmux >/dev/null 2>&1 || return 1
	tmux has-session -t "$session" 2>/dev/null
}

# Classify one lane envelope -> verdict. Reads lane fields from stdin (one JSON
# envelope) and echoes "verdict\treason".
classify_lane() {
	local envelope="$1"
	local task status review_state review_status session
	task=$(jq -r '.lane_ref.task // ""' <<<"$envelope")
	status=$(jq -r '.lane_ref.status // ""' <<<"$envelope")
	review_state=$(jq -r '.lane_ref.review_state // .review_state // ""' <<<"$envelope")
	review_status=$(jq -r '.lane_ref.review_status // .review_status // ""' <<<"$envelope")
	session=$(jq -r '.lane_ref.session // ""' <<<"$envelope")

	local receipt_file=""
	[[ -n "$task" ]] && receipt_file="${PENDING_REVIEW_DIR}/${task}.json"

	local review_pending=0
	if [[ "$review_status" == "pending" || "$review_state" == "pending" ]]; then
		review_pending=1
	fi

	# A present pending-review receipt OR a live pane = genuine live work: keep.
	if [[ -n "$receipt_file" && -f "$receipt_file" ]]; then
		printf 'kept\treceipt-present'
		return
	fi
	if tmux_session_alive "$session"; then
		printf 'kept\tlive-pane'
		return
	fi

	# Settled terminal row with no live pane -> archive.
	if is_settled_state "$review_state" && [[ "$status" != "running" ]]; then
		printf 'archived\treview-settled'
		return
	fi

	# Review pending but receipt missing and no live pane -> stale read-model.
	if [[ "$review_pending" == "1" ]]; then
		printf 'downgraded\treview-pending-receipt-missing'
		return
	fi

	# Running projection row with no receipt and no live pane -> orphan.
	if [[ "$status" == "running" ]]; then
		printf 'removed\trunning-no-evidence'
		return
	fi

	printf 'kept\tno-reconcile-signal'
}

now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
mode="dry-run"
[[ "$APPLY" == "1" ]] && mode="apply"

# Build the receipt rows object: {<lane_ref.id|task>: {verdict, reason}}.
rows_json="{}"
stale_count=0

lane_keys=$(jq -r '.lanes | keys[]' "$LANES_FILE" 2>/dev/null || true)
while IFS= read -r lane_key; do
	[[ -n "$lane_key" ]] || continue
	envelope=$(jq -c --arg k "$lane_key" '.lanes[$k]' "$LANES_FILE")
	[[ "$envelope" != "null" ]] || continue
	verdict_reason=$(classify_lane "$envelope")
	verdict="${verdict_reason%%$'\t'*}"
	reason="${verdict_reason#*$'\t'}"
	lane_id=$(jq -r '.lane_ref.id // ""' <<<"$envelope")
	row_key="${lane_id:-$lane_key}"

	if [[ "$verdict" != "kept" ]]; then
		stale_count=$((stale_count + 1))
		verdict_upper=$(printf '%s' "$verdict" | tr '[:lower:]' '[:upper:]')
		log "${verdict_upper}: ${row_key} (${reason})"
	fi

	rows_json=$(jq \
		--arg key "$row_key" \
		--arg verdict "$verdict" \
		--arg reason "$reason" \
		'.[$key] = {verdict: $verdict, reason: $reason}' <<<"$rows_json")
done <<<"$lane_keys"

# Write the GC receipt (always — dry-run and apply).
mkdir -p "$(dirname "$RECEIPT_FILE")"
receipt_tmp=$(mktemp)
jq -n \
	--arg now "$now" \
	--arg mode "$mode" \
	--argjson rows "$rows_json" \
	'{
		version: 1,
		kind: "lane-projection-gc-receipt",
		generated_at: $now,
		mode: $mode,
		rows: $rows
	}' >"$receipt_tmp"
mv "$receipt_tmp" "$RECEIPT_FILE"
log "Wrote GC receipt: $RECEIPT_FILE (mode=$mode, stale=$stale_count)"

# Apply mode: rewrite lanes.json, dropping removed rows (downgraded/archived
# rows stay in the projection so Command Central can surface their reconcile
# state; only true orphans are pruned). Backed up first; atomic tmp+mv.
if [[ "$APPLY" == "1" ]]; then
	cp "$LANES_FILE" "${LANES_FILE}.gc.bak"
	lanes_tmp=$(mktemp)
	if jq \
		--argjson rows "$rows_json" \
		'.lanes |= with_entries(
			(.value.lane_ref.id // .key) as $id
			| select(($rows[$id].verdict // "kept") != "removed")
		)
		| .updated_at = (now | todateiso8601)' \
		"$LANES_FILE" >"$lanes_tmp" 2>/dev/null && [[ -s "$lanes_tmp" ]]; then
		mv "$lanes_tmp" "$LANES_FILE"
		log "Rebuilt lanes projection (backup: ${LANES_FILE}.gc.bak)."
		exit 0
	else
		rm -f "$lanes_tmp"
		log "ERROR: lanes rebuild failed, original left untouched."
		exit 1
	fi
fi

log "Found ${stale_count} stale lane row(s) (dry-run; pass --apply to rebuild)."
[[ "$stale_count" -eq 0 ]] || exit 2
exit 0
