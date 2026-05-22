#!/bin/bash
#
# notify-macos.sh — macOS delivery adapter for council notifications
#
# Sends rich macOS notifications via terminal-notifier with:
#   - Project-specific sender identity (shows project Dock icon)
#   - Subtitle for agent/role context
#   - Click-to-focus routing to the correct Ghostty window
#   - Project-level grouping (notifications stack, not replace)
#
# Falls back to osascript if terminal-notifier is not installed.
#

[[ -n "${_NOTIFY_MACOS_SH_LOADED:-}" ]] && return 0
readonly _NOTIFY_MACOS_SH_LOADED=1

# notify_macos <title> <message> <group> [execute_cmd] [sender_bundle_id] [subtitle]
notify_macos() {
	local title="$1"
	local message="$2"
	local group="${3:-oste}"
	local execute_cmd="${4:-}"
	local sender="${5:-}"
	local subtitle="${6:-}"

	# Suppress all macOS notifications during test runs
	if [[ "${OSTE_TEST_MODE:-}" == "1" ]]; then
		return 0
	fi

	# Optional local terminal affordance when attached to a tty.
	if [[ -t 1 || -t 2 ]]; then
		printf '\a' 2>/dev/null || true
	fi

	if command -v terminal-notifier >/dev/null 2>&1; then
		local -a args=(
			-title "$title"
			-message "$message"
			-group "$group"
			-sound default
		)

		# Show the project's Dock icon as the notification sender
		if [[ -n "$sender" ]]; then
			args+=(-sender "$sender")
		fi

		# Subtitle line (agent backend + role context)
		if [[ -n "$subtitle" ]]; then
			args+=(-subtitle "$subtitle")
		fi

		# Click action: focus the correct Ghostty window
		if [[ -n "$execute_cmd" ]]; then
			args+=(-execute "$execute_cmd")
		fi

		# Activate the sender app when notification is clicked
		# (brings Ghostty bundle to front, then -execute focuses the window)
		if [[ -n "$sender" ]]; then
			args+=(-activate "$sender")
		fi

		terminal-notifier "${args[@]}" >/dev/null 2>&1 &
		return 0
	fi

	osascript -e "display notification $(printf '%q' "$message") with title $(printf '%q' "$title")" >/dev/null 2>&1 || true
}
