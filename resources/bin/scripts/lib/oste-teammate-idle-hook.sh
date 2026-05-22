#!/bin/bash
#
# oste-teammate-idle-hook.sh — Claude Code TeammateIdle hook handler
#
# Called by Claude Code Agent Teams when a teammate is about to go idle.
# Logs the event for Oste's visibility. Does NOT prevent idling by default
# (that would require exit code 2 + feedback on stdout).
#
# Input (JSON on stdin from Claude Code):
#   teammate_name, team_name, session_id, cwd
#
# Output:
#   Exit 0 = allow teammate to go idle
#   Exit 2 = send feedback (stdout) to keep teammate working
#
set -euo pipefail

# Skip all processing during test runs — prevents workspace JSONL pollution
# and unnecessary notify calls from test-exercised idle paths.
[[ "${OSTE_TEST_MODE:-}" == "1" ]] && exit 0

input=$(cat)

teammate_name=$(echo "$input" | jq -r '.teammate_name // "unknown"' 2>/dev/null)
team_name=$(echo "$input" | jq -r '.team_name // empty' 2>/dev/null)

# Cooldown guard to prevent burst spam from repeated idle callbacks.
cooldown_seconds="${OSTE_IDLE_HOOK_COOLDOWN_SECONDS:-300}"
if [[ "$cooldown_seconds" =~ ^[0-9]+$ ]] && [[ "$cooldown_seconds" -gt 0 ]]; then
	idle_key="${team_name}::${teammate_name}"
	idle_hash="$(printf '%s' "$idle_key" | shasum | awk '{print $1}')"
	idle_stamp="/tmp/oste-teammate-idle-${idle_hash}.stamp"
	now_epoch="$(date +%s)"
	if [[ -f "$idle_stamp" ]]; then
		last_epoch="$(cat "$idle_stamp" 2>/dev/null || echo 0)"
		if [[ "$last_epoch" =~ ^[0-9]+$ ]] && ((now_epoch - last_epoch < cooldown_seconds)); then
			exit 0
		fi
	fi
	printf '%s\n' "$now_epoch" >"$idle_stamp" 2>/dev/null || true
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
notify_script="${SCRIPT_DIR}/oste-notify.sh"
if [[ -f "$notify_script" ]]; then
	bash "$notify_script" \
		--kind attention_required \
		--task-id "teammate-${teammate_name}" \
		--backend claude \
		--title "Teammate idle" \
		--message "${teammate_name} is idle${team_name:+ in team ${team_name}}" \
		--source claude-teammate-idle-hook >/dev/null 2>&1 || true
fi

# Allow teammate to go idle (exit 0)
# To reassign work, exit 2 and print the new task on stdout
exit 0
