#!/bin/bash
#
# project-identity.sh — Derive lane/session/bundle identity from a project dir
#
# Extracted from oste-spawn.sh. Pure-ish naming derivation: tmux session names,
# worktree-suffixed visible lane names, and the target bundle identifier. This is
# name DERIVATION (string mirrors of the launcher's sanitizer); it is distinct
# from project-ref.sh, which is the registry-backed canonical identity resolver.
#
# Public API:
#   derive_session_name <project_name>            -> "agent-<sanitized-slug>"
#   derive_visible_project_name <project_dir> <base_name>
#                                                 -> base name + readable worktree suffix
#   resolve_target_bundle_id <project_dir>        -> CFBundleIdentifier (plist) or
#                                                    dev.partnerai.ghostty.<slug>
#
# Host contract:
#   - resolve_target_bundle_id reads LAUNCHER (the launcher binary, for
#     --parse-name) and PROJECTS_DIR (the bundle install dir) from the host.

# Guard against double-sourcing
[[ -n "${_PROJECT_IDENTITY_SH_LOADED:-}" ]] && return 0
readonly _PROJECT_IDENTITY_SH_LOADED=1

# Derive session name from project name (mirrors launcher's sanitize_for_bundle)
derive_session_name() {
	local name="$1"
	echo "agent-$(echo "$name" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[[:space:]\/]/-/g' | LC_ALL=C tr -cd '[:alnum:]-' | LC_ALL=C sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
}

derive_visible_project_name() {
	local project_dir="$1"
	local base_name="$2"
	local base_slug dir_slug suffix display_suffix

	base_slug=$(derive_session_name "$base_name")
	base_slug="${base_slug#agent-}"
	dir_slug=$(derive_session_name "$(basename "$project_dir")")
	dir_slug="${dir_slug#agent-}"

	if [[ -n "$base_slug" && -n "$dir_slug" && "$dir_slug" != "$base_slug" && "$dir_slug" == "${base_slug}-"* ]]; then
		suffix="${dir_slug#"${base_slug}-"}"
		display_suffix=$(echo "$suffix" | tr '-' ' ')
		if [[ -n "$display_suffix" ]]; then
			echo "${base_name} ${display_suffix}"
			return 0
		fi
	fi

	echo "$base_name"
}

# shellcheck disable=SC2154  # LAUNCHER/PROJECTS_DIR are provided by the host (see header)
resolve_target_bundle_id() {
	local project_dir="$1"
	[[ -d "$project_dir" ]] || return 1

	local project_name safe_name bundle_path bundle_id
	if [[ -x "$LAUNCHER" ]]; then
		project_name=$("$LAUNCHER" --parse-name "$project_dir" 2>/dev/null || true)
	fi
	[[ -n "$project_name" ]] || project_name=$(basename "$project_dir")

	safe_name=$(derive_session_name "$project_name")
	safe_name="${safe_name#agent-}"
	[[ -n "$safe_name" ]] || return 1

	bundle_path="${PROJECTS_DIR}/${safe_name}.app"
	if [[ -d "$bundle_path" ]]; then
		bundle_id=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "${bundle_path}/Contents/Info.plist" 2>/dev/null || true)
		if [[ -n "$bundle_id" ]]; then
			printf '%s' "$bundle_id"
			return 0
		fi
	fi

	printf 'dev.partnerai.ghostty.%s' "$safe_name"
}
