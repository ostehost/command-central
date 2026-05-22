#!/bin/bash
#
# oste-discord-summary.sh — Discord summary notification for recent agent completions
#
# Reads tasks.json for recently completed/failed tasks, formats a grouped summary,
# and sends it to Discord via openclaw. Deduplicates using a marker file.
#
# Usage:
#   oste-discord-summary.sh [--window MINUTES] [--exclude-task TASK_ID] [--min-recent COUNT] [--dry-run]
#
# Options:
#   --window MINUTES   Look-back window (default: 30)
#   --exclude-task ID  Exclude a specific task from digest lines (dedupe aid)
#   --min-recent N     Minimum recent tasks required to emit digest (default: 1)
#   --dry-run          Print summary without sending
#   --help             Show this help
#
# Environment:
#   TASKS_FILE                Override tasks.json path
#   OPENCLAW_DISCORD_CHANNEL  Override Discord channel target
#   OSTE_TEST_MODE=1          Suppress real Discord sends
#   OSTE_DISCORD_SUMMARY_LAST Override dedup marker file path
#

set -euo pipefail

readonly _DEFAULT_TASKS_DIR="${HOME}/.config/ghostty-launcher"
readonly TASKS_FILE="${TASKS_FILE:-${_DEFAULT_TASKS_DIR}/tasks.json}"
readonly DEDUP_FILE="${OSTE_DISCORD_SUMMARY_LAST:-/tmp/oste-discord-summary-last}"

usage() {
	cat <<EOF
oste-discord-summary.sh — Discord summary notification for recent completions

Usage:
  oste-discord-summary.sh [--window MINUTES] [--exclude-task TASK_ID] [--min-recent COUNT] [--dry-run]

Options:
  --window MINUTES   Look-back window in minutes (default: 30)
  --exclude-task ID  Exclude task_id from digest lines (default: none)
  --min-recent N     Minimum recent tasks before digest emits (default: 1)
  --dry-run          Print summary to stdout without sending to Discord
  --help             Show this help
EOF
}

die() {
	echo "Error: $*" >&2
	exit 1
}

window_minutes=30
exclude_task=""
min_recent=1
dry_run=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--window)
			window_minutes="${2:-}"
			[[ -n "$window_minutes" ]] || die "--window requires a value"
			shift 2
			;;
		--exclude-task)
			exclude_task="${2:-}"
			[[ -n "$exclude_task" ]] || die "--exclude-task requires a value"
			shift 2
			;;
		--min-recent)
			min_recent="${2:-}"
			[[ "$min_recent" =~ ^[0-9]+$ ]] || die "--min-recent must be an integer"
			shift 2
			;;
		--dry-run)
			dry_run=1
			shift
			;;
		--help | -h)
			usage
			exit 0
			;;
		*)
			die "Unknown option: $1"
			;;
	esac
done

if [[ ! -f "$TASKS_FILE" ]]; then
	echo "No tasks.json found at $TASKS_FILE" >&2
	exit 0
fi

# ── Collect recent completions ───────────────────────────────────────
cutoff=$(date -u -v-"${window_minutes}"M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null) || {
	# GNU date fallback
	cutoff=$(date -u -d "${window_minutes} minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null) || {
		die "Cannot compute cutoff time"
	}
}

# Extract matching tasks with completed_at >= cutoff.
# Output: tab-separated task_id, project_name, status
recent_tasks=$(jq -r --arg cutoff "$cutoff" '
	.tasks | to_entries[]
	| select(
		(.value.status == "completed" or .value.status == "failed" or .value.status == "completed_dirty" or .value.status == "completed_stale")
		and (.value.completed_at != null)
		and (.value.completed_at >= $cutoff)
	)
	| [.value.id, (.value.project_name // "unknown"), .value.status]
	| @tsv
' "$TASKS_FILE" 2>/dev/null) || true

if [[ -z "$recent_tasks" ]]; then
	exit 0
fi

if [[ -n "$exclude_task" ]]; then
	recent_tasks=$(echo "$recent_tasks" | awk -F'\t' -v skip="$exclude_task" '$1 != skip')
fi

if [[ -z "$recent_tasks" ]]; then
	exit 0
fi

task_count=$(echo "$recent_tasks" | wc -l | tr -d ' ')
if [[ "$task_count" -lt "$min_recent" ]]; then
	exit 0
fi

# Count by status category
completed_count=$(echo "$recent_tasks" | awk -F'\t' '$3 == "completed"' | wc -l | tr -d ' ')
failed_count=$(echo "$recent_tasks" | awk -F'\t' '$3 == "failed"' | wc -l | tr -d ' ')
dirty_count=$(echo "$recent_tasks" | awk -F'\t' '$3 == "completed_dirty"' | wc -l | tr -d ' ')
stale_count=$(echo "$recent_tasks" | awk -F'\t' '$3 == "completed_stale"' | wc -l | tr -d ' ')

# Running tasks are shown explicitly as a separate section so aggregate state
# never appears without matching body context.
running_tasks=$(jq -r --arg exclude "$exclude_task" '
	.tasks | to_entries[]
	| select(.value.status == "running")
	| select(($exclude == "") or (.value.id != $exclude))
	| [.value.id, (.value.project_name // "unknown")]
	| @tsv
' "$TASKS_FILE" 2>/dev/null) || true

running_count=0
if [[ -n "$running_tasks" ]]; then
	running_count=$(echo "$running_tasks" | wc -l | tr -d ' ')
fi

# ── Dedup guard ──────────────────────────────────────────────────────
summary_lines=""
while IFS=$'\t' read -r task_id project_name status; do
	case "$status" in
		completed) emoji="✅" ;;
		failed) emoji="❌" ;;
		completed_dirty) emoji="⚠️" ;;
		completed_stale) emoji="🕐" ;;
		*) emoji="❓" ;;
	esac
	summary_lines="${summary_lines}${emoji} ${task_id} (${project_name}) — ${status}"$'\n'
done <<<"$recent_tasks"

# Trim trailing newline
summary_lines="${summary_lines%$'\n'}"

status_line="✅ ${completed_count} completed"
[[ "$dirty_count" -gt 0 ]] && status_line="${status_line} · ⚠️ ${dirty_count} dirty"
[[ "$failed_count" -gt 0 ]] && status_line="${status_line} · ❌ ${failed_count} failed"
[[ "$stale_count" -gt 0 ]] && status_line="${status_line} · 🕐 ${stale_count} stale"

summary="📊 Agent Digest (last ${window_minutes}m)"$'\n'"Recent completions: ${task_count} · ${status_line}"$'\n'"${summary_lines}"

if [[ "$running_count" -gt 0 ]]; then
	running_lines=""
	while IFS=$'\t' read -r task_id project_name; do
		running_lines="${running_lines}🔄 ${task_id} (${project_name}) — running"$'\n'
	done <<<"$running_tasks"
	running_lines="${running_lines%$'\n'}"
	summary="${summary}"$'\n'"Other active tasks: ${running_count}"$'\n'"${running_lines}"
fi

fingerprint=$(printf '%s' "$summary" | shasum | awk '{print $1}')
if [[ -f "$DEDUP_FILE" ]]; then
	last_fingerprint=$(cat "$DEDUP_FILE" 2>/dev/null || true)
	if [[ "$fingerprint" == "$last_fingerprint" ]]; then
		exit 0
	fi
fi

# ── Send or print ────────────────────────────────────────────────────
if [[ "$dry_run" -eq 1 ]]; then
	echo "$summary"
	echo "$fingerprint" >"$DEDUP_FILE"
	exit 0
fi

if [[ "${OSTE_TEST_MODE:-}" == "1" ]]; then
	# In test mode, write summary to a known location instead of sending
	echo "$summary"
	echo "$fingerprint" >"$DEDUP_FILE"
	exit 0
fi

# Send via openclaw (channel digest)
discord_channel="${OPENCLAW_DISCORD_CHANNEL:-channel:1473741285088039115}"

if command -v openclaw >/dev/null 2>&1; then
	openclaw message send \
		--channel discord \
		--target "$discord_channel" \
		--message "$summary" \
		>/dev/null 2>&1 || true
fi

echo "$fingerprint" >"$DEDUP_FILE"
