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

_project_bundle_plist_value() {
	local bundle_path="$1"
	local key="$2"
	local plist="${bundle_path}/Contents/Info.plist"
	[[ -f "$plist" ]] || return 0
	/usr/libexec/PlistBuddy -c "Print :${key}" "$plist" 2>/dev/null || true
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

_project_bundle_execution_policy_allows() {
	local bundle_path="$1"

	# Locally-created bundles have no quarantine attribute; macOS launches
	# them without Gatekeeper assessment regardless of signing identity.
	# Only downloaded (quarantined) bundles need the spctl check.
	if ! xattr -p com.apple.quarantine "$bundle_path" >/dev/null 2>&1; then
		return 0
	fi

	command -v spctl >/dev/null 2>&1 || return 0
	spctl --assess --type execute "$bundle_path" >/dev/null 2>&1
}

_project_bundle_stock_ghostty_app() {
	if [[ -n "${GHOSTTY_STOCK_APP:-}" ]]; then
		printf '%s' "$GHOSTTY_STOCK_APP"
		return 0
	fi

	printf '%s' "/Applications/Ghostty.app"
}

_project_bundle_env_args() {
	local bundle_path="$1"
	local key value
	local bundle_id
	local -a keys=(
		XDG_CONFIG_HOME
		GHOSTTY_APP_NAME
		GHOSTTY_PROJECT_ID
		GHOSTTY_PROJECT_PATH
		GHOSTTY_SESSION_ID
		GHOSTTY_TASK_ID
		GHOSTTY_TMUX_CONF
		GHOSTTY_TMUX_SOCKET
		GHOSTTY_URL_SCHEME
		GHOSTTY_USE_TERMINAL_NOTIFIER
		GHL_MULTIPLEXER
	)

	for key in "${keys[@]}"; do
		value=$(_project_bundle_plist_env "$bundle_path" "$key")
		[[ -n "$value" ]] || continue
		printf '%s=%s\0' "$key" "$value"
	done

	bundle_id=$(_project_bundle_plist_value "$bundle_path" CFBundleIdentifier)
	if [[ -n "$bundle_id" ]]; then
		printf 'GHOSTTY_BUNDLE_ID=%s\0' "$bundle_id"
	fi
}

_open_project_bundle_direct() {
	local bundle_path="$1"
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

_open_project_bundle_via_stock_ghostty() {
	local bundle_path="$1"
	local stock_app config_file
	stock_app=$(_project_bundle_stock_ghostty_app)
	config_file="${bundle_path}/Contents/Resources/ghostty-config/ghostty/config"

	if [[ ! -d "$stock_app" ]]; then
		echo "Error: stock Ghostty app not found for execution-policy fallback: ${stock_app}" >&2
		return 1
	fi
	if [[ ! -f "$config_file" ]]; then
		echo "Error: project Ghostty config missing for execution-policy fallback: ${config_file}" >&2
		return 1
	fi

	echo "Project bundle is rejected by macOS execution policy; opening signed Ghostty.app with project config instead: ${bundle_path}" >&2

	(
		local -a env_args
		while IFS= read -r -d '' env_arg; do
			env_args+=("$env_arg")
		done < <(_project_bundle_env_args "$bundle_path")

		exec env \
			-u __CFBundleIdentifier \
			-u GHOSTTY_PERSIST_SOCKET \
			-u GHOSTTY_PROJECT_NAME \
			"${env_args[@]}" \
			open -na "$stock_app" --args \
			--config-default-files=false \
			--config-file="$config_file"
	)
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

	if _project_bundle_execution_policy_allows "$bundle_path"; then
		_open_project_bundle_direct "$bundle_path"
		return $?
	fi

	_open_project_bundle_via_stock_ghostty "$bundle_path"
}
