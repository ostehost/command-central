#!/bin/bash
#
# notify-macos.sh — macOS delivery adapter for council notifications
#
# Sends rich macOS notifications via terminal-notifier with:
#   - Project icon via -appIcon (shows the project's icon, keeps click-to-focus)
#   - Subtitle for agent/role context
#   - Click-to-focus routing to the correct Ghostty window
#   - Project-level grouping (notifications stack, not replace)
#
# NOTE: we deliberately do NOT use terminal-notifier's -sender flag. Per the
# terminal-notifier docs, -sender fakes the sender application, which (a) keeps
# the terminal-notifier process resident forever waiting for a click callback it
# can never receive (the OS routes the click to the faked sender), leaking one
# process per unclicked notification, and (b) silently disables -execute and
# -activate, which require terminal-notifier itself to remain the sender. Using
# -appIcon gives the per-project icon while keeping terminal-notifier as the
# sender, so -execute fires on click and the process exits immediately.
#
# Falls back to osascript if terminal-notifier is not installed.
#

[[ -n "${_NOTIFY_MACOS_SH_LOADED:-}" ]] && return 0
readonly _NOTIFY_MACOS_SH_LOADED=1

# _resolve_app_icon <bundle_id> — print the path to a bundle's .icns icon.
# Fast deterministic path for launcher project apps
# (/Applications/Projects/<name>.app), falling back to a Spotlight lookup for
# any other bundle id. Returns non-zero (prints nothing) if no icon is found.
_resolve_app_icon() {
	local bundle_id="$1"
	[[ -n "$bundle_id" ]] || return 1

	# Launcher project apps: bundle id suffix maps to the app name.
	# Base dir is overridable (OSTE_PROJECTS_APPS_DIR) for testing.
	local suffix="${bundle_id##*.}"
	local apps_dir="${OSTE_PROJECTS_APPS_DIR:-/Applications/Projects}"
	local fast="${apps_dir}/${suffix}.app/Contents/Resources/icon.icns"
	if [[ -f "$fast" ]]; then
		printf '%s' "$fast"
		return 0
	fi

	# General fallback via Spotlight metadata.
	local app icon_name
	app="$(mdfind "kMDItemCFBundleIdentifier == '${bundle_id}'" 2>/dev/null | head -1)"
	[[ -n "$app" ]] || return 1
	icon_name="$(defaults read "${app}/Contents/Info" CFBundleIconFile 2>/dev/null)"
	[[ -n "$icon_name" ]] || return 1
	icon_name="${icon_name%.icns}.icns"
	[[ -f "${app}/Contents/Resources/${icon_name}" ]] || return 1
	printf '%s' "${app}/Contents/Resources/${icon_name}"
}

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

		# Show the project's icon via -appIcon (NOT -sender; see header note).
		# -appIcon renders the project icon while keeping terminal-notifier as
		# the sender, so -execute/-activate still work and the process exits.
		if [[ -n "$sender" ]]; then
			local icon_path
			if icon_path="$(_resolve_app_icon "$sender")"; then
				args+=(-appIcon "$icon_path")
			fi
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
		# (brings the project bundle to front; -execute then focuses the window)
		if [[ -n "$sender" ]]; then
			args+=(-activate "$sender")
		fi

		terminal-notifier "${args[@]}" >/dev/null 2>&1 &
		return 0
	fi

	osascript -e "display notification $(printf '%q' "$message") with title $(printf '%q' "$title")" >/dev/null 2>&1 || true
}
