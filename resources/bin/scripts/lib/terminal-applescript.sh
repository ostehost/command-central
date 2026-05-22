#!/bin/bash
#
# terminal-applescript.sh — Ghostty AppleScript terminal backend
#
# Alternative backend for terminal.sh that uses Ghostty's native AppleScript
# support (requires Ghostty 1.3+ with sdef).
#
# Public API (mirrors terminal.sh):
#   terminal_create       — Create a new Ghostty tab (or window) via surface configuration
#   terminal_send         — Send text via `input text`
#   terminal_capture      — Capture output via persist log file
#   terminal_exists       — Check if a terminal UUID is still alive
#   terminal_list         — List terminal UUIDs matching a pattern
#   terminal_kill         — Close the tab containing a terminal (or window if last tab)
#   terminal_focus        — Focus a session's tab and bring window to front
#   terminal_set_option   — No-op (theming handled via surface configuration)
#

# Guard against double-sourcing
[[ -n "${_TERMINAL_APPLESCRIPT_SH_LOADED:-}" ]] && return 0
readonly _TERMINAL_APPLESCRIPT_SH_LOADED=1

# UUID mapping file: maps session names → Ghostty terminal UUIDs + window IDs
readonly _GHOSTTY_MAP="${GHOSTTY_TERMINAL_MAP:-/tmp/ghostty-terminals.json}"

# SAFETY: AppleScript target application.
# NEVER use "Ghostty" (stock app) — that's the user's main terminal with OpenClaw TUI.
# Always target launcher bundles by bundle ID: "application id \"dev.partnerai.ghostty.{project}\""
# Set via GHOSTTY_BUNDLE_ID env var (required) or fall back to error.
_ghostty_app_target() {
	local bundle_id="${GHOSTTY_BUNDLE_ID:-}"
	if [[ -z "$bundle_id" ]]; then
		echo "Error: GHOSTTY_BUNDLE_ID must be set — refusing to target stock Ghostty app" >&2
		echo "Error: Set GHOSTTY_BUNDLE_ID=dev.partnerai.ghostty.{project} before using AppleScript backend" >&2
		return 1
	fi
	# Validate it's a launcher bundle, not stock Ghostty
	if [[ "$bundle_id" == "com.mitchellh.ghostty" ]]; then
		echo "Error: GHOSTTY_BUNDLE_ID is stock Ghostty (com.mitchellh.ghostty) — REFUSING to manipulate" >&2
		echo "Error: The stock Ghostty app runs the OpenClaw TUI and must never be controlled by agents" >&2
		return 1
	fi
	echo "application id \"$bundle_id\""
}

# ── Internal Helpers ────────────────────────────────────────────────

# Ensure the mapping file exists.
_ghostty_ensure_map() {
	if [[ ! -f "$_GHOSTTY_MAP" ]]; then
		echo '{}' >"$_GHOSTTY_MAP"
	fi
}

# Store a session → terminal mapping.
# Usage: _ghostty_map_set <session_name> <terminal_id> <window_id>
_ghostty_map_set() {
	local session="$1" terminal_id="$2" window_id="$3"
	local bundle_id="${GHOSTTY_BUNDLE_ID:-}"
	_ghostty_ensure_map
	local tmp
	tmp=$(jq --arg s "$session" --arg t "$terminal_id" --arg w "$window_id" --arg b "$bundle_id" \
		'.[$s] = {"terminal_id": $t, "window_id": $w, "bundle_id": $b}' "$_GHOSTTY_MAP")
	echo "$tmp" >"$_GHOSTTY_MAP"
}

# Get terminal_id for a session.
# Usage: _ghostty_map_get_terminal <session_name>
_ghostty_map_get_terminal() {
	local session="$1"
	_ghostty_ensure_map
	jq -r --arg s "$session" '.[$s].terminal_id // empty' "$_GHOSTTY_MAP"
}

# Get window_id for a session.
# Usage: _ghostty_map_get_window <session_name>
_ghostty_map_get_window() {
	local session="$1"
	_ghostty_ensure_map
	jq -r --arg s "$session" '.[$s].window_id // empty' "$_GHOSTTY_MAP"
}

# Remove a session from the map.
# Usage: _ghostty_map_remove <session_name>
_ghostty_map_remove() {
	local session="$1"
	_ghostty_ensure_map
	local tmp
	tmp=$(jq -c --arg s "$session" 'del(.[$s])' "$_GHOSTTY_MAP" 2>/dev/null) || true
	if [[ -n "$tmp" ]]; then
		echo "$tmp" >"$_GHOSTTY_MAP"
	fi
}

# Get all session names from the map.
_ghostty_map_sessions() {
	_ghostty_ensure_map
	jq -r 'keys[]' "$_GHOSTTY_MAP"
}

# Prune stale entries from the terminal map.
# Removes entries whose Ghostty bundle app is no longer running or whose tabs were closed.
# Lightweight: one osascript call per distinct bundle_id.
_ghostty_map_prune() {
	_ghostty_ensure_map
	local sessions
	sessions=$(_ghostty_map_sessions)
	[[ -z "$sessions" ]] && return 0

	local all_alive_terminals=""
	local checked_bids=""
	local session bid tid tmp

	# Collect distinct bundle_ids, check which apps are running, and get all alive terminals
	for session in $sessions; do
		bid=$(jq -r --arg s "$session" '.[$s].bundle_id // empty' "$_GHOSTTY_MAP" 2>/dev/null)
		tid=$(jq -r --arg s "$session" '.[$s].terminal_id // empty' "$_GHOSTTY_MAP" 2>/dev/null)

		if [[ -z "$bid" || -z "$tid" ]]; then
			# Legacy entry or missing terminal_id — remove as stale
			_ghostty_map_remove "$session"
			continue
		fi

		# If we haven't checked this bundle yet
		if ! echo "$checked_bids" | grep -qF "$bid"; then
			checked_bids="$checked_bids $bid"
			if osascript -e "application id \"$bid\" is running" 2>/dev/null | grep -q "true"; then
				# Bundle is running, get its terminal IDs
				tmp=$(osascript -e "
					try
						tell application id \"$bid\"
							set allIDs to id of every terminal of every tab of every window
							set flat to {}
							repeat with winTerms in allIDs
								repeat with tabTerms in winTerms
									repeat with t in tabTerms
										set end of flat to (t as text)
									end repeat
								end repeat
							end repeat
							return flat
						end tell
					on error errMsg number errNum
						return {}
					end try
				" 2>/dev/null | tr ',' '\n' | tr -d ' ')
				all_alive_terminals="${all_alive_terminals}${tmp}"$'\n'
			fi
		fi

		# Now check if this session's terminal is alive
		if ! echo "$all_alive_terminals" | grep -qF "$tid"; then
			_ghostty_map_remove "$session"
		fi
	done
	return 0
}

# Check if a Ghostty terminal UUID is still alive.
# Usage: _ghostty_terminal_alive <terminal_id>
_ghostty_terminal_alive() {
	local terminal_id="$1"
	local app_target
	app_target=$(_ghostty_app_target) || return 1
	local all_ids
	all_ids=$(osascript -e "
		tell $app_target
			try
				set allIDs to id of every terminal of every tab of every window
				set flat to {}
				repeat with winTerms in allIDs
					repeat with tabTerms in winTerms
						repeat with tid in tabTerms
							set end of flat to (tid as text)
						end repeat
					end repeat
				end repeat
				return flat
			on error
				return {}
			end try
		end tell
	" 2>/dev/null) || return 1

	echo "$all_ids" | tr ',' '\n' | tr -d ' ' | grep -qF "$terminal_id"
}

# Check if a session has a live agent process.
# Mirrors oste-spawn.sh's _session_has_live_agent() logic:
#   1. If PID file exists and process is alive → live agent
#   2. If tasks.json says completed/failed/stopped/killed → no live agent
#   3. Otherwise → no live agent
# Returns 0 if live agent detected, 1 if stale/completed.
_terminal_create_check_live_agent() {
	local session="$1"
	local tasks_file="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"

	# No tasks file → can't determine state, assume live (conservative)
	if [[ ! -f "$tasks_file" ]] || ! command -v jq >/dev/null 2>&1; then
		return 0
	fi

	# Look up the most recent task for this session
	local task_id
	task_id=$(jq -r --arg sid "$session" \
		'[.tasks[] | select(.session_id == $sid)] | last | .task_id // empty' \
		"$tasks_file" 2>/dev/null) || true

	if [[ -z "$task_id" ]]; then
		# No task record — can't determine state, assume live (conservative)
		return 0
	fi

	# Check the agent's PID file
	local pid_file="/tmp/oste-pid-${task_id}"
	if [[ -f "$pid_file" ]]; then
		local agent_pid
		agent_pid=$(cat "$pid_file" 2>/dev/null)
		if [[ -n "$agent_pid" ]] && kill -0 "$agent_pid" 2>/dev/null; then
			return 0 # Process is alive
		fi
	fi

	# Check task status after PID liveness. A visible Claude TUI can survive
	# Stop-hook completion, and reuse must not type shell wrappers into it.
	local status
	status=$(jq -r --arg id "$session" \
		'[.tasks[] | select(.session_id == $id) | .status] | last // "unknown"' \
		"$tasks_file" 2>/dev/null || echo "unknown")
	case "$status" in
		completed | completed_dirty | completed_stale | failed | killed | stopped | contract_failure)
			return 1
			;;
	esac

	# PID file missing or process dead — no live agent
	return 1
}

# ── Public API ──────────────────────────────────────────────────────

# Create a new Ghostty tab (or window if none exist) via surface configuration.
# Usage: terminal_create <session_name> <working_dir> [--command CMD] [env_vars...]
# --command CMD: set surface config command (agent wrapper script)
# env_vars:      KEY=VALUE pairs to inject as environment variables
terminal_create() {
	local session="$1"
	local cwd="$2"
	shift 2

	local command_arg=""
	local bounds_arg=""
	local env_vars=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--command)
				command_arg="${2:-}"
				shift 2
				;;
			--bounds)
				bounds_arg="${2:-}"
				shift 2
				;;
			*)
				env_vars+=("$1")
				shift
				;;
		esac
	done

	# Prune stale entries before checking for duplicates
	_ghostty_map_prune

	# Check for duplicate session
	local existing
	existing=$(_ghostty_map_get_terminal "$session")
	if [[ -n "$existing" ]] && _ghostty_terminal_alive "$existing"; then
		# Tab is physically present — check if the agent is still alive
		if _terminal_create_check_live_agent "$session"; then
			# Live agent running — refuse to create duplicate
			echo "Error: session '$session' already exists" >&2
			return 1
		fi
		# Stale tab: agent is no longer running. Remove the map entry
		# so we can create a new tab. The old physical tab stays open
		# but is no longer tracked.
		echo "Stale tab detected for '${session}' — removing map entry and creating new tab" >&2
		_ghostty_map_remove "$session"
	fi

	# Build environment variables AppleScript fragment
	local env_script=""
	if [[ ${#env_vars[@]} -gt 0 ]]; then
		local env_list=""
		for ev in "${env_vars[@]}"; do
			local escaped_ev="${ev//\\/\\\\}"
			escaped_ev="${escaped_ev//\"/\\\"}"
			if [[ -n "$env_list" ]]; then
				env_list="$env_list, \"$escaped_ev\""
			else
				env_list="\"$escaped_ev\""
			fi
		done
		env_script="set environment variables of cfg to {${env_list}}"
	fi

	# Build command AppleScript fragment
	local command_script=""
	if [[ -n "$command_arg" ]]; then
		# Verify the wrapper script exists and is executable before passing to AppleScript
		if [[ ! -f "$command_arg" ]]; then
			echo "Error: command script does not exist: ${command_arg}" >&2
			return 1
		fi
		if [[ ! -x "$command_arg" ]]; then
			echo "Error: command script is not executable: ${command_arg}" >&2
			return 1
		fi
		local escaped_cmd="${command_arg//\"/\\\"}"
		command_script="set command of cfg to \"${escaped_cmd}\""
	fi

	local bounds_script=""
	# Validate bounds_arg is a comma-separated list of numbers to prevent AppleScript injection
	if [[ -n "$bounds_arg" && "$bounds_arg" =~ ^[0-9]+,\ ?[0-9]+,\ ?[0-9]+,\ ?[0-9]+$ ]]; then
		bounds_script="set bounds of front window to {${bounds_arg}}"
	fi

	# Create tab in existing window (fallback: new window) via AppleScript surface configuration
	local app_target
	app_target=$(_ghostty_app_target) || return 1
	local result as_stderr as_exit
	as_stderr=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			set cfg to new surface configuration
			set initial working directory of cfg to "$cwd"
			${env_script}
			${command_script}
			set wait after command of cfg to false
			if (count of every window) > 0 then
				set win to window 1
				set newTab to new tab in win with configuration cfg
				-- NOTE: "active tab index" is not a valid Ghostty AppleScript property
				-- Tab focus happens automatically when created
				activate
				set newTerm to first terminal of newTab
				return (id of newTerm as text) & "," & (id of win as text)
			else
				set win to new window with configuration cfg
				${bounds_script}
				activate
				set newTerm to first terminal of first tab of win
				return (id of newTerm as text) & "," & (id of win as text)
			end if
		end tell
	end timeout
on error errMsg number errNum
	error "AppleScript timeout or error: " & errMsg & " (" & errNum & ")"
end try
EOF

	result=$(osascript "$as_script_file" 2>"$as_stderr") || as_exit=$?
	as_exit=${as_exit:-0}

	rm -f "$as_script_file" # Clean up temporary AppleScript file

	if [[ $as_exit -ne 0 || -z "$result" ]]; then
		local err_msg
		err_msg=$(cat "$as_stderr" 2>/dev/null)
		rm -f "$as_stderr"
		echo "Error: failed to create Ghostty tab (exit ${as_exit})" >&2
		if [[ -n "$err_msg" ]]; then
			echo "AppleScript error: ${err_msg}" >&2
		fi
		return 87
	fi
	rm -f "$as_stderr"

	# Extract terminal_id and window_id from AppleScript result
	local terminal_id="${result%%,*}"
	local window_id="${result##*,}"

	if [[ -z "$terminal_id" || -z "$window_id" || "$terminal_id" == "$result" ]]; then
		echo "Error: AppleScript did not return valid terminal ID (result: $result)" >&2
		return 87
	fi

	_ghostty_map_set "$session" "$terminal_id" "$window_id"
}

# Send text to a Ghostty terminal.
# Usage: terminal_send <session_name> <text> [--no-enter] [--ctrl-c] [--disable-bracketed-paste]
terminal_send() {
	local session="$1"
	shift

	local text=""
	local send_enter=true
	local ctrl_c=false
	local disable_bp=false

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--no-enter)
				send_enter=false
				shift
				;;
			--ctrl-c)
				ctrl_c=true
				shift
				;;
			--disable-bracketed-paste)
				disable_bp=true
				shift
				;;
			*)
				text="$1"
				shift
				;;
		esac
	done

	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")
	if [[ -z "$terminal_id" ]]; then
		echo "Error: session '$session' does not exist" >&2
		return 1
	fi

	if ! _ghostty_terminal_alive "$terminal_id"; then
		echo "Error: session '$session' does not exist" >&2
		_ghostty_map_remove "$session"
		return 1
	fi

	_ghostty_app_target >/dev/null || return 1

	if [[ "$ctrl_c" == true ]]; then
		# Send Ctrl+C (ASCII ETX, \x03)
		local as_err as_exit as_result
		as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
		local as_script_file
		as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
		cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							input text (ASCII character 3) to t
							return "sent"
						end if
					end repeat
				end repeat
			end repeat
			error "terminal not found"
		end tell
	end timeout
on error errMsg number errNum
	error "terminal_send ctrl-c failed: " & errMsg & " (" & errNum & ")"
end try
EOF
		as_result=$(osascript "$as_script_file" 2>"$as_err")
		as_exit=$?
		rm -f "$as_script_file"
		if [[ $as_exit -ne 0 ]]; then
			local err_msg
			err_msg=$(cat "$as_err" 2>/dev/null)
			echo "Error: AppleScript Ctrl+C failed (exit ${as_exit})" >&2
			[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
			rm -f "$as_err"
			return 87
		fi
		rm -f "$as_err"
		if [[ "$as_result" != "sent" ]]; then
			echo "Error: AppleScript Ctrl+C did not reach session '${session}'" >&2
			return 87
		fi
		return
	fi

	# Keep printable text separate from control characters. Ghostty accepts
	# `input text` for ESC / Enter, but composing them into one opaque string
	# is fragile and makes dropped injections hard to distinguish from success.
	local send_text="$text"

	# Escape backslashes and quotes for AppleScript
	send_text="${send_text//\\/\\\\}"
	send_text="${send_text//\"/\\\"}"

	local as_err as_exit as_result
	as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			set sendText to "$send_text"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							if $disable_bp then
								input text ((ASCII character 27) & "[?2004l") to t
							end if
							if sendText is not "" then
								input text sendText to t
							end if
							if $send_enter then
								input text (ASCII character 13) to t
							end if
							return "sent"
						end if
					end repeat
				end repeat
			end repeat
			error "terminal not found"
		end tell
	end timeout
on error errMsg number errNum
	error "terminal_send failed: " & errMsg & " (" & errNum & ")"
end try
EOF
	as_result=$(osascript "$as_script_file" 2>"$as_err")
	as_exit=$?
	rm -f "$as_script_file"
	if [[ $as_exit -ne 0 ]]; then
		local err_msg
		err_msg=$(cat "$as_err" 2>/dev/null)
		echo "Error: AppleScript send failed (exit ${as_exit})" >&2
		[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
		rm -f "$as_err"
		return 87
	fi
	rm -f "$as_err"
	if [[ "$as_result" != "sent" ]]; then
		echo "Error: AppleScript send did not reach session '${session}'" >&2
		return 87
	fi
}

# Capture terminal output via persist log file.
# Ghostty's sdef has no `contents` property, so we read from the persist
# log file (/tmp/cc-agent-<session_id>.log) or stream-JSON.
# Usage: terminal_capture <session_name> [--lines N]
terminal_capture() {
	local session="$1"
	local lines=50
	if [[ "${2:-}" == "--lines" ]]; then
		lines="${3:-50}"
	fi

	# Source persist library for capture
	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	# shellcheck source=terminal-persist.sh
	source "${script_dir}/terminal-persist.sh"

	# Use persist_capture which reads from the log file
	persist_capture "$session" "$lines"
}

# Check if a session exists and its terminal is still alive.
# Usage: terminal_exists <session_name>
terminal_exists() {
	local session="$1"
	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")
	if [[ -z "$terminal_id" ]]; then
		return 1
	fi

	if _ghostty_terminal_alive "$terminal_id"; then
		return 0
	else
		# Clean up stale mapping
		_ghostty_map_remove "$session"
		return 1
	fi
}

# List sessions, optionally filtered by prefix pattern.
# Usage: terminal_list [pattern]
terminal_list() {
	local pattern="${1:-}"

	# First prune dead sessions from the map
	local all_sessions
	all_sessions=$(_ghostty_map_sessions)
	for s in $all_sessions; do
		local tid
		tid=$(_ghostty_map_get_terminal "$s")
		if [[ -n "$tid" ]] && ! _ghostty_terminal_alive "$tid"; then
			_ghostty_map_remove "$s"
		fi
	done

	# List remaining sessions
	local sessions
	sessions=$(_ghostty_map_sessions)

	if [[ -n "$pattern" ]]; then
		echo "$sessions" | grep "^${pattern}" || true
	else
		echo "$sessions"
	fi
}

# Close the Ghostty window containing a terminal.
# Usage: terminal_kill <session_name> [--force]
terminal_kill() {
	local session="$1"
	local force=false

	[[ "${2:-}" == "--force" ]] && force=true

	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")

	# Already gone — success (idempotent)
	if [[ -z "$terminal_id" ]]; then
		return 0
	fi

	if ! _ghostty_terminal_alive "$terminal_id"; then
		_ghostty_map_remove "$session"
		return 0
	fi

	if [[ "$force" == false ]]; then
		# Graceful: send Ctrl+C first, wait briefly
		terminal_send "$session" "" --ctrl-c
		local waited=0
		local graceful_timeout=5
		while [[ $waited -lt $graceful_timeout ]]; do
			sleep 1
			waited=$((waited + 1))
			if ! _ghostty_terminal_alive "$terminal_id"; then
				_ghostty_map_remove "$session"
				return 0
			fi
		done
	fi

	# Close the tab containing this terminal (close window only if it's the last tab)
	local app_target
	app_target=$(_ghostty_app_target) || return 1
	local as_err as_exit
	as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							if (count of tabs of w) > 1 then
								close tb
							else
								close w
							end if
							return
						end if
					end repeat
				end repeat
			end repeat
		end tell
	end timeout
on error errMsg number errNum
	return
end try
EOF
	osascript "$as_script_file" >/dev/null 2>"$as_err"
	as_exit=$?
	rm -f "$as_script_file"
	if [[ $as_exit -ne 0 ]]; then
		local err_msg
		err_msg=$(cat "$as_err" 2>/dev/null)
		echo "Error: AppleScript execution failed (exit ${as_exit})" >&2
		[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
		rm -f "$as_err"
		return 0
	fi
	rm -f "$as_err"

	_ghostty_map_remove "$session"
	return 0
}

# Focus a session's tab and bring the Ghostty window to front.
# Usage: terminal_focus <session_name>
terminal_focus() {
	local session="$1"
	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")
	[[ -z "$terminal_id" ]] && return 1

	local app_target
	app_target=$(_ghostty_app_target) || return 1
	local as_err as_exit
	as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							set active tab index of w to index of tb
							focus t
							activate
							return
						end if
					end repeat
				end repeat
			end repeat
		end tell
	end timeout
on error errMsg number errNum
	return
end try
EOF
	osascript "$as_script_file" >/dev/null 2>"$as_err"
	as_exit=$?
	rm -f "$as_script_file"
	if [[ $as_exit -ne 0 ]]; then
		local err_msg
		err_msg=$(cat "$as_err" 2>/dev/null)
		echo "Error: AppleScript execution failed (exit ${as_exit})" >&2
		[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
		rm -f "$as_err"
		return 0
	fi
	rm -f "$as_err"
}

# Set a terminal option — no-op for AppleScript backend.
# Ghostty theming is handled via surface configuration at creation time.
# Usage: terminal_set_option <session_name> <option> <value>
terminal_set_option() {
	# No-op: Ghostty styling is set via surface configuration at window creation
	return 0
}

# Resize the Ghostty window containing a session.
# Usage: terminal_resize <session_name> <x> <y> <width> <height>
terminal_resize() {
	local session="$1"
	local x="$2" y="$3" w="$4" h="$5"

	# Validate numeric arguments
	if ! [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ && "$w" =~ ^[0-9]+$ && "$h" =~ ^[0-9]+$ ]]; then
		echo "Error: terminal_resize requires numeric x, y, width, height" >&2
		return 1
	fi

	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")
	if [[ -z "$terminal_id" ]]; then
		echo "Error: session '$session' does not exist" >&2
		return 1
	fi

	local app_target
	app_target=$(_ghostty_app_target) || return 1
	local as_err as_exit
	as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							set bounds of w to {$x, $y, $w, $h}
							return
						end if
					end repeat
				end repeat
			end repeat
		end tell
	end timeout
on error errMsg number errNum
	error "terminal_resize failed: " & errMsg & " (" & errNum & ")"
end try
EOF
	osascript "$as_script_file" >/dev/null 2>"$as_err"
	as_exit=$?
	rm -f "$as_script_file"
	if [[ $as_exit -ne 0 ]]; then
		local err_msg
		err_msg=$(cat "$as_err" 2>/dev/null)
		echo "Error: AppleScript execution failed (exit ${as_exit})" >&2
		[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
		rm -f "$as_err"
		return 87
	fi
	rm -f "$as_err"
}

# Move a session's tab to a specific position in its window.
# Usage: terminal_move_tab <session_name> <position>
# position: 1-based tab index (use "last" for end)
terminal_move_tab() {
	local session="$1"
	local position="$2"

	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")
	if [[ -z "$terminal_id" ]]; then
		echo "Error: session '$session' does not exist" >&2
		return 1
	fi

	# Validate position
	if [[ "$position" != "last" ]] && ! [[ "$position" =~ ^[1-9][0-9]*$ ]]; then
		echo "Error: position must be a positive integer or 'last'" >&2
		return 1
	fi

	local app_target
	app_target=$(_ghostty_app_target) || return 1

	# Convert "last" to a large number; AppleScript will clamp to actual tab count
	local target_pos="$position"
	if [[ "$position" == "last" ]]; then
		target_pos=9999
	fi

	local as_err as_exit
	as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							set tabCount to count of tabs of w
							set targetIdx to $target_pos
							if targetIdx > tabCount then
								set targetIdx to tabCount
							end if
							move tb to position targetIdx of w
							set active tab index of w to targetIdx
							return targetIdx as text
						end if
					end repeat
				end repeat
			end repeat
		end tell
	end timeout
on error errMsg number errNum
	error "terminal_move_tab failed: " & errMsg & " (" & errNum & ")"
end try
EOF
	local result
	result=$(osascript "$as_script_file" 2>"$as_err")
	as_exit=$?
	rm -f "$as_script_file"
	if [[ $as_exit -ne 0 ]]; then
		local err_msg
		err_msg=$(cat "$as_err" 2>/dev/null)
		echo "Error: AppleScript execution failed (exit ${as_exit})" >&2
		[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
		rm -f "$as_err"
		return 87
	fi
	rm -f "$as_err"
	echo "$result"
}

# Get the number of tabs in the window containing a session.
# Usage: terminal_tab_count <session_name>
# Outputs the tab count to stdout.
terminal_tab_count() {
	local session="$1"

	local terminal_id
	terminal_id=$(_ghostty_map_get_terminal "$session")
	if [[ -z "$terminal_id" ]]; then
		echo "Error: session '$session' does not exist" >&2
		return 1
	fi

	local app_target
	app_target=$(_ghostty_app_target) || return 1
	local as_err as_exit
	as_err=$(mktemp /tmp/ghostty-as-err-XXXXXXXX)
	local as_script_file
	as_script_file=$(mktemp /tmp/ghostty-applescript-XXXXXXXX)
	cat >"$as_script_file" <<EOF
try
	with timeout of 5 seconds
		tell application id "${GHOSTTY_BUNDLE_ID}"
			repeat with w in windows
				repeat with tb in tabs of w
					repeat with t in terminals of tb
						if (id of t as text) is "$terminal_id" then
							return (count of tabs of w) as text
						end if
					end repeat
				end repeat
			end repeat
		end tell
	end timeout
on error errMsg number errNum
	error "terminal_tab_count failed: " & errMsg & " (" & errNum & ")"
end try
EOF
	local result
	result=$(osascript "$as_script_file" 2>"$as_err")
	as_exit=$?
	rm -f "$as_script_file"
	if [[ $as_exit -ne 0 ]]; then
		local err_msg
		err_msg=$(cat "$as_err" 2>/dev/null)
		echo "Error: AppleScript execution failed (exit ${as_exit})" >&2
		[[ -n "$err_msg" ]] && echo "${err_msg}" >&2
		rm -f "$as_err"
		return 87
	fi
	rm -f "$as_err"
	echo "$result"
}

# ── Internal Helpers (prompt detection) ─────────────────────────────

# Detect if a session is at a shell prompt.
# Uses persist-based detection: stream-JSON completion markers, completion
# marker files, and log tail prompt patterns.
# Usage: _terminal_at_prompt <session_name>
_terminal_at_prompt() {
	local session="$1"

	# Source persist library for prompt detection
	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	# shellcheck source=terminal-persist.sh
	source "${script_dir}/terminal-persist.sh"

	persist_at_prompt "$session"
}
