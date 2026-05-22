#!/bin/bash
#
# oste-stop-hook.sh — Claude Code Stop hook handler
#
# Called by Claude Code every time the agent finishes a response turn.
# Resolves the current launcher task context so the orchestrator can record
# liveness/progress for the active lane. When the launcher registered an
# explicit handoff-file contract and that artifact appears after task start,
# this hook can finalize the task without requiring the visible Claude Code
# terminal to exit.
#
# IMPORTANT: This hook fires on EVERY response turn, not just the final one.
# It is only an authoritative completion trigger when a deterministic launcher
# artifact contract is satisfied; otherwise it only records progress.
#
# Input (JSON on stdin from Claude Code):
#   session_id, transcript_path, stop_hook_active, last_assistant_message, cwd
#
# Guard: only fires once per task (checks oste-complete marker).
# Guard: stop_hook_active=true means we're in a hook loop — bail.
#
# Pod mode: Multiple agents can share the same CWD. The map file stores
# one entry per agent (append mode). OSTE_TASK_ID env var identifies which
# entry belongs to this Claude Code instance (set by oste-spawn.sh).
#
# DEFENSIVE: This hook must NEVER crash. Any failure exits 0 silently.
# Agent Teams sessions can pass unexpected input; set -e would abort on
# jq parse errors, missing fields, or wrong CWD — causing Claude Code to
# log "Stop hook error: Failed with non-blocking status code".
#
set -u

# Skip all processing during test runs — prevents completion chain firing
# from test-exercised stop-hook paths.
[[ "${OSTE_TEST_MODE:-}" == "1" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/hook-trace.sh
source "${SCRIPT_DIR}/lib/hook-trace.sh"

# Debug logging — append to rolling log (keep last 5 invocations)
_debug_log="/tmp/oste-stop-hook-debug.log"
_log_debug() {
	{
		echo "--- $(date -u +"%Y-%m-%dT%H:%M:%SZ") ---"
		echo "cwd=${_debug_cwd:-<unset>}"
		echo "task_id=${_debug_task_id:-<unset>}"
		echo "outcome=$1"
		echo ""
	} >>"$_debug_log" 2>/dev/null || true
	# Trim to last 5 entries (each entry is 5 lines)
	if [[ -f "$_debug_log" ]]; then
		tail -25 "$_debug_log" >"/tmp/oste-stop-hook-debug.tmp" 2>/dev/null &&
			mv "/tmp/oste-stop-hook-debug.tmp" "$_debug_log" 2>/dev/null || true
	fi
}

# Trap: any unexpected error → log and exit clean
trap '_log_debug "trap-error"; exit 0' ERR

_debug_cwd=""
_debug_task_id=""

_tasks_file="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"

_iso_to_epoch() {
	local value="${1:-}"
	[[ -n "$value" && "$value" != "null" ]] || return 1
	date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$value" +%s 2>/dev/null ||
		date -u -d "$value" +%s 2>/dev/null
}

_file_mtime_epoch() {
	local path="${1:-}"
	[[ -n "$path" && -e "$path" ]] || return 1
	stat -f %m "$path" 2>/dev/null || stat -c %Y "$path" 2>/dev/null
}

_resolve_handoff_path() {
	local handoff="${1:-}"
	local project_dir="${2:-}"
	[[ -n "$handoff" && "$handoff" != "null" ]] || return 1
	case "$handoff" in
		/*) printf '%s\n' "$handoff" ;;
		*)
			if [[ -n "$project_dir" ]]; then
				printf '%s/%s\n' "$project_dir" "$handoff"
			else
				printf '%s\n' "$handoff"
			fi
			;;
	esac
}

_artifact_contract_ready() {
	local task_id_arg="$1"
	local cwd_arg="$2"
	local tasks_file="$_tasks_file"
	[[ -f "$tasks_file" ]] || return 1

	local task_json
	task_json=$(jq -c --arg id "$task_id_arg" '.tasks[$id] // empty' "$tasks_file" 2>/dev/null) || return 1
	[[ -n "$task_json" ]] || return 1

	local status handoff project_dir started_at handoff_path
	status=$(printf '%s' "$task_json" | jq -r '.status // empty' 2>/dev/null) || status=""
	[[ "$status" == "running" ]] || return 1

	handoff=$(printf '%s' "$task_json" | jq -r '.handoff_file // empty' 2>/dev/null) || handoff=""
	[[ -n "$handoff" && "$handoff" != "null" ]] || return 1

	project_dir=$(printf '%s' "$task_json" | jq -r '.project_dir // empty' 2>/dev/null) || project_dir=""
	[[ -n "$project_dir" ]] || project_dir="$cwd_arg"
	handoff_path=$(_resolve_handoff_path "$handoff" "$project_dir") || return 1
	[[ -f "$handoff_path" ]] || return 1

	# Avoid accepting stale handoffs from a prior run. If started_at is present,
	# the artifact must be written/updated after the task was registered.
	started_at=$(printf '%s' "$task_json" | jq -r '.started_at // empty' 2>/dev/null) || started_at=""
	if [[ -n "$started_at" && "$started_at" != "null" ]]; then
		local start_epoch artifact_epoch
		start_epoch=$(_iso_to_epoch "$started_at") || return 1
		artifact_epoch=$(_file_mtime_epoch "$handoff_path") || return 1
		[[ "$artifact_epoch" -ge "$start_epoch" ]] || return 1
	fi

	return 0
}

_finalize_artifact_contract() {
	local task_id_arg="$1"
	local complete_script="${OSTE_COMPLETE_SCRIPT:-${SCRIPT_DIR}/oste-complete.sh}"
	[[ -x "$complete_script" || -f "$complete_script" ]] || return 1
	TASKS_FILE="$_tasks_file" bash "$complete_script" "$task_id_arg" 0 >/tmp/oste-stop-complete-${task_id_arg}.log 2>&1
}

_finalize_completion_report() {
	local task_id_arg="$1"
	local exit_code="$2"
	local complete_script="${OSTE_COMPLETE_SCRIPT:-${SCRIPT_DIR}/oste-complete.sh}"
	[[ -x "$complete_script" || -f "$complete_script" ]] || return 1
	TASKS_FILE="$_tasks_file" bash "$complete_script" "$task_id_arg" "$exit_code" >/tmp/oste-stop-complete-${task_id_arg}.log 2>&1
}

_report_field() {
	local report_file="$1"
	local key="$2"
	local line=""
	local value=""

	line=$(grep -E "^[[:space:]]*${key}:" "$report_file" 2>/dev/null | head -1 || true)
	[[ -n "$line" ]] || return 0
	value="${line#*:}"
	# trim leading/trailing whitespace, then one layer of quotes
	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	value="${value%\"}"
	value="${value#\"}"
	value="${value%\'}"
	value="${value#\'}"
	printf '%s\n' "$value"
}

_project_tree_clean() {
	local project_dir="$1"
	[[ -n "$project_dir" && -d "$project_dir/.git" ]] || return 0
	[[ -z "$(git -C "$project_dir" status --porcelain 2>/dev/null || true)" ]]
}

_final_message_contract_ready() {
	local task_id_arg="$1"
	local cwd_arg="$2"
	local last_message_arg="$3"
	local tasks_file="$_tasks_file"
	[[ -f "$tasks_file" ]] || return 1

	local task_json
	task_json=$(jq -c --arg id "$task_id_arg" '.tasks[$id] // empty' "$tasks_file" 2>/dev/null) || return 1
	[[ -n "$task_json" ]] || return 1

	local status role handoff project_dir
	status=$(printf '%s' "$task_json" | jq -r '.status // empty' 2>/dev/null) || status=""
	[[ "$status" == "running" ]] || return 1

	role=$(printf '%s' "$task_json" | jq -r '.role // empty' 2>/dev/null) || role=""
	case "$role" in
		planner | test) ;;
		*) return 1 ;;
	esac

	handoff=$(printf '%s' "$task_json" | jq -r '.handoff_file // empty' 2>/dev/null) || handoff=""
	[[ -z "$handoff" || "$handoff" == "null" ]] || return 1

	# The marker must be the final non-empty line. This keeps ordinary progress
	# turns from becoming lifecycle signals.
	local final_line=""
	final_line=$(printf '%s\n' "$last_message_arg" | awk 'NF { line=$0 } END { print line }')
	[[ "$final_line" == "TASK COMPLETE" ]] || return 1

	project_dir=$(printf '%s' "$task_json" | jq -r '.project_dir // empty' 2>/dev/null) || project_dir=""
	[[ -n "$project_dir" ]] || project_dir="$cwd_arg"
	_project_tree_clean "$project_dir" || return 1

	return 0
}

# Late-handoff reconciliation predicate. Returns 0 only when the existing
# completion marker reflects a contract_failure that is *known repairable*:
# success exit code, missing artifact at original-fire time, declared handoff,
# and the handoff now exists with mtime >= started_at. Anything else returns 1
# so we fall through to the normal "skip already completed" guard.
_artifact_contract_repairable() {
	local task_id_arg="$1"
	local cwd_arg="$2"
	local marker="/tmp/oste-complete-${task_id_arg}"
	[[ -f "$marker" ]] || return 1

	# Marker must specifically be a missing-artifact contract failure with
	# successful exit code. Any other marker shape (failed, completed_dirty,
	# already-reconciled completed, etc.) is not eligible.
	grep -q '^status=contract_failure$' "$marker" 2>/dev/null || return 1
	grep -q '^exit_code=0$' "$marker" 2>/dev/null || return 1
	grep -q '^artifact_status=missing$' "$marker" 2>/dev/null || return 1

	local tasks_file="$_tasks_file"
	[[ -f "$tasks_file" ]] || return 1

	local task_json
	task_json=$(jq -c --arg id "$task_id_arg" '.tasks[$id] // empty' "$tasks_file" 2>/dev/null) || return 1
	[[ -n "$task_json" ]] || return 1

	local status exit_code artifact_status handoff project_dir started_at
	status=$(printf '%s' "$task_json" | jq -r '.status // empty' 2>/dev/null) || return 1
	exit_code=$(printf '%s' "$task_json" | jq -r '.exit_code // empty' 2>/dev/null) || return 1
	artifact_status=$(printf '%s' "$task_json" | jq -r '.artifact_status // empty' 2>/dev/null) || return 1
	[[ "$status" == "contract_failure" ]] || return 1
	[[ "$exit_code" == "0" ]] || return 1
	[[ "$artifact_status" == "missing" ]] || return 1

	handoff=$(printf '%s' "$task_json" | jq -r '.handoff_file // empty' 2>/dev/null) || return 1
	[[ -n "$handoff" && "$handoff" != "null" ]] || return 1

	project_dir=$(printf '%s' "$task_json" | jq -r '.project_dir // empty' 2>/dev/null) || project_dir=""
	[[ -n "$project_dir" ]] || project_dir="$cwd_arg"
	local handoff_path
	handoff_path=$(_resolve_handoff_path "$handoff" "$project_dir") || return 1
	[[ -f "$handoff_path" ]] || return 1

	started_at=$(printf '%s' "$task_json" | jq -r '.started_at // empty' 2>/dev/null) || started_at=""
	if [[ -n "$started_at" && "$started_at" != "null" ]]; then
		local start_epoch artifact_epoch
		start_epoch=$(_iso_to_epoch "$started_at") || return 1
		artifact_epoch=$(_file_mtime_epoch "$handoff_path") || return 1
		[[ "$artifact_epoch" -ge "$start_epoch" ]] || return 1
	fi

	return 0
}

_reconcile_late_handoff() {
	local task_id_arg="$1"
	local complete_script="${OSTE_COMPLETE_SCRIPT:-${SCRIPT_DIR}/oste-complete.sh}"
	[[ -x "$complete_script" || -f "$complete_script" ]] || return 1
	OSTE_RECONCILE_LATE_HANDOFF=1 TASKS_FILE="$_tasks_file" \
		bash "$complete_script" "$task_id_arg" 0 \
		>"/tmp/oste-stop-reconcile-${task_id_arg}.log" 2>&1
}

input=$(cat) || exit 0
last_assistant_message=$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null) || last_assistant_message=""
raw_cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null) || raw_cwd=""
hook_trace_append "stop-hook-entry" "$input" "$(jq -cn \
	--arg hook_event "Stop" \
	--arg cwd "$raw_cwd" \
	'{hook_event: $hook_event, cwd: $cwd}')"

# Guard: stop_hook_active means Claude is processing a hook response — bail
stop_active=$(echo "$input" | jq -r '.stop_hook_active // false' 2>/dev/null) || stop_active="false"
if [[ "$stop_active" == "true" ]]; then
	_log_debug "skip-hook-active"
	exit 0
fi

# Get CWD from Claude Code's context
cwd="$raw_cwd"
_debug_cwd="$cwd"
if [[ -z "$cwd" ]]; then
	_log_debug "skip-no-cwd"
	exit 0
fi

# ── Resolve task_id ──────────────────────────────────────────────────
# Preferred: OSTE_TASK_ID env var (set by oste-spawn.sh in the wrapped
# command). This correctly identifies which task this Claude Code instance
# belongs to, even when multiple agents share the same CWD (pod mode).
task_id="${OSTE_TASK_ID:-}"
task_role="${OSTE_TASK_ROLE:-}"

if [[ -z "$task_id" ]]; then
	# DEPRECATED: Remove after 2026-04-15. All agents spawned by oste-spawn.sh set OSTE_TASK_ID.
	# Fallback: CWD-based marker file (backward compat for sessions spawned
	# before the OSTE_TASK_ID env var was added).
	cwd_hash=$(echo -n "$cwd" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || echo -n "$cwd" | md5 -q 2>/dev/null) || exit 0
	task_file="/tmp/oste-stop-map-${cwd_hash}"
	if [[ ! -f "$task_file" ]]; then
		_log_debug "skip-no-map"
		exit 0
	fi

	# Read first entry from map (backward compat: single-entry format)
	map_content=$(head -1 "$task_file") || exit 0
	task_id="${map_content%%:*}"
	# Extract role (second field) — handle both old format (task:role) and
	# new format (task:role:session)
	_remainder="${map_content#*:}"
	task_role="${_remainder%%:*}"
	# If no colon separator, role equals task_id — clear it
	[[ "$task_role" == "$task_id" ]] && task_role=""
fi

_debug_task_id="$task_id"

if [[ -z "$task_id" ]]; then
	_log_debug "skip-empty-task-id"
	hook_trace_append "stop-hook-resolved" "$input" "$(jq -cn \
		--arg resolved_task_id "" \
		--arg task_role "$task_role" \
		--arg resolution_source "none" \
		'{resolved_task_id: $resolved_task_id, task_role: $task_role, resolution_source: $resolution_source}')"
	exit 0
fi

resolution_source="env"
if [[ -z "${OSTE_TASK_ID:-}" ]]; then
	resolution_source="cwd-map"
fi
hook_trace_append "stop-hook-resolved" "$input" "$(jq -cn \
	--arg resolved_task_id "$task_id" \
	--arg task_role "$task_role" \
	--arg resolution_source "$resolution_source" \
	'{resolved_task_id: $resolved_task_id, task_role: $task_role, resolution_source: $resolution_source}')"

# Persist the last assistant turn for completion-chain enrichment.
# Limit to 500 chars to keep hook payloads bounded.
last_message_truncated="${last_assistant_message:0:500}"
printf '%s' "$last_message_truncated" >"/tmp/oste-last-message-${task_id}" 2>/dev/null || true

# Test task filtering: rely on OSTE_TEST_MODE=1 check at line 31.
# The previous naming-convention filter (test-*, spawn-*, etc.) caused
# false positives on real tasks like "test-spawn-bundle". Removed.

# Don't double-fire if already completed.
#
# Exception: late-handoff reconciliation. If the prior completion stamped a
# contract_failure *only* because the handoff artifact was missing at fire
# time, but the artifact now exists and is non-stale, repair the false
# failure. The predicate is intentionally narrow — see
# _artifact_contract_repairable() — so any other marker shape (failed,
# completed_dirty, already-reconciled completed) falls through to the normal
# skip path.
if [[ -f "/tmp/oste-complete-${task_id}" ]]; then
	if _artifact_contract_repairable "$task_id" "$cwd"; then
		if _reconcile_late_handoff "$task_id"; then
			_log_debug "late-handoff-reconciled"
			exit 0
		fi
		_log_debug "late-handoff-reconcile-failed"
	fi
	_log_debug "skip-already-completed"
	exit 0
fi

# Progress logging: Stop hook fires on every turn, not just the final one.
# Without an explicit artifact contract this hook only records a progress turn
# so the orchestrator knows the agent is active.
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) turn task=${task_id}" >>"/tmp/oste-progress-${task_id}.log" 2>/dev/null || true

# Deterministic report completion path. A final .oste-report.yaml is stronger
# than a generic handoff artifact because it records the agent's declared final
# status. Success reports require a clean tree and any handoff contract to be
# present; failure reports finalize with exit 1 so failed work is surfaced.
report_file="${cwd}/.oste-report.yaml"
if [[ "${OSTE_STOP_DETERMINISTIC_COMPLETE:-1}" != "0" && -f "$report_file" ]]; then
	report_task_id=$(_report_field "$report_file" "task_id")
	report_status=$(_report_field "$report_file" "status")
	if [[ -n "$report_task_id" && "$report_task_id" != "$task_id" ]]; then
		_log_debug "report-task-id-mismatch"
		exit 0
	fi
	case "$report_status" in
		failure | failed)
			if _finalize_completion_report "$task_id" 1; then
				_log_debug "completion-report-failure-fired"
				exit 0
			fi
			_log_debug "completion-report-failure-failed"
			exit 0
			;;
		success | completed)
			# Dirty-tree gate is conditional on the handoff backstop:
			#
			#   • Handoff declared + ready → finalize through oste-complete.sh
			#     even with a dirty tree. The finalizer's scoped auto-commit
			#     handles owned files (handoff, .oste-report.yaml, baseline-
			#     respecting code) and the artifact-contract verifier still
			#     runs. Without this allowance, the dogfood pattern of
			#     "agent writes handoff + report, leaves them untracked,
			#     waits at prompt" gets stuck on "completion-report-dirty-tree"
			#     because the very lifecycle artifacts the report endorses
			#     keep the tree dirty.
			#
			#   • Handoff declared + not ready → bail. Don't silently
			#     finalize a success report when the contracted artifact is
			#     still missing or stale.
			#
			#   • Handoff NOT declared → require a clean tree. A success
			#     report with no handoff backstop and arbitrary uncommitted
			#     code is not a deterministic finalization signal; let the
			#     normal process-exit path handle it.
			if jq -e --arg id "$task_id" '(.tasks[$id].handoff_file // "") != ""' "$_tasks_file" >/dev/null 2>&1; then
				if ! _artifact_contract_ready "$task_id" "$cwd"; then
					_log_debug "completion-report-handoff-missing"
					exit 0
				fi
			else
				if ! _project_tree_clean "$cwd"; then
					_log_debug "completion-report-dirty-tree"
					exit 0
				fi
			fi
			if _finalize_completion_report "$task_id" 0; then
				_log_debug "completion-report-success-fired"
				exit 0
			fi
			_log_debug "completion-report-success-failed"
			exit 0
			;;
		*)
			_log_debug "completion-report-status-unrecognized"
			exit 0
			;;
	esac
fi

# Native non-exit completion path: Claude Code's Stop hook fires when the turn
# reaches a stable input boundary. If the launcher registered a handoff-file
# contract and that artifact now exists, the runtime can finalize the task even
# while the visible terminal remains open for review.
#
# The finalizer simply invokes oste-complete.sh — the SAME entry point used
# by the process-exit completion path. Dual-lane review semantics
# (developer vs reviewer lanes) live in oste-complete.sh and are role-driven,
# so both completion paths converge on identical pending-review/watchdog
# behavior. See oste-complete.sh "Step 7" for the canonical fork.
if _artifact_contract_ready "$task_id" "$cwd"; then
	if _finalize_artifact_contract "$task_id"; then
		_log_debug "artifact-contract-complete-fired"
		exit 0
	fi
	_log_debug "artifact-contract-complete-failed"
	exit 0
fi

if _final_message_contract_ready "$task_id" "$cwd" "$last_assistant_message"; then
	if _finalize_completion_report "$task_id" 0; then
		_log_debug "final-message-contract-fired"
		exit 0
	fi
	_log_debug "final-message-contract-failed"
	exit 0
fi

_log_debug "logged-progress"

exit 0
