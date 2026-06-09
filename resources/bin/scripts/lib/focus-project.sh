#!/bin/bash
#
# focus-project.sh — Focus a launcher-managed Ghostty bundle on macOS
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly SCRIPT_DIR
readonly FOCUS_SCRIPT="${SCRIPT_DIR}/../oste-focus.applescript"
readonly _DEFAULT_TASKS_DIR="${HOME}/.config/ghostty-launcher"
readonly TASKS_FILE="${TASKS_FILE:-${_DEFAULT_TASKS_DIR}/tasks.json}"

usage() {
	cat <<EOF
focus-project.sh — Focus a launcher-managed Ghostty bundle

Usage:
  focus-project.sh --project-id <id>
  focus-project.sh --bundle-id <bundle-id> [--session-id <session>]
  focus-project.sh --by-task-id <task-id> [--dry-run]

Options:
  --by-task-id <id>  Resolve bundle + session from tasks.json by task id
  --dry-run          Print resolved target (FOCUS_RESOLVE …) without focusing

On failure the resolver prints a structured 'FOCUS_FAIL reason=… …' line to
stderr and exits non-zero (reasons: task_not_found, no_bundle).
EOF
}

die() {
	echo "Error: $*" >&2
	exit 1
}

# Structured failure diagnostic for by-task-id resolution. Keeps the FOCUS_FAIL
# token in line with scripts/oste-focus.applescript so consumers parse one shape.
focus_fail() {
	local reason="$1"
	shift
	echo "FOCUS_FAIL reason=${reason} $*" >&2
	exit 1
}

project_id=""
bundle_id=""
session_id=""
task_id=""
dry_run=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--project-id)
			project_id="${2:-}"
			shift 2
			;;
		--bundle-id)
			bundle_id="${2:-}"
			shift 2
			;;
		--session-id)
			session_id="${2:-}"
			shift 2
			;;
		--by-task-id)
			task_id="${2:-}"
			shift 2
			;;
		--dry-run)
			dry_run="1"
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

# ── Resolve bundle + session from tasks.json by task id ───────────────────────
# Visible lanes register ghostty_bundle_id/app_bundle/project_id/session_id, so a
# task id is enough to focus the right surface. Resolution order for the bundle
# id is deterministic and falls back through the standards aliases; if none
# yields a launcher bundle id we fail loudly rather than focus the wrong window.
if [[ -n "$task_id" ]]; then
	command -v jq >/dev/null || die "jq required for --by-task-id"
	[[ -f "$TASKS_FILE" ]] || focus_fail "task_not_found" "task_id=${task_id} tasks_file=${TASKS_FILE} (missing)"

	if [[ "$(jq -r --arg id "$task_id" 'if (.tasks[$id] != null) then "yes" else "no" end' "$TASKS_FILE" 2>/dev/null || echo no)" != "yes" ]]; then
		focus_fail "task_not_found" "task_id=${task_id} tasks_file=${TASKS_FILE}"
	fi

	# Bundle id: ghostty_bundle_id → app_bundle (if a bundle id) → derive from
	# project_id. bundle_path is a filesystem path, not a focusable bundle id.
	bundle_id=$(jq -r --arg id "$task_id" '.tasks[$id].ghostty_bundle_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	if [[ -z "$bundle_id" ]]; then
		local_app_bundle=$(jq -r --arg id "$task_id" '.tasks[$id].app_bundle // empty' "$TASKS_FILE" 2>/dev/null || true)
		case "$local_app_bundle" in
			dev.partnerai.ghostty.*) bundle_id="$local_app_bundle" ;;
		esac
	fi
	if [[ -z "$bundle_id" ]]; then
		project_id=$(jq -r --arg id "$task_id" '.tasks[$id].project_id // empty' "$TASKS_FILE" 2>/dev/null || true)
		if [[ -n "$project_id" ]]; then
			bundle_id="dev.partnerai.ghostty.${project_id}"
		fi
	fi
	[[ -n "$bundle_id" ]] || focus_fail "no_bundle" "task_id=${task_id} (no ghostty_bundle_id/app_bundle/project_id)"

	session_id=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // empty' "$TASKS_FILE" 2>/dev/null || true)

	if [[ -n "$dry_run" ]]; then
		echo "FOCUS_RESOLVE task_id=${task_id} bundle_id=${bundle_id} session_id=${session_id:-}"
		exit 0
	fi
fi

if [[ -z "$bundle_id" ]]; then
	[[ -n "$project_id" ]] || die "Provide --project-id, --bundle-id, or --by-task-id"
	bundle_id="dev.partnerai.ghostty.${project_id}"
fi

[[ -f "$FOCUS_SCRIPT" ]] || die "Missing AppleScript helper: ${FOCUS_SCRIPT}"

if [[ -n "$session_id" ]]; then
	osascript "$FOCUS_SCRIPT" "$bundle_id" "$session_id"
else
	osascript "$FOCUS_SCRIPT" "$bundle_id"
fi
