#!/bin/bash
#
# openclaw-token.sh — Config-backed OpenClaw token resolution
#
# Provides a unified 3-tier hooks-token lookup:
#   1. OPENCLAW_HOOKS_TOKEN env var (fastest, always checked first)
#   2. ~/.openclaw/openclaw.json → .hooks.token (native OpenClaw config)
#   3. macOS Keychain fallback (openclaw-hooks-token service)
#
# The config tier supports env-template strings like "${OPENCLAW_HOOKS_TOKEN}"
# which are resolved to the referenced env var's value before returning.
#
# Usage:
#   source scripts/lib/openclaw-token.sh
#   token=$(resolve_hooks_token)
#

# Resolve a raw config value that may be an env-template reference.
# Handles the pattern "${VAR_NAME}" → value of $VAR_NAME.
# Non-template strings pass through unchanged.
resolve_env_template_string() {
	local raw="$1"
	if [[ "$raw" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$ ]]; then
		local env_name="${BASH_REMATCH[1]}"
		printf '%s' "${!env_name:-}"
		return 0
	fi
	printf '%s' "$raw"
}

# Read a value from ~/.openclaw/openclaw.json using a jq expression,
# then resolve any env-template wrapper.
read_openclaw_config_string() {
	local jq_expr="$1"
	local raw_value=""
	raw_value=$(jq -r "${jq_expr} // empty" "${HOME}/.openclaw/openclaw.json" 2>/dev/null || true)
	resolve_env_template_string "$raw_value"
}

# Resolve the OpenClaw hooks token through the 3-tier chain:
#   env var → config file → keychain
# Prints the token to stdout. Returns empty string if none found.
resolve_hooks_token() {
	local token_value=""
	local config_path="${HOME}/.openclaw/openclaw.json"

	# Tier 1: env var (explicit, highest priority)
	if [[ -n "${OPENCLAW_HOOKS_TOKEN:-}" ]]; then
		printf '%s' "${OPENCLAW_HOOKS_TOKEN}"
		return 0
	fi

	# Tier 2: native OpenClaw config (.hooks.token with env-template resolution)
	token_value=$(read_openclaw_config_string '.hooks.token')
	if [[ -n "$token_value" ]]; then
		printf '%s' "$token_value"
		return 0
	fi

	# Keep notify tests hermetic: when they provide no config, do not fall through
	# to the host machine's real keychain token.
	if [[ "${OSTE_NOTIFY_TEST:-0}" == "1" && ! -f "$config_path" ]]; then
		return 0
	fi

	# Tier 3: macOS Keychain fallback
	security find-generic-password -a ostehost -s openclaw-hooks-token -w 2>/dev/null || true
}
