#!/bin/bash
#
# oste-pause.sh — Park a running agent lane in the `paused` lifecycle state.
#
# The operator counterpart to oste-kill.sh: it writes tasks.json status=paused
# (the same direct update_task_status pattern oste-kill uses) and emits the
# settled status through the Work System bridge — but it NEVER kills the process.
# A paused lane leaves Live and lands in Needs Review (limbo) in Command Central,
# which passthrough-trusts any non-"running" tasks.json status. Every launcher
# reaper scan gates on status=="running", so a paused row is reaper-safe for free.
#
# A paused lane has NO automatic paused→running transition. Its only exits are
# kill (oste-kill.sh: any→killed → Action) or an explicit same-id relaunch
# (oste-spawn rewrites status=running). "Relaunch as a new issue-scoped lane" is
# a different lane and does NOT touch the paused row — the operator must kill the
# old paused lane as part of that procedure (kill-to-clear), or it orphans in
# Needs Review. See research/DESIGN-paused-lane-lifecycle-v2-2026-06-28.md.
#
# Usage: oste-pause.sh <session-name> [OPTIONS]
#        oste-pause.sh --by-task-id <id> [OPTIONS]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly SCRIPT_DIR
readonly _DEFAULT_TASKS_DIR="${HOME}/.config/ghostty-launcher"
readonly TASKS_FILE="${TASKS_FILE:-${_DEFAULT_TASKS_DIR}/tasks.json}"

# Guard: in test mode, refuse to write to the real scripts/tasks.json.
if [[ "${OSTE_TEST_MODE:-}" == "1" ]]; then
	_real_tasks="${SCRIPT_DIR}/tasks.json"
	if [[ "$TASKS_FILE" == "$_real_tasks" ]]; then
		echo "ERROR: oste-pause.sh called with OSTE_TEST_MODE=1 but TASKS_FILE points to the real scripts/tasks.json." >&2
		echo "       Set TASKS_FILE to a temp file in your test setup to ensure isolation." >&2
		exit 1
	fi
	unset _real_tasks
fi

# shellcheck source=lib/terminal.sh
source "${SCRIPT_DIR}/lib/terminal.sh"
# shellcheck source=lib/tasks-lock.sh
source "${SCRIPT_DIR}/lib/tasks-lock.sh"
# shellcheck source=lib/reaper.sh
source "${SCRIPT_DIR}/lib/reaper.sh" # _resolve_task_tmux_socket/_conf (per-lane socket)
# shellcheck source=lib/prompt-detection.sh
source "${SCRIPT_DIR}/lib/prompt-detection.sh"
# shellcheck source=lib/work-system-bridge.sh
source "${SCRIPT_DIR}/lib/work-system-bridge.sh"
# shellcheck source=lib/env-validation.sh
source "${SCRIPT_DIR}/lib/env-validation.sh"

# Seconds between the two idle-detection pane captures. Production default is 1.5
# (a Claude TUI streaming a turn changes the pane within this window; an idle one
# awaiting input does not). Tests override it low to keep the suite fast.
# Validated to a positive number: a malformed/zero value would collapse the dwell
# and defeat the busy-vs-idle discrimination (the mis-fire guard), so fall back to
# the default rather than degrade silently.
PAUSE_DWELL_SECONDS="$(normalize_positive_number "${OSTE_PAUSE_DWELL_SECONDS:-1.5}" 1.5 OSTE_PAUSE_DWELL_SECONDS)"
readonly PAUSE_DWELL_SECONDS

# ── Usage ────────────────────────────────────────────────────────────

usage() {
	cat <<EOF
oste-pause.sh — Park a running agent lane in the paused state (never kills)

Usage:
  oste-pause.sh <session-name> [OPTIONS]
  oste-pause.sh --by-task-id <id> [OPTIONS]

Options:
  --by-task-id <id>  Select the lane by task_id instead of session name
  --force            Pause even if the lane's pane cannot be confirmed idle
  --help             Show this help

Behavior:
  Writes tasks.json status=paused under the tasks lock (compare-and-swap: only a
  running lane may be paused; a terminal lane is refused, a second pause is a
  no-op). The process is left running. Refuses if the pane shows active work
  unless --force.
EOF
}

# ── Helpers ──────────────────────────────────────────────────────────

die() {
	echo "Error: $*" >&2
	exit 1
}

# A stable fingerprint of the pane's visible tail, with ANSI/cursor noise
# stripped so an idle pane (e.g. a blinking cursor) hashes identically across
# captures. Empty (rc 0, empty stdout) when the pane cannot be observed.
_pane_fingerprint() {
	local target="$1"
	local content
	content=$(terminal_capture "$target" --lines 8 2>/dev/null || echo "")
	[[ -n "$content" ]] || {
		printf ''
		return 0
	}
	local normalized="" line
	while IFS= read -r line || [[ -n "$line" ]]; do
		normalized+="$(terminal_normalize_line "$line")"$'\n'
	done <<<"$content"
	printf '%s' "$normalized" | md5 -q 2>/dev/null ||
		printf '%s' "$normalized" | md5sum 2>/dev/null | cut -d' ' -f1
}

# Returns 0 when the pane is static across the dwell window (idle — safe to
# park), 1 when it is actively changing (working) OR cannot be observed. This is
# deliberately the inverse polarity of oste-kill's shell-prompt detection: a
# live-but-idle Claude lane is NOT at a shell prompt, so we compare snapshots
# instead of matching a prompt glyph.
_pane_is_idle() {
	local target="$1"
	local h1 h2
	h1=$(_pane_fingerprint "$target")
	[[ -n "$h1" ]] || return 1
	sleep "$PAUSE_DWELL_SECONDS"
	h2=$(_pane_fingerprint "$target")
	[[ -n "$h2" ]] || return 1
	[[ "$h1" == "$h2" ]]
}

# Optional Work System LaneRef emission once status=paused has settled in
# tasks.json (mirrors oste-kill's emit_kill_lane_ref_updates). tasks.json is the
# primary record; the bridge is fail-soft and never fails the pause. `paused` is
# non-terminal, so the bridge's monotonic terminal guard never blocks it and a
# settled lane is never regressed. NOTE: a bridge-emit failure here leaves
# lanes.json stale (showing the pre-pause state) with no auto-reconvergence — no
# reaper/sweep touches a paused row — until the lane is killed or respawned.
emit_pause_lane_ref_updates() {
	local task_id="$1"
	[[ "$(work_system_bridge_mode)" == "off" ]] && return 0
	work_system_emit_lane_ref_for_task "$TASKS_FILE" "$task_id" "paused" || true
	return 0
}

# Locked compare-and-swap: only a running lane transitions to paused. Mirrors
# reaper.sh's _reap_finalize_task guard so a pause never clobbers a row that
# completed/was killed in the race window. Exit codes: 0 paused (or already
# paused no-op), 2 refused (non-running status), 1 write error.
_commit_pause() {
	local task_id="$1"
	lock_tasks || {
		echo "Error: could not acquire tasks lock for '${task_id}'." >&2
		return 1
	}
	trap 'unlock_tasks' RETURN

	local current
	current=$(jq -r --arg id "$task_id" '.tasks[$id].status // ""' "$TASKS_FILE" 2>/dev/null || true)
	if [[ "$current" == "paused" ]]; then
		echo "Lane '${task_id}' is already paused (no-op)." >&2
		return 0
	fi
	if [[ "$current" != "running" ]]; then
		echo "Refusing to pause '${task_id}': status is '${current:-unknown}'. Only a running lane can be paused (use kill to clear a terminal lane)." >&2
		return 2
	fi
	if _tasks_json_apply --arg id "$task_id" '.tasks[$id].status = "paused"'; then
		emit_pause_lane_ref_updates "$task_id"
		echo "Paused '${task_id}' — parked in Needs Review (process left running)." >&2
		return 0
	fi
	echo "Error: failed to write paused status for '${task_id}'." >&2
	return 1
}

# Resolve a row's task_id (the tasks.json key) from a session name.
_task_id_for_session() {
	local session="$1"
	jq -r --arg sess "$session" \
		'[.tasks | to_entries[] | select(.value.session_id == $sess) | .key] | first // empty' \
		"$TASKS_FILE" 2>/dev/null || true
}

# Resolve a row's session_id from its task_id.
_session_for_task_id() {
	local task_id="$1"
	jq -r --arg id "$task_id" '.tasks[$id].session_id // empty' "$TASKS_FILE" 2>/dev/null || true
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
	local session=""
	local task_id=""
	local force=false

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--by-task-id)
				task_id="${2:-}"
				shift 2 || die "--by-task-id requires a value"
				;;
			--force)
				force=true
				shift
				;;
			--help | -h)
				usage
				exit 0
				;;
			-*) die "Unknown option: $1" ;;
			*)
				if [[ -z "$session" ]]; then
					session="$1"
				else
					die "Unexpected argument: $1"
				fi
				shift
				;;
		esac
	done

	[[ -f "$TASKS_FILE" ]] || die "tasks.json not found at ${TASKS_FILE}"

	# Resolve both session and task_id (the CC command passes session_id; the CLI
	# may pass either). task_id keys the CAS + the bridge; session drives the
	# pane idle probe.
	if [[ -n "$task_id" ]]; then
		session=$(_session_for_task_id "$task_id")
		[[ -n "$session" ]] || die "Task '$task_id' not found in tasks.json"
	else
		[[ -n "$session" ]] || {
			usage >&2
			die "session-name (or --by-task-id) is required"
		}
		task_id=$(_task_id_for_session "$session")
		[[ -n "$task_id" ]] || die "No task found for session '$session' in tasks.json"
	fi

	# Target the lane's specific tmux pane on its (possibly per-project) socket. A
	# lane runs on a custom socket, not the default one, so a bare
	# terminal_exists/terminal_capture on the session name would miss it and
	# wrongly conclude the lane is dead. Mirror oste-status: resolve socket/conf,
	# export them for the terminal libs, and probe the precise pane id.
	local probe_target="$session"
	local _backend
	_backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ "$_backend" == "tmux" ]]; then
		local tmux_socket tmux_conf tmux_pane_id
		tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session" 2>/dev/null || echo "")
		tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session" 2>/dev/null || echo "")
		tmux_pane_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_pane_id // empty' "$TASKS_FILE" 2>/dev/null || true)
		[[ -n "$tmux_socket" ]] && export GHL_TMUX_SOCKET="$tmux_socket"
		[[ -n "$tmux_conf" ]] && export GHL_TMUX_CONF="$tmux_conf"
		[[ -n "$tmux_pane_id" ]] && probe_target="$tmux_pane_id"
	fi

	# Refuse a lane whose pane is gone (already dead) — pause is for live lanes.
	if ! terminal_exists "$probe_target"; then
		die "Lane '${task_id}' pane (${probe_target}) does not exist (already dead). Nothing to pause — use kill to clear a dead lane."
	fi

	# Mis-fire guard: never park an actively-working lane.
	if [[ "$force" != true ]]; then
		if ! _pane_is_idle "$probe_target"; then
			die "Lane '${task_id}' looks busy (pane still changing) or its pane is not observable. Refusing to pause a working lane — wait until it is idle, or re-run with --force."
		fi
	fi

	local rc=0
	_commit_pause "$task_id" || rc=$?
	exit "$rc"
}

main "$@"
