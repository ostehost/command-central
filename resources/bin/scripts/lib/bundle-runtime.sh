#!/bin/bash
# lib/bundle-runtime.sh — Runtime probes for Ghostty project bundles

# shellcheck source=project-bundle-open.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/project-bundle-open.sh"

bundle_process_is_running() {
	local bundle_id="$1"
	[[ -n "$bundle_id" ]] || return 1
	osascript -e "application id \"$bundle_id\" is running" 2>/dev/null | grep -q "true"
}

bundle_window_count() {
	local bundle_id="$1"
	[[ -n "$bundle_id" ]] || {
		echo "0"
		return 1
	}

	local count
	count=$(osascript -e "tell application id \"$bundle_id\" to count of windows" 2>/dev/null) || {
		echo "0"
		return 1
	}

	echo "${count:-0}"
}

bundle_honest_visibility() {
	local bundle_id="$1"
	if ! bundle_process_is_running "$bundle_id"; then
		echo "false"
		return 1
	fi

	local count
	count=$(bundle_window_count "$bundle_id") || {
		echo "false"
		return 1
	}

	if [[ "$count" -gt 0 ]]; then
		echo "true"
	else
		echo "false"
		return 1
	fi
}

bundle_read_identifier() {
	local bundle_path="$1"
	local plist="${bundle_path}/Contents/Info.plist"
	[[ -f "$plist" ]] || return 1
	/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$plist" 2>/dev/null
}

probe_bundle_runtime() {
	local bundle_id="$1"
	local session_id="$2"
	local backend="${3:-tmux}"
	local tmux_socket="${4:-}"
	local tmux_conf="${5:-}"

	local process_alive="false"
	local window_count=0
	local session_alive="false"
	local honest_visible="false"

	if bundle_process_is_running "$bundle_id"; then
		process_alive="true"
		window_count=$(bundle_window_count "$bundle_id")
	fi

	case "$backend" in
		tmux)
			if [[ -n "$tmux_socket" ]] && [[ -n "$session_id" ]] && tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$session_id" 2>/dev/null; then
				session_alive="true"
			fi
			;;
		persist)
			if declare -F _persist_bin_path >/dev/null 2>&1 && declare -F persist_socket_path_for_session >/dev/null 2>&1; then
				local persist_bin sock
				persist_bin=$(_persist_bin_path || echo "")
				sock=$(persist_socket_path_for_session "$session_id" 2>/dev/null || echo "")
				if [[ -x "$persist_bin" ]] && [[ -n "$sock" ]] && "$persist_bin" -s "$sock" &>/dev/null; then
					session_alive="true"
				fi
			fi
			;;
	esac

	if [[ "$process_alive" == "true" ]] && [[ "$window_count" -gt 0 ]]; then
		honest_visible="true"
	fi

	echo "${process_alive}|${window_count}|${session_alive}|${honest_visible}"
}

kill_zombie_bundle() {
	local bundle_id="$1"
	local bundle_path="${2:-}"
	[[ -n "$bundle_id" ]] || return 0

	if ! bundle_process_is_running "$bundle_id"; then
		return 0
	fi

	local wcount
	wcount=$(bundle_window_count "$bundle_id")
	if [[ "$wcount" -gt 0 ]]; then
		return 1
	fi

	echo "Killing zombie Ghostty process for ${bundle_id} (running with 0 windows)" >&2
	osascript -e "tell application id \"$bundle_id\" to quit" 2>/dev/null || true
	sleep 1

	if bundle_process_is_running "$bundle_id"; then
		if [[ -n "$bundle_path" ]]; then
			pkill -f "$bundle_path" 2>/dev/null || true
		else
			pkill -f "CFBundleIdentifier.*${bundle_id}" 2>/dev/null || true
		fi
		sleep 1
	fi

	return 0
}

update_task_visibility() {
	local task_id="$1"
	local visible="$2"
	local tasks_file="${3:-${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}}"

	[[ -n "$task_id" ]] || return 1
	[[ -f "$tasks_file" ]] || return 1

	local tmp
	tmp=$(mktemp)
	if jq --arg id "$task_id" \
		--argjson vis "$visible" \
		'if .tasks[$id] then .tasks[$id].exec_visible = $vis else . end' \
		"$tasks_file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$tasks_file"
	else
		rm -f "$tmp"
		return 1
	fi
}

attach_bundle_session() {
	local task_id="$1"
	local tasks_file="${2:-${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}}"

	[[ -n "$task_id" ]] || {
		echo "error|missing_task_id"
		return 1
	}
	[[ -f "$tasks_file" ]] || {
		echo "error|tasks_file_not_found"
		return 1
	}

	local session_id bundle_path bundle_id backend tmux_socket tmux_conf
	session_id=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // ""' "$tasks_file" 2>/dev/null)
	bundle_path=$(jq -r --arg id "$task_id" '.tasks[$id].bundle_path // ""' "$tasks_file" 2>/dev/null)
	backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // "tmux"' "$tasks_file" 2>/dev/null)
	tmux_socket=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_socket // ""' "$tasks_file" 2>/dev/null)
	tmux_conf=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_conf // ""' "$tasks_file" 2>/dev/null)

	[[ -n "$session_id" ]] || {
		echo "error|no_session_id"
		return 1
	}
	[[ -n "$bundle_path" ]] || {
		echo "error|no_bundle_path"
		return 1
	}
	[[ -d "$bundle_path" ]] || {
		echo "error|bundle_not_found"
		return 1
	}

	bundle_id=$(bundle_read_identifier "$bundle_path" 2>/dev/null || echo "")
	[[ -n "$bundle_id" ]] || {
		echo "error|no_bundle_id"
		return 1
	}

	local session_alive=false
	case "$backend" in
		tmux)
			if [[ -n "$tmux_socket" ]] && tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$session_id" 2>/dev/null; then
				session_alive=true
			fi
			;;
		persist)
			if declare -F _persist_bin_path >/dev/null 2>&1 && declare -F persist_socket_path_for_session >/dev/null 2>&1; then
				local persist_bin sock
				persist_bin=$(_persist_bin_path || echo "")
				sock=$(persist_socket_path_for_session "$session_id" 2>/dev/null || echo "")
				if [[ -x "$persist_bin" ]] && [[ -n "$sock" ]] && "$persist_bin" -s "$sock" &>/dev/null; then
					session_alive=true
				fi
			fi
			;;
	esac

	if [[ "$session_alive" != "true" ]]; then
		echo "error|session_dead"
		update_task_visibility "$task_id" "false" "$tasks_file" || true
		return 1
	fi

	kill_zombie_bundle "$bundle_id" "$bundle_path" || true

	if ! pgrep -q WindowServer 2>/dev/null; then
		echo "error|no_gui_session"
		return 1
	fi

	open_project_bundle "$bundle_path"

	local waited=0
	local max_wait=10
	local visible=false
	while [[ $waited -lt $max_wait ]]; do
		sleep 1
		waited=$((waited + 1))
		local wcount
		wcount=$(bundle_window_count "$bundle_id")
		if [[ "$wcount" -gt 0 ]]; then
			visible=true
			break
		fi
	done

	if [[ "$visible" == "true" ]]; then
		update_task_visibility "$task_id" "true" "$tasks_file" || true
		echo "attached|window_visible_after_${waited}s"
		return 0
	else
		update_task_visibility "$task_id" "false" "$tasks_file" || true
		echo "failed|no_window_after_${max_wait}s"
		return 1
	fi
}
