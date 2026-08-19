#!/bin/bash
#
# oste-steer.sh — Redirect a running agent with new instructions
#
# Usage: oste-steer.sh <session-name> <text>
#        oste-steer.sh <session-name> --ctrl-c
#        oste-steer.sh --by-task-id <id> <text>
#
# NOTE: Claude Code in -p mode does NOT read stdin. Steering works by:
#   1. Interrupting the current agent (Ctrl+C)
#   2. Waiting for it to exit
#   3. Launching a new `claude -p --continue "instruction"` in the same session
# This is NOT real-time mid-task steering — it interrupts and redirects.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly SCRIPT_DIR
readonly _DEFAULT_TASKS_DIR="${HOME}/.config/ghostty-launcher"
readonly TASKS_FILE="${TASKS_FILE:-${_DEFAULT_TASKS_DIR}/tasks.json}"
# shellcheck source=lib/backend-commands.sh
# Sourced for codex_exec_sandbox_flags: the steer continuation must state the
# same Codex sandbox boundary as the initial dispatch, from one definition.
source "${SCRIPT_DIR}/lib/backend-commands.sh"
# shellcheck source=lib/terminal.sh
source "${SCRIPT_DIR}/lib/terminal.sh"
# shellcheck source=lib/agent-backend.sh
source "${SCRIPT_DIR}/lib/agent-backend.sh"
# shellcheck source=lib/reaper.sh
source "${SCRIPT_DIR}/lib/reaper.sh"
# shellcheck source=lib/completion-state-lock.sh
source "${SCRIPT_DIR}/lib/completion-state-lock.sh"
# shellcheck source=lib/task-owner-identity.sh
source "${SCRIPT_DIR}/lib/task-owner-identity.sh"
# shellcheck source=lib/task-id.sh
source "${SCRIPT_DIR}/lib/task-id.sh"
readonly STEER_WAIT_TIMEOUT=15 # seconds to wait for agent to exit after Ctrl+C

# ── Usage ────────────────────────────────────────────────────────────

usage() {
	cat <<EOF
oste-steer.sh — Redirect a running agent with new instructions

Usage:
  oste-steer.sh <session-name> <text>
  oste-steer.sh <session-name> --ctrl-c
  oste-steer.sh --by-task-id <id> <text>

Arguments:
  session-name   Session name (e.g., agent-my-app)
  text           New instruction for the agent

Options:
  --ctrl-c       Send Ctrl+C interrupt only (don't redirect)
  --no-enter     Send raw text without pressing Enter (low-level)
  --raw          Send text directly (bypasses interrupt+continue)
  --allow-shell-raw
                 Permit --raw when a task-targeted pane is already at a shell prompt
  --help         Show this help

How it works:
  Claude Code in -p mode ignores terminal input. To steer:
  1. Sends Ctrl+C to interrupt the running agent
  2. Waits for the agent to exit
  3. Launches 'claude -p --continue "instruction"' (or 'gemini -p --resume latest') to continue with context

  Use --raw for low-level terminal input (e.g., answering a prompt). By default
  --raw submits the input with an explicit Enter key; use --no-enter only when
  you intentionally want to leave text in the input buffer.
  For --by-task-id, --raw refuses to write into an idle shell prompt unless
  --allow-shell-raw is set. This prevents prose steers from becoming accidental
  shell commands after the agent exits.
  Use --ctrl-c to just interrupt without redirecting.

Examples:
  oste-steer.sh --by-task-id fix-auth "Focus on the login endpoint instead"
  oste-steer.sh agent-my-app --ctrl-c
  oste-steer.sh agent-my-app --raw "yes"
EOF
}

# ── Helpers ──────────────────────────────────────────────────────────

die() {
	echo "Error: $*" >&2
	exit 1
}

release_steer_owner_lock() {
	task_owner_transition_lock_leave || true
}

# Wait for agent to exit (reach shell prompt)
wait_for_prompt() {
	local target="$1"
	local timeout="$2"
	local waited=0
	while [[ $waited -lt $timeout ]]; do
		if _terminal_at_prompt "$target"; then
			return 0
		fi
		sleep 1
		waited=$((waited + 1))
	done
	return 1
}

resolve_task_terminal_target() {
	local task_id="$1"
	local expected_owner_hash="${2:-}"
	local task_row="" current_owner_hash=""
	local session_id=""
	local pane_id=""
	local window_id=""
	local tmux_socket=""
	local tmux_conf=""
	local terminal_backend=""

	task_row=$(jq -ce --arg id "$task_id" '.tasks[$id] // empty' "$TASKS_FILE" 2>/dev/null) || return 1
	if [[ -n "$expected_owner_hash" ]]; then
		current_owner_hash=$(task_owner_identity_hash "$task_row") || return 1
		if [[ "$current_owner_hash" != "$expected_owner_hash" ]]; then
			echo "Error: Task '$task_id' owner identity changed before raw input delivery" >&2
			return 2
		fi
	fi
	session_id=$(printf '%s' "$task_row" | jq -r '.session_id // empty')
	[[ -n "$session_id" ]] || return 1
	pane_id=$(printf '%s' "$task_row" | jq -r '.tmux_pane_id // empty')
	window_id=$(printf '%s' "$task_row" | jq -r '.tmux_window_id // empty')
	tmux_socket=$(printf '%s' "$task_row" | jq -r '.tmux_socket // empty')
	tmux_conf=$(printf '%s' "$task_row" | jq -r '.tmux_conf // empty')
	terminal_backend=$(printf '%s' "$task_row" | jq -r '.terminal_backend // empty')
	if [[ -z "$expected_owner_hash" ]]; then
		# Preserve the normal steer path's compatibility repair for legacy/stale
		# socket projections. Permission decisions pass an expected hash and must
		# use only the exact owner snapshot above.
		tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session_id" || echo "")
		tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session_id" || echo "")
	elif [[ "$terminal_backend" == "tmux" ]]; then
		[[ -n "$tmux_socket" ]] || tmux_socket=$(_default_tmux_socket_path "$session_id" || echo "")
		[[ -n "$tmux_conf" ]] || tmux_conf=$(_default_tmux_conf_path "$session_id" || echo "")
	fi

	if [[ -n "$pane_id" ]]; then
		echo "${pane_id}|${tmux_socket}|${tmux_conf}|${session_id}|${terminal_backend}"
	elif [[ -n "$window_id" ]]; then
		echo "${window_id}|${tmux_socket}|${tmux_conf}|${session_id}|${terminal_backend}"
	else
		echo "${session_id}|${tmux_socket}|${tmux_conf}|${session_id}|${terminal_backend}"
	fi
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
	local task_id=""
	local task_targeted=false
	local terminal_target=""
	local task_tmux_socket=""
	local task_tmux_conf=""
	local task_terminal_backend=""
	local resolved_target=""

	local session=""
	local text=""
	local ctrl_c=false
	local send_enter=true
	local raw_mode=false
	local allow_shell_raw=false

	# --by-task-id lookup: resolve task ID to pane/window/session target
	if [[ "${1:-}" == "--by-task-id" ]]; then
		[[ -n "${2:-}" ]] || die "Missing task ID"
		task_id="$2"
		task_id_validate "$task_id" || die "Invalid task ID"
		task_targeted=true
		shift 2
	fi

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--help | -h)
				usage
				exit 0
				;;
			--ctrl-c)
				ctrl_c=true
				shift
				;;
			--no-enter)
				send_enter=false
				shift
				;;
			--raw)
				raw_mode=true
				shift
				;;
			--allow-shell-raw)
				allow_shell_raw=true
				shift
				;;
			-*) die "Unknown option: $1" ;;
			*)
				if [[ "$task_targeted" == true && -z "$text" ]]; then
					text="$1"
				elif [[ -z "$session" ]]; then
					session="$1"
				elif [[ -z "$text" ]]; then
					text="$1"
				else
					die "Unexpected argument: $1"
				fi
				shift
				;;
		esac
	done

	[[ -n "$session" || -n "$task_id" ]] || {
		usage >&2
		die "session-name is required"
	}

	# Resolve a task owner before touching its terminal, then retain the lease
	# through raw delivery or the complete interrupt/continue transition. A
	# permission decision may lend its already-held lease to this subprocess.
	if [[ -z "$task_id" && -f "$TASKS_FILE" ]]; then
		task_id=$(jq -r --arg sess "$session" \
			'[.tasks[] | select(.session_id == $sess)][0].id // ""' \
			"$TASKS_FILE" 2>/dev/null || true)
	fi
	if [[ -n "$task_id" ]]; then
		task_owner_transition_lock_enter "$task_id" || die "Timed out acquiring task owner transition lock for '${task_id}'"
		trap release_steer_owner_lock EXIT
	fi
	if [[ "$task_targeted" == true ]]; then
		resolved_target=$(resolve_task_terminal_target "$task_id" "${OSTE_STEER_EXPECTED_OWNER_HASH:-}") || {
			die "Task '$task_id' not found in tasks.json"
		}
		IFS='|' read -r terminal_target task_tmux_socket task_tmux_conf session task_terminal_backend <<<"$resolved_target"
		export GHL_TMUX_SOCKET="$task_tmux_socket"
		export GHL_TMUX_CONF="$task_tmux_conf"
	elif [[ -z "$terminal_target" ]]; then
		terminal_target="$session"
		if [[ -n "$task_id" ]]; then
			task_terminal_backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // empty' "$TASKS_FILE" 2>/dev/null || true)
		fi
	fi

	# Terminal dispatch is lazy, so pin it to the surface recorded by the task
	# before the first terminal_* call. Ambient auto-detection can otherwise send
	# input to a different backend than the one that owns this lane.
	case "$task_terminal_backend" in
		tmux | persist | applescript) export TERMINAL_BACKEND="$task_terminal_backend" ;;
		"") ;; # Legacy rows without surface metadata retain auto-detection.
		*) die "Unsupported terminal backend '${task_terminal_backend}' for task '${task_id}'" ;;
	esac

	# Task-targeted --raw safety: refuse before the generic session-existence
	# check so a stale or missing pane reports the intended safety error
	# rather than the misleading "Session does not exist" message.
	if [[ "$raw_mode" == true && -n "$task_id" && "$allow_shell_raw" != true ]]; then
		local task_status=""
		task_status=$(jq -r --arg id "$task_id" '.tasks[$id].status // empty' "$TASKS_FILE" 2>/dev/null || true)
		if [[ -n "$task_status" && "$task_status" != "running" ]]; then
			die "Refusing task-targeted --raw input because task '${task_id}' status is '${task_status}', not running. Use --allow-shell-raw for intentional shell commands."
		fi
		if ! terminal_exists "$terminal_target"; then
			die "Refusing task-targeted --raw input because no live terminal pane is recorded for task '${task_id}' (target '${terminal_target}' is gone). The agent is not accepting TUI input; restart/resume the agent or pass --allow-shell-raw for intentional shell commands."
		fi
		if _terminal_at_prompt "$terminal_target"; then
			die "Refusing task-targeted --raw input because '${session}' is at a shell prompt. The agent is not accepting TUI input; use normal steering, restart/resume the agent, or pass --allow-shell-raw for intentional shell commands."
		fi
	fi

	# Validate session exists
	if ! terminal_exists "$terminal_target"; then
		die "Session '${session}' does not exist"
	fi

	# --ctrl-c only: just send interrupt
	if [[ "$ctrl_c" == true ]]; then
		terminal_send "$terminal_target" --ctrl-c
		echo "Sent Ctrl+C to ${session}" >&2
		return
	fi

	[[ -n "$text" ]] || {
		usage >&2
		die "text is required (or use --ctrl-c)"
	}

	# --raw mode: send text directly (for answering prompts, etc.).
	# Critical: submission must be an explicit Enter keypress after text injection.
	# Passing a trailing newline inside the text payload is not reliable for Claude
	# Code/TUI surfaces; it can leave the text sitting in the input buffer.
	# (Task-targeted --raw safety refusal already ran above the terminal_exists
	# check so a stale/missing pane reports the safety error, not the generic one.)
	if [[ "$raw_mode" == true ]]; then
		if [[ "$send_enter" == true ]]; then
			local submit_text="$text"
			while [[ "$submit_text" == *$'\n' || "$submit_text" == *$'\r' ]]; do
				submit_text="${submit_text%$'\n'}"
				submit_text="${submit_text%$'\r'}"
			done
			terminal_send "$terminal_target" "$submit_text" --no-enter
			sleep 0.1
			terminal_send "$terminal_target" ""
			echo "Sent raw input to ${session} and pressed Enter" >&2
		else
			terminal_send "$terminal_target" "$text" --no-enter
			echo "Sent raw input to ${session} without Enter" >&2
		fi
		return
	fi

	# ── Interrupt + Continue flow ────────────────────────────────────

	# Check if already at shell prompt (agent already exited)
	if _terminal_at_prompt "$terminal_target"; then
		echo "Agent already idle, sending continue..." >&2
	else
		# Step 1: Interrupt
		echo "Interrupting agent in ${session}..." >&2
		terminal_send "$terminal_target" --ctrl-c
		sleep 1
		# Send second Ctrl+C in case first was caught
		terminal_send "$terminal_target" --ctrl-c

		# Step 2: Wait for exit
		echo "Waiting for agent to exit (up to ${STEER_WAIT_TIMEOUT}s)..." >&2
		if ! wait_for_prompt "$terminal_target" "$STEER_WAIT_TIMEOUT"; then
			die "Agent did not exit within ${STEER_WAIT_TIMEOUT}s — try --ctrl-c and retry, or use oste-kill.sh"
		fi
		echo "Agent exited, redirecting..." >&2
	fi

	# Remove stale completion marker so the new run gets a fresh one.
	# This shares the watchdog/finalizer completion-state boundary so watchdog
	# cannot project advisory running state while steer clears the marker.
	if [[ -n "$task_id" ]]; then
		if completion_state_lock_acquire "$task_id"; then
			rm -f "/tmp/oste-complete-${task_id}"
			completion_state_unlock "$task_id"
		else
			die "Failed to acquire completion-state lock for ${task_id}"
		fi
	fi
	# Step 3: Launch continue with completion wrapper
	local continue_cmd
	local agent_backend
	local stream_file=""

	# Try to resolve stream file and backend
	if [[ -n "$task_id" ]]; then
		local stream_info
		if stream_info=$(resolve_agent_stream "$task_id"); then
			stream_file="${stream_info%|*}"
			agent_backend="${stream_info#*|}"
		else
			agent_backend=$(resolve_agent_backend "$session" "$task_id")
		fi
	else
		agent_backend=$(resolve_agent_backend "$session" "$task_id")
	fi

	if [[ "$agent_backend" == "gemini" ]]; then
		continue_cmd="gemini -p --resume latest $(printf '%q' "$text") --approval-mode yolo"
	elif [[ "$agent_backend" == "codex" ]]; then
		# Same sandbox boundary as the initial headless dispatch, from the one
		# definition in lib/backend-commands.sh. The removed --full-auto alias
		# used to live here and killed continuations at argv-parse time.
		local codex_sandbox_flags
		codex_sandbox_flags="$(codex_exec_sandbox_flags)"
		if [[ -n "$stream_file" ]]; then
			local stderr_log="/tmp/codex-stderr-${task_id}.log"
			local formatter="${SCRIPT_DIR}/lib/stream-formatter.py"
			if [[ -x "$formatter" ]]; then
				continue_cmd="printf '%s' $(printf '%q' "$text") | codex exec --json ${codex_sandbox_flags} - 2>>'${stderr_log}' | tee -a '${stream_file}' | '${formatter}'"
			else
				continue_cmd="printf '%s' $(printf '%q' "$text") | codex exec --json ${codex_sandbox_flags} - 2>>'${stderr_log}' | tee -a '${stream_file}'"
			fi
		else
			continue_cmd="printf '%s' $(printf '%q' "$text") | codex exec ${codex_sandbox_flags} -"
		fi
	else
		continue_cmd="claude -p --continue $(printf '%q' "$text") --allowedTools 'Bash(*)' 'Read(*)' 'Write(*)' 'Edit(*)'"
	fi

	local context_prefix="export OSTE_SESSION_ID='${session}' && export OSTE_LANE_TYPE='steer' && "
	if [[ -n "$task_id" ]]; then
		context_prefix="${context_prefix}export OSTE_TASK_ID='${task_id}' && "
		continue_cmd="${continue_cmd}; bash '${SCRIPT_DIR}/oste-complete.sh' '${task_id}' \$?"
	fi
	continue_cmd="${context_prefix}${continue_cmd}"

	terminal_send "$terminal_target" "$continue_cmd"
	echo "Redirected agent with: ${text}" >&2
}

main "$@"
