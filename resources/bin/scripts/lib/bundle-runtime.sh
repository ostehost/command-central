#!/bin/bash
# lib/bundle-runtime.sh — Runtime probes for Ghostty project bundles

# shellcheck source=project-bundle-open.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/project-bundle-open.sh"

bundle_process_is_running() {
	local bundle_id="$1"
	[[ -n "$bundle_id" ]] || return 1
	osascript -e "application id \"$bundle_id\" is running" 2>/dev/null | grep -q "true"
}

# AX window observation via the shared oste-ui-observer service — the single
# Accessibility-granted identity (docs/UI-OBSERVER.md). Env seam:
# OSTE_UI_OBSERVER_BIN (default: the canonical installed binary at
# ~/.local/bin/oste-ui-observer). Fail-closed: an absent, unreachable, or
# malformed observer degrades — every path prints a well-formed 6-field line
# so a receipt always materializes; there is no osascript fallback.
#
# Task binding is corroborated by the SERVICE against its own canonical
# tasks.json: callers running with a divergent TASKS_FILE (isolated
# worktrees, fixtures) get task_binding_mismatch on bound probes by design —
# point OSTE_UI_OBSERVER_BIN at a mock (tests) or probe unbound.
bundle_window_probe() {
	local bundle_id="$1"
	local task_id="${2:-}"
	local task_generation="${3:-}"
	local release_generation="${4:-}"
	[[ -n "$bundle_id" ]] || {
		echo "false|0|0|0||missing_bundle_id"
		return 1
	}
	# Default to the canonical install path, not bare PATH lookup: spawn-time
	# probes can run under launchd/bundle environments whose PATH lacks
	# ~/.local/bin, and that must degrade only when the binary is truly absent.
	local observer_bin="${OSTE_UI_OBSERVER_BIN:-${HOME}/.local/bin/oste-ui-observer}"
	if ! command -v "$observer_bin" >/dev/null 2>&1; then
		echo "false|0|0|0||observer_unavailable"
		return 1
	fi
	local args=(probe --format pipe --bundle-id "$bundle_id")
	[[ -n "$task_id" ]] && args+=(--task-id "$task_id")
	[[ -n "$task_generation" ]] && args+=(--task-generation "$task_generation")
	[[ -n "$release_generation" ]] && args+=(--release-generation "$release_generation")
	local probe
	probe=$("$observer_bin" "${args[@]}" 2>/dev/null) || true
	# Bracket classes, not backslash-escaped pipes: macOS bash 3.2's regex
	# library does not treat \| as a literal pipe inside [[ =~ ]].
	local probe_re='^(true|false)[|][0-9]+[|][0-9]+[|][0-9]+[|][0-9]*[|][a-z0-9_]+$'
	if [[ ! "$probe" =~ $probe_re ]]; then
		echo "false|0|0|0||observer_bad_response"
		return 1
	fi
	echo "$probe"
	[[ "$probe" == true\|* ]]
}

bundle_window_count() {
	local bundle_id="$1"
	local process_alive window_count onscreen_count focusable_count pid reason
	IFS='|' read -r process_alive window_count onscreen_count focusable_count pid reason <<<"$(bundle_window_probe "$bundle_id" || true)"
	echo "${window_count:-0}"
	[[ "${process_alive:-false}" == "true" ]]
}

bundle_honest_visibility() {
	local bundle_id="$1"
	local process_alive window_count onscreen_count focusable_count pid reason
	IFS='|' read -r process_alive window_count onscreen_count focusable_count pid reason <<<"$(bundle_window_probe "$bundle_id" || true)"
	if [[ "${process_alive:-false}" == "true" && "${onscreen_count:-0}" -gt 0 && "${focusable_count:-0}" -gt 0 ]]; then
		echo "true"
		return 0
	fi
	echo "false"
	return 1
}

bundle_visibility_fields() {
	local task_id="$1"
	local tasks_file="${2:-${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}}"
	local verified=false degraded=true reason="unknown" bundle_id="" app_bundle="" bundle_path="" backend="" session_id="" tmux_socket="" tmux_conf="" tmux_pane_id="" tmux_window_id=""
	local tmux_attached=false process_alive=false window_count=0 onscreen_count=0 focusable_count=0 pid=""

	if [[ -z "$task_id" ]]; then
		echo "false|true|missing_task_id|$tasks_file||false|0|0|false|"
		return 1
	fi
	if [[ ! -f "$tasks_file" ]]; then
		echo "false|true|tasks_file_missing|$tasks_file||false|0|0|false|"
		return 1
	fi
	if [[ "$(jq -r --arg id "$task_id" 'if (.tasks[$id] != null) then "yes" else "no" end' "$tasks_file" 2>/dev/null || echo no)" != "yes" ]]; then
		echo "false|true|task_not_found|$tasks_file||false|0|0|false|"
		return 1
	fi

	bundle_id=$(jq -r --arg id "$task_id" '.tasks[$id].ghostty_bundle_id // empty' "$tasks_file" 2>/dev/null || true)
	app_bundle=$(jq -r --arg id "$task_id" '.tasks[$id].app_bundle // empty' "$tasks_file" 2>/dev/null || true)
	bundle_path=$(jq -r --arg id "$task_id" '.tasks[$id].bundle_path // empty' "$tasks_file" 2>/dev/null || true)
	backend=$(jq -r --arg id "$task_id" '.tasks[$id].terminal_backend // empty' "$tasks_file" 2>/dev/null || true)
	session_id=$(jq -r --arg id "$task_id" '.tasks[$id].session_id // empty' "$tasks_file" 2>/dev/null || true)
	tmux_socket=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_socket // empty' "$tasks_file" 2>/dev/null || true)
	tmux_conf=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_conf // empty' "$tasks_file" 2>/dev/null || true)
	tmux_pane_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_pane_id // empty' "$tasks_file" 2>/dev/null || true)
	tmux_window_id=$(jq -r --arg id "$task_id" '.tasks[$id].tmux_window_id // empty' "$tasks_file" 2>/dev/null || true)

	if [[ -z "$bundle_id" && "$app_bundle" == dev.partnerai.ghostty.* ]]; then
		bundle_id="$app_bundle"
	fi
	if [[ -z "$bundle_id" ]]; then
		reason="no_bundle_id"
		echo "false|true|$reason|$tasks_file||false|0|0|false|"
		return 1
	fi
	if [[ -n "$app_bundle" && "$app_bundle" == dev.partnerai.ghostty.* && "$app_bundle" != "$bundle_id" ]]; then
		reason="app_bundle_mismatch"
		echo "false|true|$reason|$tasks_file|$bundle_id|false|0|0|false|"
		return 1
	fi
	if [[ -n "$bundle_path" && -d "$bundle_path" ]]; then
		local plist_bundle
		plist_bundle=$(bundle_read_identifier "$bundle_path" 2>/dev/null || true)
		if [[ -n "$plist_bundle" && "$plist_bundle" != "$bundle_id" ]]; then
			reason="bundle_path_id_mismatch"
			echo "false|true|$reason|$tasks_file|$bundle_id|false|0|0|false|"
			return 1
		fi
	fi

	case "$backend" in
		tmux)
			local target="${tmux_pane_id:-${tmux_window_id:-$session_id}}"
			if [[ -n "$target" && -n "$tmux_socket" ]] && declare -F tmux_target_exists_on_socket >/dev/null 2>&1 && tmux_target_exists_on_socket "$tmux_socket" "$tmux_conf" "$target" 2>/dev/null; then
				# tmux_attached must mean a live client is displaying the
				# target, not merely that the target exists on the socket.
				if ! declare -F tmux_target_has_attached_client_on_socket >/dev/null 2>&1; then
					tmux_attached=true
				elif tmux_target_has_attached_client_on_socket "$tmux_socket" "$tmux_conf" "$target" 2>/dev/null; then
					tmux_attached=true
				else
					reason="tmux_no_attached_clients"
				fi
			else
				reason="tmux_target_missing"
			fi
			;;
		persist | applescript | "")
			tmux_attached=true
			;;
		*)
			reason="unknown_backend"
			;;
	esac

	# Server-side lane binding context: the observer corroborates the claim
	# against the canonical row. task_generation is the row's immutable
	# registration UUID; app_stamp.git_sha travels separately as the optional
	# release_generation diagnostic — never cross-compared. A row without a
	# generation gets an unbound (bundle-only) observation instead of a
	# guaranteed mismatch; this function has already verified row identity.
	local row_task_generation row_release_generation probe_task_id
	row_task_generation=$(jq -r --arg id "$task_id" '.tasks[$id].task_generation // empty' "$tasks_file" 2>/dev/null || true)
	row_release_generation=$(jq -r --arg id "$task_id" '.tasks[$id].app_stamp.git_sha // empty' "$tasks_file" 2>/dev/null || true)
	probe_task_id="$task_id"
	[[ -n "$row_task_generation" ]] || probe_task_id=""

	local probe_reason=""
	IFS='|' read -r process_alive window_count onscreen_count focusable_count pid probe_reason <<<"$(bundle_window_probe "$bundle_id" "$probe_task_id" "$row_task_generation" "$row_release_generation" || true)"
	# reason=="ok" is required locally, not just implied by counts: a probe
	# line carrying positive counts under any other token must never verify.
	if [[ "$tmux_attached" == "true" && "${process_alive:-false}" == "true" && "${onscreen_count:-0}" -gt 0 && "${focusable_count:-0}" -gt 0 && "${probe_reason:-}" == "ok" ]]; then
		verified=true
		degraded=false
		reason="ok"
	elif [[ "$reason" == "unknown" ]]; then
		reason="${probe_reason:-visibility_not_verified}"
	fi

	echo "${verified}|${degraded}|${reason}|${tasks_file}|${bundle_id}|${tmux_attached}|${focusable_count:-0}|${onscreen_count:-0}|${process_alive:-false}|${pid:-}"
	[[ "$verified" == "true" ]]
}

bundle_visibility_receipt() {
	local task_id="$1"
	local tasks_file="${2:-${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}}"
	local verified degraded reason resolved_tasks_file bundle_id tmux_attached focusable_count onscreen_count process_alive pid
	IFS='|' read -r verified degraded reason resolved_tasks_file bundle_id tmux_attached focusable_count onscreen_count process_alive pid <<<"$(bundle_visibility_fields "$task_id" "$tasks_file" || true)"
	# Spawn-time launcher app generation recorded on the row (visible lanes only).
	# Carry it into the receipt so consumers can decide reuse/rebuild from the
	# receipt alone, without re-reading tasks.json on the writer host.
	local app_stamp="null"
	if [[ -f "$tasks_file" ]]; then
		app_stamp=$(jq -c --arg id "$task_id" '.tasks[$id].app_stamp // null' "$tasks_file" 2>/dev/null || echo "null")
	fi
	jq -e 'type == "object" or . == null' >/dev/null 2>&1 <<<"$app_stamp" || app_stamp="null"
	jq -n \
		--arg task_id "$task_id" \
		--arg tasks_file "$resolved_tasks_file" \
		--arg bundle_id "$bundle_id" \
		--arg reason "${reason:-unknown}" \
		--arg pid "${pid:-}" \
		--argjson app_stamp "$app_stamp" \
		--argjson verified "${verified:-false}" \
		--argjson degraded "${degraded:-true}" \
		--argjson tmux_attached "${tmux_attached:-false}" \
		--argjson focusable_windows "${focusable_count:-0}" \
		--argjson onscreen_windows "${onscreen_count:-0}" \
		--argjson process_alive "${process_alive:-false}" \
		'{task_id:$task_id,tasks_file:$tasks_file,bundle_id:$bundle_id,verified:$verified,degraded:$degraded,reason:$reason,tmux_attached:$tmux_attached,process_alive:$process_alive,focusable_windows:$focusable_windows,onscreen_windows:$onscreen_windows,pid:(if $pid == "" then null else ($pid|tonumber) end),generation:{app_stamp:$app_stamp,release_generation:($app_stamp.git_sha // null),source_version:($app_stamp.launcher_version // null)}}'
}

# Persist the spawn-time visibility receipt path + degraded state into the
# durable tasks.json row. register_task() runs BEFORE the receipt exists (the
# probe reads the registered row), so the durable row would otherwise keep
# visibility_receipt_path=null while only the /tmp exec receipt and spawn stdout
# carried it. This is the canonical cross-host visibility truth the lanes
# projection and release gate both read.
#
# Serializes through the authoritative tasks lock when tasks-lock.sh is sourced
# (spawn path), and degrades to a best-effort atomic write otherwise (unit tests
# that source bundle-runtime.sh alone). Fail-soft: always returns 0 and never
# corrupts tasks.json.
persist_task_visibility_receipt() {
	local task_id="$1"
	local receipt_path="$2"
	local receipt_json="$3"
	local tasks_file="${4:-${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}}"

	[[ -n "$task_id" ]] || return 0
	[[ -f "$tasks_file" ]] || return 0
	[[ -n "$receipt_json" ]] || return 0
	jq -e 'type == "object"' >/dev/null 2>&1 <<<"$receipt_json" || return 0

	local verified degraded reason
	verified=$(jq -r '.verified // false' <<<"$receipt_json" 2>/dev/null || echo false)
	degraded=$(jq -r '.degraded // true' <<<"$receipt_json" 2>/dev/null || echo true)
	reason=$(jq -r '.reason // "unknown"' <<<"$receipt_json" 2>/dev/null || echo unknown)
	[[ "$verified" == "true" || "$verified" == "false" ]] || verified="false"
	[[ "$degraded" == "true" || "$degraded" == "false" ]] || degraded="true"

	local _locked=0
	if declare -F lock_tasks >/dev/null 2>&1; then
		lock_tasks "$tasks_file" || return 0
		_locked=1
	fi

	local tmp
	tmp=$(mktemp "${tasks_file}.tmp.XXXXXX") || {
		if [[ "$_locked" == "1" ]]; then
			unlock_tasks "$tasks_file" || true
		fi
		return 0
	}
	if jq --arg id "$task_id" \
		--arg path "$receipt_path" \
		--arg reason "$reason" \
		--argjson verified "$verified" \
		--argjson degraded "$degraded" \
		'if .tasks[$id] then
			.tasks[$id].visibility_receipt_path = (if $path == "" then null else $path end)
			| .tasks[$id].visibility = {
				verified: $verified,
				degraded: $degraded,
				reason: $reason,
				receipt_path: (if $path == "" then null else $path end)
			}
		 else . end' \
		"$tasks_file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$tasks_file"
	else
		rm -f "$tmp"
	fi

	if [[ "$_locked" == "1" ]]; then
		unlock_tasks "$tasks_file" || true
	fi
	return 0
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

	# Quit only on an AFFIRMATIVE zero-window observation (alive +
	# no_ax_windows). Every degraded token — observer_unavailable/timeout,
	# ax_not_trusted, task_binding_mismatch, … — also reports 0 windows, and
	# quitting a live visible lane off missing telemetry would be a
	# destructive action keyed to a degraded probe.
	local probe z_alive z_windows _zo _zf _zp z_reason
	probe=$(bundle_window_probe "$bundle_id" || true)
	IFS='|' read -r z_alive z_windows _zo _zf _zp z_reason <<<"$probe"
	if [[ "${z_alive:-false}" != "true" || "${z_reason:-}" != "no_ax_windows" || "${z_windows:-0}" -gt 0 ]]; then
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
	tmp=$(mktemp "${tasks_file}.tmp.XXXXXX") || return 1
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
	if [[ -z "$bundle_path" ]]; then
		if [[ -n "$tmux_socket" ]]; then
			echo "error|headless_tmux: tmux -S ${tmux_socket} attach -t ${session_id}"
			return 1
		fi
		echo "error|no_bundle_path"
		return 1
	fi
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
