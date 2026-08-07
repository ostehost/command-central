#!/bin/bash
#
# notify-receipt.sh — Per-transport completion notification receipt (PAR-595)
#
# A completion notification fans out over several independent transports:
#
#   workroom       direct OpenClaw channel send — the deterministic, receipted
#                  delivery into the issue workroom. This is the ONLY transport
#                  that proves a human-visible receipt landed.
#   wake_http      POST /hooks/wake — wakes an orchestrator session.
#   wake_cli       `openclaw system event` — local wake fallback.
#   owner_callback owner-bound POST /hooks/agent relay for the owning session.
#
# Before this library the only evidence was append-only prose in
# /tmp/oste-wake-log.txt, so a reader could not tell "the workroom received the
# receipt" from "some wake transport returned 200" — and a later owner-callback
# or CLI failure printed `wake=NONE_DELIVERED`, which reads as "nothing was
# delivered" even when the workroom delivery had already succeeded.
#
# This receipt keeps one durable document per task with one INDEPENDENT subtree
# per transport. Every writer touches only its own subtree, so a transport that
# fails later can never downgrade or overwrite a delivered workroom state.
#
# Public API (every function is fail-soft and returns 0):
#   notify_receipt_path <task_id>
#   notify_receipt_init <task_id> <kind> [<scope_json>]
#   notify_receipt_record <task_id> <transport> <state> [<detail>] [<extra_json>]
#   notify_receipt_transport_state <task_id> <transport>
#
# States are recorded verbatim so consumers own any normalization. The
# conventional set is: delivered | accepted | failed | skipped | unavailable.

[[ -n "${_OSTE_NOTIFY_RECEIPT_SH_LOADED:-}" ]] && return 0
readonly _OSTE_NOTIFY_RECEIPT_SH_LOADED=1

notify_receipt_dir() {
	printf '%s' "${OSTE_NOTIFY_RECEIPT_DIR:-/tmp/oste-notify-receipt}"
}

_notify_receipt_safe_id() {
	printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

notify_receipt_path() {
	local task_id="${1:-}"
	[[ -n "$task_id" ]] || return 0
	printf '%s/%s.json' "$(notify_receipt_dir)" "$(_notify_receipt_safe_id "$task_id")"
}

# Serialize read-modify-write per receipt file. Bounded and fail-soft: a lock we
# cannot take means the update is dropped rather than a notification blocked.
_notify_receipt_lock() {
	local lockdir="$1" waited=0 max_wait="${OSTE_NOTIFY_RECEIPT_LOCK_MAX_WAIT:-5}"
	while ! mkdir "$lockdir" 2>/dev/null; do
		local lock_mtime now
		lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
		now=$(date +%s)
		if [[ $((now - lock_mtime)) -ge "${OSTE_NOTIFY_RECEIPT_LOCK_STALE_AGE:-30}" ]]; then
			rm -rf "$lockdir" 2>/dev/null || true
			continue
		fi
		sleep 0.05
		waited=$((waited + 1))
		[[ "$waited" -lt $((max_wait * 20)) ]] || return 1
	done
	return 0
}

# Apply a jq filter to the receipt document, creating a minimal one first.
# Never partially publishes: the merged document is written to a temp file in
# the same directory and renamed into place.
_notify_receipt_apply() {
	local task_id="$1" filter="$2"
	shift 2
	local path lockdir current tmp rc=0
	path=$(notify_receipt_path "$task_id") || return 0
	[[ -n "$path" ]] || return 0
	mkdir -p "$(dirname "$path")" 2>/dev/null || return 0
	lockdir="${path}.lock"
	_notify_receipt_lock "$lockdir" || return 0
	current=""
	if [[ -s "$path" ]]; then
		current=$(jq -c . "$path" 2>/dev/null || true)
	fi
	[[ -n "$current" ]] || current=$(jq -cn --arg id "$task_id" \
		'{version:1,task_id:$id,kind:null,scope:null,transports:{}}' 2>/dev/null || true)
	if [[ -n "$current" ]]; then
		tmp=$(mktemp "${path}.tmp.XXXXXX" 2>/dev/null) || tmp=""
		if [[ -n "$tmp" ]]; then
			if jq -c "$@" "$filter" <<<"$current" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
				mv "$tmp" "$path" 2>/dev/null || rm -f "$tmp"
			else
				rm -f "$tmp"
				rc=1
			fi
		fi
	fi
	rm -rf "$lockdir" 2>/dev/null || true
	[[ "$rc" -eq 0 ]] || return 0
	return 0
}

# Create/refresh the receipt envelope. Transport subtrees are NEVER touched
# here, so a re-emitted notification for the same task keeps prior evidence.
notify_receipt_init() {
	local task_id="${1:-}" kind="${2:-}" scope_json="${3:-null}"
	[[ -n "$task_id" ]] || return 0
	jq -e . >/dev/null 2>&1 <<<"$scope_json" || scope_json="null"
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	_notify_receipt_apply "$task_id" '
		.version = 1 |
		.task_id = $id |
		.kind = (if $kind == "" then .kind else $kind end) |
		.scope = (if $scope == null then .scope else $scope end) |
		.transports = (.transports // {}) |
		.created_at = (.created_at // $now) |
		.updated_at = $now
	' --arg id "$task_id" --arg kind "$kind" --arg now "$now" --argjson scope "$scope_json"
	return 0
}

# Record ONE transport outcome. Writes only .transports[<transport>], so a
# failing transport can never rewrite a sibling's delivered state.
notify_receipt_record() {
	local task_id="${1:-}" transport="${2:-}" state="${3:-}" detail="${4:-}" extra_json="${5:-null}"
	[[ -n "$task_id" && -n "$transport" && -n "$state" ]] || return 0
	jq -e 'type == "object"' >/dev/null 2>&1 <<<"$extra_json" || extra_json='{}'
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	_notify_receipt_apply "$task_id" '
		.transports = (.transports // {}) |
		.transports[$transport] = (
			{
				transport: $transport,
				state: $state,
				detail: (if $detail == "" then null else $detail end),
				at: $now
			} + $extra
		) |
		.updated_at = $now
	' --arg transport "$transport" --arg state "$state" --arg detail "$detail" \
		--arg now "$now" --argjson extra "$extra_json"
	return 0
}

notify_receipt_transport_state() {
	local task_id="${1:-}" transport="${2:-}" path
	[[ -n "$task_id" && -n "$transport" ]] || return 0
	path=$(notify_receipt_path "$task_id") || return 0
	[[ -s "$path" ]] || return 0
	jq -r --arg t "$transport" '.transports[$t].state // ""' "$path" 2>/dev/null || true
	return 0
}
