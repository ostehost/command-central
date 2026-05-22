#!/bin/bash
# staging.sh — Helpers for staging agent launch scripts.
#
# Two staging patterns:
#
# 1. stage_surface_command — creates a wrapper for AppleScript surface spawns
#    (terminal_create --command).  Sets tab title, runs agent, execs shell.
#
# 2. stage_reuse_command — creates a hardened, self-deleting script for session
#    reuse.  Atomic write (mktemp+mv), 700 permissions, sent to the reused
#    terminal via a short `bash <path>` executor instead of raw keystroke
#    injection.  Same integrity guarantees as stage_bundle_first_command.
#
# Callers are responsible for tracking the returned path and cleaning it up
# on failure (see _reuse_script in oste-spawn.sh).

# Directory for pending command scripts (atomic staging area).
# Guard against re-sourcing (readonly can't be reassigned).
if [[ -z "${PENDING_COMMAND_DIR:-}" ]]; then
	readonly PENDING_COMMAND_DIR="${OSTE_PENDING_COMMAND_DIR:-${HOME}/.config/ghostty-launcher/pending}"
fi

# stage_surface_command <wrapped_cmd> <title>
#
# Writes a self-contained launcher script to a temp file and prints
# its path.  The script:
#   1. Sets the terminal tab title via OSC escape sequence
#   2. Runs the wrapped agent command (with completion wrapper)
#   3. Drops into an interactive shell so the tab stays open
#
# Usage:
#   script=$(stage_surface_command "$wrapped_cmd" "$title")
stage_surface_command() {
	local wrapped_cmd="$1"
	local title="$2"

	local script
	script=$(mktemp /tmp/oste-wrapper-XXXXXXXX)
	{
		echo '#!/bin/bash'
		# Set terminal tab title via OSC escape sequence (use %q for safe quoting)
		printf 'OSTE_TAB_TITLE=%q\n' "$title"
		printf '%s\n' "printf '\\033]0;%s\\007' \"\$OSTE_TAB_TITLE\""
		# Run agent command with completion wrapper
		printf '%s\n' "$wrapped_cmd"
		# Drop into interactive shell so the tab stays open with a usable prompt
		# instead of showing "Press any key to close the terminal"
		printf '%s\n' 'exec ${SHELL:-/bin/bash}'
	} >"$script"
	chmod +x "$script"
	echo "$script"
}

# stage_reuse_command <session> <project_dir> <wrapped_cmd>
#
# Creates a hardened, self-deleting launcher script for session reuse.
# Instead of injecting long commands as terminal keystrokes (which can
# corrupt if interleaved with escape sequences or shell editing), we
# stage to a file and send a short `bash <path>` executor.
#
# Guarantees:
#   - Atomic write (mktemp + mv) prevents partial reads
#   - Restrictive permissions (700) prevent tampering
#   - Self-deleting (rm -f "$0") cleans up after execution
#
# Usage:
#   script=$(stage_reuse_command "$session" "$project_dir" "$wrapped_cmd")
#   terminal_send "$session" "bash '${script}'" --disable-bracketed-paste
stage_reuse_command() {
	_stage_command_file "$1" "$2" "$3" "reuse"
}

# stage_spawn_command <session> <project_dir> <wrapped_cmd>
#
# Same guarantees as stage_reuse_command but for fresh-spawn visible lanes.
# The wrapped agent command would otherwise be injected as raw keystrokes
# via `terminal_send`, leaking the full `export OSTE_TASK_ID=... && ( ... );
# bash oste-complete.sh ...` payload into the user-visible scrollback.
# Staging reduces the visible command to `bash '<short path>'` while keeping
# runtime semantics identical (the wrapped cmd still runs in a subshell that
# exits cleanly once oste-complete.sh returns).
#
# Usage:
#   script=$(stage_spawn_command "$session" "$project_dir" "$wrapped_cmd")
#   terminal_send "$target" "bash '${script}'"
stage_spawn_command() {
	_stage_command_file "$1" "$2" "$3" "spawn"
}

# Shared implementation for stage_{reuse,spawn}_command.
_stage_command_file() {
	local session="$1"
	local project_dir="$2"
	local wrapped_cmd="$3"
	local suffix="$4"

	mkdir -p "$PENDING_COMMAND_DIR"
	chmod 700 "$PENDING_COMMAND_DIR" 2>/dev/null || true

	local final_script="${PENDING_COMMAND_DIR}/${session}.${suffix}.sh"
	local tmp_script
	tmp_script=$(mktemp "${PENDING_COMMAND_DIR}/${session}.${suffix}.XXXXXX")

	{
		echo '#!/bin/bash'
		# The wrapped command captures its own exit code before running
		# oste-complete.sh. `set -e` here would abort before that tail on
		# SIGTERM/non-zero exits, leaving stale prompts and missing receipts.
		echo 'set -uo pipefail'
		echo 'rm -f -- "$0" 2>/dev/null || true'
		printf 'cd %q\n' "$project_dir"
		printf '%s\n' "$wrapped_cmd"
	} >"$tmp_script"

	chmod 700 "$tmp_script"
	mv -f "$tmp_script" "$final_script"
	echo "$final_script"
}
