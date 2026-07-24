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
: "${OSTE_PERMISSION_DECISION_ACTOR:=workroom}"
: "${OSTE_PERMISSION_DECISION_LOCK_WAIT:=10}"
: "${OSTE_PERMISSION_DECISION_LOCK_STALE:=30}"

_OSTE_PERMISSION_BROKER_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/task-id.sh
source "${_OSTE_PERMISSION_BROKER_SCRIPT_DIR}/task-id.sh"

# ── Permission decision serialization + durable claims ───────────────────
# A decision is serialized by task/input hash, then claimed per prompt
# occurrence. The claim directory itself is the fail-closed record: if a
# process dies after mkdir but before claim.json is complete, later callers see
# an ambiguous claim and never steer a second key for that occurrence.
permission_broker_prompt_id_is_valid() {
	local prompt_id="${1:-}"
	[[ -z "$prompt_id" || "$prompt_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
}

permission_broker_decision_claim_dir() {
	local task_id="$1" input_hash="$2" prompt_id="${3:-}"
	permission_broker_prompt_id_is_valid "$prompt_id" || return 1
	if [[ -n "$prompt_id" ]]; then
		printf '%s/.decision-claims/%s/%s/occurrences/%s' "$OSTE_PERMISSION_PROMPT_DIR" "$task_id" "$input_hash" "$prompt_id"
	else
		# Legacy receipts did not carry prompt_id. Keep their historical claim
		# location so an already-claimed pre-upgrade prompt remains fail-closed.
		printf '%s/.decision-claims/%s/%s' "$OSTE_PERMISSION_PROMPT_DIR" "$task_id" "$input_hash"
	fi
}

permission_broker_decision_claim_json() {
	printf '%s/claim.json' "$(permission_broker_decision_claim_dir "$1" "$2" "${3:-}")"
}

permission_broker_decision_claim_state() {
	local claim_file
	permission_broker_prompt_id_is_valid "${3:-}" || return 1
	claim_file=$(permission_broker_decision_claim_json "$1" "$2" "${3:-}")
	[[ -f "$claim_file" ]] || return 1
	jq -er '.state // empty' "$claim_file" 2>/dev/null
}

permission_broker_claim_state_is_resolved() {
	case "${1:-}" in
		sent | reconciled_sent | reconciled_retired) return 0 ;;
		*) return 1 ;;
	esac
}

permission_broker_new_prompt_id() {
	local value=""
	if command -v uuidgen >/dev/null 2>&1; then
		value=$(uuidgen 2>/dev/null | LC_ALL=C tr '[:upper:]' '[:lower:]')
	fi
	if [[ -z "$value" ]]; then
		value=$(printf '%s' "$(date +%s)-${BASHPID:-$$}-${RANDOM:-0}-${RANDOM:-0}" | shasum -a 256 | awk '{print $1}')
	fi
	printf '%s' "$value"
}

_permission_broker_process_start() {
	local pid="$1"
	LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null |
		sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

# macOS Bash 3.2 has no BASHPID. A directly spawned child can still report the
# PID of the shell that invoked it through PPID; use a private file so command
# substitution does not insert an intermediary subshell and capture the wrong
# process generation.
_permission_broker_capture_current_pid() {
	local probe_dir="$1"
	if [[ -n "${BASHPID:-}" ]]; then
		_PERMISSION_DECISION_CALLER_PID="$BASHPID"
	else
		local probe
		probe=$(mktemp "${probe_dir}/.pid-probe.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _PERMISSION_DECISION_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_PERMISSION_DECISION_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_permission_broker_new_lock_token() {
	local pid="$1"
	printf '%s' "${pid}-$(date +%s)-${RANDOM:-0}-${RANDOM:-0}"
}

_permission_broker_lock_path() {
	local task_id="$1" input_hash="$2"
	printf '%s/.decision-locks/%s/%s.lock' "$OSTE_PERMISSION_PROMPT_DIR" "$task_id" "$input_hash"
}

_permission_broker_lock_age() {
	local lockdir="$1" mtime now
	mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
	now=$(date +%s 2>/dev/null || echo 0)
	printf '%s' "$((now - mtime))"
}

_permission_broker_lock_is_stale() {
	local lockdir="$1" pid start current age
	[[ -d "$lockdir" ]] || return 1
	pid=$(cat "$lockdir/pid" 2>/dev/null || true)
	start=$(cat "$lockdir/start_identity" 2>/dev/null || true)
	if [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]]; then
		current=$(_permission_broker_process_start "$pid")
		[[ -z "$current" || "$current" != "$start" ]] && return 0
		return 1
	fi
	age=$(_permission_broker_lock_age "$lockdir")
	[[ "$age" -ge "$OSTE_PERMISSION_DECISION_LOCK_STALE" ]]
}

_permission_broker_lock_reap() {
	local lockdir="$1" reapdir="${1}.reap"
	_permission_broker_lock_is_stale "$lockdir" || return 0
	if ! mkdir "$reapdir" 2>/dev/null; then
		[[ "$(_permission_broker_lock_age "$reapdir")" -ge 5 ]] && rm -rf "$reapdir"
		return 0
	fi
	if _permission_broker_lock_is_stale "$lockdir"; then
		rm -rf "$lockdir"
	fi
	rm -rf "$reapdir"
}

permission_broker_decision_lock_acquire() {
	local task_id="$1" input_hash="$2" lockdir parent pid start token waited=0
	lockdir=$(_permission_broker_lock_path "$task_id" "$input_hash")
	parent=$(dirname "$lockdir")
	(umask 077 && mkdir -p "$parent") 2>/dev/null || return 1
	_permission_broker_capture_current_pid "$parent" || return 1
	pid="$_PERMISSION_DECISION_CALLER_PID"
	while true; do
		if (umask 077 && mkdir "$lockdir") 2>/dev/null; then
			start=$(_permission_broker_process_start "$pid")
			token=$(_permission_broker_new_lock_token "$pid")
			[[ -n "$start" ]] || {
				rm -rf "$lockdir"
				return 1
			}
			if ! printf '%s\n' "$pid" >"$lockdir/pid" ||
				! printf '%s\n' "$start" >"$lockdir/start_identity" ||
				! printf '%s\n' "$token" >"$lockdir/token"; then
				rm -rf "$lockdir"
				return 1
			fi
			_PERMISSION_DECISION_LOCK_OWNED="$lockdir"
			_PERMISSION_DECISION_LOCK_OWNER_PID="$pid"
			_PERMISSION_DECISION_LOCK_TOKEN="$token"
			return 0
		fi
		_permission_broker_lock_reap "$lockdir"
		sleep 0.1
		waited=$((waited + 1))
		[[ "$waited" -lt $((OSTE_PERMISSION_DECISION_LOCK_WAIT * 10)) ]] || return 1
	done
}

permission_broker_decision_lock_release() {
	local lockdir="${_PERMISSION_DECISION_LOCK_OWNED:-}" owner_pid="${_PERMISSION_DECISION_LOCK_OWNER_PID:-}"
	local owned_token="${_PERMISSION_DECISION_LOCK_TOKEN:-}" pid start token
	[[ -n "$lockdir" ]] || return 0
	pid=$(cat "$lockdir/pid" 2>/dev/null || true)
	start=$(cat "$lockdir/start_identity" 2>/dev/null || true)
	token=$(cat "$lockdir/token" 2>/dev/null || true)
	_PERMISSION_DECISION_LOCK_OWNED=""
	_PERMISSION_DECISION_LOCK_OWNER_PID=""
	_PERMISSION_DECISION_LOCK_TOKEN=""
	[[ -n "$owner_pid" && "$pid" == "$owner_pid" ]] || return 1
	[[ -n "$owned_token" && "$token" == "$owned_token" ]] || return 1
	[[ "$start" == "$(_permission_broker_process_start "$pid")" ]] || return 1
	rm -rf "$lockdir"
}

permission_broker_decision_claim_create() {
	local task_id="$1" input_hash="$2" prompt_id="$3" claim_json="$4" claim_dir claim_file tmp
	permission_broker_prompt_id_is_valid "$prompt_id" || return 1
	claim_dir=$(permission_broker_decision_claim_dir "$task_id" "$input_hash" "$prompt_id")
	claim_file="${claim_dir}/claim.json"
	mkdir -p "$(dirname "$claim_dir")" 2>/dev/null || return 1
	mkdir "$claim_dir" 2>/dev/null || return 1
	tmp=$(mktemp "${claim_dir}/claim.json.tmp.XXXXXX") || return 1
	if printf '%s\n' "$claim_json" >"$tmp" && jq -e . "$tmp" >/dev/null 2>&1 && mv "$tmp" "$claim_file"; then
		return 0
	fi
	rm -f "$tmp" 2>/dev/null || true
	return 1
}

permission_broker_decision_claim_finalize() {
	local task_id="$1" input_hash="$2" prompt_id="$3" claim_id="$4" state="$5" claim_file tmp now epoch
	permission_broker_prompt_id_is_valid "$prompt_id" || return 1
	claim_file=$(permission_broker_decision_claim_json "$task_id" "$input_hash" "$prompt_id")
	[[ -f "$claim_file" ]] || return 1
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
	epoch=$(date +%s 2>/dev/null || echo 0)
	tmp=$(mktemp "${claim_file}.tmp.XXXXXX") || return 1
	if jq --arg claim_id "$claim_id" --arg state "$state" --arg now "$now" --argjson epoch "$epoch" '
		if .claim_id == $claim_id and .state == "claimed" and .generation == 1 then
			.state = $state |
			.generation = 2 |
			.finished_at = $now |
			.finished_epoch = $epoch |
			.delivery_ambiguous = ($state == "failed") |
			.reconciliation_required = ($state == "failed")
		else error("permission decision claim CAS mismatch") end
	' "$claim_file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]] && mv "$tmp" "$claim_file"; then
		return 0
	fi
	rm -f "$tmp" 2>/dev/null || true
	return 1
}

permission_broker_decision_claim_reconcile() {
	local task_id="$1" input_hash="$2" prompt_id="$3" claim_id="$4" decision="$5" state="$6"
	local actor="$7" reason="$8" claim_file tmp now epoch
	claim_file=$(permission_broker_decision_claim_json "$task_id" "$input_hash" "$prompt_id")
	[[ -f "$claim_file" ]] || return 1
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
	epoch=$(date +%s 2>/dev/null || echo 0)
	tmp=$(mktemp "${claim_file}.tmp.XXXXXX") || return 1
	if jq --arg task_id "$task_id" --arg input_hash "$input_hash" --arg prompt_id "$prompt_id" \
		--arg claim_id "$claim_id" --arg decision "$decision" --arg state "$state" \
		--arg actor "$actor" --arg reason "$reason" --arg now "$now" --argjson epoch "$epoch" '
		if .task_id == $task_id and .input_hash == $input_hash and (.prompt_id // "") == $prompt_id and
			.claim_id == $claim_id and .decision == $decision and (.state == "claimed" or .state == "failed") and
			((.generation | type) == "number") then
			.reconciled_from_state = .state | .state = $state | .generation += 1 |
			.reconciled_at = $now | .reconciled_epoch = $epoch | .reconciled_by = $actor |
			.reconciliation_reason = $reason | .delivery_ambiguous = true | .reconciliation_required = false
		elif .task_id == $task_id and .input_hash == $input_hash and (.prompt_id // "") == $prompt_id and
			.claim_id == $claim_id and .decision == $decision and .state == $state then .
		else error("permission reconciliation claim CAS mismatch") end
	' "$claim_file" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]] && mv "$tmp" "$claim_file"; then
		return 0
	fi
	rm -f "$tmp" 2>/dev/null || true
	return 1
}

permission_broker_reconciliation_projected() {
	local task_id="$1" claim_id="$2" state="$3" receipt_file line
	receipt_file="${OSTE_PERMISSION_PROMPT_DIR}/${task_id}.jsonl"
	[[ -f "$receipt_file" ]] || return 1
	while IFS= read -r line; do
		printf '%s' "$line" | jq -e --arg claim_id "$claim_id" --arg state "$state" '
			.event == "permission_reconciliation" and .claim_id == $claim_id and .outcome == $state
		' >/dev/null 2>&1 && return 0
	done <"$receipt_file"
	return 1
}

permission_broker_record_reconciliation() {
	local task_id="$1" claim_json="$2" state="$3" actor="$4" reason="$5" receipt_file record
	receipt_file="${OSTE_PERMISSION_PROMPT_DIR}/${task_id}.jsonl"
	permission_broker_reconciliation_projected "$task_id" "$(printf '%s' "$claim_json" | jq -r '.claim_id')" "$state" && return 0
	record=$(printf '%s' "$claim_json" | jq -c --arg state "$state" --arg actor "$actor" --arg reason "$reason" \
		--arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson epoch "$(date +%s)" '
		{ts:$ts, epoch:$epoch, event:"permission_reconciliation", task_id:.task_id,
		 task_generation:(.task_generation // null), input_hash:.input_hash, prompt_id:(.prompt_id // null),
		 claim_id:.claim_id, decision:.decision, outcome:$state, actor:$actor, reason:$reason,
		 previous_state:(.reconciled_from_state // null), delivery_ambiguous:(.delivery_ambiguous // true)}
	') || return 1
	mkdir -p "$OSTE_PERMISSION_PROMPT_DIR" 2>/dev/null || return 1
	printf '%s\n' "$record" >>"$receipt_file"
}

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
		# `find` is intentionally excluded. Its option grammar permits mutating
		# actions such as -delete, so classifying it from the first token alone is
		# not a safe basis for automatic approval.
		ls | pwd | cat | head | tail | wc | rg | grep | echo | date | whoami | jq)
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

# ── permission_broker_occurrence_key ──────────────────────────────────
# Stable occurrence identity for a permission_prompt Notification. Claude's
# prompt_id is a per-user-input UUID that rotates each turn (and session_id each
# session), so combining it with the tool-and-action-bearing message yields a key
# that:
#   - stays constant while the SAME still-pending prompt re-fires (so a replay is
#     suppressed regardless of the generic dedup TTL),
#   - differs for genuinely distinct prompts in the same turn (message differs),
#   - retires implicitly when the turn or session advances (prompt_id/session_id
#     change → a new key → the next prompt is delivered, never indefinitely
#     suppressed).
# Requires prompt_id: without it there is nothing that rotates safely, so the key
# is empty and callers fall back to the legacy TTL-scoped dedup (no regression).
permission_broker_occurrence_key() {
	local session_id="${1:-}" prompt_id="${2:-}" message="${3:-}"
	[[ -n "$prompt_id" ]] || {
		printf ''
		return 0
	}
	printf '%s' "${session_id}|${prompt_id}|${message}" | shasum -a 256 | cut -d' ' -f1
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

# Read routing and generation in one row snapshot. Spawned lanes carry
# OSTE_TASK_GENERATION, which remains authoritative even if the task ID is
# reused while a late hook is draining. If that immutable generation no longer
# owns the row, quarantine routing to ops_fallback instead of combining the old
# generation with a replacement owner's workroom. An unbound legacy hook cannot
# distinguish its original row from a reused task ID, so it remains generation-
# less and unroutable; the decision broker will reject it before claiming.
permission_broker_resolve_owner_snapshot() {
	local task_id="${1:-}"
	local tasks_file="${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
	[[ -n "$task_id" && -f "$tasks_file" ]] || {
		jq -cn --arg generation "${OSTE_TASK_GENERATION:-}" \
			'{task_generation: (if $generation == "" then null else $generation end), workroom_ref: null}'
		return 0
	}
	jq -c --arg id "$task_id" --arg generation "${OSTE_TASK_GENERATION:-}" '
		(.tasks[$id] // {}) as $row |
		($row.task_generation // "") as $row_generation |
		{
			task_generation: (
				if $generation != "" then $generation else null end
			),
			workroom_ref: (
				if $generation != "" and $generation == $row_generation
				then ($row.workroom_ref // null)
				else null end
			)
		}
	' "$tasks_file" 2>/dev/null || jq -cn --arg generation "${OSTE_TASK_GENERATION:-}" \
		'{task_generation: (if $generation == "" then null else $generation end), workroom_ref: null}'
}

# ── permission_broker_write_receipt ──────────────────────────────────
# Append receipt JSONL; de-dupe within TTL (by input_hash or event+cwd+session_id).
permission_broker_write_receipt() {
	local task_id="${1:-unknown}"
	local receipt_json="${2:-}"
	[[ -n "$receipt_json" ]] || return 0
	task_id_validate "$task_id" 2>/dev/null || return 1

	local dir="${OSTE_PERMISSION_PROMPT_DIR}"
	mkdir -p "$dir" 2>/dev/null || true
	local receipt_file="${dir}/${task_id}.jsonl"

	local event input_hash new_epoch cwd_val sess_id task_generation occurrence_key decision_lock=0
	event=$(printf '%s' "$receipt_json" | jq -r '.event // ""' 2>/dev/null || echo "")
	input_hash=$(printf '%s' "$receipt_json" | jq -r '.input_hash // ""' 2>/dev/null || echo "")
	new_epoch=$(printf '%s' "$receipt_json" | jq -r '.epoch // 0' 2>/dev/null || echo "0")
	cwd_val=$(printf '%s' "$receipt_json" | jq -r '.cwd // ""' 2>/dev/null || echo "")
	sess_id=$(printf '%s' "$receipt_json" | jq -r '.session_id // ""' 2>/dev/null || echo "")
	task_generation=$(printf '%s' "$receipt_json" | jq -r '.task_generation // ""' 2>/dev/null || echo "")
	occurrence_key=$(printf '%s' "$receipt_json" | jq -r '.occurrence_key // ""' 2>/dev/null || echo "")
	if [[ "$event" == "permission_request" && "$input_hash" =~ ^[a-f0-9]{64}$ && "$task_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
		permission_broker_decision_lock_acquire "$task_id" "$input_hash" || return 1
		decision_lock=1
	fi

	# De-dupe: hash-based for permission_request/permission_prompt with non-empty hash
	if [[ "$event" == "permission_request" || "$event" == "permission_prompt" ]]; then
		if [[ -n "$input_hash" && -f "$receipt_file" ]]; then
			if _broker_dedup_by_hash "$task_id" "$receipt_file" "$event" "$input_hash" "$new_epoch" "$task_generation"; then
				[[ "$decision_lock" -eq 1 ]] && permission_broker_decision_lock_release
				return 0
			fi
		elif [[ -z "$input_hash" && -f "$receipt_file" ]]; then
			if [[ -n "$occurrence_key" ]]; then
				# Occurrence-keyed de-dupe (permission_prompt carrying Claude's
				# prompt_id): suppress a replay of the SAME occurrence regardless
				# of the generic TTL, so a still-pending prompt does not re-alert
				# just because the TTL lapsed. The key rotates with
				# prompt_id/session, so a genuinely new prompt is never suppressed.
				if _broker_dedup_by_occurrence "$receipt_file" "$event" "$occurrence_key"; then
					[[ "$decision_lock" -eq 1 ]] && permission_broker_decision_lock_release
					return 0
				fi
			# Empty hash, no occurrence key: de-dupe by event+cwd+session_id within TTL
			elif _broker_dedup_by_cwd_session "$receipt_file" "$event" "$cwd_val" "$sess_id" "$new_epoch"; then
				[[ "$decision_lock" -eq 1 ]] && permission_broker_decision_lock_release
				return 0
			fi
		fi
	fi

	printf '%s\n' "$receipt_json" >>"$receipt_file" 2>/dev/null || true
	[[ "$decision_lock" -eq 1 ]] && permission_broker_decision_lock_release
	return 0
}

_broker_dedup_by_hash() {
	local task_id="$1" receipt_file="$2" event="$3" input_hash="$4" new_epoch="$5" task_generation="${6:-}"
	local ttl="${OSTE_PERMISSION_DEDUP_TTL}"
	while IFS= read -r line; do
		local line_event line_hash line_epoch line_generation prompt_id claim_state
		line_event=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		line_hash=$(printf '%s' "$line" | jq -r '.input_hash // ""' 2>/dev/null || true)
		line_epoch=$(printf '%s' "$line" | jq -r '.epoch // 0' 2>/dev/null || true)
		[[ "$line_event" == "$event" && "$line_hash" == "$input_hash" ]] || continue
		line_generation=$(printf '%s' "$line" | jq -r '.task_generation // ""' 2>/dev/null || true)
		[[ "$line_generation" == "$task_generation" ]] || continue
		[[ -n "$line_hash" ]] || continue
		local diff=$((new_epoch - line_epoch))
		[[ "$diff" -lt 0 ]] && diff=$((-diff))
		[[ "$diff" -le "$ttl" ]] || continue
		prompt_id=$(printf '%s' "$line" | jq -r '.prompt_id // ""' 2>/dev/null || true)
		claim_state=$(permission_broker_decision_claim_state "$task_id" "$input_hash" "$prompt_id" 2>/dev/null || true)
		permission_broker_claim_state_is_resolved "$claim_state" && continue
		_broker_prompt_has_sent_projection "$receipt_file" "$input_hash" "$prompt_id" && continue
		return 0
	done <"$receipt_file"
	return 1
}

_broker_prompt_has_sent_projection() {
	local receipt_file="$1" input_hash="$2" prompt_id="$3" line event line_hash line_prompt status
	while IFS= read -r line; do
		event=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		[[ "$event" == "permission_decision" ]] || continue
		status=$(printf '%s' "$line" | jq -r '.apply_status // ""' 2>/dev/null || true)
		[[ "$status" == "sent" ]] || continue
		line_hash=$(printf '%s' "$line" | jq -r '.input_hash // ""' 2>/dev/null || true)
		[[ "$line_hash" == "$input_hash" ]] || continue
		line_prompt=$(printf '%s' "$line" | jq -r '.prompt_id // ""' 2>/dev/null || true)
		if [[ -n "$prompt_id" ]]; then
			[[ "$line_prompt" == "$prompt_id" ]] && return 0
		else
			[[ -z "$line_prompt" ]] && return 0
		fi
	done <"$receipt_file"
	return 1
}

_broker_dedup_by_occurrence() {
	local receipt_file="$1" event="$2" occurrence_key="$3" line
	[[ -n "$occurrence_key" ]] || return 1
	# Deliberately NOT time-bounded: the same still-pending prompt must not
	# re-alert merely because a generic TTL lapsed. The occurrence_key embeds
	# Claude's prompt_id + session_id, both of which rotate when the turn or
	# session advances, so a genuinely new prompt earns a fresh key and is
	# delivered — there is no indefinite-suppression bug.
	while IFS= read -r line; do
		local line_event line_key
		line_event=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		[[ "$line_event" == "$event" ]] || continue
		line_key=$(printf '%s' "$line" | jq -r '.occurrence_key // ""' 2>/dev/null || true)
		[[ "$line_key" == "$occurrence_key" ]] && return 0
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

# ── permission_broker_decision_key ─────────────────────────────────────
# Map a validated workroom decision to the current Claude Code TUI prompt.
# Keep this intentionally tiny: callers may choose only allow-once or deny.
permission_broker_decision_key() {
	local decision="${1:-}"
	case "$decision" in
		allow)
			echo "1"
			;;
		deny)
			echo "2"
			;;
		*)
			return 1
			;;
	esac
}

# ── permission_broker_record_decision ──────────────────────────────────
# Append a decision receipt for a validated prompt apply attempt.
permission_broker_record_decision() {
	local task_id="${1:-unknown}" prompt_json="${2:-{}}" decision="${3:-}" actor="${4:-${OSTE_PERMISSION_DECISION_ACTOR}}"
	local reason="${5:-}" apply_status="${6:-}" applied_key="${7:-}" claim_id="${8:-}" prompt_id="${9:-}"
	local ts epoch input_hash session_id tool cwd classification workroom_ref routing task_generation redacted_input
	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
	epoch=$(date +%s 2>/dev/null || echo "0")
	input_hash=$(printf '%s' "$prompt_json" | jq -r '.input_hash // ""' 2>/dev/null || echo "")
	session_id=$(printf '%s' "$prompt_json" | jq -r '.session_id // ""' 2>/dev/null || echo "")
	tool=$(printf '%s' "$prompt_json" | jq -r '.tool // ""' 2>/dev/null || echo "")
	cwd=$(printf '%s' "$prompt_json" | jq -r '.cwd // ""' 2>/dev/null || echo "")
	classification=$(printf '%s' "$prompt_json" | jq -r '.classification // ""' 2>/dev/null || echo "")
	workroom_ref=$(printf '%s' "$prompt_json" | jq -r '.workroom_ref // ""' 2>/dev/null || echo "")
	routing=$(printf '%s' "$prompt_json" | jq -r '.routing // ""' 2>/dev/null || echo "")
	task_generation=$(printf '%s' "$prompt_json" | jq -r '.task_generation // ""' 2>/dev/null || echo "")
	redacted_input=$(printf '%s' "$prompt_json" | jq -c 'try (.redacted_input // {}) catch {}' 2>/dev/null | head -n 1 || true)
	[[ -n "$redacted_input" ]] || redacted_input='{}'
	mkdir -p "${OSTE_PERMISSION_PROMPT_DIR}" 2>/dev/null || true
	jq -cn \
		--arg ts "$ts" --argjson epoch "$epoch" --arg task_id "$task_id" --arg session_id "$session_id" \
		--arg tool "$tool" --arg input_hash "$input_hash" --arg cwd "$cwd" --arg classification "$classification" \
		--arg decision "$decision" --arg actor "$actor" --arg reason "$reason" --arg apply_status "$apply_status" \
		--arg applied_key "$applied_key" --arg workroom_ref "$workroom_ref" --arg routing "$routing" \
		--arg task_generation "$task_generation" --arg redacted_input "$redacted_input" --arg claim_id "$claim_id" --arg prompt_id "$prompt_id" \
		'{ts: $ts, epoch: $epoch, event: "permission_decision", task_id: $task_id,
		  task_generation: (if $task_generation == "" then null else $task_generation end),
		  session_id: $session_id, tool: $tool, input_hash: $input_hash, cwd: $cwd,
		  permission_mode: "", transcript_path: "", classification: $classification,
		  decision: $decision, actor: $actor, reason: $reason, apply_status: $apply_status,
		  applied_key: $applied_key, workroom_ref: $workroom_ref, routing: $routing,
		  claim_id: (if $claim_id == "" then null else $claim_id end),
		  prompt_id: (if $prompt_id == "" then null else $prompt_id end),
		  redacted_input: ($redacted_input | fromjson? // {})}' >>"${OSTE_PERMISSION_PROMPT_DIR}/${task_id}.jsonl" 2>/dev/null || true
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
		local ev decision epoch_val input_hash prompt_id
		ev=$(printf '%s' "$line" | jq -r '.event // ""' 2>/dev/null || true)
		[[ "$ev" == "permission_request" || "$ev" == "permission_prompt" ]] || continue
		decision=$(printf '%s' "$line" | jq -r '.decision // ""' 2>/dev/null || true)
		[[ "$decision" == "deny" || "$decision" == "allow" ]] && continue
		epoch_val=$(printf '%s' "$line" | jq -r '.epoch // 0' 2>/dev/null || true)
		local age=$((now - epoch_val))
		input_hash=$(printf '%s' "$line" | jq -r '.input_hash // ""' 2>/dev/null || true)
		if [[ -n "$input_hash" ]]; then
			# A successfully delivered canonical claim resolves the prompt even if
			# the best-effort JSONL projection was interrupted. A durable claim is
			# not a TTL-scoped notification: claimed/failed or malformed claims must
			# remain pending after the original prompt receipt ages out, otherwise a
			# crash or ambiguous terminal delivery silently clears the completion
			# gate. Only a canonical sent/reconciled state is resolved.
			local claim_state="" claim_file="" claim_dir=""
			prompt_id=$(printf '%s' "$line" | jq -r '.prompt_id // ""' 2>/dev/null || true)
			claim_file=$(permission_broker_decision_claim_json "$task_id" "$input_hash" "$prompt_id" 2>/dev/null || true)
			[[ -n "$claim_file" ]] && claim_dir=$(dirname "$claim_file")
			claim_state=$(permission_broker_decision_claim_state "$task_id" "$input_hash" "$prompt_id" 2>/dev/null || true)
			permission_broker_claim_state_is_resolved "$claim_state" && continue
			_broker_prompt_has_sent_projection "$receipt_file" "$input_hash" "$prompt_id" && continue
			if [[ -n "$claim_file" && (-f "$claim_file" || -d "$claim_dir") ]]; then
				return 0
			fi
			[[ "$age" -le "$ttl" ]] || continue
			if [[ -z "$prompt_id" ]]; then
				printf '%s' "$resolved_hashes" | grep -qF "$input_hash" && continue
			fi
		else
			[[ "$age" -le "$ttl" ]] || continue
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
