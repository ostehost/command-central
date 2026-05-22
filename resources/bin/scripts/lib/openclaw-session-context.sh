#!/bin/bash
# openclaw-session-context.sh — normalize native OpenClaw session/callback context
#
# Canonical launcher env vars remain OSTE_CALLBACK_URL + OSTE_SESSION_KEY.
# Native OpenClaw wrappers can supply OPENCLAW_* fallbacks. Generic shells
# cannot infer the active session on their own, so callers must still pass or
# export one of these values when session binding matters.

resolve_launcher_callback_url() {
	local explicit="${1:-}"
	if [[ -n "$explicit" ]]; then
		printf '%s' "$explicit"
		return 0
	fi

	local var_name value
	for var_name in OSTE_CALLBACK_URL OPENCLAW_CALLBACK_URL; do
		value="${!var_name:-}"
		if [[ -n "$value" ]]; then
			printf '%s' "$value"
			return 0
		fi
	done

	return 0
}

resolve_launcher_session_key() {
	local explicit="${1:-}"
	if [[ -n "$explicit" ]]; then
		printf '%s' "$explicit"
		return 0
	fi

	local var_name value
	for var_name in OSTE_SESSION_KEY OPENCLAW_SESSION_KEY OPENCLAW_MCP_SESSION_KEY; do
		value="${!var_name:-}"
		if [[ -n "$value" ]]; then
			printf '%s' "$value"
			return 0
		fi
	done

	return 0
}
