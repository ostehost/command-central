#!/bin/bash
#
# terminal.sh — Terminal abstraction layer (pure dispatch)
#
# Detects the platform and sources the appropriate backend:
#   - applescript (macOS + Ghostty + GHOSTTY_BUNDLE_ID set)
#   - tmux (Linux fallback, or explicit override)
#
# Backend selection via TERMINAL_BACKEND env var:
#   auto        — AppleScript if Ghostty sdef available, else tmux (default)
#   applescript — Force AppleScript backend
#   tmux        — Force tmux backend
#
# Public API (provided by the sourced backend):
#   terminal_create       — Create a new detached session
#   terminal_send         — Send text or control sequences to a session
#   terminal_capture      — Capture visible terminal output
#   terminal_exists       — Check if a session exists
#   terminal_list         — List sessions matching a pattern
#   terminal_kill         — Destroy a session (graceful or force)
#   terminal_set_option   — Set a session option
#   terminal_focus        — Focus a session's tab and bring window to front
#   terminal_resize       — Resize the window containing a session
#   terminal_move_tab     — Move a session's tab to a specific position
#   terminal_tab_count    — Get number of tabs in the session's window
#
# Internal (provided by the sourced backend):
#   _terminal_at_prompt   — Detect if session is at a shell prompt
#

# Guard against double-sourcing
[[ -n "${_TERMINAL_SH_LOADED:-}" ]] && return 0
readonly _TERMINAL_SH_LOADED=1

# ── Backend Detection ─────────────────────────────────────────────

_terminal_detect_backend() {
	local requested="${TERMINAL_BACKEND:-auto}"

	case "$requested" in
		applescript)
			echo "applescript"
			;;
		tmux)
			echo "tmux"
			;;
		persist)
			echo "persist"
			;;
		auto)
			# Use AppleScript if: macOS + Ghostty sdef available + GHOSTTY_BUNDLE_ID set
			# GHOSTTY_BUNDLE_ID is required because AppleScript must target launcher
			# bundles (dev.partnerai.ghostty.*), never the stock Ghostty app.
			if [[ "$(uname -s)" == "Darwin" ]] &&
				[[ -n "${GHOSTTY_BUNDLE_ID:-}" ]] &&
				sdef /Applications/Ghostty.app &>/dev/null; then
				echo "applescript"
			else
				echo "tmux"
			fi
			;;
		*)
			echo "Warning: unknown TERMINAL_BACKEND='$requested', falling back to tmux" >&2
			echo "tmux"
			;;
	esac
}

# Lazy backend detection: resolved on first terminal_* call, not at source time.
# This allows GHOSTTY_BUNDLE_ID to be set after sourcing terminal.sh.
_TERMINAL_BACKEND=""
_TERMINAL_BACKEND_RESOLVED=false

_terminal_ensure_backend() {
	if [[ "$_TERMINAL_BACKEND_RESOLVED" == true ]]; then
		return 0
	fi
	_TERMINAL_BACKEND=$(_terminal_detect_backend)
	_TERMINAL_BACKEND_RESOLVED=true

	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

	case "$_TERMINAL_BACKEND" in
		applescript)
			# shellcheck source=terminal-applescript.sh
			source "${script_dir}/terminal-applescript.sh"
			;;
		persist)
			# shellcheck source=terminal-persist.sh
			source "${script_dir}/terminal-persist.sh"
			# Alias persist_* to terminal_* for dispatch compatibility
			terminal_create() { persist_new_session "$@"; }
			terminal_send() { persist_send_keys "$@"; }
			terminal_capture() { persist_capture "$@"; }
			terminal_exists() { persist_session_exists "$@"; }
			terminal_list() { persist_list_sessions "$@"; }
			terminal_kill() { persist_kill_session "$@"; }
			terminal_set_option() { :; } # no-op for persist
			_terminal_at_prompt() { persist_at_prompt "$@"; }
			;;
		tmux)
			# shellcheck source=terminal-tmux.sh
			source "${script_dir}/terminal-tmux.sh"
			;;
	esac
}

# ── Dispatch Layer ─────────────────────────────────────────────────
#
# Each public function ensures the backend is loaded, then delegates.
# The sourced backend defines the actual terminal_* functions, so we
# need wrapper functions that trigger lazy loading on first call, then
# re-dispatch to the now-defined backend functions.

# We use a trampoline pattern: define thin wrappers that load the
# backend and then call themselves (the backend's version).

_terminal_dispatch() {
	local fn="$1"
	shift
	_terminal_ensure_backend
	# After sourcing the backend, the function is now redefined.
	# Call it directly.
	"$fn" "$@"
}

# Only define trampolines if the backend hasn't already provided them.
# On first call, the trampoline loads the backend (which redefines the
# function), then calls the real implementation.

terminal_create() { _terminal_dispatch terminal_create "$@"; }
terminal_send() { _terminal_dispatch terminal_send "$@"; }
terminal_capture() { _terminal_dispatch terminal_capture "$@"; }
terminal_exists() { _terminal_dispatch terminal_exists "$@"; }
terminal_list() { _terminal_dispatch terminal_list "$@"; }
terminal_kill() { _terminal_dispatch terminal_kill "$@"; }
terminal_set_option() { _terminal_dispatch terminal_set_option "$@"; }
terminal_focus() { _terminal_dispatch terminal_focus "$@"; }
terminal_resize() { _terminal_dispatch terminal_resize "$@"; }
terminal_move_tab() { _terminal_dispatch terminal_move_tab "$@"; }
terminal_tab_count() { _terminal_dispatch terminal_tab_count "$@"; }
terminal_client_count() { _terminal_dispatch terminal_client_count "$@"; }
terminal_list_clients() { _terminal_dispatch terminal_list_clients "$@"; }
terminal_flow_type() { _terminal_dispatch terminal_flow_type "$@"; }
terminal_session_identity() { _terminal_dispatch terminal_session_identity "$@"; }
_terminal_at_prompt() { _terminal_dispatch _terminal_at_prompt "$@"; }
