#!/bin/bash
#
# session-filter.sh — Shared filters for excluding synthetic/test agent sessions
#
# Provides is_synthetic_session() to identify sessions created by test suites
# that should not appear in production discovery, dashboards, or diagnostics.
#
# Usage:
#   source "${SCRIPT_DIR}/lib/session-filter.sh"
#   if is_synthetic_session "agent-test-reuse-80451"; then ...
#

# ── Synthetic session detection ──────────────────────────────────────

# Session name prefixes created by test suites (all start with "agent-")
# Keep in sync with test/test-*.sh session naming conventions.
readonly _SYNTHETIC_SESSION_PREFIXES=(
	"agent-test-"
	"agent-ghostty-test-"
	"agent-lifecycle-test-"
	"agent-oste-testdir-"
)

# is_synthetic_session <session_name>
#   Returns 0 if the session matches a known test/synthetic pattern.
is_synthetic_session() {
	local session="$1"
	for prefix in "${_SYNTHETIC_SESSION_PREFIXES[@]}"; do
		if [[ "$session" == "${prefix}"* ]]; then
			return 0
		fi
	done
	return 1
}

# is_synthetic_task <task_id>
#   Returns 0 if the task_id matches a known test/synthetic pattern.
#   Mirrors the jq filter in oste-dashboard.sh completions section.
is_synthetic_task() {
	local task_id="${1:-}"
	[[ -z "$task_id" ]] && return 1
	case "$task_id" in
		test-* | spawn-* | git-hook-identity-* | lifecycle-test* | gemini-test* | claude-hook*)
			return 0
			;;
	esac
	return 1
}

# filter_synthetic_sessions <sessions_string>
#   Reads newline-delimited session names from stdin or argument,
#   outputs only non-synthetic ones.
filter_synthetic_sessions() {
	local input="${1:-}"
	if [[ -z "$input" ]]; then
		input=$(cat)
	fi
	while IFS= read -r session; do
		[[ -z "$session" ]] && continue
		if ! is_synthetic_session "$session"; then
			echo "$session"
		fi
	done <<<"$input"
}
