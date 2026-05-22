#!/bin/bash
#
# terminal-tmux.sh — tmux terminal backend (Linux fallback)
#
# Extracted from terminal.sh. Contains all tmux-specific implementations
# of the standard terminal API. Used on Linux or when explicitly requested.
#
# Public API (mirrors terminal-applescript.sh):
#   terminal_create           — Create a new detached tmux session
#   terminal_send             — Send text via `tmux send-keys`
#   terminal_capture          — Capture output via `tmux capture-pane`
#   terminal_exists           — Check if a tmux session exists
#   terminal_list             — List tmux sessions matching a pattern
#   terminal_kill             — Kill a tmux session (graceful or force)
#   terminal_set_option       — Set a tmux session option
#   terminal_client_count     — Count attached clients for a session
#   terminal_list_clients     — List client details (tty, activity, size)
#   terminal_flow_type        — Classify: detached | single | multiflow
#   terminal_session_identity — Full JSON identity report for a session
#
# Internal:
#   _terminal_at_prompt   — Detect if session is at a shell prompt
#

# Guard against double-sourcing
[[ -n "${_TERMINAL_TMUX_SH_LOADED:-}" ]] && return 0
readonly _TERMINAL_TMUX_SH_LOADED=1

# shellcheck source=prompt-detection.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prompt-detection.sh"

# Build a tmux command array with optional dedicated socket/config.
_tmux_cmd() {
	TMUX_CMD=(tmux)
	if [[ -n "${GHL_TMUX_CONF:-}" ]]; then
		TMUX_CMD+=(-f "$GHL_TMUX_CONF")
	fi
	if [[ -n "${GHL_TMUX_SOCKET:-}" ]]; then
		TMUX_CMD+=(-S "$GHL_TMUX_SOCKET")
	fi
}

_tmux_target_exists() {
	local target="$1"
	_tmux_cmd
	"${TMUX_CMD[@]}" capture-pane -t "$target" -p -S -0 >/dev/null 2>&1
}

# ── Public API ──────────────────────────────────────────────────────

# Create a new detached tmux session.
# Usage: terminal_create <session_name> <working_dir>
terminal_create() {
	local session="$1"
	local cwd="$2"

	if terminal_exists "$session"; then
		echo "Error: session '$session' already exists" >&2
		return 1
	fi

	_tmux_cmd
	"${TMUX_CMD[@]}" new-session -d -s "$session" -c "$cwd" /bin/bash -l
}

# Send text or control sequences to a tmux session.
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

	if ! terminal_exists "$session"; then
		echo "Error: session '$session' does not exist" >&2
		return 1
	fi

	if [[ "$ctrl_c" == true ]]; then
		_tmux_cmd
		"${TMUX_CMD[@]}" send-keys -t "$session" C-c
		return
	fi

	# Tmux send-keys does not use terminal bracketed paste. Older code tried to
	# inject ESC[?2004l through paste-buffer here, which leaked the control
	# sequence into the shell input and could prefix commands as "2004l...".
	if [[ "$disable_bp" == true ]]; then
		:
	fi

	_tmux_cmd
	if [[ "$send_enter" == true ]]; then
		"${TMUX_CMD[@]}" send-keys -t "$session" "$text" Enter
	else
		"${TMUX_CMD[@]}" send-keys -t "$session" "$text"
	fi
}

# Capture visible terminal output from a tmux session's pane.
# Usage: terminal_capture <session_name> [--lines N]
# Default: 50 lines. Output on stdout.
terminal_capture() {
	local session="$1"
	local lines=50

	if [[ "${2:-}" == "--lines" ]]; then
		lines="${3:-50}"
	fi

	if ! terminal_exists "$session"; then
		return 1
	fi

	_tmux_cmd
	"${TMUX_CMD[@]}" capture-pane -t "$session" -p -S "-${lines}"
}

# Check if a tmux session exists.
# Usage: terminal_exists <session_name>
terminal_exists() {
	local target="$1"
	_tmux_target_exists "$target"
}

# List all tmux sessions, optionally filtered by prefix pattern.
# Usage: terminal_list [pattern]
terminal_list() {
	local pattern="${1:-}"
	local sessions
	_tmux_cmd
	sessions=$("${TMUX_CMD[@]}" list-sessions -F '#{session_name}' 2>/dev/null) || true

	if [[ -n "$pattern" ]]; then
		echo "$sessions" | grep "^${pattern}" || true
	else
		echo "$sessions"
	fi
}

# Kill a tmux session.
# Usage: terminal_kill <session_name> [--force]
# Without --force: sends Ctrl+C, waits for prompt, then kills.
# With --force: immediate kill.
terminal_kill() {
	local session="$1"
	local force=false
	local graceful_timeout=5

	[[ "${2:-}" == "--force" ]] && force=true

	# Already dead — success (idempotent)
	if ! terminal_exists "$session"; then
		return 0
	fi

	if [[ "$force" == true ]]; then
		_tmux_cmd
		"${TMUX_CMD[@]}" kill-session -t "$session" 2>/dev/null || true
		return 0
	fi

	# Graceful: interrupt, wait for shell prompt, then kill
	_tmux_cmd
	"${TMUX_CMD[@]}" send-keys -t "$session" C-c
	local waited=0
	while [[ $waited -lt $graceful_timeout ]]; do
		sleep 1
		waited=$((waited + 1))
		if _terminal_at_prompt "$session"; then
			_tmux_cmd
			"${TMUX_CMD[@]}" kill-session -t "$session" 2>/dev/null || true
			return 0
		fi
	done

	# Graceful failed — return 1 so caller can decide
	return 1
}

# Set a tmux session option.
# Usage: terminal_set_option <session_name> <option> <value>
terminal_set_option() {
	local session="$1" option="$2" value="$3"
	_tmux_cmd
	"${TMUX_CMD[@]}" set-option -t "$session" "$option" "$value"
}

# Create a new window in an existing tmux session.
# Usage: tmux_new_window <session_name> <working_dir> <window_name>
tmux_new_window() {
	local session="$1"
	local cwd="$2"
	local window_name="$3"
	_tmux_cmd
	"${TMUX_CMD[@]}" new-window -P -F '#{window_id}|#{pane_id}' \
		-t "${session}:" -c "$cwd" -n "$window_name" /bin/bash -l
}

# ── Session Identity (multiflow detection) ─────────────────────────

terminal_client_count() {
	local session="$1"
	_tmux_cmd
	local count
	count=$("${TMUX_CMD[@]}" list-clients -t "$session" -F '#{client_name}' 2>/dev/null | wc -l | tr -d ' ')
	echo "${count:-0}"
}

terminal_list_clients() {
	local session="$1"
	_tmux_cmd
	"${TMUX_CMD[@]}" list-clients -t "$session" \
		-F '#{client_tty}|#{client_session}|#{client_activity}|#{client_width}|#{client_height}' \
		2>/dev/null || true
}

terminal_flow_type() {
	local session="$1"
	if ! terminal_exists "$session"; then
		echo "dead"
		return 1
	fi
	local count
	count=$(terminal_client_count "$session")
	if [[ "$count" -eq 0 ]]; then
		echo "detached"
	elif [[ "$count" -eq 1 ]]; then
		echo "single"
	else
		echo "multiflow"
	fi
}

terminal_session_identity() {
	local session="$1"
	if ! terminal_exists "$session"; then
		printf '{"session":"%s","exists":false,"client_count":0,"flow_type":"dead","clients":[]}\n' "$session"
		return 1
	fi

	local count flow_type clients_json
	count=$(terminal_client_count "$session")
	flow_type=$(terminal_flow_type "$session")

	local raw_clients
	raw_clients=$(terminal_list_clients "$session")
	if [[ -n "$raw_clients" ]]; then
		clients_json=$(echo "$raw_clients" | while IFS='|' read -r tty c_session activity width height; do
			printf '{"tty":"%s","session":"%s","last_activity":%s,"width":%s,"height":%s}\n' \
				"$tty" "$c_session" "${activity:-0}" "${width:-0}" "${height:-0}"
		done | jq -s '.')
	else
		clients_json="[]"
	fi

	_tmux_cmd
	local window_count
	window_count=$("${TMUX_CMD[@]}" list-windows -t "$session" -F '#{window_id}' 2>/dev/null | wc -l | tr -d ' ')

	jq -n \
		--arg session "$session" \
		--argjson exists true \
		--argjson client_count "$count" \
		--arg flow_type "$flow_type" \
		--argjson window_count "${window_count:-0}" \
		--argjson clients "$clients_json" \
		'{session: $session, exists: $exists, client_count: $client_count, flow_type: $flow_type, window_count: $window_count, clients: $clients}'
}

# ── Internal Helpers ────────────────────────────────────────────────

# Detect if a tmux session's terminal is at a shell prompt.
# Usage: _terminal_at_prompt <session_name>
_terminal_at_prompt() {
	local session="$1"
	local output
	_tmux_cmd
	local current
	current=$("${TMUX_CMD[@]}" display-message -p -t "$session" '#{pane_current_command}' 2>/dev/null || true)
	case "$current" in
		bash | zsh | sh | fish | ksh | dash | ash | nu | elvish) ;;
		*) return 1 ;;
	esac
	output=$("${TMUX_CMD[@]}" capture-pane -t "$session" -p -S -20 2>/dev/null) || return 1
	terminal_output_ends_at_prompt "$output"
}
