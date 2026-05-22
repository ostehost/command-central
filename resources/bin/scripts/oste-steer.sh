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
# shellcheck source=lib/terminal.sh
source "${SCRIPT_DIR}/lib/terminal.sh"
# shellcheck source=lib/agent-backend.sh
source "${SCRIPT_DIR}/lib/agent-backend.sh"
# shellcheck source=lib/reaper.sh
source "${SCRIPT_DIR}/lib/reaper.sh"
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
	local session_id=""
	local pane_id=""
	local window_id=""
	local tmux_socket=""
	local tmux_conf=""

	session_id=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	[[ -n "$session_id" ]] || return 1
	pane_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_pane_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	window_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_window_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session_id" || echo "")
	tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session_id" || echo "")

	if [[ -n "$pane_id" ]]; then
		echo "${pane_id}|${tmux_socket}|${tmux_conf}|${session_id}"
	elif [[ -n "$window_id" ]]; then
		echo "${window_id}|${tmux_socket}|${tmux_conf}|${session_id}"
	else
		echo "${session_id}|${tmux_socket}|${tmux_conf}|${session_id}"
	fi
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
	local task_id=""
	local terminal_target=""
	local task_tmux_socket=""
	local task_tmux_conf=""
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
		resolved_target=$(resolve_task_terminal_target "$task_id") || {
			die "Task '$task_id' not found in tasks.json"
		}
		IFS='|' read -r terminal_target task_tmux_socket task_tmux_conf session <<<"$resolved_target"
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
				if [[ -z "$session" ]]; then
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

	[[ -n "$session" ]] || {
		usage >&2
		die "session-name is required"
	}

	if [[ -z "$terminal_target" ]]; then
		terminal_target="$session"
	elif [[ -n "$task_id" ]]; then
		export GHL_TMUX_SOCKET="$task_tmux_socket"
		export GHL_TMUX_CONF="$task_tmux_conf"
	fi

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

	# Look up task metadata if we don't have task_id yet
	if [[ -z "$task_id" && -f "$TASKS_FILE" ]]; then
		task_id=$(jq -r --arg sess "$session" \
			'[.tasks[] | select(.session_id == $sess)][0].id // ""' \
			"$TASKS_FILE" 2>/dev/null || true)
	fi

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

	# Remove stale completion marker so the new run gets a fresh one
	if [[ -n "$task_id" ]]; then
		rm -f "/tmp/oste-complete-${task_id}"
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
		if [[ -n "$stream_file" ]]; then
			local stderr_log="/tmp/codex-stderr-${task_id}.log"
			local formatter="${SCRIPT_DIR}/lib/stream-formatter.py"
			if [[ -x "$formatter" ]]; then
				continue_cmd="printf '%s' $(printf '%q' "$text") | codex exec --json --full-auto - 2>>'${stderr_log}' | tee -a '${stream_file}' | '${formatter}'"
			else
				continue_cmd="printf '%s' $(printf '%q' "$text") | codex exec --json --full-auto - 2>>'${stderr_log}' | tee -a '${stream_file}'"
			fi
		else
			continue_cmd="printf '%s' $(printf '%q' "$text") | codex exec --full-auto -"
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
