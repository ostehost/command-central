#!/bin/bash
#
# focus-project.sh — Focus a launcher-managed Ghostty bundle on macOS
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly SCRIPT_DIR
readonly FOCUS_SCRIPT="${SCRIPT_DIR}/../oste-focus.applescript"

usage() {
	cat <<EOF
focus-project.sh — Focus a launcher-managed Ghostty bundle

Usage:
  focus-project.sh --project-id <id>
  focus-project.sh --bundle-id <bundle-id> [--session-id <session>]
EOF
}

die() {
	echo "Error: $*" >&2
	exit 1
}

project_id=""
bundle_id=""
session_id=""

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
		--help | -h)
			usage
			exit 0
			;;
		*)
			die "Unknown option: $1"
			;;
	esac
done

if [[ -z "$bundle_id" ]]; then
	[[ -n "$project_id" ]] || die "Provide --project-id or --bundle-id"
	bundle_id="dev.partnerai.ghostty.${project_id}"
fi

[[ -f "$FOCUS_SCRIPT" ]] || die "Missing AppleScript helper: ${FOCUS_SCRIPT}"

if [[ -n "$session_id" ]]; then
	osascript "$FOCUS_SCRIPT" "$bundle_id" "$session_id"
else
	osascript "$FOCUS_SCRIPT" "$bundle_id"
fi
