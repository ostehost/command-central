#!/bin/bash
#
# task-id.sh — Canonical task identity grammar and generation helpers.
#
# Task IDs are embedded in task-map keys and launcher-owned filenames. Keep one
# grammar for every producer/consumer so a remotely derived ID cannot escape its
# state directory or become unreadable by a later lifecycle script.

[[ -n "${__OSTE_TASK_ID_SH:-}" ]] && return 0
__OSTE_TASK_ID_SH=1

readonly OSTE_TASK_ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

task_id_is_valid() {
	local task_id="${1:-}"
	[[ "$task_id" =~ $OSTE_TASK_ID_RE ]]
}

task_id_validate() {
	local task_id="${1:-}"
	if ! task_id_is_valid "$task_id"; then
		echo "invalid task-id '${task_id}' (must match [A-Za-z0-9][A-Za-z0-9._-]{0,127})" >&2
		return 1
	fi
}

# Normalize an external identifier before composing it into a task ID. The
# result is intentionally a component, not a complete ID; callers still run the
# final value through task_id_validate after adding their prefix/suffix.
task_id_slug_component() {
	local raw="${1:-}" slug
	slug=$(printf '%s' "$raw" | LC_ALL=C tr '[:upper:]' '[:lower:]' |
		LC_ALL=C sed -E 's/[^a-z0-9._-]+/-/g; s/^[._-]+//; s/[._-]+$//; s/-+/-/g')
	[[ -n "$slug" ]] || slug="node"
	printf '%s' "${slug:0:48}"
}

# Compose a derived task ID while preserving fixed routing prefixes/suffixes.
# When the direct composition exceeds the grammar limit, retain as much of the
# source ID as fits and add a stable digest so distinct long source IDs do not
# collapse onto the same reviewer/fixup lane.
task_id_compose_bounded() {
	local prefix="${1:-}" source_id="${2:-}" suffix="${3:-}"
	local candidate="${prefix}${source_id}${suffix}"
	if task_id_is_valid "$candidate"; then
		printf '%s' "$candidate"
		return 0
	fi

	task_id_validate "$source_id" >/dev/null 2>&1 || return 1
	local digest fixed_budget source_budget
	digest=$(printf '%s' "$candidate" | shasum -a 256 | awk '{print substr($1, 1, 12)}') || return 1
	fixed_budget=$((${#prefix} + ${#suffix} + ${#digest} + 1))
	source_budget=$((128 - fixed_budget))
	((source_budget >= 1)) || return 1
	candidate="${prefix}${source_id:0:source_budget}-${digest}${suffix}"
	task_id_validate "$candidate" || return 1
	printf '%s' "$candidate"
}

# A task ID may be reused after a terminal run. Every registration therefore
# carries a distinct generation which completion/watchdog writers compare under
# the tasks lock before changing terminal state.
task_generation_new() {
	local uuid=""
	if command -v uuidgen >/dev/null 2>&1; then
		uuid=$(uuidgen 2>/dev/null | LC_ALL=C tr '[:upper:]' '[:lower:]')
	fi
	if [[ -z "$uuid" ]]; then
		uuid=$(printf '%s' "$(date +%s)-$$-${RANDOM:-0}-${RANDOM:-0}" |
			shasum -a 256 | awk '{print $1}')
	fi
	printf '%s' "$uuid"
}

# A completion marker is authoritative only for the task generation currently
# registered in tasks.json. Missing generation fields match only legacy rows;
# a marker from a reused ID must never suppress the new lane's hooks.
task_completion_marker_matches_generation() {
	local task_id="$1"
	local tasks_file="$2"
	local marker="${3:-/tmp/oste-complete-${task_id}}"
	local row_generation marker_generation row_present

	task_id_validate "$task_id" >/dev/null 2>&1 || return 1
	[[ -f "$tasks_file" && -f "$marker" ]] || return 1
	row_present=$(jq -r --arg id "$task_id" '(.tasks[$id] // null) != null' "$tasks_file" 2>/dev/null || true)
	[[ "$row_present" == "true" ]] || return 1
	row_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // ""' "$tasks_file" 2>/dev/null || true)
	marker_generation=$(awk -F= '$1 == "task_generation" {print substr($0, index($0, "=") + 1); exit}' "$marker" 2>/dev/null || true)
	[[ "$marker_generation" == "$row_generation" ]]
}
