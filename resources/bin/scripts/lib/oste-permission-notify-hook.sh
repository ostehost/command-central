#!/bin/bash
#
# oste-permission-notify-hook.sh — Claude Code Notification(permission_prompt) hook
#
# Records permission_prompt notifications and routes an alert to the workroom
# (or ops-fallback when no workroom is known). Notification hooks cannot block.
#
# Input (JSON on stdin from Claude Code):
#   session_id, transcript_path, cwd, permission_mode,
#   notification_type, message, title
#
# This hook fires only when notification_type == "permission_prompt".
# The Notification matcher in install-claude-hooks.sh scopes to "permission_prompt",
# but we guard here too so sourcing in tests is safe.
#
# DEFENSIVE: This hook must NEVER crash a lane — all errors trap to exit 0.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
readonly SCRIPT_DIR
# shellcheck source=lib/permission-broker.sh
source "${SCRIPT_DIR}/lib/permission-broker.sh"
# shellcheck source=lib/hook-trace.sh
source "${SCRIPT_DIR}/lib/hook-trace.sh"

# Trap: any unexpected error → exit 0 (never crash a lane)
trap 'exit 0' ERR

input=$(cat)

# ── Parse fields ─────────────────────────────────────────────────────
notification_type=$(printf '%s' "$input" | jq -r '.notification_type // ""' 2>/dev/null || true)

# Guard: only handle permission_prompt notifications
if [[ "$notification_type" != "permission_prompt" ]]; then
	exit 0
fi

session_id=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || true)
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || true)
permission_mode=$(printf '%s' "$input" | jq -r '.permission_mode // ""' 2>/dev/null || true)
message=$(printf '%s' "$input" | jq -r '.message // ""' 2>/dev/null || true)

# ── Resolve task_id ───────────────────────────────────────────────────
task_id="${OSTE_TASK_ID:-}"
if [[ -z "$task_id" && -n "$cwd" ]]; then
	cwd_hash=$(printf '%s' "$cwd" | shasum -a 256 2>/dev/null | cut -d' ' -f1 || true)
	task_file="/tmp/oste-stop-map-${cwd_hash}"
	if [[ -f "$task_file" ]]; then
		map_content=$(head -1 "$task_file" 2>/dev/null || true)
		task_id="${map_content%%:*}"
	fi
fi
[[ -n "$task_id" ]] || task_id="unknown"

# ── Trace entry ───────────────────────────────────────────────────────
hook_trace_append "permission-notify-hook-entry" "$input" "$(jq -cn \
	--arg task_id "$task_id" \
	--arg notification_type "$notification_type" \
	--arg cwd "$cwd" \
	'{task_id: $task_id, notification_type: $notification_type, cwd: $cwd}')" 2>/dev/null || true

# ── Workroom + routing ────────────────────────────────────────────────
workroom=$(permission_broker_resolve_workroom "$task_id" 2>/dev/null || echo "")
routing="ops_fallback"
[[ -n "$workroom" ]] && routing="workroom"

# ── Build + write receipt ─────────────────────────────────────────────
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
epoch=$(date +%s 2>/dev/null || echo "0")
cwd_basename=$(basename "$cwd" 2>/dev/null || echo "$cwd")
receipt=$(jq -cn \
	--arg ts "$ts" \
	--argjson epoch "$epoch" \
	--arg task_id "$task_id" \
	--arg session_id "$session_id" \
	--arg cwd "$cwd" \
	--arg permission_mode "$permission_mode" \
	--arg transcript_path "$transcript_path" \
	--arg workroom_ref "$workroom" \
	--arg routing "$routing" \
	'{ts: $ts, epoch: $epoch, event: "permission_prompt",
	  task_id: $task_id, session_id: $session_id,
	  tool: "", input_hash: "", cwd: $cwd,
	  permission_mode: $permission_mode, transcript_path: $transcript_path,
	  classification: "", decision: "notify",
	  workroom_ref: $workroom_ref, routing: $routing,
	  redacted_input: {}}' 2>/dev/null || echo '{}')

permission_broker_write_receipt "$task_id" "$receipt" 2>/dev/null || true

# ── Route alert ───────────────────────────────────────────────────────
alert="⚠️ Permission prompt waiting — task ${task_id} (${cwd_basename}): ${message}"
permission_broker_notify "$task_id" "$workroom" "$routing" "$alert" 2>/dev/null || true

exit 0
