#!/bin/bash
#
# openclaw-task-events.sh — emit launcher task-lifecycle events shaped for the
# OpenClaw task ledger.
#
# Why: OpenClaw's public CLI (`openclaw tasks …`) exposes only read + cancel +
# notify-policy surfaces. There is no primitive to create or update a row in
# `~/.openclaw/tasks/runs.sqlite → task_runs` from an external process.
# `createTaskRecord` in openclaw's task-registry is gateway-internal.
#
# This emitter writes an append-only JSONL feed whose records map 1:1 onto the
# `task_runs` schema (runtime="cli", task_kind, owner_key, scope_kind, label,
# task, status, created_at, started_at, ended_at, last_event_at, error,
# terminal_summary, terminal_outcome). When an OpenClaw ingester or public CLI
# primitive lands, this feed can be replayed verbatim with no information loss.
#
# Feed path: ${OSTE_LAUNCHER_TASK_EVENTS_FILE:-~/.openclaw/workspace/launcher-task-events.jsonl}
#
# Test isolation:
#   - OSTE_TEST_MODE=1 suppresses emission unless OSTE_LAUNCHER_TASK_EVENTS_FILE
#     is explicitly set (same convention as OSTE_PENDING_REVIEW_DIR).
#
# Every emitter is best-effort: emission must never fail a spawn or completion.

if [[ -n "${_OPENCLAW_TASK_EVENTS_LOADED:-}" ]]; then
	return 0
fi
_OPENCLAW_TASK_EVENTS_LOADED=1

# Resolve the canonical feed path (honouring explicit override).
openclaw_task_events_file() {
	if [[ -n "${OSTE_LAUNCHER_TASK_EVENTS_FILE:-}" ]]; then
		printf '%s' "$OSTE_LAUNCHER_TASK_EVENTS_FILE"
		return 0
	fi
	printf '%s/.openclaw/workspace/launcher-task-events.jsonl' "$HOME"
}

# Map launcher status strings onto the canonical OpenClaw TaskStatus enum.
# Reference: dist/plugin-sdk/src/tasks/task-registry.types.d.ts
#   TaskStatus = "queued"|"running"|"succeeded"|"failed"|"timed_out"|"cancelled"|"lost"
openclaw_task_events_map_status() {
	case "$1" in
		completed) printf 'succeeded' ;;
		completed_dirty) printf 'succeeded' ;;
		completed_stale) printf 'lost' ;;
		contract_failure) printf 'failed' ;;
		failed) printf 'failed' ;;
		killed | cancelled | stopped) printf 'cancelled' ;;
		timed_out) printf 'timed_out' ;;
		running | queued) printf '%s' "$1" ;;
		*) printf 'failed' ;;
	esac
}

# Map launcher status strings onto the TaskTerminalOutcome enum.
#   TaskTerminalOutcome = "succeeded"|"blocked"
openclaw_task_events_map_terminal_outcome() {
	case "$1" in
		completed) printf 'succeeded' ;;
		completed_dirty | contract_failure) printf 'blocked' ;;
		*) printf '' ;;
	esac
}

# Resolve the owner_key for this launcher-managed task. When a session_key is
# known (native OpenClaw lane) use it verbatim; otherwise fall back to the
# canonical CLI owner format used elsewhere in openclaw: "cli:local:<user>".
openclaw_task_events_owner_key() {
	local session_key="${1:-}"
	if [[ -n "$session_key" ]]; then
		printf '%s' "$session_key"
		return 0
	fi
	local user_name="${USER:-$(id -un 2>/dev/null || echo unknown)}"
	printf 'cli:local:%s' "$user_name"
}

openclaw_task_events_scope_kind() {
	local session_key="${1:-}"
	if [[ -n "$session_key" ]]; then
		printf 'session'
	else
		printf 'system'
	fi
}

# Append a single JSONL record to the feed. Best-effort.
openclaw_task_events_append() {
	local record="$1"
	local feed_path
	feed_path="$(openclaw_task_events_file)"

	# Respect test-mode unless caller explicitly routed the feed.
	if [[ "${OSTE_TEST_MODE:-}" == "1" && -z "${OSTE_LAUNCHER_TASK_EVENTS_FILE:-}" ]]; then
		return 0
	fi

	local feed_dir
	feed_dir="$(dirname "$feed_path")"
	mkdir -p "$feed_dir" 2>/dev/null || return 0

	printf '%s\n' "$record" >>"$feed_path" 2>/dev/null || true
}

# Emit a task_started event. Call after register_task succeeds.
#
# Usage:
#   openclaw_task_event_started <task_id> <task_kind> <label> <task_text> <launcher_extras_json>
#
# launcher_extras_json must be a compact JSON object or "{}".
openclaw_task_event_started() {
	local task_id="$1"
	local task_kind="${2:-launcher}"
	local label="${3:-}"
	local task_text="${4:-}"
	local launcher_extras_json="${5:-{\}}"

	[[ -n "$task_id" ]] || return 0

	local session_key
	session_key="${OSTE_SESSION_KEY:-${OPENCLAW_SESSION_KEY:-}}"
	local owner_key scope_kind
	owner_key="$(openclaw_task_events_owner_key "$session_key")"
	scope_kind="$(openclaw_task_events_scope_kind "$session_key")"

	local now_iso now_ms
	now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	now_ms=$(date +%s000)

	local record
	record=$(jq -cn \
		--arg ts "$now_iso" \
		--arg event "task_started" \
		--arg task_id "$task_id" \
		--arg runtime "cli" \
		--arg task_kind "$task_kind" \
		--arg source_id "ghostty-launcher" \
		--arg owner_key "$owner_key" \
		--arg scope_kind "$scope_kind" \
		--arg requester_session_key "$session_key" \
		--arg agent_id "${OSTE_TASK_ROLE:-}" \
		--arg label "$label" \
		--arg task "$task_text" \
		--arg status "running" \
		--argjson created_at "$now_ms" \
		--argjson started_at "$now_ms" \
		--argjson last_event_at "$now_ms" \
		--argjson launcher "$launcher_extras_json" \
		'{
			ts: $ts,
			event: $event,
			schema_version: 1,
			task_id: $task_id,
			runtime: $runtime,
			task_kind: $task_kind,
			source_id: $source_id,
			owner_key: $owner_key,
			scope_kind: $scope_kind,
			requester_session_key: (if $requester_session_key == "" then null else $requester_session_key end),
			agent_id: (if $agent_id == "" then null else $agent_id end),
			run_id: null,
			label: (if $label == "" then null else $label end),
			task: $task,
			status: $status,
			created_at: $created_at,
			started_at: $started_at,
			ended_at: null,
			last_event_at: $last_event_at,
			exit_code: null,
			error: null,
			terminal_summary: null,
			terminal_outcome: null,
			launcher: $launcher
		}' 2>/dev/null) || return 0

	openclaw_task_events_append "$record"
}

# Emit a task_terminal event. Call from oste-complete.sh once the final status
# is known.
#
# Usage:
#   openclaw_task_event_terminal <task_id> <launcher_status> <exit_code> \
#       <terminal_summary> <launcher_extras_json>
openclaw_task_event_terminal() {
	local task_id="$1"
	local launcher_status="${2:-failed}"
	local exit_code="${3:-}"
	local terminal_summary="${4:-}"
	local launcher_extras_json="${5:-{\}}"

	[[ -n "$task_id" ]] || return 0

	local session_key
	session_key="${OSTE_SESSION_KEY:-${OPENCLAW_SESSION_KEY:-}}"
	local owner_key scope_kind
	owner_key="$(openclaw_task_events_owner_key "$session_key")"
	scope_kind="$(openclaw_task_events_scope_kind "$session_key")"

	local mapped_status terminal_outcome
	mapped_status=$(openclaw_task_events_map_status "$launcher_status")
	terminal_outcome=$(openclaw_task_events_map_terminal_outcome "$launcher_status")

	local error_text=""
	case "$launcher_status" in
		failed) error_text="exit_code=${exit_code}" ;;
		contract_failure) error_text="contract_failure: expected handoff artifact missing" ;;
		completed_dirty) error_text="completed_dirty: auto-commit failed, tree left dirty" ;;
	esac

	local now_iso now_ms
	now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	now_ms=$(date +%s000)

	local exit_code_json="null"
	if [[ "$exit_code" =~ ^-?[0-9]+$ ]]; then
		exit_code_json="$exit_code"
	fi

	local record
	record=$(jq -cn \
		--arg ts "$now_iso" \
		--arg event "task_terminal" \
		--arg task_id "$task_id" \
		--arg runtime "cli" \
		--arg task_kind "${OSTE_TASK_KIND:-launcher}" \
		--arg source_id "ghostty-launcher" \
		--arg owner_key "$owner_key" \
		--arg scope_kind "$scope_kind" \
		--arg requester_session_key "$session_key" \
		--arg agent_id "${OSTE_TASK_ROLE:-}" \
		--arg status "$mapped_status" \
		--arg launcher_status "$launcher_status" \
		--argjson ended_at "$now_ms" \
		--argjson last_event_at "$now_ms" \
		--argjson exit_code "$exit_code_json" \
		--arg error "$error_text" \
		--arg terminal_summary "$terminal_summary" \
		--arg terminal_outcome "$terminal_outcome" \
		--argjson launcher "$launcher_extras_json" \
		'{
			ts: $ts,
			event: $event,
			schema_version: 1,
			task_id: $task_id,
			runtime: $runtime,
			task_kind: $task_kind,
			source_id: $source_id,
			owner_key: $owner_key,
			scope_kind: $scope_kind,
			requester_session_key: (if $requester_session_key == "" then null else $requester_session_key end),
			agent_id: (if $agent_id == "" then null else $agent_id end),
			run_id: null,
			label: null,
			task: null,
			status: $status,
			launcher_status: $launcher_status,
			created_at: null,
			started_at: null,
			ended_at: $ended_at,
			last_event_at: $last_event_at,
			exit_code: $exit_code,
			error: (if $error == "" then null else $error end),
			terminal_summary: (if $terminal_summary == "" then null else $terminal_summary end),
			terminal_outcome: (if $terminal_outcome == "" then null else $terminal_outcome end),
			launcher: $launcher
		}' 2>/dev/null) || return 0

	openclaw_task_events_append "$record"
}
