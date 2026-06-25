#!/bin/bash
#
# bundle-codesign.sh — App-bundle hygiene, codesigning, and role-config injection
#
# Extracted from oste-spawn.sh. Strips invalid xattrs, validates/re-signs project
# .app bundles (ad-hoc, hardened-runtime with library-validation disabled), and
# injects per-role Ghostty config into a bundle's config copy.
#
# Public API:
#   bundle_strip_invalid_xattrs <bundle_path>   — drop FinderInfo/ResourceFork detritus
#   bundle_signature_is_valid <bundle_path>     — strict `codesign --verify --deep`
#   resign_bundle <bundle_path>                 — re-sign after post-create mutation
#   inject_role_config <bundle_path> <role>     — copy/refresh role-<role>.conf into bundle
#
# Host contract:
#   - inject_role_config reads ROLES_DIR (the configs/roles dir) from the host.
#   - resign_bundle honors GHOSTTY_STOCK_APP (defaults to /Applications/Ghostty.app)
#     as the entitlements donor.

# Guard against double-sourcing
[[ -n "${_BUNDLE_CODESIGN_SH_LOADED:-}" ]] && return 0
readonly _BUNDLE_CODESIGN_SH_LOADED=1

# macOS sometimes stamps app bundles with FinderInfo / resource-fork xattrs
# during copy/open/reveal flows. Strict codesign verification rejects those as
# "detritus not allowed", even when the bundle contents are otherwise fine.
# Strip only the invalid metadata before re-sign/verify so visible launcher
# recovery is resilient instead of getting stuck on bundle hygiene noise.
bundle_strip_invalid_xattrs() {
	local bundle_path="$1"
	[[ -n "$bundle_path" && -d "$bundle_path" ]] || return 0
	command -v xattr >/dev/null 2>&1 || return 0

	xattr -dr com.apple.FinderInfo "$bundle_path" >/dev/null 2>&1 || true
	xattr -dr com.apple.ResourceFork "$bundle_path" >/dev/null 2>&1 || true
}

# Validate a bundle the same way Launch Services will care about it.
# Weak verification can miss broken bundles that later fail to open with -54.
bundle_signature_is_valid() {
	local bundle_path="$1"
	[[ -n "$bundle_path" && -d "$bundle_path" ]] || return 1
	bundle_strip_invalid_xattrs "$bundle_path"
	codesign --verify --deep --strict "$bundle_path" >/dev/null 2>&1
}

# Re-sign a bundle after post-create mutation (bundle config, Info.plist, etc).
# Some macOS launch paths get cranky if we mutate a created bundle and leave the
# original ad-hoc signature stale.
resign_bundle() {
	local bundle_path="$1"
	[[ -n "$bundle_path" && -d "$bundle_path" ]] || return 0

	bundle_strip_invalid_xattrs "$bundle_path"

	local stock_app="${GHOSTTY_STOCK_APP:-/Applications/Ghostty.app}"
	local _ent_file
	_ent_file=$(mktemp)
	codesign -d --entitlements :- "${stock_app}/Contents/MacOS/ghostty" >"$_ent_file" 2>/dev/null || true
	if [[ ! -s "$_ent_file" ]]; then
		cat >"$_ent_file" <<-'EOF'
			<?xml version="1.0" encoding="UTF-8"?>
			<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
			<plist version="1.0"><dict></dict></plist>
		EOF
	fi
	# Ad-hoc project bundles have no Team ID. Hardened runtime library
	# validation otherwise rejects embedded frameworks such as Sparkle at dyld
	# load time ("mapping process and mapped file have different Team IDs").
	/usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$_ent_file" 2>/dev/null ||
		/usr/libexec/PlistBuddy -c "Set :com.apple.security.cs.disable-library-validation true" "$_ent_file"

	local -a _sign_args=(--force --deep --sign - --options runtime)
	if [[ -s "$_ent_file" ]]; then
		_sign_args+=(--entitlements "$_ent_file")
	fi
	if ! codesign "${_sign_args[@]}" "$bundle_path" >/dev/null 2>&1; then
		rm -f "$_ent_file"
		echo "Error: Failed to re-sign bundle: ${bundle_path}" >&2
		return 1
	fi
	rm -f "$_ent_file"

	if ! bundle_signature_is_valid "$bundle_path"; then
		echo "Error: Bundle verification failed after re-sign: ${bundle_path}" >&2
		return 1
	fi
}

# Inject role config into Ghostty bundle config.
# The bundle keeps its own copy (role-<role>.conf) referenced via config-file;
# the copy is refreshed from the source conf whenever they differ, so source
# fixes propagate to already-created bundles on their next role spawn.
# background-image keys are stripped from the copy: role confs load after the
# bundle main config, so any background-image here would silently replace the
# project emoji watermark — the bundle's single background image.
# shellcheck disable=SC2154  # ROLES_DIR is provided by the host (see header contract)
inject_role_config() {
	local bundle_path="$1"
	local role="$2"

	local role_conf="${ROLES_DIR}/${role}.conf"
	[[ -f "$role_conf" ]] || return 0

	local bundle_config_dir="${bundle_path}/Contents/Resources/ghostty-config/ghostty"
	local bundle_config="${bundle_config_dir}/config"
	[[ -f "$bundle_config" ]] || return 0

	local resolved_conf="${bundle_config_dir}/role-${role}.conf"
	local tmp_conf
	tmp_conf=$(mktemp)
	grep -v '^[[:space:]]*background-image' "$role_conf" >"$tmp_conf" || true

	local changed=0
	if [[ ! -f "$resolved_conf" ]] || ! cmp -s "$tmp_conf" "$resolved_conf"; then
		mv "$tmp_conf" "$resolved_conf"
		changed=1
	else
		rm -f "$tmp_conf"
	fi

	if ! grep -q "config-file = ${resolved_conf}" "$bundle_config" 2>/dev/null; then
		echo "config-file = ${resolved_conf}" >>"$bundle_config"
		changed=1
	fi

	if [[ "$changed" -eq 1 ]] && ! resign_bundle "$bundle_path"; then
		echo "Error: role config mutation left bundle invalid: ${bundle_path}" >&2
		return 1
	fi
}
