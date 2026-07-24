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
_work_system_capture_current_pid() {
	if [[ -n "${BASHPID:-}" ]]; then
		_WORK_SYSTEM_CALLER_PID="$BASHPID"
	else
		local probe
		probe=$(mktemp "${TMPDIR:-/tmp}/oste-work-system-lock-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _WORK_SYSTEM_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_WORK_SYSTEM_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

work_system_bridge_lock_outbox() {
	local lockdir="$1"
	local ownerfile="${lockdir}/owner.json"
	local max_wait="${OSTE_WORK_SYSTEM_OUTBOX_LOCK_MAX_WAIT:-10}"
	local stale_age="${OSTE_WORK_SYSTEM_OUTBOX_LOCK_STALE_AGE:-60}"
	local waited=0
	local pid process_start token owner_tmp
	_work_system_capture_current_pid || return 1
	pid="$_WORK_SYSTEM_CALLER_PID"
	process_start=$(ps -p "$pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}')
	[[ -n "$process_start" ]] || return 1
	token="${pid}-$(date +%s)-${RANDOM:-0}-${RANDOM:-0}"
	owner_tmp="${lockdir}.owner.${pid}.${RANDOM:-0}"
	if ! jq -cn --argjson pid "$pid" --arg start "$process_start" --arg token "$token" \
		'{pid:$pid,process_start:$start,token:$token}' >"$owner_tmp" 2>/dev/null; then
		rm -f "$owner_tmp"
		return 1
	fi
	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			if ! mv "$owner_tmp" "$ownerfile"; then
				rm -f "$owner_tmp"
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
			_WORK_SYSTEM_OUTBOX_LOCK_OWNED="$lockdir"
			_WORK_SYSTEM_OUTBOX_LOCK_TOKEN="$token"
			return 0
		fi
		# Keep bridge non-blocking, but never steal a live matching generation.
		local held_pid="" held_start="" held_token="" current_start="" stale="false"
		held_pid=$(jq -r '.pid // empty' "$ownerfile" 2>/dev/null || true)
		held_start=$(jq -r '.process_start // empty' "$ownerfile" 2>/dev/null || true)
		held_token=$(jq -r '.token // empty' "$ownerfile" 2>/dev/null || true)
		if [[ "$held_pid" =~ ^[0-9]+$ ]]; then
			if ! kill -0 "$held_pid" 2>/dev/null; then
				stale="true"
			else
				current_start=$(ps -p "$held_pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}')
				[[ -n "$held_start" && -n "$current_start" && "$held_start" != "$current_start" ]] && stale="true"
			fi
		else
			local lock_mtime
			lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
			[[ $(($(date +%s) - lock_mtime)) -ge "$stale_age" ]] && stale="true"
		fi
		if [[ "$stale" == "true" ]]; then
			local reapdir="${lockdir}.reap"
			if mkdir "$reapdir" 2>/dev/null; then
				local verify_token
				verify_token=$(jq -r '.token // empty' "$ownerfile" 2>/dev/null || true)
				if [[ "$verify_token" == "$held_token" ]]; then
					rm -rf "$lockdir"
				fi
				rm -rf "$reapdir"
			else
				local reap_mtime
				reap_mtime=$(stat -f %m "$reapdir" 2>/dev/null || stat -c %Y "$reapdir" 2>/dev/null || echo 0)
				[[ $(($(date +%s) - reap_mtime)) -ge 5 ]] && rm -rf "$reapdir"
			fi
		fi
		sleep 0.1
		waited=$((waited + 1))
		if [[ $waited -ge $((max_wait * 10)) ]]; then
			echo "Warning: work-system projection lock timeout after ${max_wait}s" >&2
			rm -f "$owner_tmp"
			return 1
		fi
	done
}

work_system_bridge_unlock_outbox() {
	local lockdir="$1"
	local held_token
	[[ "${_WORK_SYSTEM_OUTBOX_LOCK_OWNED:-}" == "$lockdir" ]] || return 0
	held_token=$(jq -r '.token // empty' "${lockdir}/owner.json" 2>/dev/null || true)
	_WORK_SYSTEM_OUTBOX_LOCK_OWNED=""
	if [[ -n "$held_token" && "$held_token" == "${_WORK_SYSTEM_OUTBOX_LOCK_TOKEN:-}" ]]; then
		rm -rf "$lockdir" 2>/dev/null || true
	fi
	_WORK_SYSTEM_OUTBOX_LOCK_TOKEN=""
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
	local tmp
	tmp=$(mktemp "${outbox}.tmp.XXXXXX") || {
		work_system_bridge_unlock_outbox "$lockdir"
		return 0
	}
	if jq -c --arg id "$lane_id" --argjson update "$update" \
		'def terminal(s): ["completed", "completed_dirty", "contract_failure", "failed", "killed", "stopped"] | index(s) != null;
		 .version = 1 |
		 .kind = "work-system-lanes-projection" |
		 (.lanes[$id] // null) as $existing |
		 ($update.generation.task_generation // "") as $update_generation |
		 ($existing.generation.task_generation // "") as $existing_generation |
		 if $existing != null
			and terminal($existing.lane_ref.status // "")
			and (terminal($update.lane_ref.status // "") | not)
			and ($update_generation == "" or $update_generation == $existing_generation)
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
			revision: ($row.review_revision // null),
			attempt: ($row.review_attempt // null),
			attempt_id: ($row.review_attempt_id // null),
			task_generation: ($row.review_task_generation // $row.task_generation // null),
			owner_state: ($row.owner_review_state // null),
			retry_disabled: ($row.retry_disabled // false),
			blocker_count: ($row.review_blocker_count // null),
			disposition: ($row.review_disposition // null),
			disposition_reason: ($row.review_disposition_reason // null),
			receipt_path: ($row.pending_review_path // null),
			receipt_present: $receipt_present
		 } |
		 .completion_marker = ($row.completion_marker // null) |
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
			task_generation: ($row.task_generation // null),
			app_stamp: ($row.app_stamp // null),
			release_generation: ($row.app_stamp.git_sha // null),
			source_version: ($row.app_stamp.launcher_version // null)
		 } |
		 .origin_host = ($row.exec_host // str($writer_host)) |
		 .writer_host = str($writer_host) |
		 .canonical_project_id = ($row.project_ref.id // $row.project_id // null) |
		 .canonical_project_dir = ($row.canonical_project_dir // null) |
		 .work_item_ref = (.work_item_ref // ($row.work_item_ref // null)) |
		 .workroom_ref = (.workroom_ref // ($row.workroom_ref // null))' \
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
_work_system_projection_lock_acquire() {
	local tasks_file="$1" task_id="$2" safe_id root lockdir ownerfile waited=0 max_wait
	safe_id=$(printf '%s' "$task_id" | tr -c 'A-Za-z0-9._-' '_')
	root="${tasks_file}.projection-locks"
	lockdir="${root}/${safe_id}.lock"
	ownerfile="${lockdir}/owner.json"
	max_wait="${OSTE_WORK_SYSTEM_PROJECTION_LOCK_WAIT:-10}"
	mkdir -p "$root" 2>/dev/null || return 1
	while true; do
		if mkdir "$lockdir" 2>/dev/null; then
			local pid token process_start owner_tmp
			if ! _work_system_capture_current_pid; then
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
			pid="$_WORK_SYSTEM_CALLER_PID"
			token="${pid}-$(date +%s)-${RANDOM:-0}-${RANDOM:-0}"
			process_start=$(ps -p "$pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}')
			if [[ -z "$process_start" ]]; then
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
			owner_tmp="${ownerfile}.tmp.${pid}"
			if ! jq -cn --argjson pid "$pid" --arg start "$process_start" --arg token "$token" \
				'{pid:$pid,process_start:$start,token:$token}' >"$owner_tmp" 2>/dev/null || ! mv "$owner_tmp" "$ownerfile"; then
				rm -f "$owner_tmp"
				rmdir "$lockdir" 2>/dev/null || true
				return 1
			fi
			_WORK_SYSTEM_PROJECTION_LOCK_OWNED="$lockdir"
			_WORK_SYSTEM_PROJECTION_LOCK_TOKEN="$token"
			return 0
		fi
		local held_pid="" held_start="" held_token="" current_start="" stale="false"
		held_pid=$(jq -r '.pid // empty' "$ownerfile" 2>/dev/null || true)
		held_start=$(jq -r '.process_start // empty' "$ownerfile" 2>/dev/null || true)
		held_token=$(jq -r '.token // empty' "$ownerfile" 2>/dev/null || true)
		if [[ "$held_pid" =~ ^[0-9]+$ ]]; then
			if ! kill -0 "$held_pid" 2>/dev/null; then
				stale="true"
			else
				current_start=$(ps -p "$held_pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}')
				[[ -n "$held_start" && -n "$current_start" && "$held_start" != "$current_start" ]] && stale="true"
			fi
		elif [[ -d "$lockdir" ]]; then
			local lock_mtime now
			lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
			now=$(date +%s)
			[[ $((now - lock_mtime)) -ge "${OSTE_WORK_SYSTEM_PROJECTION_LOCK_STALE:-60}" ]] && stale="true"
		fi
		if [[ "$stale" == "true" ]]; then
			local reapdir="${lockdir}.reap"
			if mkdir "$reapdir" 2>/dev/null; then
				# Re-read owner identity under the reap mutex. Remove only if the
				# exact stale generation we observed is still present.
				local verify_pid verify_start verify_token
				verify_pid=$(jq -r '.pid // empty' "$ownerfile" 2>/dev/null || true)
				verify_start=$(jq -r '.process_start // empty' "$ownerfile" 2>/dev/null || true)
				verify_token=$(jq -r '.token // empty' "$ownerfile" 2>/dev/null || true)
				if [[ "$verify_pid" == "$held_pid" && "$verify_start" == "$held_start" && "$verify_token" == "$held_token" ]]; then
					rm -rf "$lockdir"
				fi
				rm -rf "$reapdir"
			else
				local reap_mtime reap_now
				reap_mtime=$(stat -f %m "$reapdir" 2>/dev/null || stat -c %Y "$reapdir" 2>/dev/null || echo 0)
				reap_now=$(date +%s)
				[[ $((reap_now - reap_mtime)) -ge 5 ]] && rm -rf "$reapdir"
			fi
		fi
		sleep 0.05
		waited=$((waited + 1))
		[[ "$waited" -lt $((max_wait * 20)) ]] || return 1
	done
}

_work_system_projection_lock_release() {
	local lockdir="${_WORK_SYSTEM_PROJECTION_LOCK_OWNED:-}" held_token=""
	[[ -n "$lockdir" ]] || return 0
	held_token=$(jq -r '.token // empty' "${lockdir}/owner.json" 2>/dev/null || true)
	_WORK_SYSTEM_PROJECTION_LOCK_OWNED=""
	if [[ -n "$held_token" && "$held_token" == "${_WORK_SYSTEM_PROJECTION_LOCK_TOKEN:-}" ]]; then
		rm -rf "$lockdir" 2>/dev/null || true
	fi
	_WORK_SYSTEM_PROJECTION_LOCK_TOKEN=""
}

work_system_emit_lane_ref_for_task() {
	local tasks_file="$1"
	local task_id="$2"
	local status="$3"
	if [[ "$(work_system_bridge_mode)" == "off" ]]; then
		return 0
	fi
	# Serialize every projection for this task outside tasks.json locking. The
	# winner re-reads the row after acquiring the lock and derives status from
	# durable truth, so a delayed advisory-running emitter cannot land after a
	# terminal or newer review revision.
	_work_system_projection_lock_acquire "$tasks_file" "$task_id" || return 0
	local row='{}'
	if [[ -f "$tasks_file" ]]; then
		row=$(jq -c --arg id "$task_id" '.tasks[$id] // {}' "$tasks_file" 2>/dev/null) || row='{}'
	fi
	local row_status
	row_status=$(jq -r '.status // empty' <<<"$row" 2>/dev/null || true)
	[[ -z "$row_status" ]] || status="$row_status"
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
	if [[ -z "$update" ]]; then
		_work_system_projection_lock_release
		return 0
	fi
	update=$(work_system_lane_ref_enrich "$update" "$row") || {
		_work_system_projection_lock_release
		return 0
	}
	if [[ -z "$update" ]]; then
		_work_system_projection_lock_release
		return 0
	fi
	local transport_rc=0
	_work_system_bridge_transport "$update" || transport_rc=$?
	_work_system_projection_lock_release
	# The bridge is advisory/fail-soft. Serialization must be released on every
	# transport outcome, and transport failure never fails the lifecycle writer.
	[[ "$transport_rc" -eq 0 ]] || return 0
}
