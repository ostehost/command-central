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
# Modes (OSTE_WORK_SYSTEM_BRIDGE, default outbox):
#   off      no emission — tasks.json stays the only record
#   dry-run  print the update to stderr (marker: WORK_SYSTEM_LANE_REF_DRY_RUN)
#   outbox   DEFAULT (2026-06-12): maintain the canonical lanes read-model/
#            projection keyed by lane_ref.id (default:
#            ~/.config/openclaw/lanes.json; override with
#            OSTE_WORK_SYSTEM_OUTBOX). The default is set in code, not env,
#            because emission happens from heterogeneous entry points (spawn
#            shell, Claude Code Stop hook, launchd reaper) whose environments
#            do not share exports — an env-enabled bridge fragments into a
#            half-written projection. Read-model only — never an identity
#            authority and never read back by the launcher.
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
	local mode="${OSTE_WORK_SYSTEM_BRIDGE:-outbox}"
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

# Lanes read-model/projection: serialized read-modify-write with an atomic
# same-dir rename. The lock is intentionally scoped to the projection file, not
# tasks.json, so bridge writes do not contend with launcher registry updates.
# Every successful write lands a complete valid document, and concurrent writers
# for different lanes merge through the latest on-disk projection instead of
# overwriting sibling updates.
#
# Monotonic terminal guard: a non-terminal update (e.g. a racing spawn-side
# `running` snapshot) whose updatedAt is not strictly newer than the stored
# TERMINAL snapshot for the same lane id is dropped — a settled lane state
# must never regress to `running` from an out-of-order write. A legitimately
# re-spawned task (same task_id, later updatedAt) still wins.
#
# The document carries kind: work-system-lanes-projection so it can never be
# mistaken for the PLUGIN-API.md §6 drainable op-queue
# (~/.config/openclaw/work-system-outbox.json), which this library never
# writes.
work_system_bridge_lock_outbox() {
	local lockdir="$1"
	local pidfile="${lockdir}/pid"
	local max_wait="${OSTE_WORK_SYSTEM_OUTBOX_LOCK_MAX_WAIT:-10}"
	local waited=0
	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			echo "${BASHPID:-$$}" >"$pidfile" 2>/dev/null || true
			return 0
		fi
		# Keep bridge non-blocking: clear only obviously dead holders, otherwise
		# skip after the short wait budget rather than slowing lane completion.
		if [[ -f "$pidfile" ]]; then
			local held_pid
			held_pid=$(cat "$pidfile" 2>/dev/null || echo "")
			if [[ -n "$held_pid" ]] && ! kill -0 "$held_pid" 2>/dev/null; then
				rm -f "$pidfile" 2>/dev/null || true
				rmdir "$lockdir" 2>/dev/null || true
				continue
			fi
		fi
		sleep 0.1
		waited=$((waited + 1))
		if [[ $waited -ge $((max_wait * 10)) ]]; then
			echo "Warning: work-system projection lock timeout after ${max_wait}s" >&2
			return 1
		fi
	done
}

work_system_bridge_unlock_outbox() {
	local lockdir="$1"
	local pidfile="${lockdir}/pid"
	local held_pid
	held_pid=$(cat "$pidfile" 2>/dev/null || echo "")
	[[ "$held_pid" == "${BASHPID:-$$}" ]] || return 0
	rm -f "$pidfile" 2>/dev/null || true
	rmdir "$lockdir" 2>/dev/null || true
}

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
	local lockdir="${outbox}.lock"
	work_system_bridge_lock_outbox "$lockdir" || return 0
	local current='{"version":1,"lanes":{}}'
	if [[ -s "$outbox" ]] && jq -e '.lanes | type == "object"' "$outbox" >/dev/null 2>&1; then
		current=$(cat "$outbox" 2>/dev/null) || current='{"version":1,"lanes":{}}'
	fi
	if [[ "${OSTE_TEST_MODE:-}" == "1" && -n "${OSTE_WORK_SYSTEM_OUTBOX_WRITE_DELAY:-}" ]]; then
		sleep "$OSTE_WORK_SYSTEM_OUTBOX_WRITE_DELAY"
	fi
	local tmp="${outbox}.tmp.${BASHPID:-$$}"
	if jq -c --arg id "$lane_id" --argjson update "$update" \
		'def terminal(s): ["completed", "completed_dirty", "contract_failure", "failed", "killed", "stopped"] | index(s) != null;
		 .version = 1 |
		 .kind = "work-system-lanes-projection" |
		 (.lanes[$id] // null) as $existing |
		 if $existing != null
			and terminal($existing.lane_ref.status // "")
			and (terminal($update.lane_ref.status // "") | not)
			and (($update.lane_ref.updatedAt // "") <= ($existing.lane_ref.updatedAt // ""))
		 then .
		 else (.lanes[$id] = $update | .updated_at = $update.lane_ref.updatedAt)
		 end' \
		<<<"$current" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$outbox" 2>/dev/null || rm -f "$tmp"
	else
		rm -f "$tmp"
	fi
	work_system_bridge_unlock_outbox "$lockdir"
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

# Route one built update through the configured transport. Always returns 0.
_work_system_bridge_transport() {
	local update="$1"
	case "$(work_system_bridge_mode)" in
		dry-run) echo "WORK_SYSTEM_LANE_REF_DRY_RUN ${update}" >&2 ;;
		outbox) work_system_bridge_write_outbox "$update" ;;
		http) work_system_bridge_post_http "$update" ;;
	esac
	return 0
}

# Enrich a base lane_ref update with first-class read-model fields derived
# from the persisted task row plus cheap local evidence probes, so consumers
# (Command Central) never have to interpret tasks.json, /tmp receipts, or
# terminal state themselves. Additive to the schema_version 1 envelope and
# fail-soft: a non-object row or a jq failure returns the update unchanged.
#
#   lane_ref.started_at/.completed_at/.exit_code   lifecycle in ONE snapshot
#   review.{state,status,disposition,disposition_reason,
#           receipt_path,receipt_present}          explicit review lifecycle;
#                                                  receipt_present is a
#                                                  writer-host -f probe
#   handoff.{file,artifact_status}                 finalizer-verified contract
#   attach.{backend,session,socket,available,
#           verified_at,reason_if_unavailable}     evidence-backed attach
#                                                  affordance (tmux probed
#                                                  via has-session; other
#                                                  backends report unprobed)
#   generation.{app_stamp,release_generation,
#               source_version}                    spawn-time launcher app
#                                                  generation for visible lanes
#   visibility.{verified,degraded,reason,
#               receipt_path,receipt_present}      spawn-time visible-terminal
#                                                  verification/degradation
#   origin_host/writer_host                        hub/node provenance
#   canonical_project_id/canonical_project_dir     registry identity echo
work_system_lane_ref_enrich() {
	local update="$1"
	local row="${2:-null}"
	if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$row"; then
		printf '%s' "$update"
		return 0
	fi

	local writer_host
	writer_host=$(hostname -s 2>/dev/null) || writer_host=""

	local receipt_path receipt_present="null"
	receipt_path=$(jq -r '.pending_review_path // empty' <<<"$row" 2>/dev/null) || receipt_path=""
	if [[ -n "$receipt_path" ]]; then
		if [[ -f "$receipt_path" ]]; then receipt_present="true"; else receipt_present="false"; fi
	fi

	local vis_receipt_path vis_receipt_present="null"
	vis_receipt_path=$(jq -r '.visibility_receipt_path // .visibility.receipt_path // empty' <<<"$row" 2>/dev/null) || vis_receipt_path=""
	if [[ -n "$vis_receipt_path" ]]; then
		if [[ -f "$vis_receipt_path" ]]; then vis_receipt_present="true"; else vis_receipt_present="false"; fi
	fi

	local backend session socket attach_available="null" attach_reason=""
	backend=$(jq -r '.terminal_backend // .agent_backend // empty' <<<"$row" 2>/dev/null) || backend=""
	session=$(jq -r '.session_id // empty' <<<"$row" 2>/dev/null) || session=""
	socket=$(jq -r '.tmux_socket // .persist_socket // empty' <<<"$row" 2>/dev/null) || socket=""
	if [[ -z "$session" ]]; then
		attach_available="false"
		attach_reason="no-session-recorded"
	elif [[ "$backend" == "tmux" || -z "$backend" ]]; then
		if ! command -v tmux >/dev/null 2>&1; then
			attach_reason="tmux-unavailable"
		else
			local tmux_cmd=(tmux)
			[[ -n "$socket" ]] && tmux_cmd=(tmux -S "$socket")
			if "${tmux_cmd[@]}" has-session -t "=${session}" 2>/dev/null; then
				attach_available="true"
			else
				attach_available="false"
				attach_reason="tmux-session-not-found"
			fi
		fi
	else
		attach_reason="unprobed-backend:${backend}"
	fi

	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	jq -c \
		--argjson row "$row" \
		--arg writer_host "$writer_host" \
		--argjson receipt_present "$receipt_present" \
		--argjson vis_receipt_present "$vis_receipt_present" \
		--argjson attach_available "$attach_available" \
		--arg attach_reason "$attach_reason" \
		--arg verified_at "$now" \
		'def str(v): if v == null or v == "" then null else v end;
		 .lane_ref += {
			started_at: ($row.started_at // null),
			completed_at: ($row.completed_at // null),
			exit_code: ($row.exit_code // null)
		 } |
		 .review = {
			state: ($row.review_state // null),
			status: ($row.review_status // null),
			disposition: ($row.review_disposition // null),
			disposition_reason: ($row.review_disposition_reason // null),
			receipt_path: ($row.pending_review_path // null),
			receipt_present: $receipt_present
		 } |
		 .handoff = {
			file: ($row.handoff_file // null),
			artifact_status: ($row.artifact_status // null)
		 } |
		 .attach = {
			backend: ($row.terminal_backend // $row.agent_backend // null),
			session: ($row.session_id // null),
			socket: ($row.tmux_socket // $row.persist_socket // null),
			available: $attach_available,
			verified_at: (if $attach_available == null then null else $verified_at end),
			reason_if_unavailable: str($attach_reason)
		 } |
		 .visibility = {
			verified: $row.visibility.verified,
			degraded: $row.visibility.degraded,
			reason: $row.visibility.reason,
			receipt_path: ($row.visibility_receipt_path // $row.visibility.receipt_path // null),
			receipt_present: $vis_receipt_present
		 } |
		 .generation = {
			app_stamp: ($row.app_stamp // null),
			release_generation: ($row.app_stamp.git_sha // null),
			source_version: ($row.app_stamp.launcher_version // null)
		 } |
		 .origin_host = ($row.exec_host // str($writer_host)) |
		 .writer_host = str($writer_host) |
		 .canonical_project_id = ($row.project_ref.id // $row.project_id // null) |
		 .canonical_project_dir = ($row.canonical_project_dir // null)' \
		<<<"$update" 2>/dev/null || printf '%s' "$update"
}

# Emit one LaneRef update through the configured transport. Same arguments as
# work_system_lane_ref_update. Always returns 0.
work_system_emit_lane_ref() {
	if [[ "$(work_system_bridge_mode)" == "off" ]]; then
		return 0
	fi
	local update
	update=$(work_system_lane_ref_update "$@") || update=""
	[[ -n "$update" ]] || return 0
	_work_system_bridge_transport "$update"
}

# Row-backed emission: derive the LaneRef fields from the task row already
# persisted in tasks.json (the producer-side working record), enrich with the
# first-class read-model fields, and emit. This is the SINGLE writer path for
# lifecycle transitions — spawn, completion, kill, and reaper all project
# through here so the lanes read-model carries one consistent snapshot.
# A missing row still emits task + status so consumers see the terminal state.
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
	local update
	update=$(work_system_lane_ref_update "$task_id" "$status" "$session" "$lane_kind" \
		"$worktree" "$surface" "$project_ref" "$lane_id") || update=""
	[[ -n "$update" ]] || return 0
	update=$(work_system_lane_ref_enrich "$update" "$row") || return 0
	[[ -n "$update" ]] || return 0
	_work_system_bridge_transport "$update"
}
