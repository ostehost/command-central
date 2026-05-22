#!/bin/bash
# Open Ghostty project bundles without leaking the caller bundle's identity.

_project_bundle_plist_env() {
	local bundle_path="$1"
	local key="$2"
	local plist="${bundle_path}/Contents/Info.plist"
	[[ -f "$plist" ]] || return 0
	/usr/libexec/PlistBuddy -c "Print :LSEnvironment:${key}" "$plist" 2>/dev/null || true
}

_project_bundle_process_env() {
	local env_dump="$1"
	local key="$2"
	printf '%s' "$env_dump" | tr ' ' '\n' | awk -F= -v key="$key" '$1 == key {print substr($0, length(key) + 2); exit}'
}

_project_bundle_local_host() {
	scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || hostname 2>/dev/null || echo "unknown"
}

_project_bundle_visible_launcher_hosts() {
	if [[ -n "${OSTE_VISIBLE_LAUNCHER_HOSTS:-}" ]]; then
		printf '%s' "$OSTE_VISIBLE_LAUNCHER_HOSTS"
		return 0
	fi

	local lib_dir scripts_dir policy
	lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	scripts_dir="$(cd "${lib_dir}/.." && pwd)"
	policy="${OSTE_ROUTE_POLICY_FILE:-${scripts_dir}/routing-policy.json}"

	[[ -f "$policy" ]] || return 1

	if command -v jq >/dev/null 2>&1; then
		jq -r '.visible_launcher_hosts // .guards.coder.require_node // empty' "$policy" 2>/dev/null
	else
		awk -F'"' '/"visible_launcher_hosts"/ {print $4; exit}' "$policy" 2>/dev/null
	fi
}

_project_bundle_csv_contains_host() {
	local csv="$1"
	local target="$2"
	local candidate
	local -a _project_bundle_candidates

	IFS=',' read -r -a _project_bundle_candidates <<<"$csv"
	for candidate in "${_project_bundle_candidates[@]}"; do
		candidate="${candidate#"${candidate%%[![:space:]]*}"}"
		candidate="${candidate%"${candidate##*[![:space:]]}"}"
		[[ -n "$candidate" ]] || continue
		[[ "$candidate" == "$target" ]] && return 0
	done

	return 1
}

_project_bundle_enforce_visible_launcher_host() {
	local allowed_hosts local_host
	allowed_hosts="$(_project_bundle_visible_launcher_hosts || true)"
	local_host="$(_project_bundle_local_host)"

	if [[ -z "$allowed_hosts" ]]; then
		echo "Visible Ghostty project bundles are node-only, but no visible_launcher_hosts policy was found; refusing to open ${1} on ${local_host}" >&2
		return 1
	fi

	if _project_bundle_csv_contains_host "$allowed_hosts" "$local_host"; then
		return 0
	fi

	echo "Visible Ghostty project bundles are node-only; refusing to open ${1} on ${local_host}. Allowed hosts: ${allowed_hosts}" >&2
	return 1
}

_project_bundle_refuse_test_mode_open() {
	local bundle_path="$1"
	if [[ "${OSTE_TEST_MODE:-}" == "1" && "${OSTE_TEST_ALLOW_PROJECT_BUNDLE_OPEN:-0}" != "1" ]]; then
		echo "OSTE_TEST_MODE=1 refuses to open real project bundle ${bundle_path}" >&2
		return 1
	fi

	return 0
}

_reap_mislaunched_project_bundle() {
	local bundle_path="$1"
	local expected_xdg expected_project expected_session
	expected_xdg=$(_project_bundle_plist_env "$bundle_path" XDG_CONFIG_HOME)
	expected_project=$(_project_bundle_plist_env "$bundle_path" GHOSTTY_PROJECT_ID)
	expected_session=$(_project_bundle_plist_env "$bundle_path" GHOSTTY_SESSION_ID)
	[[ -n "$expected_xdg" || -n "$expected_project" || -n "$expected_session" ]] || return 0

	local pids
	pids=$(pgrep -f "${bundle_path}/Contents/MacOS/ghostty" 2>/dev/null || true)
	[[ -n "$pids" ]] || return 0

	local pid killed_any=0
	while IFS= read -r pid; do
		[[ -n "$pid" ]] || continue

		local env_dump current_xdg current_project current_session mismatch=0
		env_dump=$(ps eww -p "$pid" -o command= 2>/dev/null || true)
		[[ -n "$env_dump" ]] || continue

		current_xdg=$(_project_bundle_process_env "$env_dump" XDG_CONFIG_HOME)
		current_project=$(_project_bundle_process_env "$env_dump" GHOSTTY_PROJECT_ID)
		current_session=$(_project_bundle_process_env "$env_dump" GHOSTTY_SESSION_ID)

		[[ -n "$expected_xdg" && -n "$current_xdg" && "$current_xdg" != "$expected_xdg" ]] && mismatch=1
		[[ -n "$expected_project" && -n "$current_project" && "$current_project" != "$expected_project" ]] && mismatch=1
		[[ -n "$expected_session" && -n "$current_session" && "$current_session" != "$expected_session" ]] && mismatch=1
		[[ "$mismatch" -eq 1 ]] || continue

		echo "Killing mislaunched Ghostty process (pid=${pid}) for ${bundle_path}; process identity does not match bundle plist" >&2
		kill "$pid" 2>/dev/null || true
		killed_any=1
	done <<<"$pids"

	[[ "$killed_any" -eq 0 ]] || sleep 1
}

open_project_bundle() {
	local bundle_path="$1"
	[[ -n "$bundle_path" ]] || {
		echo "Error: bundle path is required" >&2
		return 1
	}

	_project_bundle_refuse_test_mode_open "$bundle_path" || return 1
	_project_bundle_enforce_visible_launcher_host "$bundle_path" || return 1
	_reap_mislaunched_project_bundle "$bundle_path"

	(
		# `open` inherits the caller environment. When one project terminal
		# launches another, inherited Ghostty identity/config variables can win
		# over the target bundle's LSEnvironment and attach the wrong session.
		unset XDG_CONFIG_HOME
		unset __CFBundleIdentifier
		unset GHOSTTY_APP_NAME
		unset GHOSTTY_BUNDLE_ID
		unset GHOSTTY_PERSIST_SOCKET
		unset GHOSTTY_PROJECT_ID
		unset GHOSTTY_PROJECT_NAME
		unset GHOSTTY_PROJECT_PATH
		unset GHOSTTY_SESSION_ID
		unset GHOSTTY_TASK_ID
		unset GHOSTTY_TMUX_CONF
		unset GHOSTTY_TMUX_SOCKET
		unset GHOSTTY_URL_SCHEME
		unset GHOSTTY_USE_TERMINAL_NOTIFIER
		unset GHL_MULTIPLEXER
		exec env \
			-u XDG_CONFIG_HOME \
			-u __CFBundleIdentifier \
			-u GHOSTTY_APP_NAME \
			-u GHOSTTY_BUNDLE_ID \
			-u GHOSTTY_PERSIST_SOCKET \
			-u GHOSTTY_PROJECT_ID \
			-u GHOSTTY_PROJECT_NAME \
			-u GHOSTTY_PROJECT_PATH \
			-u GHOSTTY_SESSION_ID \
			-u GHOSTTY_TASK_ID \
			-u GHOSTTY_TMUX_CONF \
			-u GHOSTTY_TMUX_SOCKET \
			-u GHOSTTY_URL_SCHEME \
			-u GHOSTTY_USE_TERMINAL_NOTIFIER \
			-u GHL_MULTIPLEXER \
			open -a "$bundle_path"
	)
}
