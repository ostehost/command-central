#!/bin/bash
# lib/reaper.sh — Shared logic for reaping stale tasks

REAPER_LAST_DEAD_REASON=""
REAPER_LAST_DEAD_DETAIL=""

_reset_reaper_dead_reason() {
	REAPER_LAST_DEAD_REASON=""
	REAPER_LAST_DEAD_DETAIL=""
}

_derive_base_session() {
	local session_id="$1"
	local base_session="${session_id%-developer}"
	base_session="${base_session%-reviewer}"
	base_session="${base_session%-planner}"
	base_session="${base_session%-test}"
	echo "$base_session"
}

_default_persist_socket_path() {
	local session_id="$1"
	local sock_dir="${PERSIST_SOCKET_DIR:-${HOME}/.local/share/cc/sockets}"
	[[ -n "$session_id" ]] || return 1
	echo "${sock_dir}/${session_id}.sock"
}

_tmux_state_dir() {
	echo "${XDG_STATE_HOME:-${HOME}/.local/state}/ghostty-launcher/tmux"
}

_session_slug() {
	local session_id="$1"
	echo "${session_id#agent-}"
}

_default_tmux_socket_path() {
	local session_id="$1"
	local socket_dir
	socket_dir=$(_tmux_state_dir)
	[[ -n "$session_id" ]] || return 1
	echo "${socket_dir}/$(_session_slug "$session_id").sock"
}

_default_tmux_conf_path() {
	local session_id="$1"
	local socket_dir
	socket_dir=$(_tmux_state_dir)
	[[ -n "$session_id" ]] || return 1
	echo "${socket_dir}/$(_session_slug "$session_id").conf"
}

_persist_bin_path() {
	local persist_bin="${SCRIPT_DIR}/../persist/persist"
	[[ -x "$persist_bin" ]] || return 1
	echo "$persist_bin"
}

cleanup_dead_persist_socket_path() {
	local persist_socket="$1"
	local session_label="${2:-$persist_socket}"
	local persist_bin=""

	[[ -n "$persist_socket" ]] || return 1
	[[ -e "$persist_socket" ]] || return 1

	persist_bin=$(_persist_bin_path) || return 1
	if "$persist_bin" -s "$persist_socket" &>/dev/null; then
		return 1
	fi

	echo "Cleaning up stale persist socket for '${session_label}' (session is dead)" >&2
	rm -f "$persist_socket"
	return 0
}

cleanup_dead_persist_socket_for_session() {
	local session_id="$1"
	local persist_socket=""

	persist_socket=$(_default_persist_socket_path "$session_id" || echo "")
	cleanup_dead_persist_socket_path "$persist_socket" "$session_id"
}

_resolve_task_persist_socket() {
	local task_id="$1"
	local session_id="${2:-}"
	local persist_socket=""

	if [[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
		persist_socket=$(jq -r --arg id "$task_id" '.tasks[$id].persist_socket // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		if [[ -n "$persist_socket" ]]; then
			echo "$persist_socket"
			return 0
		fi
	fi

	_default_persist_socket_path "$session_id"
}

_resolve_task_tmux_socket() {
	local task_id="$1"
	local session_id="${2:-}"
	local tmux_socket=""
	local tmux_conf=""
	local terminal_backend=""

	if [[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
		tmux_socket=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_socket // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		tmux_conf=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_conf // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		terminal_backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // empty' "$TASKS_FILE" 2>/dev/null || echo "")
	fi
	[[ "$terminal_backend" == "tmux" ]] || return 1

	if [[ -n "$tmux_socket" ]]; then
		local default_socket default_conf
		default_socket=$(_default_tmux_socket_path "$session_id" || echo "")
		default_conf=$(_default_tmux_conf_path "$session_id" || echo "")
		if [[ -n "$session_id" && -n "$default_socket" && "$default_socket" != "$tmux_socket" ]]; then
			if ! tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$session_id" && tmux_target_exists_on_socket "$default_socket" "$default_conf" "$session_id"; then
				echo "$default_socket"
				return 0
			fi
		fi
		echo "$tmux_socket"
		return 0
	fi

	_default_tmux_socket_path "$session_id"
}

_resolve_task_tmux_conf() {
	local task_id="$1"
	local session_id="${2:-}"
	local tmux_socket=""
	local tmux_conf=""
	local terminal_backend=""

	if [[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
		tmux_socket=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_socket // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		tmux_conf=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_conf // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		terminal_backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // empty' "$TASKS_FILE" 2>/dev/null || echo "")
	fi
	[[ "$terminal_backend" == "tmux" ]] || return 1

	if [[ -n "$tmux_conf" ]]; then
		local default_socket default_conf
		default_socket=$(_default_tmux_socket_path "$session_id" || echo "")
		default_conf=$(_default_tmux_conf_path "$session_id" || echo "")
		if [[ -n "$session_id" && -n "$tmux_socket" && -n "$default_conf" && "$default_conf" != "$tmux_conf" ]]; then
			if ! tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$session_id" && tmux_target_exists_on_socket "$default_socket" "$default_conf" "$session_id"; then
				echo "$default_conf"
				return 0
			fi
		fi
		echo "$tmux_conf"
		return 0
	fi

	_default_tmux_conf_path "$session_id"
}

_tmux_socket_cmd() {
	local socket="${1:-}"
	local conf="${2:-}"
	TMUX_RUNTIME_CMD=(tmux)
	[[ -n "$conf" ]] && TMUX_RUNTIME_CMD+=(-f "$conf")
	[[ -n "$socket" ]] && TMUX_RUNTIME_CMD+=(-S "$socket")
	return 0
}

cleanup_dead_tmux_socket_path() {
	local tmux_socket="$1"
	local tmux_conf="${2:-}"

	[[ -n "$tmux_socket" ]] || return 1
	[[ -e "$tmux_socket" ]] || return 1

	_tmux_socket_cmd "$tmux_socket" "$tmux_conf"
	if "${TMUX_RUNTIME_CMD[@]}" list-sessions >/dev/null 2>&1; then
		return 1
	fi

	rm -f "$tmux_socket"
	return 0
}

tmux_target_exists_on_socket() {
	local socket="$1"
	local conf="$2"
	local target="$3"

	_tmux_socket_cmd "$socket" "$conf"
	"${TMUX_RUNTIME_CMD[@]}" display-message -p -t "$target" '#{session_name}' >/dev/null 2>&1
}

# Target existence proves the session, not a viewer. Visibility receipts need
# the stronger claim: at least one live client attached to the target's session.
tmux_target_has_attached_client_on_socket() {
	local socket="$1"
	local conf="$2"
	local target="$3"

	_tmux_socket_cmd "$socket" "$conf"
	local clients
	clients=$("${TMUX_RUNTIME_CMD[@]}" list-clients -t "$target" -F '#{client_tty}' 2>/dev/null) || return 1
	[[ -n "$clients" ]]
}

_tmux_target_identity_on_socket() {
	local socket="$1"
	local conf="$2"
	local target="$3"

	_tmux_socket_cmd "$socket" "$conf"
	"${TMUX_RUNTIME_CMD[@]}" display-message -p -t "$target" '#{session_name}|#{window_id}|#{window_name}|#{pane_id}' 2>/dev/null
}

_tmux_identity_matches_expected() {
	local identity="$1"
	local expected_session="$2"
	local expected_window="$3"
	local expected_pane="$4"
	local actual_session="" actual_window="" _actual_window_name="" actual_pane=""

	IFS='|' read -r actual_session actual_window _actual_window_name actual_pane <<<"$identity"

	[[ -n "$expected_session" && "$actual_session" != "$expected_session" ]] && return 1
	[[ -n "$expected_window" && "$actual_window" != "$expected_window" ]] && return 1
	[[ -n "$expected_pane" && "$actual_pane" != "$expected_pane" ]] && return 1
	return 0
}

_tmux_owner_mismatch_detail() {
	local target="$1"
	local identity="$2"
	local actual_session="" actual_window="" _actual_window_name="" actual_pane=""

	IFS='|' read -r actual_session actual_window _actual_window_name actual_pane <<<"$identity"

	printf 'target=%s actual_session=%s actual_window=%s actual_pane=%s' \
		"$target" "${actual_session:-unknown}" "${actual_window:-unknown}" "${actual_pane:-unknown}"
}

_resolve_task_stream_file() {
	local task_id="$1"
	local stream_file=""

	# Priority 1: explicit stream_file from tasks.json (supports all backends).
	if [[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
		stream_file=$(jq -r --arg id "$task_id" '.tasks[$id].stream_file // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		if [[ -n "$stream_file" && -f "$stream_file" ]]; then
			echo "$stream_file"
			return 0
		fi
	fi

	# Priority 2: known stream path conventions.
	local prefixes=("claude" "gemini" "codex" "acp" "acp-codex" "acp-gemini")
	local prefix candidate
	for prefix in "${prefixes[@]}"; do
		candidate="/tmp/${prefix}-stream-${task_id}.jsonl"
		if [[ -f "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done

	return 1
}

_read_yaml_field() {
	local file="$1"
	local field="$2"
	[[ -f "$file" ]] || return 1
	grep "^${field}:" "$file" 2>/dev/null | head -1 | sed "s/^${field}: *//; s/\"//g; s/'//g" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

_check_oste_report() {
	local task_id="$1"
	[[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]] || return 1

	local project_dir
	project_dir=$(jq -r --arg id "$task_id" '.tasks[$id].project_dir // ""' "$TASKS_FILE" 2>/dev/null || true)
	[[ -n "$project_dir" ]] || return 1

	local report_file="${project_dir}/.oste-report.yaml"
	[[ -f "$report_file" ]] || return 1

	local report_task_id
	report_task_id=$(_read_yaml_field "$report_file" "task_id") || return 1
	[[ "$report_task_id" == "$task_id" ]] || return 1

	local report_status
	report_status=$(_read_yaml_field "$report_file" "status") || return 1

	case "$report_status" in
		success) echo "completed" ;;
		failure) echo "failed" ;;
		*) return 1 ;;
	esac
}

_receipt_exit_code() {
	local receipt_path="$1"
	local receipt_exit
	receipt_exit=$(jq -r '.exit_code // -1' "$receipt_path" 2>/dev/null || echo "-1")
	if ! [[ "$receipt_exit" =~ ^-?[0-9]+$ ]]; then
		receipt_exit="-1"
	fi
	echo "$receipt_exit"
}

_receipt_finished_at() {
	local receipt_path="$1"
	jq -r '.finished_at // empty' "$receipt_path" 2>/dev/null || true
}

_marker_field() {
	local marker_path="$1"
	local key="$2"
	[[ -f "$marker_path" ]] || return 1
	grep "^${key}=" "$marker_path" 2>/dev/null | head -1 | cut -d= -f2-
}

_marker_exit_code() {
	local marker_path="$1"
	local marker_exit
	marker_exit=$(_marker_field "$marker_path" "exit_code" || true)
	if ! [[ "$marker_exit" =~ ^-?[0-9]+$ ]]; then
		marker_exit="-1"
	fi
	echo "$marker_exit"
}

_marker_completed_at() {
	local marker_path="$1"
	_marker_field "$marker_path" "completed_at" || true
}

_marker_status() {
	local marker_path="$1"
	local marker_status
	marker_status=$(_marker_field "$marker_path" "status" || true)
	case "$marker_status" in
		completed | failed | completed_dirty | completed_stale | contract_failure)
			echo "$marker_status"
			;;
		*)
			echo "completed_stale"
			;;
	esac
}

_task_json_field() {
	local task_id="$1"
	local jq_expr="$2"
	[[ -f "$TASKS_FILE" ]] || return 1
	jq -r --arg id "$task_id" "$jq_expr" "$TASKS_FILE" 2>/dev/null || true
}

_task_recovery_notify_message() {
	local task_id="$1"
	local status="$2"
	local reason="$3"
	local detail="$4"
	local exit_code="$5"
	local suffix="Recovered after unexpected launcher task exit"

	if [[ -n "$reason" ]]; then
		suffix="${suffix} (${reason}"
		if [[ -n "$detail" ]]; then
			suffix="${suffix}, ${detail}"
		fi
		suffix="${suffix})"
	fi

	case "$status" in
		completed)
			echo "${task_id} finished successfully. ${suffix}."
			;;
		failed)
			echo "${task_id} failed"
			if [[ -n "$exit_code" ]]; then
				printf ' (exit %s)' "$exit_code"
			fi
			printf '. %s.\n' "$suffix"
			;;
		completed_stale)
			echo "${task_id} was recovered via stale-task reconciliation. ${suffix}."
			;;
		*)
			echo "${task_id} changed to ${status}. ${suffix}."
			;;
	esac
}

_task_recovery_title() {
	local status="$1"
	case "$status" in
		completed) echo "Task completed (recovered)" ;;
		failed) echo "Task failed (recovered)" ;;
		completed_stale) echo "Task reconciled (recovered)" ;;
		*) echo "Task recovered" ;;
	esac
}

_write_recovery_marker() {
	local task_id="$1"
	local status="$2"
	local exit_code="$3"
	local completed_at="$4"
	local reason="$5"
	local detail="$6"
	local marker="/tmp/oste-complete-${task_id}"

	cat >"$marker" <<-EOF
		status=${status}
		exit_code=${exit_code}
		completed_at=${completed_at}
		task_id=${task_id}
		recovery_reason=${reason}
		recovery_detail=${detail}
		recovery_source=oste-reaper
	EOF
}

_resolve_complete_script() {
	local candidate=""
	for candidate in \
		"${OSTE_COMPLETE_SCRIPT:-}" \
		"${SCRIPT_DIR}/oste-complete.sh" \
		"${SCRIPT_DIR}/../oste-complete.sh"; do
		[[ -n "$candidate" ]] || continue
		if [[ -x "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done
	return 1
}

_complete_from_receipt_if_possible() {
	local task_id="$1"
	local receipt_exit="$2"
	local complete_script=""
	complete_script=$(_resolve_complete_script) || return 1

	bash "$complete_script" "$task_id" "$receipt_exit" >/dev/null 2>&1 || return 1

	local current_status=""
	if [[ -f "${TASKS_FILE:-}" ]]; then
		current_status=$(jq -r --arg id "$task_id" '.tasks[$id].status // ""' "$TASKS_FILE" 2>/dev/null || true)
	fi
	if [[ -f "/tmp/oste-complete-${task_id}" || "$current_status" != "running" ]]; then
		return 0
	fi
	return 1
}

_reap_finalize_task() {
	local task_id="$1"
	local session_id="$2"
	local terminal_backend="$3"
	local target_status="$4"
	local exit_code="$5"
	local completed_at="$6"
	local reason="$7"
	local detail="$8"
	local notify="${9:-true}"

	local project_dir=""
	local project_name=""
	local backend=""
	local role=""
	project_dir=$(_task_json_field "$task_id" '.tasks[$id].project_dir // empty')
	project_name=$(_task_json_field "$task_id" '.tasks[$id].project_name // .tasks[$id].project // empty')
	backend=$(_task_json_field "$task_id" '.tasks[$id].agent_backend // empty')
	role=$(_task_json_field "$task_id" '.tasks[$id].role // empty')
	[[ -n "$completed_at" ]] || completed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	lock_tasks || return 1
	local current_status=""
	current_status=$(jq -r --arg id "$task_id" '.tasks[$id].status // ""' "$TASKS_FILE" 2>/dev/null || true)
	if [[ "$current_status" != "running" ]]; then
		unlock_tasks
		return 0
	fi

	local tmp
	tmp=$(mktemp)
	if jq --arg id "$task_id" \
		--arg status "$target_status" \
		--arg completed "$completed_at" \
		--arg exit_code "$exit_code" \
		--arg reason "$reason" \
		--arg detail "$detail" \
		'.tasks[$id].status = $status |
		 .tasks[$id].completed_at = $completed |
		 .tasks[$id].exit_code = ($exit_code | tonumber) |
		 .tasks[$id].recovery_reason = (if $reason == "" then null else $reason end) |
		 .tasks[$id].recovery_detail = (if $detail == "" then null else $detail end) |
		 .tasks[$id].error = (if $status == "failed" then (if $reason == "" then "stale_session" else $reason end) elif $reason == "duplicate_session_replaced" then $reason else .tasks[$id].error end)' \
		"$TASKS_FILE" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$TASKS_FILE"
	else
		rm -f "$tmp"
		unlock_tasks
		return 1
	fi
	unlock_tasks

	if [[ "$notify" == "true" ]]; then
		_write_recovery_marker "$task_id" "$target_status" "$exit_code" "$completed_at" "$reason" "$detail"

		if [[ "${OSTE_TEST_MODE:-}" != "1" ]] || [[ -n "${OSTE_PENDING_REVIEW_DIR:-}" ]]; then
			# shellcheck source=lib/pending-review.sh
			source "${SCRIPT_DIR}/lib/pending-review.sh"
			local last_commit=""
			local agent_summary=""
			local last_message_file="/tmp/oste-last-message-${task_id}"
			if [[ -n "$project_dir" && -d "$project_dir" ]]; then
				last_commit=$(git -C "$project_dir" log -1 --format="%H" 2>/dev/null || true)
			fi
			if [[ -f "$last_message_file" ]]; then
				agent_summary=$(cat "$last_message_file" 2>/dev/null || true)
			fi
			pending_review_write "$task_id" "$target_status" "$exit_code" "$completed_at" \
				"$project_name" "$project_dir" "$last_commit" "$agent_summary" || true
		fi

		if [[ "${OSTE_TEST_MODE:-}" != "1" ]]; then
			local notify_script="${OSTE_NOTIFY_SCRIPT:-${SCRIPT_DIR}/../oste-notify.sh}"
			if [[ -f "$notify_script" ]]; then
				local notify_title notify_message
				notify_title=$(_task_recovery_title "$target_status")
				notify_message=$(_task_recovery_notify_message "$task_id" "$target_status" "$reason" "$detail" "$exit_code")
				bash "$notify_script" \
					--kind "$target_status" \
					--task-id "$task_id" \
					--project-path "$project_dir" \
					--session-id "$session_id" \
					--backend "${backend:-$terminal_backend}" \
					--role "$role" \
					--title "$notify_title" \
					--message "$notify_message" \
					--exit-code "$exit_code" \
					--source oste-reaper >/dev/null 2>&1 || true
			fi
		fi
	fi

	rm -f "/tmp/oste-receipt-${task_id}" 2>/dev/null || true
	rm -f "/tmp/oste-pid-${task_id}" 2>/dev/null || true
	return 0
}

# Check if a task's process is genuinely alive.
# Returns 0 if process is alive, 1 if dead/stale.
is_task_process_alive() {
	local task_id="$1"
	local session_id="$2"
	local terminal_backend="$3"
	local base_alive=false
	local persist_socket=""
	local tmux_socket=""
	local tmux_conf=""
	local tmux_pane_id=""
	local tmux_window_id=""
	local receipt_path="/tmp/oste-receipt-${task_id}"

	_reset_reaper_dead_reason
	persist_socket=$(_resolve_task_persist_socket "$task_id" "$session_id" || echo "")
	tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session_id" || echo "")
	tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session_id" || echo "")
	if [[ -n "${TASKS_FILE:-}" && -f "$TASKS_FILE" ]]; then
		tmux_pane_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_pane_id // empty' "$TASKS_FILE" 2>/dev/null || echo "")
		tmux_window_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_window_id // empty' "$TASKS_FILE" 2>/dev/null || echo "")
	fi

	# Layer 1: Check completion marker or wrapper receipt (definitive proof
	# that the launcher-owned agent process has exited). A live terminal window
	# after this point is just the human-visible shell surface, not task liveness.
	if [[ -f "/tmp/oste-complete-${task_id}" ]]; then
		REAPER_LAST_DEAD_REASON="completion_marker"
		REAPER_LAST_DEAD_DETAIL="missing_tasks_update"
		return 1
	fi
	if [[ -f "$receipt_path" ]]; then
		REAPER_LAST_DEAD_REASON="completion_receipt"
		REAPER_LAST_DEAD_DETAIL="wrapper_receipt"
		return 1
	fi

	# Layer 1.5: PID file liveness check
	# The agent subshell writes its PID to /tmp/oste-pid-{task_id} at start.
	# If the PID is alive, the agent is definitely running (strong positive).
	# If the PID is dead, the agent has exited — but the completion handler
	# may still be running, so we fall through to let other layers decide.
	local pid_file="/tmp/oste-pid-${task_id}"
	if [[ -f "$pid_file" ]]; then
		local agent_pid
		agent_pid=$(cat "$pid_file" 2>/dev/null || echo "")
		if [[ -n "$agent_pid" ]] && [[ "$agent_pid" =~ ^[0-9]+$ ]]; then
			if kill -0 "$agent_pid" 2>/dev/null; then
				return 0 # Agent subshell is alive
			fi
			# PID dead: agent exited. If no receipt file exists either,
			# the completion handler likely also failed — strong stale signal.
			# Skip the terminal session check (terminal may linger at prompt)
			# and go straight to stream freshness as a last-resort tiebreaker.
			if [[ ! -f "$receipt_path" ]]; then
				# Jump directly to stream freshness (Layer 3) — don't let
				# a lingering terminal session mask a dead agent.
				local stream_file=""
				stream_file=$(_resolve_task_stream_file "$task_id" || echo "")
				if [[ -f "$stream_file" ]]; then
					local last_modified now age
					last_modified=$(stat -f %m "$stream_file" 2>/dev/null) || return 1
					now=$(date +%s)
					age=$((now - last_modified))
					local fresh_seconds="${OSTE_REAPER_STREAM_FRESH_SECONDS:-600}"
					[[ "$fresh_seconds" =~ ^[0-9]+$ ]] || fresh_seconds=600
					if [[ $age -lt $fresh_seconds ]]; then
						return 0 # Stream still fresh — give benefit of doubt
					fi
				fi
				REAPER_LAST_DEAD_REASON="dead_pid"
				REAPER_LAST_DEAD_DETAIL="missing_receipt"
				return 1 # PID dead + no receipt + stale/missing stream = dead
			fi
			# Receipt exists but no completion marker — completion handler
			# may be in progress. Fall through to terminal/stream checks.
		fi
	fi

	# Layer 2: Check terminal session existence
	local persist_bin=""
	persist_bin=$(_persist_bin_path || echo "")
	if [[ -n "$persist_socket" ]] && [[ -x "$persist_bin" ]] && "$persist_bin" -s "$persist_socket" &>/dev/null; then
		return 0
	fi

	case "$terminal_backend" in
		persist)
			# Pod member fallback: if base session is alive, defer to stream
			# freshness (Layer 3) rather than assuming the pod member is alive.
			# The base session being alive does NOT prove the pod member is alive —
			# it may have exited while the lead agent continues.
			local base_session
			base_session=$(_derive_base_session "$session_id")
			if [[ "$base_session" != "$session_id" ]]; then
				local base_sock
				base_sock=$(_default_persist_socket_path "$base_session" || echo "")
				if [[ -x "$persist_bin" ]] && "$persist_bin" -s "$base_sock" &>/dev/null; then
					base_alive=true
				fi
			fi
			;;
		tmux)
			local explicit_tmux_target=false
			local target_identity=""

			if [[ -n "$tmux_pane_id" ]]; then
				explicit_tmux_target=true
				target_identity=$(_tmux_target_identity_on_socket "$tmux_socket" "$tmux_conf" "$tmux_pane_id" || echo "")
				if [[ -n "$target_identity" ]]; then
					if _tmux_identity_matches_expected "$target_identity" "$session_id" "$tmux_window_id" "$tmux_pane_id"; then
						return 0
					fi
					REAPER_LAST_DEAD_REASON="tmux_owner_mismatch"
					REAPER_LAST_DEAD_DETAIL=$(_tmux_owner_mismatch_detail "$tmux_pane_id" "$target_identity")
					return 1
				fi
			fi

			if [[ -n "$tmux_window_id" ]]; then
				explicit_tmux_target=true
				target_identity=$(_tmux_target_identity_on_socket "$tmux_socket" "$tmux_conf" "$tmux_window_id" || echo "")
				if [[ -n "$target_identity" ]]; then
					if _tmux_identity_matches_expected "$target_identity" "$session_id" "$tmux_window_id" ""; then
						return 0
					fi
					REAPER_LAST_DEAD_REASON="tmux_owner_mismatch"
					REAPER_LAST_DEAD_DETAIL=$(_tmux_owner_mismatch_detail "$tmux_window_id" "$target_identity")
					return 1
				fi
			fi

			if [[ "$explicit_tmux_target" == true ]]; then
				REAPER_LAST_DEAD_REASON="dead_tmux_target"
				if [[ ! -f "$receipt_path" ]]; then
					REAPER_LAST_DEAD_DETAIL="missing_receipt"
				fi
			else
				if tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$session_id"; then
					return 0
				fi
				REAPER_LAST_DEAD_REASON="dead_tmux_target"
				if [[ ! -f "$receipt_path" ]]; then
					REAPER_LAST_DEAD_DETAIL="missing_receipt"
				fi
				cleanup_dead_tmux_socket_path "$tmux_socket" "$tmux_conf" 2>/dev/null || true
				# Pod member fallback: if base session is alive, defer to stream
				# freshness (Layer 3) rather than assuming the pod member is alive.
				local base_session
				base_session=$(_derive_base_session "$session_id")
				if [[ "$base_session" != "$session_id" ]]; then
					if tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$base_session"; then
						base_alive=true
					fi
				fi
			fi
			;;
		applescript)
			# AppleScript sessions tracked via JSON map — verify the bundle app is still running
			local map_file="/tmp/ghostty-terminals.json"
			if [[ -f "$map_file" ]] && jq -e --arg s "$session_id" '.[$s]' "$map_file" &>/dev/null; then
				local _as_bid
				_as_bid=$(jq -r --arg s "$session_id" '.[$s].bundle_id // empty' "$map_file")
				if [[ -n "$_as_bid" ]] && osascript -e "application id \"$_as_bid\" is running" 2>/dev/null | grep -q "true"; then
					return 0
				fi
				# Bundle not running — stale entry, fall through to stream check
			fi
			;;
	esac

	# Layer 3: Check stream file freshness (last resort)
	local stream_file=""
	stream_file=$(_resolve_task_stream_file "$task_id" || echo "")
	if [[ -f "$stream_file" ]]; then
		local last_modified now age
		last_modified=$(stat -f %m "$stream_file" 2>/dev/null) || return 1
		now=$(date +%s)
		age=$((now - last_modified))
		# If stream was updated recently, likely still alive.
		# Keep this conservative to avoid reaping long-running live tasks.
		local fresh_seconds="${OSTE_REAPER_STREAM_FRESH_SECONDS:-600}"
		[[ "$fresh_seconds" =~ ^[0-9]+$ ]] || fresh_seconds=600
		if [[ $age -lt $fresh_seconds ]]; then
			return 0
		fi
	fi

	if [[ -z "$REAPER_LAST_DEAD_REASON" ]]; then
		REAPER_LAST_DEAD_REASON="dead_stream"
		if [[ ! -f "$receipt_path" ]]; then
			REAPER_LAST_DEAD_DETAIL="missing_receipt"
		fi
	fi

	# Base session alive but no direct liveness proof for this role-suffixed
	# session. Keep this classified as dead unless a fresh stream exists.
	# This allows stale pod members to be reaped while preserving live members
	# via the stream freshness signal above.
	if [[ "$base_alive" == true ]]; then
		return 1
	fi

	# No evidence of life
	return 1
}

# Find and optionally fix stale 'running' tasks in tasks.json.
# Returns the number of stale tasks found.
reap_stale_tasks() {
	local do_update="$1" # "true" to actually update tasks.json

	[[ -f "$TASKS_FILE" ]] || return 0

	local stale_count=0
	local task_ids
	task_ids=$(jq -r '[.tasks[] | select(.status == "running")] | .[].id' "$TASKS_FILE" 2>/dev/null) || return 0

	# Session collision rule: if multiple running tasks share one session_id,
	# only the newest running task stays running. Older ones are stale.
	local duplicate_ids=""
	duplicate_ids=$(jq -r '
		[.tasks[] | select(.status == "running" and ((.session_id // "") != ""))]
		| map(. + {
			duplicate_key: (
				if (.tmux_window_id // "") != "" then
					((.tmux_socket // "") + "|" + (.session_id // "") + "|" + (.tmux_window_id // ""))
				else
					(.session_id // "")
				end
			)
		})
		# Tie-break order: duplicate_key + started_at + id.
		# On equal timestamps, lexicographically higher id wins (last entry stays running).
		| sort_by((.duplicate_key // ""), (.started_at // ""), (.id // ""))
		| group_by(.duplicate_key)
		| map(select(length > 1) | .[0:-1] | .[].id)
		| .[]?
	' "$TASKS_FILE" 2>/dev/null || true)

	# shellcheck source=lib/tasks-lock.sh
	source "${SCRIPT_DIR}/lib/tasks-lock.sh"

	while IFS= read -r task_id; do
		[[ -n "$task_id" ]] || continue

		local session_id terminal_backend
		session_id=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // ""' "$TASKS_FILE" 2>/dev/null)
		terminal_backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // "tmux"' "$TASKS_FILE" 2>/dev/null)

		local duplicate_stale=false
		if [[ -n "$duplicate_ids" ]] && echo "$duplicate_ids" | grep -Fxq "$task_id"; then
			duplicate_stale=true
		fi

		# Without a session id, pid, receipt, or completion marker, the reaper has
		# no process-level proof that a task is dead. Leave that state running so
		# deterministic artifact/report predicates can decide truthfully.
		if [[ -z "$session_id" && ! -f "/tmp/oste-pid-${task_id}" && ! -f "/tmp/oste-receipt-${task_id}" && ! -f "/tmp/oste-complete-${task_id}" ]]; then
			continue
		fi

		if [[ "$duplicate_stale" == true ]] || ! is_task_process_alive "$task_id" "$session_id" "$terminal_backend"; then
			stale_count=$((stale_count + 1))

			if [[ "$do_update" == "true" ]]; then
				local receipt="/tmp/oste-receipt-${task_id}"
				local marker="/tmp/oste-complete-${task_id}"
				local receipt_exit="-1"
				local target_status="failed"
				local recovered=false
				local recovery_reason=""
				local recovery_detail=""
				local completed_at=""
				local should_notify=true

				if [[ "$duplicate_stale" == true ]]; then
					target_status="completed_stale"
					recovery_reason="duplicate_session_replaced"
					recovery_detail="superseded_by_newer_task"
					should_notify=false
				elif [[ -n "$REAPER_LAST_DEAD_REASON" ]]; then
					recovery_reason="$REAPER_LAST_DEAD_REASON"
					recovery_detail="$REAPER_LAST_DEAD_DETAIL"
				else
					recovery_reason="dead_stream"
					recovery_detail="missing_receipt"
				fi

				if [[ -f "$marker" ]]; then
					target_status=$(_marker_status "$marker")
					receipt_exit=$(_marker_exit_code "$marker")
					completed_at=$(_marker_completed_at "$marker")
					recovered=true
					if [[ -z "$recovery_reason" ]]; then
						recovery_reason="completion_marker"
						recovery_detail="missing_tasks_update"
					fi
				else
					if [[ -f "$receipt" ]]; then
						# Agent finished but completion handler failed — recover
						# through the same completion wrapper so git, pending-review,
						# report ingestion, notifications, and task state stay aligned.
						receipt_exit=$(_receipt_exit_code "$receipt")
						if _complete_from_receipt_if_possible "$task_id" "$receipt_exit"; then
							echo "Recovered stale task ${task_id}: delegated receipt finalization to oste-complete" >&2
							continue
						fi
						target_status="completed"
						[[ "$receipt_exit" != "0" ]] && target_status="failed"
						completed_at=$(_receipt_finished_at "$receipt")
						recovered=true
					fi
				fi

				[[ -n "$completed_at" ]] || completed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
				local persist_socket
				local tmux_socket
				local tmux_conf
				persist_socket=$(_resolve_task_persist_socket "$task_id" "$session_id" || echo "")
				tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session_id" || echo "")
				tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session_id" || echo "")
				cleanup_dead_persist_socket_path "$persist_socket" "$session_id" 2>/dev/null || true
				cleanup_dead_tmux_socket_path "$tmux_socket" "$tmux_conf" 2>/dev/null || true
				_reap_finalize_task "$task_id" "$session_id" "$terminal_backend" \
					"$target_status" "$receipt_exit" "$completed_at" \
					"$recovery_reason" "$recovery_detail" "$should_notify" || continue
				if [[ "$duplicate_stale" == true ]]; then
					echo "Reaped duplicate running session: ${task_id} (session: ${session_id})" >&2
				elif [[ "$recovered" == true ]]; then
					echo "Recovered stale task ${task_id}: ${target_status} (reason: ${recovery_reason}, exit=${receipt_exit})" >&2
				else
					echo "Reaped dead task ${task_id}: ${target_status} (reason: ${recovery_reason})" >&2
				fi
			else
				echo "Warning: stale task '${task_id}' (session: ${session_id}, backend: ${terminal_backend}) — no live process found" >&2
			fi
		fi
	done <<<"$task_ids"

	return "$stale_count"
}

# Detect completed/failed tasks whose terminal sessions are still alive.
# These orphaned terminals sit at a bare shell prompt after the agent exits,
# which makes the active surface look noisier and less truthful.
# Returns the number of orphaned terminals via exit code.
# Args:
#   $1 — do_cleanup: "true" to kill orphaned terminals, "false" to report only.
detect_orphaned_terminals() {
	local do_cleanup="${1:-false}"

	[[ -f "$TASKS_FILE" ]] || return 0

	local orphan_count=0
	local terminal_statuses="completed|failed|completed_dirty|contract_failure|completed_stale|stopped|killed"
	local task_ids
	task_ids=$(jq -r --arg statuses "$terminal_statuses" \
		'[.tasks[] | select(.status as $s | $statuses | split("|") | index($s))] | .[].id' \
		"$TASKS_FILE" 2>/dev/null) || return 0

	while IFS= read -r task_id; do
		[[ -n "$task_id" ]] || continue

		local session_id terminal_backend exec_visible
		session_id=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // ""' "$TASKS_FILE" 2>/dev/null)
		terminal_backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // "tmux"' "$TASKS_FILE" 2>/dev/null)
		exec_visible=$(jq -r --arg id "$task_id" '.tasks[$id].exec_visible // false' "$TASKS_FILE" 2>/dev/null)

		[[ -n "$session_id" ]] || continue

		local session_alive=false

		case "$terminal_backend" in
			persist)
				local persist_socket=""
				persist_socket=$(_resolve_task_persist_socket "$task_id" "$session_id" || echo "")
				local persist_bin=""
				persist_bin=$(_persist_bin_path || echo "")
				if [[ -n "$persist_socket" ]] && [[ -x "$persist_bin" ]] && "$persist_bin" -s "$persist_socket" &>/dev/null; then
					session_alive=true
				fi
				;;
			tmux)
				local tmux_socket="" tmux_conf=""
				tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session_id" || echo "")
				tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session_id" || echo "")
				if tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$session_id"; then
					session_alive=true
				fi
				;;
			applescript)
				local map_file="/tmp/ghostty-terminals.json"
				if [[ -f "$map_file" ]] && jq -e --arg s "$session_id" '.[$s]' "$map_file" &>/dev/null; then
					local _as_bid
					_as_bid=$(jq -r --arg s "$session_id" '.[$s].bundle_id // empty' "$map_file")
					if [[ -n "$_as_bid" ]] && osascript -e "application id \"$_as_bid\" is running" 2>/dev/null | grep -q "true"; then
						session_alive=true
					fi
				fi
				;;
		esac

		if [[ "$session_alive" == true ]]; then
			orphan_count=$((orphan_count + 1))
			local task_status
			task_status=$(jq -r --arg id "$task_id" '.tasks[$id].status // "unknown"' "$TASKS_FILE" 2>/dev/null)

			if [[ "$do_cleanup" == "true" ]]; then
				case "$terminal_backend" in
					persist)
						local persist_socket=""
						persist_socket=$(_resolve_task_persist_socket "$task_id" "$session_id" || echo "")
						if [[ -n "$persist_socket" ]]; then
							local persist_bin=""
							persist_bin=$(_persist_bin_path || echo "")
							if [[ -x "$persist_bin" ]]; then
								"$persist_bin" -k "$persist_socket" &>/dev/null || true
							fi
							rm -f "$persist_socket" 2>/dev/null || true
						fi
						;;
					tmux)
						local tmux_socket="" tmux_conf=""
						tmux_socket=$(_resolve_task_tmux_socket "$task_id" "$session_id" || echo "")
						tmux_conf=$(_resolve_task_tmux_conf "$task_id" "$session_id" || echo "")
						_tmux_socket_cmd "$tmux_socket" "$tmux_conf"
						"${TMUX_RUNTIME_CMD[@]}" kill-session -t "$session_id" 2>/dev/null || true
						;;
				esac
				echo "Cleaned orphaned terminal: ${task_id} (session: ${session_id}, status: ${task_status})" >&2
			else
				echo "Warning: orphaned terminal for completed task '${task_id}' (session: ${session_id}, status: ${task_status}, backend: ${terminal_backend}, visible: ${exec_visible})" >&2
			fi
		fi
	done <<<"$task_ids"

	return "$orphan_count"
}

# ── Child Process Cleanup ────────────────────────────────────────────
# Cleans up descendant processes left behind by a completed/failed agent.
#
# Two-phase approach:
#   Phase 1: If agent PID is still alive, walk the process tree via recursive
#            pgrep -P and collect descendants for termination.
#   Phase 2: Scan for orphaned processes (reparented to launchd, PPID=1) that
#            carry OSTE_TASK_ID=<task_id> in their inherited environment.
#
# Safety invariants:
#   - Never kills the calling process (oste-complete.sh) or its parent shell
#   - Never kills the terminal backend (tmux server, Ghostty, persist)
#   - Only targets processes with provable task affinity (env marker OR
#     direct descendant of the recorded agent PID)
#   - Idempotent: safe to call multiple times for the same task_id

_collect_descendant_pids() {
	local parent_pid="$1"
	shift
	local exclude_list="$*"

	local children
	children=$(pgrep -P "$parent_pid" 2>/dev/null || true)
	[[ -n "$children" ]] || return 0

	local child
	while IFS= read -r child; do
		[[ -n "$child" ]] || continue
		local skip=false
		local ep
		for ep in $exclude_list; do
			[[ "$child" == "$ep" ]] && {
				skip=true
				break
			}
		done
		[[ "$skip" == true ]] && continue
		# Recurse into grandchildren first (bottom-up collection)
		_collect_descendant_pids "$child" "$exclude_list"
		echo "$child"
	done <<<"$children"
}

_find_task_orphans_by_env() {
	local task_id="$1"
	shift
	local exclude_list="$*"
	local env_marker="OSTE_TASK_ID=${task_id}"

	# Single `ps eww` pass over the user's process table. A per-PID
	# `ps eww -p` probe loop forks once per PPID=1 process — seconds of
	# completion latency on a busy host (~3s observed at ~600 orphans) —
	# making callers O(process count) and flaking time-bounded paths.
	# macOS: the `e` flag appends each same-user process's environment to
	# the command column, so the marker match sees the same data the old
	# per-PID probe did.
	local pid ppid cmd_env
	while read -r pid ppid cmd_env; do
		# Only target processes reparented to launchd (PPID=1).
		# Processes with a living parent are either the terminal shell
		# itself or something the user started after the agent exited.
		[[ "$ppid" == "1" ]] || continue
		[[ -n "$pid" ]] || continue
		[[ "$pid" =~ ^[0-9]+$ ]] || continue

		local skip=false
		local ep
		for ep in $exclude_list; do
			[[ "$pid" == "$ep" ]] && {
				skip=true
				break
			}
		done
		[[ "$skip" == true ]] && continue

		# Fixed-string match — same semantics as the previous grep -qF.
		[[ "$cmd_env" == *"$env_marker"* ]] || continue

		echo "$pid"
		# Also collect descendants of this orphan (they may not be PPID=1)
		_collect_descendant_pids "$pid" "$exclude_list"
	done < <(ps eww -U "$(id -u)" -o pid=,ppid=,command= 2>/dev/null || true)
}

_terminate_pid_list() {
	local grace="$1"
	shift
	[[ $# -gt 0 ]] || return 0

	local pid
	for pid in "$@"; do
		kill -TERM "$pid" 2>/dev/null || true
	done

	sleep "$grace"

	for pid in "$@"; do
		kill -0 "$pid" 2>/dev/null || continue
		kill -KILL "$pid" 2>/dev/null || true
	done
}

cleanup_task_descendants() {
	local task_id="$1"
	local grace="${OSTE_CLEANUP_GRACE_SECONDS:-2}"
	local pid_file="/tmp/oste-pid-${task_id}"
	local agent_pid=""
	local -a target_pids=()

	local my_pid=$$
	local my_ppid=$PPID

	# Phase 1: If agent PID is still alive, enumerate its full descendant tree
	if [[ -f "$pid_file" ]]; then
		agent_pid=$(cat "$pid_file" 2>/dev/null || true)
		if [[ -n "$agent_pid" ]] && [[ "$agent_pid" =~ ^[0-9]+$ ]] && kill -0 "$agent_pid" 2>/dev/null; then
			local desc
			while IFS= read -r desc; do
				[[ -n "$desc" ]] || continue
				target_pids+=("$desc")
			done < <(_collect_descendant_pids "$agent_pid" "$my_pid $my_ppid")
		fi
	fi

	# Phase 2: Find orphaned processes via OSTE_TASK_ID env marker
	local orphan
	while IFS= read -r orphan; do
		[[ -n "$orphan" ]] || continue
		# De-duplicate against Phase 1 results
		local already=false
		local t
		for t in "${target_pids[@]+"${target_pids[@]}"}"; do
			[[ "$orphan" == "$t" ]] && {
				already=true
				break
			}
		done
		[[ "$already" == true ]] && continue
		target_pids+=("$orphan")
	done < <(_find_task_orphans_by_env "$task_id" "$my_pid $my_ppid")

	if [[ ${#target_pids[@]} -eq 0 ]]; then
		return 0
	fi

	echo "Cleaning up ${#target_pids[@]} descendant process(es) for task ${task_id}: ${target_pids[*]}" >&2
	_terminate_pid_list "$grace" "${target_pids[@]}"
	return 0
}
