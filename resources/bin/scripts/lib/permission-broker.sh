#!/bin/bash
# shellcheck shell=bash
#
# permission-broker.sh — Shared library for PermissionRequest + Notification hook broker
#
# Pure library: sourcing defines functions and readonly config vars; runs nothing.
#
# Receipt storage: per-task append-only JSONL under OSTE_PERMISSION_PROMPT_DIR.
# De-dupe: identical event+input_hash receipts within OSTE_PERMISSION_DEDUP_TTL are
# suppressed. Notification receipts (empty hash) de-dupe by event+cwd+session_id.
#
# Hooks: oste-permission-request-hook.sh, oste-permission-notify-hook.sh
# Status integration: oste-status.sh calls permission_broker_status_json
#
# Standards: bash, set -euo pipefail in callers; tabs (shfmt -i 0 -ci);
# sc clean (severity=warning); functions ≤30 lines, ≤3 nesting.

# ── Config (env-overridable) ──────────────────────────────────────────
: "${OSTE_PERMISSION_PROMPT_DIR:=/tmp/oste-permission-prompts}"
: "${OSTE_PERMISSION_DEDUP_TTL:=300}"
: "${OSTE_PERMISSION_RECENT_LIMIT:=5}"
: "${OSTE_PERMISSION_NOTIFY_CMD:=}"
: "${OSTE_PERMISSION_AUTO_ALLOW_SAFE:=0}"

# ── permission_broker_redact ──────────────────────────────────────────
# Mask credential-like keys and inline secrets in a JSON string.
# Always emits valid JSON; on parse failure emits {}.
permission_broker_redact() {
	local json="${1:-{\}}"
	# Redact by key name (case-insensitive) and inline secret patterns — pure jq,
	# no sed, so JSON structure is never corrupted by inline-token substitution.
	printf '%s' "$json" | jq -e '.' >/dev/null 2>&1 || {
		echo '{}'
		return 0
	}
	printf '%s' "$json" | jq '
		def redact_str:
			gsub("(?<a>[Bb]earer )(?<b>[A-Za-z0-9._~+/=-]{8,})"; .a + "[REDACTED]")
			| gsub("(?<a>[Aa]uthorization: )(?<b>[A-Za-z0-9._~+/=-]{8,})"; .a + "[REDACTED]")
			| gsub("(?<a>--token[ =])(?<b>[A-Za-z0-9._~+/=-]{8,})"; .a + "[REDACTED]")
			| gsub("(?<a>--password[ =])(?<b>[^ \"]{8,})"; .a + "[REDACTED]")
			| gsub("(?<a>api[_-]?key[ =])(?<b>[A-Za-z0-9._~+/=-]{8,})"; .a + "[REDACTED]")
			| gsub("(?<t>[A-Za-z0-9_-]{24,})"; "[REDACTED]");
		walk(
			if type == "object" then
				with_entries(
					if (.key | ascii_downcase | test("token|secret|password|passwd|api[_-]?key|authorization|bearer|access[_-]?key|client[_-]?secret"))
					then .value = "[REDACTED]"
					else .
					end
				)
			elif type == "string" then redact_str
			else .
			end
		)
	' 2>/dev/null || echo '{}'
}

# ── permission_broker_classify ────────────────────────────────────────
# Returns: safe | dangerous | neutral
permission_broker_classify() {
	local tool_name="${1:-}"
	local tool_input_json="${2:-{\}}"
	local cmd=""
	cmd=$(printf '%s' "$tool_input_json" | jq -r '.command // ""' 2>/dev/null || true)
	local file_path=""
	file_path=$(printf '%s' "$tool_input_json" | jq -r '.file_path // .path // ""' 2>/dev/null || true)
	local permission_mode=""
	permission_mode=$(printf '%s' "$tool_input_json" | jq -r '.permission_mode // ""' 2>/dev/null || true)

	# Escalation via bypassPermissions mode
	if [[ "$permission_mode" == "bypassPermissions" ]]; then
		echo "dangerous"
		return 0
	fi

	_classify_bash_dangerous "$tool_name" "$cmd" && {
		echo "dangerous"
		return 0
	}
	_classify_write_dangerous "$tool_name" "$file_path" && {
		echo "dangerous"
		return 0
	}
	_classify_safe "$tool_name" "$cmd" && {
		echo "safe"
		return 0
	}

	echo "neutral"
}

_classify_bash_dangerous() {
	local tool_name="${1:-}"
	local cmd="${2:-}"
	[[ "$tool_name" == "Bash" ]] || return 1
	[[ -n "$cmd" ]] || return 1

	# Destructive / exfil / escalation patterns
	if printf '%s' "$cmd" | grep -qE \
		'rm[[:space:]]+-[^ ]*r[^ ]*f|rm[[:space:]]+-[^ ]*f[^ ]*r|:(\(\)){|mkfs|dd[[:space:]]+if=|>[[:space:]]*/dev/|(shutdown|reboot)[[:space:]]|chmod[[:space:]]+-R|chown[[:space:]]+-R'; then
		return 0
	fi
	if printf '%s' "$cmd" | grep -qE \
		'(curl|wget)[^|]*(\||>|--upload-file|-T[[:space:]])|(nc |ncat )|ssh[[:space:]]|scp[[:space:]]|security[[:space:]]|launchctl[[:space:]]'; then
		return 0
	fi
	if printf '%s' "$cmd" | grep -qE \
		'git[[:space:]]+push|git[[:space:]]+tag|git[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-fd)|--force|npm[[:space:]]+publish|gh[[:space:]]+(release|pr[[:space:]]+merge)'; then
		return 0
	fi
	if printf '%s' "$cmd" | grep -qE \
		'(deploy|release)[[:space:]]|~/.ssh|~/.aws|\.env|id_rsa|keychain|--dangerously|bypassPermissions|sudo[[:space:]]'; then
		return 0
	fi
	return 1
}

_classify_write_dangerous() {
	local tool_name="${1:-}"
	local file_path="${2:-}"
	[[ "$tool_name" == "Write" || "$tool_name" == "Edit" ]] || return 1
	[[ -n "$file_path" ]] || return 1
	if printf '%s' "$file_path" | grep -qE \
		'~?/\.ssh|~?/\.aws|/\.env$|/secrets|keychain|/id_rsa'; then
		return 0
	fi
	return 1
}

_classify_safe() {
	local tool_name="${1:-}"
	local cmd="${2:-}"

	case "$tool_name" in
		Read | Glob | Grep) return 0 ;;
	esac

	[[ "$tool_name" == "Bash" ]] || return 1
	[[ -n "$cmd" ]] || return 1

	# Split on '&&'; EVERY segment must independently be a safe read-only cmd.
	local rest="$cmd" segment
	while [[ -n "$rest" ]]; do
		if [[ "$rest" == *"&&"* ]]; then
			segment="${rest%%&&*}"
			rest="${rest#*&&}"
		else
			segment="$rest"
			rest=""
		fi
		_classify_safe_segment "$segment" || return 1
	done
	return 0
}

_classify_safe_segment() {
	local seg="${1:-}"
	# Trim surrounding whitespace.
	seg="${seg#"${seg%%[![:space:]]*}"}"
	seg="${seg%"${seg##*[![:space:]]}"}"
	[[ -n "$seg" ]] || return 1

	# Reject any control/redirection metachar that could hide a writer.
	if printf '%s' "$seg" | grep -qE '[;|&`<>]|\$\(|\$\{|\(\)'; then
		return 1
	fi

	# First real token (skip leading VAR=val assignments).
	local first_token
	first_token=$(printf '%s' "$seg" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=[^ ]+ +)*//' | awk '{print $1}')

	case "$first_token" in
		ls | pwd | cat | head | tail | wc | rg | grep | find | echo | date | whoami | jq)
			return 0
			;;
		shfmt | shellcheck | git | just)
			_is_safe_compound_cmd "$seg" "$first_token" && return 0
			return 1
			;;
	esac
	return 1
}

_is_safe_compound_cmd() {
	local cmd="${1:-}"
	local first="${2:-}"
	case "$first" in
		shfmt)
			# Read-only diff mode only; never a write (-w/--write).
			printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-d|--diff)([[:space:]]|$)' &&
				! printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(-w|--write)([[:space:]]|$)' && return 0
			;;
		just)
			# Anchor the target token so "just latest"/"just protest" do NOT match
			# the bare "test" substring (which would silently widen the allow-surface).
			printf '%s' "$cmd" | grep -qE '(^|[[:space:]])just[[:space:]]+(--list|test|test-[a-z][a-z-]*|persist-test|lint|format-check)([[:space:]]|$)' && return 0
			;;
		git) _is_safe_git_cmd "$cmd" && return 0 ;;
	esac
	return 1
}

_is_safe_git_cmd() {
	local cmd="${1:-}"
	# Strip 'git' + safe leading global options (-C <path>, --no-pager,
	# --no-optional-locks) so `git -C /p status` works.
	# NOT stripped: -c (config-injection vector — e.g. -c core.pager=<cmd>
	# executes arbitrary code), --git-dir=, --work-tree= (path-traversal risk).
	local sub
	sub=$(printf '%s' "$cmd" | sed -E '
		s/^git[[:space:]]+//
		:s
		s/^(-C[[:space:]]+[^[:space:]]+|--no-pager|--no-optional-locks)[[:space:]]+//
		ts
	' 2>/dev/null || true)

	# Always-read-only subcommands.
	printf '%s' "$sub" | grep -qE '^(status|diff|log|show|rev-parse)([[:space:]]|$)' && return 0
	# Read-only stash inspection only (never bare stash / pop / drop / clear / apply / push).
	printf '%s' "$sub" | grep -qE '^stash[[:space:]]+(list|show)([[:space:]]|$)' && return 0
	# branch: read-only only when no mutating flag is present.
	if printf '%s' "$sub" | grep -qE '^branch([[:space:]]|$)' &&
		! printf '%s' "$sub" | grep -qE '(^|[[:space:]])(-[dDmMcCf]|-u|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--edit-description)([[:space:]]|=|$)'; then
		return 0
	fi
	# remote: read-only listing only.
	if printf '%s' "$sub" | grep -qE '^remote([[:space:]]|$)' &&
		! printf '%s' "$sub" | grep -qE '(^|[[:space:]])(add|remove|rm|rename|set-url|set-head|prune|update)([[:space:]]|$)'; then
		return 0
	fi
	return 1
}

# ── permission_broker_should_auto_allow ───────────────────────────────
# Exit 0 only when the auto-allow policy is enabled AND class is "safe".
permission_broker_should_auto_allow() {
	local class="${1:-}"
	[[ "${OSTE_PERMISSION_AUTO_ALLOW_SAFE:-0}" == "1" ]] || return 1
	[[ "$class" == "safe" ]] || return 1
	return 0
}

# ── permission_broker_input_hash ──────────────────────────────────────
permission_broker_input_hash() {
	local session_id="${1:-}"
	local tool_name="${2:-}"
	local redacted_input_json="${3:-}"
	printf '%s' "${session_id}|${tool_name}|${redacted_input_json}" |
		shasum -a 256 | cut -d' ' -f1
}

# ── permission_broker_resolve_workroom ────────────────────────────────
# Returns workroom_ref for task or "" on any failure.
permission_broker_resolve_workroom() {
	local task_id="${1:-}"
	local tasks_file="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
	[[ -n "$task_id" && -f "$tasks_file" ]] || {
		echo ""
		return 0
	}
	jq -r --arg id "$task_id" '.tasks[$id].workroom_ref // ""' "$tasks_file" 2>/dev/null || echo ""
}

# ── permission_broker_write_receipt ──────────────────────────────────
# Append receipt JSONL; de-dupe within TTL (by input_hash or event+cwd+session_id).
permission_broker_write_receipt() {
	local task_id="${1:-unknown}"
	local receipt_json="${2:-}"
	[[ -n "$receipt_json" ]] || return 0

	local dir="${OSTE_PERMISSION_PROMPT_DIR}"
	mkdir -p "$dir" 2>/dev/null || true
	local receipt_file="${dir}/${task_id}.jsonl"

	local event input_hash new_epoch cwd_val sess_id
	event=$(printf '%s' "$receipt_json" | jq -r '.event // ""' 2>/dev/null || echo "")
	input_hash=$(printf '%s' "$receipt_json" | jq -r '.input_hash // ""' 2>/dev/null || echo "")
	new_epoch=$(printf '%s' "$receipt_json" | jq -r '.epoch // 0' 2>/dev/null || echo "0")
	cwd_val=$(printf '%s' "$receipt_json" | jq -r '.cwd // ""' 2>/dev/null || echo "")
	sess_id=$(printf '%s' "$receipt_json" | jq -r '.session_id // ""' 2>/dev/null || echo "")

	# De-dupe: hash-based for permission_request/permission_prompt with non-empty hash
	if [[ "$event" == "permission_request" || "$event" == "permission_prompt" ]]; then
		if [[ -n "$input_hash" && -f "$receipt_file" ]]; then
			if _broker_dedup_by_hash "$receipt_file" "$event" "$input_hash" "$new_epoch"; then
				return 0
			fi
		elif [[ -z "$input_hash" && -f "$receipt_file" ]]; then
			# Empty hash: de-dupe by event+cwd+session_id within TTL
			if _broker_dedup_by_cwd_session "$receipt_file" "$event" "$cwd_val" "$sess_id" "$new_epoch"; then
				return 0
			fi
		fi
	fi

	printf '%s\n' "$receipt_json" >>"$receipt_file" 2>/dev/null || true
	return 0
}

_broker_dedup_by_hash() {
	local receipt_file="$1" event="$2" input_hash="$3" new_epoch="$4"
	local ttl="${OSTE_PERMISSION_DEDUP_TTL}"
	while IFS= read -r line; do
		local line_event line_hash line_epoch
		line_event=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		line_hash=$(printf '%s' "$line" | jq -r '.input_hash // ""' 2>/dev/null || true)
		line_epoch=$(printf '%s' "$line" | jq -r '.epoch // 0' 2>/dev/null || true)
		[[ "$line_event" == "$event" && "$line_hash" == "$input_hash" ]] || continue
		[[ -n "$line_hash" ]] || continue
		local diff=$((new_epoch - line_epoch))
		[[ "$diff" -lt 0 ]] && diff=$((-diff))
		[[ "$diff" -le "$ttl" ]] && return 0
	done <"$receipt_file"
	return 1
}

_broker_dedup_by_cwd_session() {
	local receipt_file="$1" event="$2" cwd_val="$3" sess_id="$4" new_epoch="$5"
	local ttl="${OSTE_PERMISSION_DEDUP_TTL}"
	while IFS= read -r line; do
		local line_event line_cwd line_sess line_epoch
		line_event=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		line_cwd=$(printf '%s' "$line" | jq -r '.cwd // ""' 2>/dev/null || true)
		line_sess=$(printf '%s' "$line" | jq -r '.session_id // ""' 2>/dev/null || true)
		line_epoch=$(printf '%s' "$line" | jq -r '.epoch // 0' 2>/dev/null || true)
		[[ "$line_event" == "$event" && "$line_cwd" == "$cwd_val" && "$line_sess" == "$sess_id" ]] || continue
		local diff=$((new_epoch - line_epoch))
		[[ "$diff" -lt 0 ]] && diff=$((-diff))
		[[ "$diff" -le "$ttl" ]] && return 0
	done <"$receipt_file"
	return 1
}

# ── permission_broker_resolve ─────────────────────────────────────────
# Mark a pending hash as resolved by appending a resolved line.
permission_broker_resolve() {
	local task_id="${1:-unknown}"
	local input_hash="${2:-}"
	local dir="${OSTE_PERMISSION_PROMPT_DIR}"
	mkdir -p "$dir" 2>/dev/null || true
	local receipt_file="${dir}/${task_id}.jsonl"
	local ts epoch
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
	epoch=$(date +%s 2>/dev/null || echo "0")
	jq -cn \
		--arg ts "$ts" \
		--argjson epoch "$epoch" \
		--arg task_id "$task_id" \
		--arg input_hash "$input_hash" \
		'{ts: $ts, epoch: $epoch, event: "resolved", task_id: $task_id,
		  session_id: "", tool: "", input_hash: $input_hash, cwd: "",
		  permission_mode: "", transcript_path: "", classification: "",
		  decision: "resolved", workroom_ref: "", routing: "none",
		  redacted_input: {}}' >>"$receipt_file" 2>/dev/null || true
	return 0
}

# ── permission_broker_pending ─────────────────────────────────────────
# Exit 0 if a prompt is pending; exit 1 otherwise.
permission_broker_pending() {
	local task_id="${1:-}"
	local receipt_file="${OSTE_PERMISSION_PROMPT_DIR}/${task_id}.jsonl"
	[[ -f "$receipt_file" ]] || return 1

	local now
	now=$(date +%s 2>/dev/null || echo "0")
	local ttl="${OSTE_PERMISSION_DEDUP_TTL}"

	# Collect all resolved hashes
	local resolved_hashes=""
	while IFS= read -r line; do
		local ev
		ev=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		[[ "$ev" == "resolved" ]] || continue
		local h
		h=$(printf '%s' "$line" | jq -r '.input_hash // ""' 2>/dev/null || true)
		[[ -n "$h" ]] && resolved_hashes="${resolved_hashes}${h}"$'\n'
	done <"$receipt_file"

	# Check for any fresh, unresolved prompt
	while IFS= read -r line; do
		local ev decision epoch_val input_hash
		ev=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		[[ "$ev" == "permission_request" || "$ev" == "permission_prompt" ]] || continue
		decision=$(printf '%s' "$line" | jq -r '.decision // ""' 2>/dev/null || true)
		[[ "$decision" == "deny" || "$decision" == "allow" ]] && continue
		epoch_val=$(printf '%s' "$line" | jq -r '.epoch // 0' 2>/dev/null || true)
		local age=$((now - epoch_val))
		[[ "$age" -le "$ttl" ]] || continue
		input_hash=$(printf '%s' "$line" | jq -r '.input_hash // ""' 2>/dev/null || true)
		if [[ -n "$input_hash" ]]; then
			printf '%s' "$resolved_hashes" | grep -qF "$input_hash" && continue
		else
			# Empty-hash notification: check cwd+session_id resolved proxy
			local cwd_val sess_id
			cwd_val=$(printf '%s' "$line" | jq -r '.cwd // ""' 2>/dev/null || true)
			sess_id=$(printf '%s' "$line" | jq -r '.session_id // ""' 2>/dev/null || true)
			if _broker_notification_resolved "$receipt_file" "$cwd_val" "$sess_id" "$epoch_val"; then
				continue
			fi
		fi
		return 0
	done <"$receipt_file"
	return 1
}

_broker_notification_resolved() {
	local receipt_file="$1" cwd_val="$2" sess_id="$3" prompt_epoch="$4"
	while IFS= read -r line; do
		local ev
		ev=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		[[ "$ev" == "resolved" ]] || continue
		local line_epoch
		line_epoch=$(printf '%s' "$line" | jq -r '.epoch // 0' 2>/dev/null || true)
		[[ "$line_epoch" -ge "$prompt_epoch" ]] && return 0
	done <"$receipt_file"
	return 1
}

# ── permission_broker_status_json ─────────────────────────────────────
# Returns a JSON object with count, pending, degraded_routing, last, recent.
# Never fails; returns {} on error.
permission_broker_status_json() {
	local task_id="${1:-}"
	local receipt_file="${OSTE_PERMISSION_PROMPT_DIR}/${task_id}.jsonl"
	[[ -f "$receipt_file" ]] || {
		echo '{}'
		return 0
	}

	local pending_bool="false"
	permission_broker_pending "$task_id" 2>/dev/null && pending_bool="true" || true

	jq -n \
		--arg receipt_file "$receipt_file" \
		--argjson pending "$pending_bool" \
		--argjson limit "${OSTE_PERMISSION_RECENT_LIMIT}" \
		'
		[inputs] as $lines |
		($lines | map(select(.event != "resolved"))) as $prompts |
		{
			count: ($prompts | length),
			pending: $pending,
			degraded_routing: ($prompts | any(.routing == "ops_fallback" or .routing == "none")),
			last: ($prompts | last // null),
			recent: ($prompts | reverse | .[:$limit])
		}
		' "$receipt_file" 2>/dev/null || echo '{}'
}

# ── permission_broker_notify ──────────────────────────────────────────
# Send human-readable alert; fail-soft, always returns 0.
permission_broker_notify() {
	local task_id="${1:-}"
	local workroom_ref="${2:-}"
	local routing="${3:-}"
	local message="${4:-}"
	local scripts_dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

	if [[ -n "${OSTE_PERMISSION_NOTIFY_CMD:-}" ]]; then
		${OSTE_PERMISSION_NOTIFY_CMD} "$task_id" "$workroom_ref" "$routing" "$message" 2>/dev/null || true
		return 0
	fi

	local notify_script="${scripts_dir}/oste-notify.sh"
	if [[ -x "$notify_script" ]]; then
		"$notify_script" --kind attention_required \
			--task-id "$task_id" \
			--message "$message" 2>/dev/null || true
	else
		# Fallback: append to notifications outbox
		local outbox="${HOME}/.openclaw/workspace/notifications.jsonl"
		mkdir -p "$(dirname "$outbox")" 2>/dev/null || true
		jq -cn \
			--arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			--arg task_id "$task_id" \
			--arg routing "$routing" \
			--arg message "$message" \
			'{ts: $ts, kind: "permission_prompt", task_id: $task_id,
			  routing: $routing, message: $message}' \
			>>"$outbox" 2>/dev/null || true
	fi
	return 0
}
