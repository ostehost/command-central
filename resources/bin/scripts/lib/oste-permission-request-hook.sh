#!/bin/bash
#
# oste-permission-request-hook.sh — Claude Code PermissionRequest hook
#
# Records every permission request as a JSONL receipt. Dangerous commands are
# denied immediately; everything else is notification-only (the human/agent still
# decides). Never auto-allows in this slice.
#
# Input (JSON on stdin from Claude Code):
#   session_id, transcript_path, cwd, permission_mode, hook_event_name,
#   tool_name, tool_input (object)
#
# Output (stdout → Claude Code):
#   Dangerous: {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
#               "decision":{"behavior":"deny","message":"..."}}}
#   Safe/neutral: (empty / {}) — normal permission prompt proceeds
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
session_id=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || true)
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || true)
permission_mode=$(printf '%s' "$input" | jq -r '.permission_mode // ""' 2>/dev/null || true)
hook_event_name=$(printf '%s' "$input" | jq -r '.hook_event_name // "PermissionRequest"' 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || true)
tool_input=$(printf '%s' "$input" | jq -c '.tool_input // {}' 2>/dev/null || true)
permission_suggestions=$(printf '%s' "$input" | jq -c '.permission_suggestions // []' 2>/dev/null || echo '[]')

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
hook_trace_append "permission-request-hook-entry" "$input" "$(jq -cn \
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
decision="notify"
if [[ "$class" == "dangerous" ]]; then
	decision="deny"
elif permission_broker_should_auto_allow "$class"; then
	decision="allow"
fi

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
	--arg workroom_ref "$workroom" \
	--arg routing "$routing" \
	--argjson redacted_input "$redacted" \
	--argjson permission_suggestions "$permission_suggestions" \
	'{ts: $ts, epoch: $epoch, event: "permission_request",
	  task_id: $task_id, session_id: $session_id,
	  tool: $tool, input_hash: $input_hash, cwd: $cwd,
	  permission_mode: $permission_mode, transcript_path: $transcript_path,
	  classification: $classification, decision: $decision,
	  workroom_ref: $workroom_ref, routing: $routing,
	  redacted_input: $redacted_input,
	  permission_suggestions: $permission_suggestions}' 2>/dev/null || echo '{}')

permission_broker_write_receipt "$task_id" "$receipt" 2>/dev/null || true

# ── Output decision ───────────────────────────────────────────────────
if [[ "$decision" == "deny" ]]; then
	deny_reason=$(printf '%s' "$tool_name" | head -c 40)
	[[ -n "$deny_reason" ]] || deny_reason="dangerous operation"
	jq -cn \
		--arg hook_event_name "$hook_event_name" \
		--arg deny_reason "$deny_reason" \
		'{hookSpecificOutput: {hookEventName: $hook_event_name,
		  decision: {behavior: "deny",
		    message: ("Denied by launcher permission broker: " + $deny_reason)}}}'
elif [[ "$decision" == "allow" ]]; then
	jq -cn --arg hook_event_name "$hook_event_name" \
		'{hookSpecificOutput: {hookEventName: $hook_event_name, decision: {behavior: "allow"}}}'
fi

# Notify (non-blocking best-effort)
if [[ "$decision" == "notify" && -n "$workroom" ]]; then
	alert="Permission request: ${tool_name} — task ${task_id} ($(basename "$cwd"))"
	# Redirect stdout too: the hook's stdout is the Claude Code decision channel,
	# so the notify path must never leak a stray line that corrupts the protocol.
	permission_broker_notify "$task_id" "$workroom" "$routing" "$alert" >/dev/null 2>&1 || true
fi

exit 0
