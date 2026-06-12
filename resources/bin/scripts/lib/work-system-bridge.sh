#!/bin/bash
#
# work-system-bridge.sh — optional Work System LaneRef update emitter.
#
# The launcher is the visible lane executor/recorder, not the project
# identity authority. tasks.json remains the primary working record (it is
# deprecated compatibility/diagnostics, but still primary today); this
# bridge additionally emits LaneRef updates shaped for an OpenClaw-native
# Work System (workSystem.bindLane/updateLaneRef or a configurable HTTP
# endpoint) without requiring a live plugin.
#
# Modes (OSTE_WORK_SYSTEM_BRIDGE, default off):
#   off      no emission — tasks.json stays the only record
#   dry-run  print the update to stderr (marker: WORK_SYSTEM_LANE_REF_DRY_RUN)
#   outbox   maintain the transitional lanes read-model/projection keyed by
#            lane_ref.id (default: ~/.config/openclaw/lanes.json; override
#            with OSTE_WORK_SYSTEM_OUTBOX). Read-model only — never an
#            identity authority and never read back by the launcher.
#            Contract decision (2026-06-12): lanes.json carries ONLY this
#            self-describing projection (kind: work-system-lanes-projection);
#            the drainable op-queue outbox from PLUGIN-API.md §6 lives at
#            ~/.config/openclaw/work-system-outbox.json and is a different
#            artifact this library never writes. One path, one shape.
#   http     POST each update to OSTE_WORK_SYSTEM_BRIDGE_ENDPOINT (full URL,
#            used verbatim) when set, else to
#            ${OSTE_WORK_SYSTEM_BRIDGE_URL}<path> where <path> is
#            OSTE_WORK_SYSTEM_BRIDGE_PATH (default
#            /plugins/work-system/lane-ref). The contract ingest route
#            (POST /work-system/ghostty/reconcile, gateway auth, outbox batch
#            body) expects a different envelope — point the endpoint at an
#            adapter that owns the transform, not at that route directly.
#
# Test isolation: with OSTE_TEST_MODE=1, outbox emission requires an explicit
# OSTE_WORK_SYSTEM_OUTBOX (same convention as OSTE_LAUNCHER_TASK_EVENTS_FILE).
#
# Every entry point is fail-soft: emission must never fail a spawn or a
# completion. All emitters return 0.

if [[ -n "${_WORK_SYSTEM_BRIDGE_LOADED:-}" ]]; then
	return 0
fi
_WORK_SYSTEM_BRIDGE_LOADED=1

readonly WORK_SYSTEM_LANE_PROVIDER="ghostty-launcher"

work_system_bridge_mode() {
	local mode="${OSTE_WORK_SYSTEM_BRIDGE:-off}"
	case "$mode" in
		off | dry-run | outbox | http) printf '%s' "$mode" ;;
		*)
			echo "Warning: unknown OSTE_WORK_SYSTEM_BRIDGE mode '${mode}' — bridge disabled" >&2
			printf 'off'
			;;
	esac
}

work_system_bridge_outbox_file() {
	printf '%s' "${OSTE_WORK_SYSTEM_OUTBOX:-${HOME}/.config/openclaw/lanes.json}"
}

# Build a single LaneRef update document (see scripts/laneref-update-schema.json).
#
# Usage:
#   work_system_lane_ref_update <task_id> <status> <session> <lane_kind> \
#       <worktree> <surface> <project_ref_json> [<lane_id>]
#
# status carries the launcher-native status verbatim (running, completed,
# completed_dirty, contract_failure, failed, killed, stopped, ...): the
# launcher records what it observed; Work System ingesters own any enum
# normalization. project_ref_json is the slim record persisted in tasks.json
# (project_ref_record_registered / _unregistered) — invalid JSON degrades to
# null. lane_id defaults to the launcher source_ref form "launcher:<task_id>".
# work_item_ref / workroom_ref are optional string refs from
# OSTE_WORK_ITEM_REF / OSTE_WORKROOM_REF, null when unset.
work_system_lane_ref_update() {
	local task_id="$1"
	local status="${2:-}"
	local session="${3:-}"
	local lane_kind="${4:-}"
	local worktree="${5:-}"
	local surface="${6:-}"
	local project_ref_json="${7:-null}"
	local lane_id="${8:-}"
	[[ -n "$task_id" ]] || return 0
	[[ -n "$lane_id" ]] || lane_id="launcher:${task_id}"
	# Canonical laneKind alignment: emitted lane_kind is always a value from
	# the frozen canonical enum (implementation|review|research) or null —
	# never a launcher-native kind that would fail Work System validation.
	# release-proof emits as review; anything else non-canonical emits null.
	# Whenever the emitted value differs from the launcher-native one, the
	# native kind is retained verbatim in lane_kind_source (tasks.json keeps
	# the native value either way).
	local lane_kind_source=""
	case "$lane_kind" in
		"" | implementation | review | research) ;;
		release-proof)
			lane_kind_source="$lane_kind"
			lane_kind="review"
			;;
		*)
			lane_kind_source="$lane_kind"
			lane_kind=""
			;;
	esac
	jq -e . >/dev/null 2>&1 <<<"$project_ref_json" || project_ref_json="null"
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	jq -cn \
		--arg lane_id "$lane_id" \
		--arg provider "$WORK_SYSTEM_LANE_PROVIDER" \
		--arg surface "$surface" \
		--arg session "$session" \
		--arg task "$task_id" \
		--arg worktree "$worktree" \
		--arg lane_kind "$lane_kind" \
		--arg lane_kind_source "$lane_kind_source" \
		--arg status "$status" \
		--arg updated_at "$now" \
		--arg work_item "${OSTE_WORK_ITEM_REF:-}" \
		--arg workroom "${OSTE_WORKROOM_REF:-}" \
		--argjson project_ref "$project_ref_json" \
		'{
			schema_version: 1,
			kind: "lane_ref_update",
			project_ref: $project_ref,
			lane_ref: {
				id: $lane_id,
				provider: $provider,
				surface: (if $surface == "" then null else $surface end),
				session: (if $session == "" then null else $session end),
				task: $task,
				worktree: (if $worktree == "" then null else $worktree end),
				lane_kind: (if $lane_kind == "" then null else $lane_kind end),
				lane_kind_source: (if $lane_kind_source == "" then null else $lane_kind_source end),
				status: $status,
				updatedAt: $updated_at
			},
			work_item_ref: (if $work_item == "" then null else $work_item end),
			workroom_ref: (if $workroom == "" then null else $workroom end)
		}' 2>/dev/null || true
}

# Lanes read-model/projection: read-modify-write with an atomic same-dir
# rename. Lock-free by design — every write lands a complete valid document.
# Last-writer-wins: a lane clobbered by a concurrent racer heals on that
# lane's next update, but a clobbered TERMINAL update has no next update and
# stays stale until the lane id is written again. Acceptable for a
# transitional read-model that is never authoritative; consumers needing
# convergence must read tasks.json (via the launcher), not this file.
# The document carries kind: work-system-lanes-projection so it can never be
# mistaken for the PLUGIN-API.md §6 drainable op-queue
# (~/.config/openclaw/work-system-outbox.json), which this library never
# writes.
work_system_bridge_write_outbox() {
	local update="$1"
	if [[ "${OSTE_TEST_MODE:-}" == "1" && -z "${OSTE_WORK_SYSTEM_OUTBOX:-}" ]]; then
		return 0
	fi
	local outbox lane_id
	outbox="$(work_system_bridge_outbox_file)"
	lane_id=$(jq -r '.lane_ref.id // empty' <<<"$update" 2>/dev/null) || lane_id=""
	[[ -n "$lane_id" ]] || return 0
	mkdir -p "$(dirname "$outbox")" 2>/dev/null || return 0
	local current='{"version":1,"lanes":{}}'
	if [[ -s "$outbox" ]] && jq -e '.lanes | type == "object"' "$outbox" >/dev/null 2>&1; then
		current=$(cat "$outbox" 2>/dev/null) || current='{"version":1,"lanes":{}}'
	fi
	local tmp="${outbox}.tmp.$$"
	if jq -c --arg id "$lane_id" --argjson update "$update" \
		'.version = 1 |
		 .kind = "work-system-lanes-projection" |
		 .lanes[$id] = $update |
		 .updated_at = $update.lane_ref.updatedAt' \
		<<<"$current" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$outbox" 2>/dev/null || rm -f "$tmp"
	else
		rm -f "$tmp"
	fi
	return 0
}

# HTTP transport toward the long-term OpenClaw plugin/API target. Short
# timeout, no retry: a slow or absent bridge must not slow the lane.
# Endpoint resolution: OSTE_WORK_SYSTEM_BRIDGE_ENDPOINT wins verbatim;
# otherwise OSTE_WORK_SYSTEM_BRIDGE_URL + OSTE_WORK_SYSTEM_BRIDGE_PATH
# (default /plugins/work-system/lane-ref). Nothing is hard-coded-only —
# a contract-route adapter can be targeted without code changes.
work_system_bridge_post_http() {
	local update="$1"
	local endpoint="${OSTE_WORK_SYSTEM_BRIDGE_ENDPOINT:-}"
	if [[ -z "$endpoint" ]]; then
		local base="${OSTE_WORK_SYSTEM_BRIDGE_URL:-}"
		[[ -n "$base" ]] || return 0
		local path="${OSTE_WORK_SYSTEM_BRIDGE_PATH:-/plugins/work-system/lane-ref}"
		endpoint="${base%/}/${path#/}"
	fi
	command -v curl >/dev/null 2>&1 || return 0
	local timeout="${OSTE_WORK_SYSTEM_BRIDGE_TIMEOUT:-2}"
	curl -s -m "$timeout" -X POST \
		-H "Content-Type: application/json" \
		--data-binary "$update" \
		"$endpoint" >/dev/null 2>&1 || true
	return 0
}

# Emit one LaneRef update through the configured transport. Same arguments as
# work_system_lane_ref_update. Always returns 0.
work_system_emit_lane_ref() {
	local mode
	mode=$(work_system_bridge_mode)
	if [[ "$mode" == "off" ]]; then
		return 0
	fi
	local update
	update=$(work_system_lane_ref_update "$@") || update=""
	[[ -n "$update" ]] || return 0
	case "$mode" in
		dry-run) echo "WORK_SYSTEM_LANE_REF_DRY_RUN ${update}" >&2 ;;
		outbox) work_system_bridge_write_outbox "$update" ;;
		http) work_system_bridge_post_http "$update" ;;
	esac
	return 0
}

# Completion-side convenience: derive the LaneRef fields from the task row
# already persisted in tasks.json (the primary record) and emit. A missing
# row still emits task + status so the consumer sees the terminal state.
work_system_emit_lane_ref_for_task() {
	local tasks_file="$1"
	local task_id="$2"
	local status="$3"
	if [[ "$(work_system_bridge_mode)" == "off" ]]; then
		return 0
	fi
	local row='{}'
	if [[ -f "$tasks_file" ]]; then
		row=$(jq -c --arg id "$task_id" '.tasks[$id] // {}' "$tasks_file" 2>/dev/null) || row='{}'
	fi
	local session lane_kind worktree surface project_ref lane_id
	session=$(jq -r '.session_id // ""' <<<"$row" 2>/dev/null) || session=""
	lane_kind=$(jq -r '.lane_kind // ""' <<<"$row" 2>/dev/null) || lane_kind=""
	worktree=$(jq -r '.execution_dir // .project_dir // ""' <<<"$row" 2>/dev/null) || worktree=""
	surface=$(jq -r '.terminal_backend // ""' <<<"$row" 2>/dev/null) || surface=""
	project_ref=$(jq -c '.project_ref // null' <<<"$row" 2>/dev/null) || project_ref="null"
	lane_id=$(jq -r '.source_ref // ""' <<<"$row" 2>/dev/null) || lane_id=""
	work_system_emit_lane_ref "$task_id" "$status" "$session" "$lane_kind" \
		"$worktree" "$surface" "$project_ref" "$lane_id"
}
