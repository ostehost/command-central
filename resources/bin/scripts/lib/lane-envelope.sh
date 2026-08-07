#!/bin/bash
#
# lane-envelope.sh — PAR-598 fail-closed lane ownership envelope checks.
#
# The launcher↔daemon bridge identifies one lane with five fields, each in a
# different vocabulary:
#
#   work_item_ref    linear:PAR-598
#   workroom_ref     discord:channel:<id>
#   session_key      agent:main:discord:channel:<id>   (the native workroom session)
#   task_generation  the immutable identity of THIS registration of the task id
#   pending review   /tmp/oste-pending-review/<task>.json
#
# Any disagreement between them means two lanes were conflated — which is how a
# completion receipt for one issue lands in another issue's workroom. So a
# missing-or-disagreeing field is a blocker, never a value to guess.
#
# Scope rule: a lane that names NO workroom at all is simply unbound (most
# launcher lanes are), and is left alone. Once a lane names ANY of
# work_item_ref / workroom_ref / session_key, it is workroom-bound and ALL of
# them must be present and consistent.
#
# Usage:
#   source scripts/lib/lane-envelope.sh
#   if blocker=$(lane_envelope_blocker "$task_id"); then :; else ... ; fi
#   lane_is_terminal_lane && ...

# The visible lane exports OSTE_TERMINAL_LANE=1 (oste-spawn.sh). Terminal code is
# untrusted evidence: never a Discord actor, never a lifecycle actor.
lane_is_terminal_lane() {
	[[ "${OSTE_TERMINAL_LANE:-0}" == "1" ]]
}

_lane_tasks_file() {
	printf '%s' "${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
}

_lane_row_field() {
	local task_id="$1" field="$2" tasks_file
	tasks_file=$(_lane_tasks_file)
	[[ -n "$task_id" && -f "$tasks_file" ]] || return 0
	local value
	value=$(jq -r --arg id "$task_id" --arg f "$field" '.tasks[$id][$f] // ""' "$tasks_file" 2>/dev/null || true)
	[[ "$value" == "null" ]] && value=""
	printf '%s' "$value"
}

# Distinguish "this task has no row" (unbound — fine) from "the registry could
# not be read" (unknown — NOT fine). Without this the fence failed OPEN: a
# missing or malformed tasks.json made every field read empty, which looked
# exactly like an unbound lane and permitted every outward transport.
# Returns 0 when the registry is readable, 1 with a reason on stdout otherwise.
_lane_registry_readable() {
	local tasks_file
	tasks_file=$(_lane_tasks_file)
	if [[ ! -f "$tasks_file" ]]; then
		printf 'lane_envelope_registry_unreadable: task registry %q does not exist' "$tasks_file"
		return 1
	fi
	if ! jq -e 'type == "object"' "$tasks_file" >/dev/null 2>&1; then
		printf 'lane_envelope_registry_unreadable: task registry %q is missing or malformed' "$tasks_file"
		return 1
	fi
	return 0
}

_lane_json_field() {
	local file="$1" field="$2"
	[[ -f "$file" ]] || return 0
	local value
	value=$(jq -r --arg f "$field" '.[$f] // ""' "$file" 2>/dev/null || true)
	[[ "$value" == "null" ]] && value=""
	printf '%s' "$value"
}

# Discord channel id from either spelling the bridge writes. Empty when the ref
# names something this transport cannot address.
lane_channel_id_from_workroom_ref() {
	local ref="${1:-}"
	case "$ref" in
		discord:channel:*) ref="${ref#discord:channel:}" ;;
		channel:*) ref="${ref#channel:}" ;;
		*) return 0 ;;
	esac
	[[ "$ref" =~ ^[0-9]+$ ]] || return 0
	printf '%s' "$ref"
}

# Print a blocker reason and return 1 when the envelope is incomplete or
# contested; print nothing and return 0 when the lane is unbound or agrees.
lane_envelope_blocker() {
	local task_id="${1:-}"
	if [[ -z "$task_id" ]]; then
		printf 'lane_envelope_incomplete: no task id to resolve a lane envelope for'
		return 1
	fi

	local registry_blocker=""
	if ! registry_blocker=$(_lane_registry_readable); then
		printf '%s' "$registry_blocker"
		return 1
	fi

	local work_item_ref workroom_ref session_key task_generation
	work_item_ref=$(_lane_row_field "$task_id" work_item_ref)
	workroom_ref=$(_lane_row_field "$task_id" workroom_ref)
	session_key=$(_lane_row_field "$task_id" session_key)
	task_generation=$(_lane_row_field "$task_id" task_generation)

	# Unbound lane: nothing claims a workroom, so there is no envelope to break.
	if [[ -z "$work_item_ref" && -z "$workroom_ref" && -z "$session_key" ]]; then
		return 0
	fi

	local missing=()
	[[ -n "$work_item_ref" ]] || missing+=("work_item_ref")
	[[ -n "$workroom_ref" ]] || missing+=("workroom_ref")
	[[ -n "$session_key" ]] || missing+=("session_key")
	[[ -n "$task_generation" ]] || missing+=("task_generation")
	if ((${#missing[@]} > 0)); then
		printf 'lane_envelope_incomplete: task %s is workroom-bound but its row is missing %s' \
			"$task_id" "$(
				IFS=,
				echo "${missing[*]}"
			)"
		return 1
	fi

	local channel_id
	channel_id=$(lane_channel_id_from_workroom_ref "$workroom_ref")
	if [[ -z "$channel_id" ]]; then
		printf 'lane_envelope_unroutable: task %s workroom_ref %q is not a Discord channel ref' \
			"$task_id" "$workroom_ref"
		return 1
	fi
	# session_key is the OWNING session, which is not always a Discord room: a
	# spoke-owned lane legitimately carries a hub owner key (`agent:hub:<name>`)
	# for completion routing. Only a key that CLAIMS to be a native Discord
	# workroom session is held to the derivation — a native key naming a
	# DIFFERENT channel is the cross-room hazard; a non-Discord owner key is a
	# different namespace, not a disagreement.
	if [[ "$session_key" == agent:main:discord:channel:* &&
		"$session_key" != "agent:main:discord:channel:${channel_id}" ]]; then
		printf 'lane_envelope_unroutable: task %s session_key %q is a native workroom session for another channel, not %q' \
			"$task_id" "$session_key" "$workroom_ref"
		return 1
	fi

	# The running lane exports its own task id + generation. A row that has moved
	# on means this process is speaking for a generation that no longer owns the
	# task id.
	#
	# Scoped to OSTE_TASK_ID deliberately: this broker runs from heterogeneous
	# entry points (completion shell, Claude Code hooks, launchd reaper) that
	# routinely inherit ANOTHER lane's OSTE_TASK_GENERATION. Comparing an
	# unrelated lane's generation against this row would block every legitimate
	# notification emitted from inside some other lane's terminal — the same
	# ambient-env hazard PAR-595 fixed for OPENCLAW_DISCORD_CHANNEL.
	if [[ -n "${OSTE_TASK_ID:-}" && "${OSTE_TASK_ID}" == "$task_id" ]] &&
		[[ -n "${OSTE_TASK_GENERATION:-}" && "${OSTE_TASK_GENERATION}" != "$task_generation" ]]; then
		printf 'lane_envelope_generation_mismatch: task %s row generation %q ≠ lane generation %q' \
			"$task_id" "$task_generation" "${OSTE_TASK_GENERATION}"
		return 1
	fi

	# Pending-review evidence, when it exists, is an independent sighting of the
	# same envelope. Fields it does not carry are silence, not consent.
	local pending_file="${OSTE_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}/${task_id}.json"
	if [[ -f "$pending_file" ]]; then
		local seen
		seen=$(_lane_json_field "$pending_file" task_id)
		if [[ -n "$seen" && "$seen" != "$task_id" ]]; then
			printf 'lane_envelope_mismatch: pending review names task %q, bound task is %q' "$seen" "$task_id"
			return 1
		fi
		seen=$(_lane_json_field "$pending_file" work_item_ref)
		if [[ -n "$seen" && "$seen" != "$work_item_ref" ]]; then
			printf 'lane_envelope_mismatch: pending review work_item_ref %q ≠ bound %q' "$seen" "$work_item_ref"
			return 1
		fi
		seen=$(_lane_json_field "$pending_file" workroom_ref)
		if [[ -n "$seen" && "$(lane_channel_id_from_workroom_ref "$seen")" != "$channel_id" ]]; then
			printf 'lane_envelope_mismatch: pending review workroom_ref %q ≠ bound %q' "$seen" "$workroom_ref"
			return 1
		fi
		seen=$(_lane_json_field "$pending_file" session_key)
		if [[ -n "$seen" && "$seen" != "$session_key" ]]; then
			printf 'lane_envelope_mismatch: pending review session_key %q ≠ bound %q' "$seen" "$session_key"
			return 1
		fi
		seen=$(_lane_json_field "$pending_file" task_generation)
		if [[ -n "$seen" && "$seen" != "$task_generation" ]]; then
			printf 'lane_envelope_mismatch: pending review task_generation %q ≠ bound %q' "$seen" "$task_generation"
			return 1
		fi
	fi

	return 0
}
