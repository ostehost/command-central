#!/bin/bash
#
# terminal-persist.sh — persist binary backend for terminal.sh
#
# Wraps the `persist` binary into the same API shape used by terminal.sh
# and terminal-applescript.sh. This is the persistence layer that replaces
# tmux session management on macOS.
#
# Public API:
#   persist_session_exists  — Check if a persist session is alive
#   persist_new_session     — Create a new detached persist session
#   persist_send_keys       — Send input to a running session
#   persist_capture         — Read output from script log file
#   persist_kill_session    — Terminate a persist session
#   persist_list_sessions   — List active persist sessions
#   persist_at_prompt       — Check if process is at a shell prompt
#

# Guard against double-sourcing
[[ -n "${_TERMINAL_PERSIST_SH_LOADED:-}" ]] && return 0
readonly _TERMINAL_PERSIST_SH_LOADED=1

# shellcheck source=prompt-detection.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prompt-detection.sh"

# ── Constants ────────────────────────────────────────────────────────

readonly _PERSIST_SOCKET_DIR="${PERSIST_SOCKET_DIR:-${HOME}/.local/share/cc/sockets}"
readonly _PERSIST_LOG_DIR="${PERSIST_LOG_DIR:-/tmp}"

# ── Binary Resolution ────────────────────────────────────────────────

# Find the persist binary. Check bundle first, then PATH.
_persist_bin() {
	# 1. Explicit override (testing)
	if [[ -n "${PERSIST_BIN:-}" ]] && [[ -x "$PERSIST_BIN" ]]; then
		echo "$PERSIST_BIN"
		return 0
	fi

	# 2. Inside an .app bundle (Contents/MacOS/persist)
	if [[ -n "${GHOSTTY_RESOURCES_DIR:-}" ]]; then
		local bundle_bin
		bundle_bin="$(dirname "$GHOSTTY_RESOURCES_DIR")/MacOS/persist"
		if [[ -x "$bundle_bin" ]]; then
			echo "$bundle_bin"
			return 0
		fi
	fi

	# 3. Project-local build
	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	local project_bin="${script_dir}/../../persist/persist"
	if [[ -x "$project_bin" ]]; then
		echo "$project_bin"
		return 0
	fi

	# 4. PATH lookup
	if command -v persist &>/dev/null; then
		command -v persist
		return 0
	fi

	echo "Error: persist binary not found" >&2
	return 1
}

# ── Path Helpers ─────────────────────────────────────────────────────

# Socket path for a session ID.
# Usage: _persist_socket_path <session_id>
_persist_socket_path() {
	echo "${_PERSIST_SOCKET_DIR}/${1}.sock"
}

# Log file path for a session ID.
# Usage: _persist_log_path <session_id>
_persist_log_path() {
	echo "${_PERSIST_LOG_DIR}/cc-agent-${1}.log"
}

# Create a temporary wrapper script that runs a command with tee capture.
# Usage: _persist_make_wrapper <logfile>
# Returns path to wrapper script on stdout.
_persist_make_wrapper() {
	local logfile="$1"
	local wrapper
	wrapper=$(mktemp /tmp/cc-persist-wrapper.XXXXXX)
	cat >"$wrapper" <<'WRAPPER'
#!/bin/sh
LOG_FILE="$1"
shift
"$@" 2>&1 | tee -a "$LOG_FILE"
WRAPPER
	chmod +x "$wrapper"
	echo "$wrapper"
}

# ── Public API ───────────────────────────────────────────────────────

# Check if a persist session exists and is alive.
# Usage: persist_session_exists <session_id>
# Returns 0 if socket exists and process is alive.
persist_session_exists() {
	local session_id="$1"
	local persist_bin
	persist_bin=$(_persist_bin) || return 1
	local sock
	sock=$(_persist_socket_path "$session_id")

	"$persist_bin" -s "$sock" &>/dev/null
}

# Create a new persist session (detached).
# Usage: persist_new_session <session_id> <command> [args...]
# Creates socket at $PERSIST_SOCKET_DIR/<session_id>.sock
# Captures output to /tmp/cc-agent-<session_id>.log via tee.
persist_new_session() {
	local session_id="$1"
	shift
	local cmd=("$@")

	if [[ ${#cmd[@]} -eq 0 ]]; then
		echo "Error: persist_new_session requires a command" >&2
		return 1
	fi

	local persist_bin
	persist_bin=$(_persist_bin) || return 1
	local sock
	sock=$(_persist_socket_path "$session_id")
	local logfile
	logfile=$(_persist_log_path "$session_id")

	# Check for existing alive session
	if "$persist_bin" -s "$sock" &>/dev/null; then
		echo "Error: session '$session_id' already exists" >&2
		return 1
	fi

	# Ensure socket directory exists
	mkdir -p "$_PERSIST_SOCKET_DIR"

	# Clean up stale socket file if present
	rm -f "$sock"

	# Initialize empty log file
	: >"$logfile"

	# Create a wrapper script that pipes command output through tee.
	# This captures all stdout+stderr to the log file while still
	# displaying output on the persist PTY.
	local wrapper
	wrapper=$(_persist_make_wrapper "$logfile")

	"$persist_bin" -n "$sock" "$wrapper" "$logfile" "${cmd[@]}"

	# Clean up wrapper after persist has forked (daemon reads it immediately)
	sleep 0.5
	rm -f "$wrapper"
}

# Send input to a running persist session.
# Usage: persist_send_keys <session_id> <text> [--no-enter] [--ctrl-c] [--disable-bracketed-paste]
# Writes to the persist socket via Unix domain socket.
# Wire protocol: 0x00 prefix byte marks stdin data.
#
# --disable-bracketed-paste: sends ESC[?2004l before the text to disable
#   bracketed paste mode. Required when reusing a completed session whose
#   shell has bracketed paste enabled — without this, the shell wraps the
#   injected text in paste brackets and may not execute it as a command.
persist_send_keys() {
	local session_id="$1"
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

	local persist_bin
	persist_bin=$(_persist_bin) || return 1
	local sock
	sock=$(_persist_socket_path "$session_id")

	if ! "$persist_bin" -s "$sock" &>/dev/null; then
		echo "Error: session '$session_id' does not exist" >&2
		return 1
	fi

	# Build the payload to send over the socket
	# Wire protocol: 0x00 prefix byte marks stdin data
	python3 -c "
import socket, sys

sock_path = sys.argv[1]
text = sys.argv[2]
send_enter = sys.argv[3] == '1'
ctrl_c = sys.argv[4] == '1'
disable_bp = sys.argv[5] == '1'

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)

if ctrl_c:
    # Send Ctrl-C (ETX)
    s.send(b'\x00\x03')
    s.close()
    sys.exit(0)

payload = b''

# Disable bracketed paste mode first if requested
if disable_bp:
    payload += b'\x1b[?2004l'

payload += text.encode()

if send_enter:
    payload += b'\n'

s.send(b'\x00' + payload)
s.close()
" "$sock" "$text" "$([ "$send_enter" = true ] && echo 1 || echo 0)" "$([ "$ctrl_c" = true ] && echo 1 || echo 0)" "$([ "$disable_bp" = true ] && echo 1 || echo 0)" 2>/dev/null
	return 0
}

# Capture output from a persist session.
# Usage: persist_capture <session_id> [lines]
# Reads from script log file: /tmp/cc-agent-<session_id>.log
# Returns last N lines (default 50).
persist_capture() {
	local session_id="$1"
	local lines="${2:-50}"
	local logfile
	logfile=$(_persist_log_path "$session_id")

	if [[ ! -f "$logfile" ]]; then
		echo "Error: no log file for session '$session_id'" >&2
		return 1
	fi

	# Strip ANSI escape sequences for clean output, return last N lines
	tail -n "$lines" "$logfile" | col -b 2>/dev/null || tail -n "$lines" "$logfile"
}

# Kill a persist session.
# Usage: persist_kill_session <session_id> [--force]
# Graceful: send SIGTERM to child process.
# Force: send SIGKILL.
# Cleans up socket file.
persist_kill_session() {
	local session_id="$1"
	local force=false
	[[ "${2:-}" == "--force" ]] && force=true

	local persist_bin
	persist_bin=$(_persist_bin) || return 1
	local sock
	sock=$(_persist_socket_path "$session_id")

	# Already dead — success (idempotent)
	if ! "$persist_bin" -s "$sock" &>/dev/null; then
		rm -f "$sock"
		return 0
	fi

	# Find the persist daemon PID via the socket
	local daemon_pid
	daemon_pid=$(pgrep -f "$sock" 2>/dev/null | head -1)

	if [[ -z "$daemon_pid" ]]; then
		# Can't find process — clean up socket
		rm -f "$sock"
		return 0
	fi

	if [[ "$force" == true ]]; then
		kill -9 "$daemon_pid" 2>/dev/null || true
	else
		kill "$daemon_pid" 2>/dev/null || true
		# Wait briefly for graceful shutdown
		local waited=0
		while [[ $waited -lt 5 ]]; do
			sleep 1
			waited=$((waited + 1))
			if ! "$persist_bin" -s "$sock" &>/dev/null; then
				rm -f "$sock"
				return 0
			fi
		done
		# Graceful failed — caller can retry with --force
		return 1
	fi

	# Wait for cleanup
	sleep 0.5
	rm -f "$sock"
	return 0
}

# List all active persist sessions.
# Usage: persist_list_sessions
# Lists sockets in $PERSIST_SOCKET_DIR.
persist_list_sessions() {
	local persist_bin
	persist_bin=$(_persist_bin) || return 1

	"$persist_bin" -l "$_PERSIST_SOCKET_DIR"
}

# Check if process is at a shell prompt (for steering).
# Usage: persist_at_prompt <session_id>
# Checks stream-JSON completion markers OR log tail for prompt patterns.
persist_at_prompt() {
	local session_id="$1"

	# 1. Check stream-JSON completion marker
	local stream_file="/tmp/claude-stream-${session_id}.jsonl"
	if [[ -f "$stream_file" ]]; then
		local last_line
		last_line=$(tail -1 "$stream_file" 2>/dev/null)
		if echo "$last_line" | grep -q '"type":"result"'; then
			return 0
		fi
	fi

	# 2. Check completion marker file
	local complete_marker="/tmp/oste-complete-${session_id}"
	if [[ -f "$complete_marker" ]]; then
		return 0
	fi

	# 3. Fall back to log tail for shell prompt patterns
	local logfile
	logfile=$(_persist_log_path "$session_id")
	if [[ -f "$logfile" ]]; then
		local tail_output
		tail_output=$(tail -20 "$logfile" 2>/dev/null | col -b 2>/dev/null || tail -20 "$logfile")
		if terminal_output_ends_at_prompt "$tail_output"; then
			return 0
		fi
	fi

	return 1
}
