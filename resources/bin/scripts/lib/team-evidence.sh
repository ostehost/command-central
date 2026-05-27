#!/bin/bash
# team-evidence.sh — Validate Agent Teams artifacts for a task
#
# Provides functions to check whether a --team launch actually resulted
# in a real Agent Team with teammates, or silently degraded to a single
# agent. Checks ~/.claude/teams/ for config.json and inbox artifacts.

# Minimum Claude Code version that supports Agent Teams.
readonly TEAM_MIN_CC_VERSION="2.1.32"

# Check whether a semver string meets the minimum Agent Teams version.
# Usage: team_version_is_sufficient "2.1.150"
# Returns 0 if sufficient, 1 if too old.
team_version_is_sufficient() {
	local version="$1"
	[[ -n "$version" ]] || return 1

	local major minor patch
	IFS='.' read -r major minor patch <<<"$version"
	[[ -n "$major" && -n "$minor" && -n "$patch" ]] || return 1

	local min_major min_minor min_patch
	IFS='.' read -r min_major min_minor min_patch <<<"$TEAM_MIN_CC_VERSION"

	if [[ "$major" -lt "$min_major" ]]; then
		return 1
	elif [[ "$major" -eq "$min_major" ]]; then
		if [[ "$minor" -lt "$min_minor" ]]; then
			return 1
		elif [[ "$minor" -eq "$min_minor" ]] && [[ "$patch" -lt "$min_patch" ]]; then
			return 1
		fi
	fi
	return 0
}

# Scan ~/.claude/teams/ for team directories created after a given timestamp.
# Usage: team_find_recent_teams <since_epoch_seconds> [teams_dir]
# Outputs one team directory path per line.
team_find_recent_teams() {
	local since_epoch="$1"
	local teams_dir="${2:-${HOME}/.claude/teams}"

	[[ -d "$teams_dir" ]] || return 0

	local team_path config_file created_at
	for team_path in "${teams_dir}"/*/; do
		[[ -d "$team_path" ]] || continue
		config_file="${team_path}config.json"
		[[ -f "$config_file" ]] || continue

		created_at=$(jq -r '.createdAt // 0' "$config_file" 2>/dev/null || echo "0")
		if [[ "$created_at" -gt 0 ]]; then
			local created_epoch=$((created_at / 1000))
			if [[ "$created_epoch" -ge "$since_epoch" ]]; then
				printf '%s\n' "${team_path%/}"
			fi
		fi
	done
}

# Count members (excluding lead) in a team config.
# Usage: team_count_teammates <team_dir>
# Outputs integer count.
team_count_teammates() {
	local team_dir="$1"
	local config="${team_dir}/config.json"
	[[ -f "$config" ]] || {
		echo "0"
		return
	}

	jq '[.members[]? | select(.agentType != "team-lead")] | length' "$config" 2>/dev/null || echo "0"
}

# List teammate names from a team config.
# Usage: team_list_teammates <team_dir>
# Outputs one name per line.
team_list_teammates() {
	local team_dir="$1"
	local config="${team_dir}/config.json"
	[[ -f "$config" ]] || return 0

	jq -r '.members[]? | select(.agentType != "team-lead") | .name' "$config" 2>/dev/null || true
}

# Check for inbox files (evidence of teammate communication).
# Usage: team_has_inbox_files <team_dir>
# Returns 0 if teammate inbox files exist.
team_has_inbox_files() {
	local team_dir="$1"
	local inboxes_dir="${team_dir}/inboxes"
	[[ -d "$inboxes_dir" ]] || return 1

	local count
	count=$(find "$inboxes_dir" -name '*.json' -not -name 'lead.json' -not -name 'team-lead.json' 2>/dev/null | wc -l | tr -d ' ')
	[[ "$count" -gt 0 ]]
}

# Validate team evidence for a task.
# Usage: team_validate_evidence <task_id> <spawn_epoch> [teams_dir]
# Outputs a JSON object with validation results:
#   { "team_state": "created|not_created|unknown",
#     "evidence": [...], "teammate_count": N }
team_validate_evidence() {
	local task_id="$1"
	local spawn_epoch="$2"
	local teams_dir="${3:-${HOME}/.claude/teams}"
	local state="not_created"
	local -a evidence_items=()
	local teammate_count=0

	if [[ ! -d "$teams_dir" ]]; then
		state="not_created"
		evidence_items+=("\"no ~/.claude/teams/ directory\"")
	else
		local recent_teams
		recent_teams=$(team_find_recent_teams "$spawn_epoch" "$teams_dir")

		if [[ -z "$recent_teams" ]]; then
			state="not_created"
			evidence_items+=("\"no team directories created since spawn (epoch=${spawn_epoch})\"")
		else
			while IFS= read -r team_dir; do
				[[ -n "$team_dir" ]] || continue
				local tc
				tc=$(team_count_teammates "$team_dir")
				if [[ "$tc" -gt 0 ]]; then
					state="created"
					teammate_count="$tc"
					evidence_items+=("\"team_dir=${team_dir}\"")
					evidence_items+=("\"teammate_count=${tc}\"")

					local teammates
					teammates=$(team_list_teammates "$team_dir")
					while IFS= read -r name; do
						[[ -n "$name" ]] || continue
						evidence_items+=("\"teammate=${name}\"")
					done <<<"$teammates"

					if team_has_inbox_files "$team_dir"; then
						evidence_items+=("\"has_inbox_files=true\"")
					fi
					break
				else
					state="unknown"
					evidence_items+=("\"team_dir=${team_dir} has config but no teammates beyond lead\"")
				fi
			done <<<"$recent_teams"
		fi
	fi

	local evidence_json
	evidence_json=$(printf '%s\n' "${evidence_items[@]}" | jq -cs '.')

	jq -cn \
		--arg state "$state" \
		--arg task_id "$task_id" \
		--argjson teammate_count "$teammate_count" \
		--argjson evidence "$evidence_json" \
		'{task_id: $task_id, team_state: $state, teammate_count: $teammate_count, evidence: $evidence}'
}
