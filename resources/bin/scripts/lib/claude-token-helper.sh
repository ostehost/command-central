#!/bin/bash
#
# claude-token-helper.sh — Headless auth token provider for Claude Code
#
# Used by Claude Code's apiKeyHelper mechanism (called every 5min + on 401).
# Supports multiple token sources with fallback chain:
#
#   1. Long-lived setup-token (from `claude setup-token`, ~1 year)
#   2. Keychain extraction (short-lived OAuth, ~8 hours)
#   3. Environment variable fallback
#
# Architecture: Provider-agnostic design. Only Claude Code supported now,
# but the pattern supports future providers (Codex CLI, etc).
#
# Usage:
#   claude-token-helper.sh [--provider claude-code]
#   claude-token-helper.sh --status
#   claude-token-helper.sh --validate
#
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────

readonly TOKEN_DIR="${HOME}/.config/ghostty-launcher/tokens"
readonly CLAUDE_SETUP_TOKEN_FILE="${TOKEN_DIR}/claude-setup-token"
readonly LOG_FILE="${TOKEN_DIR}/helper.log"
# Reserved for future token refresh locking
# readonly LOCK_FILE="${TOKEN_DIR}/.refresh.lock"

# Claude Code keychain service names (newest first)
readonly -a CLAUDE_KEYCHAIN_SERVICES=(
	"Claude Code-credentials"
	"Claude Code-credentials-2fa094e0"
)

# ── Helpers ──────────────────────────────────────────────────────────

log() {
	local ts
	ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	echo "${ts} $*" >>"$LOG_FILE" 2>/dev/null || true
}

die() {
	log "FATAL: $*"
	echo "ERROR: $*" >&2
	exit 1
}

ensure_dirs() {
	if [[ ! -d "$TOKEN_DIR" ]]; then
		mkdir -p "$TOKEN_DIR"
		chmod 700 "$TOKEN_DIR"
	fi
}

# ── Token Sources ────────────────────────────────────────────────────

# Source 1: Long-lived setup token (preferred — ~1 year validity)
get_setup_token() {
	if [[ -f "$CLAUDE_SETUP_TOKEN_FILE" ]]; then
		local token
		token=$(cat "$CLAUDE_SETUP_TOKEN_FILE" 2>/dev/null)
		if [[ -n "$token" && "$token" == sk-ant-oat01-* ]]; then
			log "INFO: Using setup-token"
			echo "$token"
			return 0
		fi
	fi
	return 1
}

# Source 2: Keychain extraction (short-lived, ~8h)
get_keychain_token() {
	for svc in "${CLAUDE_KEYCHAIN_SERVICES[@]}"; do
		local raw_json
		raw_json=$(security find-generic-password -s "$svc" -w 2>/dev/null) || continue

		# Check expiry
		local expires_at
		expires_at=$(echo "$raw_json" | python3 -c "
import sys, json, time
d = json.load(sys.stdin)
exp = d.get('claudeAiOauth', {}).get('expiresAt', 0)
print(exp)
" 2>/dev/null) || continue

		local now_ms
		now_ms=$(python3 -c "import time; print(int(time.time()*1000))")

		# Token must have at least 5 minutes remaining
		if [[ "$expires_at" -gt $((now_ms + 300000)) ]]; then
			local token
			token=$(echo "$raw_json" | python3 -c "
import sys, json
print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])
" 2>/dev/null) || continue

			if [[ -n "$token" ]]; then
				log "INFO: Using keychain token from '$svc' (expires in $(((expires_at - now_ms) / 60000))min)"
				echo "$token"
				return 0
			fi
		else
			log "WARN: Keychain token from '$svc' expired or expiring soon"
		fi
	done
	return 1
}

# Source 3: Environment variable fallback
get_env_token() {
	if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
		log "INFO: Using CLAUDE_CODE_OAUTH_TOKEN env var"
		echo "$CLAUDE_CODE_OAUTH_TOKEN"
		return 0
	fi
	return 1
}

# ── Store setup token ────────────────────────────────────────────────

store_setup_token() {
	local token="$1"
	ensure_dirs
	echo "$token" >"$CLAUDE_SETUP_TOKEN_FILE"
	chmod 600 "$CLAUDE_SETUP_TOKEN_FILE"
	log "INFO: Stored setup-token"
	echo "Setup token stored at $CLAUDE_SETUP_TOKEN_FILE"
}

# ── Status / Validation ─────────────────────────────────────────────

emit_status_json() {
	local setup_present=false
	local setup_valid=false
	local env_present=false
	local keychain_valid_count=0
	local keychain_best_service=""
	local keychain_best_remaining_minutes=0

	if [[ -f "$CLAUDE_SETUP_TOKEN_FILE" ]]; then
		setup_present=true
		local setup_token
		setup_token=$(cat "$CLAUDE_SETUP_TOKEN_FILE" 2>/dev/null)
		if [[ -n "$setup_token" && "$setup_token" == sk-ant-oat01-* ]]; then
			setup_valid=true
		fi
	fi

	for svc in "${CLAUDE_KEYCHAIN_SERVICES[@]}"; do
		local raw_json
		raw_json=$(security find-generic-password -s "$svc" -w 2>/dev/null) || continue

		local expires_at
		expires_at=$(echo "$raw_json" | python3 -c "
import sys, json
print(json.load(sys.stdin).get('claudeAiOauth', {}).get('expiresAt', 0))
" 2>/dev/null) || continue

		local now_ms
		now_ms=$(python3 -c "import time; print(int(time.time()*1000))")
		local remaining_minutes
		remaining_minutes=$(((expires_at - now_ms) / 60000))
		if [[ "$remaining_minutes" -gt 5 ]]; then
			keychain_valid_count=$((keychain_valid_count + 1))
			if [[ "$remaining_minutes" -gt "$keychain_best_remaining_minutes" ]]; then
				keychain_best_remaining_minutes="$remaining_minutes"
				keychain_best_service="$svc"
			fi
		fi
	done

	if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
		env_present=true
	fi

	local keychain_available=false
	local headless_available=false
	local preferred_source="none"
	if [[ "$keychain_valid_count" -gt 0 ]]; then
		keychain_available=true
	fi
	if [[ "$setup_valid" == true || "$keychain_available" == true || "$env_present" == true ]]; then
		headless_available=true
	fi
	if [[ "$setup_valid" == true ]]; then
		preferred_source="setup-token"
	elif [[ "$keychain_available" == true ]]; then
		preferred_source="keychain"
	elif [[ "$env_present" == true ]]; then
		preferred_source="env"
	fi

	jq -n \
		--argjson setup_present "$([[ "$setup_present" == true ]] && echo true || echo false)" \
		--argjson setup_valid "$([[ "$setup_valid" == true ]] && echo true || echo false)" \
		--argjson keychain_available "$([[ "$keychain_available" == true ]] && echo true || echo false)" \
		--argjson keychain_valid_count "$keychain_valid_count" \
		--arg keychain_best_service "$keychain_best_service" \
		--argjson keychain_best_remaining_minutes "$keychain_best_remaining_minutes" \
		--argjson env_present "$([[ "$env_present" == true ]] && echo true || echo false)" \
		--argjson headless_available "$([[ "$headless_available" == true ]] && echo true || echo false)" \
		--arg preferred_source "$preferred_source" \
		'{
			setupTokenPresent: $setup_present,
			setupTokenValid: $setup_valid,
			keychainAuthAvailable: $keychain_available,
			keychainValidCount: $keychain_valid_count,
			keychainBestService: $keychain_best_service,
			keychainBestRemainingMinutes: $keychain_best_remaining_minutes,
			envTokenPresent: $env_present,
			headlessAuthAvailable: $headless_available,
			preferredSource: $preferred_source
		}'
}

show_status() {
	local status_json
	status_json=$(emit_status_json)

	echo "=== Claude Code Token Helper Status ==="
	echo ""

	if [[ "$(jq -r '.setupTokenPresent' <<<"$status_json")" == "true" ]]; then
		local token
		token=$(cat "$CLAUDE_SETUP_TOKEN_FILE" 2>/dev/null)
		echo "Setup token: ✅ Present (${token:0:20}...)"
	else
		echo "Setup token: ❌ Not configured"
	fi

	for svc in "${CLAUDE_KEYCHAIN_SERVICES[@]}"; do
		if security find-generic-password -s "$svc" -w >/dev/null 2>&1; then
			local expires_at now_ms remaining
			expires_at=$(security find-generic-password -s "$svc" -w 2>/dev/null | python3 -c "
import sys, json
print(json.load(sys.stdin).get('claudeAiOauth', {}).get('expiresAt', 0))
" 2>/dev/null)
			now_ms=$(python3 -c "import time; print(int(time.time()*1000))")
			remaining=$(((expires_at - now_ms) / 60000))
			if [[ "$remaining" -gt 0 ]]; then
				echo "Keychain ($svc): ✅ Valid (${remaining}min remaining)"
			else
				echo "Keychain ($svc): ⚠️  Expired"
			fi
		else
			echo "Keychain ($svc): ❌ Not found"
		fi
	done

	if [[ "$(jq -r '.envTokenPresent' <<<"$status_json")" == "true" ]]; then
		echo "Env var: ✅ Set"
	else
		echo "Env var: ❌ Not set"
	fi

	echo "Preferred source: $(jq -r '.preferredSource' <<<"$status_json")"

	echo ""
	if [[ -f "$LOG_FILE" ]]; then
		echo "Recent log:"
		tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
	fi
}

validate_token() {
	local token
	token=$(get_token_for_provider "claude-code") || die "No valid token found"

	# Quick validation: check format
	if [[ "$token" == sk-ant-oat01-* ]]; then
		echo "✅ Token format valid (OAuth access token)"
	elif [[ "$token" == sk-ant-* ]]; then
		echo "✅ Token format valid (API token)"
	else
		echo "⚠️  Unknown token format"
	fi

	# Could add an actual API call here to validate, but that costs a request
	echo "Token: ${token:0:20}..."
}

# ── Provider Router ──────────────────────────────────────────────────
# Extensible: add new providers here (codex, etc)

get_token_for_provider() {
	local provider="${1:-claude-code}"

	case "$provider" in
		claude-code)
			# Fallback chain: setup-token → keychain → env var
			get_setup_token && return 0
			get_keychain_token && return 0
			get_env_token && return 0
			log "ERROR: No valid Claude Code token found from any source"
			return 1
			;;
		# Future: codex, gemini, etc
		# codex)
		#     get_codex_token && return 0
		#     ;;
		*)
			die "Unknown provider: $provider"
			;;
	esac
}

# ── Main ─────────────────────────────────────────────────────────────

main() {
	ensure_dirs

	case "${1:-}" in
		--store)
			[[ -n "${2:-}" ]] || die "Usage: $0 --store <token>"
			store_setup_token "$2"
			;;
		--status)
			show_status
			;;
		--status-json)
			emit_status_json
			;;
		--validate)
			validate_token
			;;
		--provider)
			get_token_for_provider "${2:-claude-code}" || exit 1
			;;
		--help | -h)
			cat <<EOF
claude-token-helper.sh — Token provider for headless Claude Code

Usage:
  claude-token-helper.sh              Output a valid token (for apiKeyHelper)
  claude-token-helper.sh --store TKN  Store a setup-token
  claude-token-helper.sh --status     Show token source status
  claude-token-helper.sh --status-json  Emit parseable token source status JSON
  claude-token-helper.sh --validate   Validate current token
  claude-token-helper.sh --provider X Get token for provider (default: claude-code)

Token sources (in priority order):
  1. Setup token (~/.config/ghostty-launcher/tokens/claude-setup-token)
  2. macOS Keychain (Claude Code OAuth credentials)
  3. CLAUDE_CODE_OAUTH_TOKEN environment variable

Setup:
  1. Run: claude setup-token
  2. Run: claude-token-helper.sh --store <token-from-step-1>
  3. Add to ~/.claude/settings.json:
     {"apiKeyHelper": "$0"}
EOF
			;;
		*)
			# Default: output token (this is what apiKeyHelper calls)
			get_token_for_provider "claude-code" || exit 1
			;;
	esac
}

main "$@"
