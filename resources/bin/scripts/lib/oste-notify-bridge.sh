#!/bin/bash
#
# oste-notify-bridge.sh — Completion notification & wake bridge
#
# Extracted from oste-complete.sh: the cluster of fire-and-forget outbound
# signals emitted at the tail of the completion pipeline (and from the
# reconciliation paths). Pure external-process invokes — every call is
# fail-soft and gated by OSTE_TEST_MODE so test suites stay hermetic.
#
# Public API:
#   _kick_review_watchdog            — background the review watchdog runner
#   _wake_openclaw <text>            — fire the OpenClaw wake CLI
#   _wake_openclaw_for_completion <task_id> <exit_code> <auto_committed> <project_dir>
#   _emit_completion_notifications   — council notification + Discord summary (dynamic-scope reader)
#   _update_tmux_completion_window <task_id> <status> <exit_code>
#
# Host contract (these functions read state from the calling script's scope —
# bash dynamic scoping is preserved across the source boundary):
#   - Globals set by the host: SCRIPT_DIR, TASKS_FILE, PENDING_REVIEW_DIR,
#     launcher_session_key, launcher_callback_url.
#   - _emit_completion_notifications additionally reads main()'s locals:
#     task_id, status, auto_committed, dirty_reason, exit_code, project_dir,
#     handoff_file, handoff_path, notify_script, discord_script.
#   - Requires reaper.sh's _tmux_socket_cmd / TMUX_RUNTIME_CMD (host sources
#     reaper.sh before this lib).

# Guard against double-sourcing
[[ -n "${_OSTE_NOTIFY_BRIDGE_SH_LOADED:-}" ]] && return 0
readonly _OSTE_NOTIFY_BRIDGE_SH_LOADED=1

# Kick the deterministic review watchdog in the background (fire-and-forget).
# No-op if the runner is missing/non-executable. Callers gate on OSTE_TEST_MODE
# (and any should-kick predicate) before invoking.
_kick_review_watchdog() {
	local review_watchdog_script="${OSTE_REVIEW_WATCHDOG_SCRIPT:-${SCRIPT_DIR}/oste-review-watchdog-runner.sh}"
	if [[ -x "$review_watchdog_script" ]]; then
		OSTE_PENDING_REVIEW_DIR="$PENDING_REVIEW_DIR" "$review_watchdog_script" >/dev/null 2>&1 &
		disown $! 2>/dev/null || true
	fi
}

# Fire the OpenClaw wake CLI for a completion event (fire-and-forget). Honors a
# cron-run wake command (which takes no args) and otherwise sends the default
# `openclaw system event --text ... --mode now --timeout 30000` form. Callers
# gate on OSTE_TEST_MODE; tests set OSTE_WAKE_COMMAND=true to neutralize it.
_wake_openclaw() {
	local text="$1"
	local wake_cmd="${OSTE_WAKE_COMMAND:-openclaw system event}"
	# shellcheck disable=SC2086
	if [[ "$wake_cmd" == *"cron run"* ]]; then
		$wake_cmd >/dev/null 2>&1 &
	else
		$wake_cmd \
			--text "$text" \
			--mode now \
			--timeout 30000 >/dev/null 2>&1 &
	fi
	disown $! 2>/dev/null || true
}

# Update the completed task's tmux window/pane: stamp @ghl_task_status on the
# pane and append a ✅/❌ status emoji to the window title. Resolves the tmux
# socket/conf/pane/window from the task row (falling back to the GHL_TMUX_*/
# TMUX_PANE env of the calling shell), then locates the window by pane, or by
# role-named window under the session. Entirely best-effort: every tmux call is
# fail-soft, and the whole step no-ops when no tmux coordinates are known.
_update_tmux_completion_window() {
	local task_id="$1" status="$2" exit_code="$3"
	local task_tmux_socket task_tmux_conf task_tmux_pane_id task_tmux_window_id task_tmux_window_name task_session task_role
	task_tmux_socket=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_socket // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_tmux_conf=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_conf // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_tmux_pane_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_pane_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_tmux_window_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_window_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_tmux_window_name=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_window_name // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_session=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_role=$(jq -r --arg id "$task_id" '.tasks[$id].role // empty' "$TASKS_FILE" 2>/dev/null || true)

	if [[ -z "$task_tmux_socket" && -n "${GHL_TMUX_SOCKET:-}" ]]; then
		task_tmux_socket="$GHL_TMUX_SOCKET"
	fi
	if [[ -z "$task_tmux_conf" && -n "${GHL_TMUX_CONF:-}" ]]; then
		task_tmux_conf="$GHL_TMUX_CONF"
	fi
	if [[ -z "$task_tmux_pane_id" && -n "${TMUX_PANE:-}" ]]; then
		task_tmux_pane_id="$TMUX_PANE"
	fi

	if [[ -n "$task_tmux_socket" || -n "$task_session" || -n "$task_tmux_pane_id" ]]; then
		local status_emoji
		if [[ "$exit_code" -eq 0 ]]; then
			status_emoji="✅"
		else
			status_emoji="❌"
		fi
		_tmux_socket_cmd "$task_tmux_socket" "$task_tmux_conf"
		if [[ -n "$task_tmux_pane_id" ]]; then
			"${TMUX_RUNTIME_CMD[@]}" set-option -p -t "$task_tmux_pane_id" @ghl_task_status "$status" 2>/dev/null || true
			if [[ -z "$task_tmux_window_id" ]]; then
				task_tmux_window_id=$("${TMUX_RUNTIME_CMD[@]}" display-message -p -t "$task_tmux_pane_id" '#{window_id}' 2>/dev/null || true)
			fi
		fi
		if [[ -z "$task_tmux_window_id" && -n "$task_role" && -n "$task_session" ]]; then
			task_tmux_window_id=$("${TMUX_RUNTIME_CMD[@]}" list-windows -t "$task_session" -F '#{window_id} #{window_name}' 2>/dev/null | grep -i "$task_role" | head -1 | awk '{print $1}') || true
		fi
		if [[ -n "$task_tmux_window_id" ]]; then
			local base_title="$task_tmux_window_name"
			if [[ -z "$base_title" ]]; then
				base_title=$("${TMUX_RUNTIME_CMD[@]}" display-message -p -t "$task_tmux_window_id" '#{window_name}' 2>/dev/null || true)
			fi
			if [[ -n "$base_title" ]]; then
				"${TMUX_RUNTIME_CMD[@]}" rename-window -t "$task_tmux_window_id" "${base_title} ${status_emoji}" 2>/dev/null || true
			fi
		fi
	fi
}

# Fire the OpenClaw wake CLI for a completion (with a composed status message:
# project + last commit + pending-review hint). Falls back through _wake_openclaw
# (which honors OSTE_WAKE_COMMAND). Gated by OSTE_TEST_MODE; skipped if
# oste-done.sh already fired the wake synchronously.
_wake_openclaw_for_completion() {
	local task_id="$1" exit_code="$2" auto_committed="$3" project_dir="$4"
	[[ "${OSTE_TEST_MODE:-}" != "1" ]] || return 0
	if [[ -f "/tmp/oste-done-${task_id}" ]]; then
		echo "Wake command already fired by oste-done.sh, skipping" >&2
		return 0
	fi
	local wake_message
	if [[ "$exit_code" == "0" ]]; then
		wake_message="Task completed: ${task_id} finished successfully"
	else
		wake_message="Task failed: ${task_id} exited with code ${exit_code}"
	fi
	if [[ "$auto_committed" == true ]]; then
		wake_message="${wake_message} — auto-committed"
	fi
	if [[ -n "$project_dir" && -d "$project_dir" ]]; then
		local last_commit_short
		last_commit_short=$(git -C "$project_dir" log -1 --format="%h %s" 2>/dev/null || echo "unknown")
		wake_message="${wake_message}\nProject: $(basename "$project_dir")\nLast commit: ${last_commit_short}"
	fi
	local pending_review_file="${PENDING_REVIEW_DIR}/${task_id}.json"
	if [[ -f "$pending_review_file" ]]; then
		wake_message="${wake_message}\nPending review: ${pending_review_file}\nReview state: pending"
	fi
	# Fire and forget — don't block completion on OpenClaw availability
	_wake_openclaw "$wake_message"
}

# Step 5/5b: emit the canonical council notification + Discord summary.
# Verbatim of the former inline block, kept as a dynamic-scope reader (no args)
# because it has MANY inputs and writes nothing consumed downstream — so a
# cut/paste preserves behavior exactly with no positional-arg surface to mis-wire.
# Reads (from main()): task_id, status, auto_committed, dirty_reason, exit_code,
# project_dir, handoff_file, handoff_path, notify_script, discord_script,
# launcher_session_key, launcher_callback_url; globals TASKS_FILE, PENDING_REVIEW_DIR.
# Gated by OSTE_TEST_MODE (tests stub notify/discord scripts to /dev/null).
# shellcheck disable=SC2154  # reads main()'s locals via dynamic scope (see header contract)
_emit_completion_notifications() {
	[[ "${OSTE_TEST_MODE:-}" != "1" ]] || return 0
	local backend=""
	backend=$(jq -r --arg id "$task_id" '.tasks[$id].agent_backend // empty' "$TASKS_FILE" 2>/dev/null || true)
	local role=""
	role=$(jq -r --arg id "$task_id" '.tasks[$id].role // empty' "$TASKS_FILE" 2>/dev/null || true)
	local notify_title notify_message
	if [[ "$status" == "completed" && "$auto_committed" == true ]]; then
		notify_title="Task completed (auto-committed)"
		notify_message="${task_id} finished successfully — auto-committed uncommitted changes"
	elif [[ "$status" == "completed" ]]; then
		notify_title="Task completed"
		notify_message="${task_id} finished successfully"
	elif [[ "$status" == "completed_dirty" ]]; then
		if [[ "$dirty_reason" == "baseline_preserved" ]]; then
			notify_title="Task completed (baseline preserved)"
			notify_message="${task_id} completed; preexisting dirty files left for owning lane"
		else
			notify_title="Task completed (dirty)"
			notify_message="${task_id} completed but has uncommitted changes"
		fi
	else
		notify_title="Task failed"
		notify_message="${task_id} exited with code ${exit_code}"
	fi
	# Owner routing: pass exec_mode/exec_node and the owning hub session
	# key + callback URL through to oste-notify.sh so the wake payload and
	# /hooks/agent relay can target the owning orchestrator session
	# instead of falling through to a generic main-session wake.
	local exec_mode_for_notify=""
	local exec_node_for_notify=""
	local task_session_key_for_notify=""
	local task_callback_url_for_notify=""
	exec_mode_for_notify=$(jq -r --arg id "$task_id" '.tasks[$id].exec_mode // empty' "$TASKS_FILE" 2>/dev/null || true)
	exec_node_for_notify=$(jq -r --arg id "$task_id" '.tasks[$id].exec_node // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_session_key_for_notify=$(jq -r --arg id "$task_id" '.tasks[$id].session_key // empty' "$TASKS_FILE" 2>/dev/null || true)
	task_callback_url_for_notify=$(jq -r --arg id "$task_id" '.tasks[$id].callback_url // empty' "$TASKS_FILE" 2>/dev/null || true)
	[[ -z "$task_session_key_for_notify" || "$task_session_key_for_notify" == "null" ]] && task_session_key_for_notify="$launcher_session_key"
	[[ -z "$task_callback_url_for_notify" || "$task_callback_url_for_notify" == "null" ]] && task_callback_url_for_notify="$launcher_callback_url"
	local pending_review_path_for_notify="${PENDING_REVIEW_DIR}/${task_id}.json"
	local handoff_path_for_notify="$handoff_path"

	if [[ -f "$notify_script" ]]; then
		if bash "$notify_script" \
			--kind "$status" \
			--task-id "$task_id" \
			--project-path "$project_dir" \
			--backend "$backend" \
			--role "$role" \
			--title "$notify_title" \
			--message "$notify_message" \
			--handoff-file "$handoff_file" \
			--handoff-path "$handoff_path_for_notify" \
			--exit-code "$exit_code" \
			--exec-mode "$exec_mode_for_notify" \
			--exec-node "$exec_node_for_notify" \
			--launcher-session-key "$task_session_key_for_notify" \
			--launcher-callback-url "$task_callback_url_for_notify" \
			--pending-review-path "$pending_review_path_for_notify" \
			--source oste-complete >/dev/null 2>&1; then
			true # oste-notify.sh handles macOS notification + wake layers internally
		fi
	fi

	# Step 5b: Send Discord status summary (recent completions)
	if [[ -f "$discord_script" ]]; then
		# Exclude the just-posted immediate task event to avoid near-duplicate
		# completion lines in digest messages.
		bash "$discord_script" --exclude-task "$task_id" --min-recent 2 &
		disown $! 2>/dev/null || true
	fi
}
