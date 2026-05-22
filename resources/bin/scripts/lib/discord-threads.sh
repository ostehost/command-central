#!/bin/bash
#
# discord-threads.sh — Thread-per-task mapping for Discord notifications
#
# Manages a JSON file mapping task_id → thread_id so that all notifications
# for the same task are grouped into a single Discord thread.
#
# Usage:
#   source scripts/lib/discord-threads.sh
#   thread_id=$(discord_thread_lookup "my-task-id")
#   discord_thread_store "my-task-id" "1234567890"
#   discord_thread_cleanup  # remove entries older than 24h
#

readonly DISCORD_THREAD_MAP="${OSTE_DISCORD_THREAD_MAP:-/tmp/oste-discord-threads.json}"
# Max age for thread entries (24 hours) — used by discord_thread_cleanup
# shellcheck disable=SC2034
readonly DISCORD_THREAD_MAX_AGE_SECONDS=86400

# Look up thread_id for a given task_id.
# Returns the thread_id on stdout, or empty string if not found.
discord_thread_lookup() {
	local task_id="$1"
	if [[ ! -f "$DISCORD_THREAD_MAP" ]]; then
		return 0
	fi
	jq -r --arg id "$task_id" '.[$id].thread_id // empty' "$DISCORD_THREAD_MAP" 2>/dev/null || true
}

# Store a thread_id for a task_id (atomic write via temp file + mv).
discord_thread_store() {
	local task_id="$1"
	local thread_id="$2"
	local ts
	ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	local tmp_file="${DISCORD_THREAD_MAP}.tmp.$$"

	if [[ -f "$DISCORD_THREAD_MAP" ]]; then
		jq --arg id "$task_id" --arg tid "$thread_id" --arg ts "$ts" \
			'.[$id] = {thread_id: $tid, created_at: $ts}' \
			"$DISCORD_THREAD_MAP" >"$tmp_file" 2>/dev/null
	else
		jq -n --arg id "$task_id" --arg tid "$thread_id" --arg ts "$ts" \
			'{($id): {thread_id: $tid, created_at: $ts}}' >"$tmp_file" 2>/dev/null
	fi

	if [[ -s "$tmp_file" ]]; then
		mv -f "$tmp_file" "$DISCORD_THREAD_MAP"
	else
		rm -f "$tmp_file"
	fi
}

# Remove entries older than 24 hours from the thread map.
discord_thread_cleanup() {
	if [[ ! -f "$DISCORD_THREAD_MAP" ]]; then
		return 0
	fi

	local cutoff_epoch
	cutoff_epoch=$(date -u -v-24H +%s 2>/dev/null || date -u -d "24 hours ago" +%s 2>/dev/null) || return 0

	local tmp_file="${DISCORD_THREAD_MAP}.tmp.$$"

	jq --arg cutoff "$cutoff_epoch" '
		with_entries(
			select(
				(.value.created_at // "1970-01-01T00:00:00Z")
				| gsub("Z$"; "")
				| strptime("%Y-%m-%dT%H:%M:%S")
				| mktime
				| . >= ($cutoff | tonumber)
			)
		)
	' "$DISCORD_THREAD_MAP" >"$tmp_file" 2>/dev/null

	if [[ -s "$tmp_file" ]]; then
		mv -f "$tmp_file" "$DISCORD_THREAD_MAP"
	else
		# If result is empty or jq failed, clean up
		rm -f "$tmp_file"
	fi
}
