#!/bin/bash
#
# oste-permission-denied-hook.sh — Claude Code PermissionDenied hook
#
# Fires when auto-mode classifier denies a tool call. Returns
# hookSpecificOutput.retry=true ONLY for safe retry classes (policy-gated);
# never approves/reverses the denial. Records the classifier reason as a
# receipt.
#
# Input (JSON on stdin from Claude Code):
#   session_id, transcript_path, cwd, permission_mode, hook_event_name,
#   tool_name, tool_input (object), reason/message/decision_reason
#
# Output (stdout → Claude Code):
#   Safe + policy enabled: {"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}
#   Otherwise: (empty)
#
# DEFENSIVE: never crashes a lane — all errors trap to exit 0.
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
session_id=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || true)
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || true)
permission_mode=$(printf '%s' "$input" | jq -r '.permission_mode // ""' 2>/dev/null || true)
hook_event_name=$(printf '%s' "$input" | jq -r '.hook_event_name // "PermissionDenied"' 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || true)
tool_input=$(printf '%s' "$input" | jq -c '.tool_input // {}' 2>/dev/null || true)
classifier_reason=$(printf '%s' "$input" | jq -r '.reason // .message // .decision_reason // .permission_denied_reason // ""' 2>/dev/null || true)

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
hook_trace_append "permission-denied-hook-entry" "$input" "$(jq -cn \
	--arg task_id "$task_id" \
	--arg tool_name "$tool_name" \
	--arg cwd "$cwd" \
	'{task_id: $task_id, tool_name: $tool_name, cwd: $cwd}')" 2>/dev/null || true

# ── Classify + redact ─────────────────────────────────────────────────
redacted=$(permission_broker_redact "$tool_input" 2>/dev/null || echo '{}')
class=$(permission_broker_classify "$tool_name" "$tool_input" 2>/dev/null || echo "neutral")
hash=$(permission_broker_input_hash "$session_id" "$tool_name" "$redacted" 2>/dev/null || echo "")

# ── Workroom + routing ────────────────────────────────────────────────
workroom=$(permission_broker_resolve_workroom "$task_id" 2>/dev/null || echo "")
routing="ops_fallback"
[[ -n "$workroom" ]] && routing="workroom"

# ── Decision ──────────────────────────────────────────────────────────
decision="noretry"
permission_broker_should_auto_allow "$class" && decision="retry"

# ── Build + write receipt ─────────────────────────────────────────────
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
epoch=$(date +%s 2>/dev/null || echo "0")
receipt=$(jq -cn \
	--arg ts "$ts" \
	--argjson epoch "$epoch" \
	--arg task_id "$task_id" \
	--arg session_id "$session_id" \
	--arg tool "$tool_name" \
	--arg input_hash "$hash" \
	--arg cwd "$cwd" \
	--arg permission_mode "$permission_mode" \
	--arg transcript_path "$transcript_path" \
	--arg classification "$class" \
	--arg decision "$decision" \
	--arg classifier_reason "$classifier_reason" \
	--arg workroom_ref "$workroom" \
	--arg routing "$routing" \
	--argjson redacted_input "$redacted" \
	'{ts: $ts, epoch: $epoch, event: "permission_denied",
	  task_id: $task_id, session_id: $session_id,
	  tool: $tool, input_hash: $input_hash, cwd: $cwd,
	  permission_mode: $permission_mode, transcript_path: $transcript_path,
	  classification: $classification, decision: $decision,
	  classifier_reason: $classifier_reason,
	  workroom_ref: $workroom_ref, routing: $routing,
	  redacted_input: $redacted_input}' 2>/dev/null || echo '{}')

permission_broker_write_receipt "$task_id" "$receipt" 2>/dev/null || true

# ── Output decision ───────────────────────────────────────────────────
if [[ "$decision" == "retry" ]]; then
	jq -cn --arg hook_event_name "$hook_event_name" \
		'{hookSpecificOutput: {hookEventName: $hook_event_name, retry: true}}'
fi

exit 0
