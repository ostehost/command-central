#!/bin/bash
#
# spawn-guards.sh — Hard invariants checked before any spawn side effects
#
# Protects coding lanes from silent misrouting:
#   1. Wrong node   — e.g. a coder lane launched on the hub instead of
#                     Mike MacBook Pro. Configured via OSTE_REQUIRE_NODE.
#   2. Hidden tmux  — e.g. visible launcher terminal silently falls back to
#                     headless tmux. Configured via OSTE_REQUIRE_VISIBLE_TERMINAL.
#   2b. Missing multiplexer — e.g. a coding lane runs outside tmux/zellij and
#                     cannot be reattached. Configured via
#                     OSTE_REQUIRE_MULTIPLEXED_TERMINAL.
#   3. Wrong agent  — e.g. Codex/Gemini substituted for Claude. Configured
#                     via OSTE_REQUIRE_AGENT.
#   4. Missing automation permission — macOS TCC silently denies Ghostty
#                     AppleScript control, producing long opaque timeouts
#                     instead of an actionable error. Preflight surfaces it.
#
# Guard values come from two sources, later wins:
#   1. routing-policy.json `guards.<role>` — declarative defaults per role
#   2. OSTE_REQUIRE_* env vars — explicit orchestrator overrides (always win)
#
# Every violation dies with an actionable message; there is no silent fallback.

readonly _SPAWN_GUARDS_PROJECTS_DIR="${OSTE_PROJECTS_DIR:-/Applications/Projects}"

spawn_guards_emit_openclaw_event() {
	local reason="${1:-guardrail_violation}"
	local detail="${2:-}"
	if [[ "${OSTE_TEST_MODE:-}" == "1" && -z "${OSTE_GUARD_NOTIFY+x}" ]]; then
		return 0
	fi
	[[ "${OSTE_GUARD_NOTIFY:-1}" != "0" ]] || return 0
	command -v openclaw >/dev/null 2>&1 || return 0

	local local_host
	local_host=$(spawn_guards_local_host 2>/dev/null || printf '%s' "unknown")

	local text
	text="HOST_ROUTING_BLOCKED reason=${reason} actual_host=${local_host}"
	[[ -n "${OSTE_REQUIRE_NODE:-}" ]] && text="${text} required_host=${OSTE_REQUIRE_NODE}"
	[[ -n "${OSTE_EXEC_MODE:-}" ]] && text="${text} exec_mode=${OSTE_EXEC_MODE}"
	[[ -n "${OSTE_EXEC_NODE:-}" ]] && text="${text} exec_node=${OSTE_EXEC_NODE}"
	[[ -n "${OSTE_ROUTING_ROLE:-}" ]] && text="${text} routing_role=${OSTE_ROUTING_ROLE}"
	[[ -n "${OSTE_GUARD_TASK_ID:-}" ]] && text="${text} task_id=${OSTE_GUARD_TASK_ID}"
	[[ -n "${OSTE_GUARD_PROJECT_DIR:-}" ]] && text="${text} project=${OSTE_GUARD_PROJECT_DIR}"
	[[ -n "${OSTE_GUARD_AGENT:-}" ]] && text="${text} agent=${OSTE_GUARD_AGENT}"
	[[ -n "$detail" ]] && text="${text} detail=$(printf '%s' "$detail" | tr '\n' ' ' | tr -s ' ')"

	if openclaw system event --text "$text" --mode now --timeout "${OSTE_GUARD_NOTIFY_TIMEOUT_MS:-10000}" >/dev/null 2>&1; then
		echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) guard=host-routing-blocked reason=${reason} status=ok method=openclaw-system-event" >>/tmp/oste-wake-log.txt
	else
		echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) guard=host-routing-blocked reason=${reason} status=FAILED method=openclaw-system-event" >>/tmp/oste-wake-log.txt
	fi
}

_spawn_guards_die() {
	local reason="${OSTE_GUARD_VIOLATION_REASON:-guardrail_violation}"
	spawn_guards_emit_openclaw_event "$reason" "$*" || true
	echo "GUARDRAIL VIOLATION: $*" >&2
	exit 1
}

spawn_guards_fail() {
	local reason="${1:-guardrail_violation}"
	shift || true
	OSTE_GUARD_VIOLATION_REASON="$reason" _spawn_guards_die "$*"
}

# Resolve the local machine's ComputerName (matches --require-node values).
spawn_guards_local_host() {
	local name=""
	name=$(scutil --get ComputerName 2>/dev/null || true)
	[[ -n "$name" ]] || name=$(hostname -s 2>/dev/null || true)
	[[ -n "$name" ]] || name="unknown"
	printf '%s' "$name"
}

# Return a conservative comparison key for host names. This is intentionally
# narrower than general Unicode normalization: it lowercases ASCII and removes
# non-alphanumeric bytes so typographic apostrophes — and common mojibake forms
# of those apostrophes inherited through launchd/env — do not poison otherwise
# correct host allowlists. Exact string equality is still checked first.
spawn_guards_host_token_key() {
	local value="${1:-}"
	printf '%s' "$value" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -cd '[:alnum:]'
}

spawn_guards_host_token_matches() {
	local actual="${1:-}"
	local candidate="${2:-}"
	[[ -n "$actual" && -n "$candidate" ]] || return 1
	[[ "$actual" == "$candidate" ]] && return 0

	local actual_key candidate_key
	actual_key=$(spawn_guards_host_token_key "$actual")
	candidate_key=$(spawn_guards_host_token_key "$candidate")
	[[ -n "$actual_key" && "$actual_key" == "$candidate_key" ]]
}

# Read guard defaults from routing-policy.json into the OSTE_REQUIRE_* env vars.
# Env overrides always win: if a var is already set, it is not overwritten.
# Usage: spawn_guards_load_from_policy <role> [policy_file]
spawn_guards_load_from_policy() {
	local role="${1:-}"
	local policy_file="${2:-}"
	[[ -n "$role" ]] || return 0
	[[ -n "$policy_file" && -f "$policy_file" ]] || return 0
	command -v jq >/dev/null 2>&1 || return 0

	local node visible multiplexed agent
	node=$(jq -r --arg r "$role" '.guards[$r].require_node // empty' "$policy_file" 2>/dev/null || true)
	visible=$(jq -r --arg r "$role" '.guards[$r].require_visible_terminal // empty' "$policy_file" 2>/dev/null || true)
	multiplexed=$(jq -r --arg r "$role" '.guards[$r].require_multiplexed_terminal // empty' "$policy_file" 2>/dev/null || true)
	agent=$(jq -r --arg r "$role" '.guards[$r].require_agent // empty' "$policy_file" 2>/dev/null || true)

	if [[ -z "${OSTE_REQUIRE_NODE:-}" && -n "$node" && "$node" != "null" ]]; then
		export OSTE_REQUIRE_NODE="$node"
	fi
	if [[ -z "${OSTE_REQUIRE_VISIBLE_TERMINAL:-}" && "$visible" == "true" ]]; then
		export OSTE_REQUIRE_VISIBLE_TERMINAL=1
	fi
	if [[ -z "${OSTE_REQUIRE_MULTIPLEXED_TERMINAL:-}" && "$multiplexed" == "true" ]]; then
		export OSTE_REQUIRE_MULTIPLEXED_TERMINAL=1
	fi
	if [[ -z "${OSTE_REQUIRE_AGENT:-}" && -n "$agent" && "$agent" != "null" ]]; then
		export OSTE_REQUIRE_AGENT="$agent"
	fi
}

# Enforce OSTE_REQUIRE_NODE against the local ComputerName/hostname.
# Accepts a comma-separated list of candidates (first match passes).
spawn_guards_enforce_node() {
	local required="${OSTE_REQUIRE_NODE:-}"
	[[ -n "$required" ]] || return 0

	local local_host
	local_host=$(spawn_guards_local_host)

	local IFS=','
	for candidate in $required; do
		candidate="${candidate## }"
		candidate="${candidate%% }"
		[[ -n "$candidate" ]] || continue
		if spawn_guards_host_token_matches "$local_host" "$candidate"; then
			return 0
		fi
	done

	spawn_guards_fail "wrong_node" "node mismatch — this machine '${local_host}' is not in OSTE_REQUIRE_NODE='${required}'.
  This guarded lane must run on the required node. Refusing to fall back.
  Either dispatch via 'oste-route.sh --mode spoke --node <id>' or rerun on the correct machine."
}

# Enforce OSTE_REQUIRE_AGENT against the selected agent backend.
# Usage: spawn_guards_enforce_agent <agent_backend>
spawn_guards_enforce_agent() {
	local agent="${1:-}"
	local required="${OSTE_REQUIRE_AGENT:-}"
	[[ -n "$required" ]] || return 0
	[[ -n "$agent" ]] || spawn_guards_fail "wrong_agent" "agent backend is empty but OSTE_REQUIRE_AGENT='${required}' is set"

	local IFS=','
	for candidate in $required; do
		candidate="${candidate## }"
		candidate="${candidate%% }"
		[[ -n "$candidate" ]] || continue
		if [[ "$agent" == "$candidate" ]]; then
			return 0
		fi
	done

	spawn_guards_fail "wrong_agent" "agent mismatch — selected '--agent ${agent}' but OSTE_REQUIRE_AGENT='${required}'.
  This guarded lane forbids silent backend substitution. Refusing to fall back from ${required} to ${agent}.
  Rerun with '--agent ${required%%,*}' or unset OSTE_REQUIRE_AGENT."
}

# Enforce OSTE_REQUIRE_VISIBLE_TERMINAL against the chosen surface.
# Any mode that bypasses the real launcher terminal (tmux, no-bundle, headless)
# is rejected. A visible Ghostty bundle surface is the only accepted mode.
# Usage: spawn_guards_enforce_visible <tmux_mode_flag> <no_bundle_flag>
spawn_guards_enforce_visible() {
	local tmux_mode="${1:-}"
	local no_bundle="${2:-}"
	[[ "${OSTE_REQUIRE_VISIBLE_TERMINAL:-}" == "1" ]] || return 0

	if [[ -n "$tmux_mode" ]]; then
		spawn_guards_fail "hidden_surface" "visible terminal required but --tmux was requested.
  OSTE_REQUIRE_VISIBLE_TERMINAL=1 forbids the headless tmux surface for this lane.
  Drop --tmux (or unset OSTE_REQUIRE_VISIBLE_TERMINAL) and rerun."
	fi
	if [[ -n "$no_bundle" ]]; then
		spawn_guards_fail "hidden_surface" "visible terminal required but --no-bundle was requested.
  OSTE_REQUIRE_VISIBLE_TERMINAL=1 requires the real launcher bundle surface, not AppleScript-only.
  Drop --no-bundle and rerun."
	fi
	if ! pgrep -q WindowServer 2>/dev/null; then
		spawn_guards_fail "no_gui_session" "visible terminal required but no GUI session is available.
  OSTE_REQUIRE_VISIBLE_TERMINAL=1 needs a logged-in Aqua session to open the launcher terminal."
	fi
}

# Enforce OSTE_REQUIRE_MULTIPLEXED_TERMINAL against the chosen surface.
# Pure tmux mode is accepted. A launcher bundle surface is also accepted because
# project bundles are tmux/zellij-backed; --no-bundle is not reattachable enough
# for implementation lanes.
# Usage: spawn_guards_enforce_multiplexer <tmux_mode_flag> <no_bundle_flag>
spawn_guards_enforce_multiplexer() {
	local tmux_mode="${1:-}"
	local no_bundle="${2:-}"
	[[ "${OSTE_REQUIRE_MULTIPLEXED_TERMINAL:-}" == "1" ]] || return 0

	if [[ -n "$no_bundle" ]]; then
		spawn_guards_fail "missing_multiplexer" "multiplexed terminal required but --no-bundle was requested.
  OSTE_REQUIRE_MULTIPLEXED_TERMINAL=1 requires tmux or a launcher bundle backed by tmux/zellij.
  Drop --no-bundle, use --tmux, or launch through the project bundle."
	fi
	# Explicit --tmux is the most compatible green path. Without --tmux, the
	# launcher bundle path must provide the tmux/zellij anchor.
	return 0
}

spawn_guards_resolve_claude_opus_node() {
	local policy_file="${1:-}"

	if [[ -n "${OSTE_CLAUDE_OPUS_REQUIRE_NODE:-}" ]]; then
		printf '%s' "${OSTE_CLAUDE_OPUS_REQUIRE_NODE}"
		return 0
	fi

	[[ -n "$policy_file" && -f "$policy_file" ]] || return 0
	command -v jq >/dev/null 2>&1 || return 0

	jq -r '.guards.claude_opus.require_node // .claude_opus_hosts // .visible_launcher_hosts // .guards.coder.require_node // empty' "$policy_file" 2>/dev/null || true
}

spawn_guards_model_is_claude_opus() {
	local model="${1:-}"
	case "$model" in
		claude-opus* | opus* | *opus*) return 0 ;;
		*) return 1 ;;
	esac
}

# Claude Opus lanes are expensive/high-power lanes and must execute on the
# MacBook node. This is separate from the coder role guard: review lanes can
# still be Claude Opus, and those must not silently fall back to hub tmux.
#
# Usage: spawn_guards_enforce_claude_opus_node <agent> <model> [policy_file]
spawn_guards_enforce_claude_opus_node() {
	local agent="${1:-}"
	local model="${2:-}"
	local policy_file="${3:-}"

	[[ "$agent" == "claude" ]] || return 0
	spawn_guards_model_is_claude_opus "$model" || return 0
	if [[ "${OSTE_TEST_MODE:-}" == "1" && "${OSTE_TEST_ENFORCE_CLAUDE_OPUS_NODE_GUARD:-0}" != "1" ]]; then
		return 0
	fi

	local required
	required=$(spawn_guards_resolve_claude_opus_node "$policy_file")
	[[ -n "$required" ]] || spawn_guards_fail "claude_opus_node_unconfigured" "Claude Opus lanes are node-only, but no Claude Opus node host is configured.
  Configure .guards.claude_opus.require_node in routing-policy.json or set OSTE_CLAUDE_OPUS_REQUIRE_NODE."

	local local_host
	local_host=$(spawn_guards_local_host)

	local IFS=','
	for candidate in $required; do
		candidate="${candidate## }"
		candidate="${candidate%% }"
		[[ -n "$candidate" ]] || continue
		if spawn_guards_host_token_matches "$local_host" "$candidate"; then
			return 0
		fi
	done

	spawn_guards_fail "claude_opus_wrong_node" "Claude Opus lanes are node-only. This machine '${local_host}' is not in the required Claude Opus host set '${required}'.
  Refusing to run Claude Opus on the hub or any fallback host.
  Re-dispatch through the MacBook node and repair node Claude auth before retrying."
}

# Preflight AppleScript automation permission. macOS TCC silently denies
# AppleEvents to unapproved callers, which produces long opaque timeouts
# downstream. This probe surfaces the failure early with an actionable message.
#
# The probe uses a trivial "get name of first process" via System Events. If
# Automation permission is missing for the caller, osascript exits non-zero
# with stderr including "-1743" or "not authorized" or "assistive access".
#
# Usage: spawn_guards_preflight_automation [timeout_sec]
spawn_guards_preflight_automation() {
	[[ "${OSTE_REQUIRE_VISIBLE_TERMINAL:-}" == "1" ]] || return 0
	[[ "${OSTE_SKIP_AUTOMATION_PREFLIGHT:-}" != "1" ]] || return 0
	command -v osascript >/dev/null 2>&1 || return 0

	local timeout_sec="${1:-5}"
	local probe_output rc=0
	probe_output=$(
		(
			osascript -e 'tell application "System Events" to get name of first process' 2>&1 >/dev/null &
			local pid=$!
			local waited=0
			while kill -0 "$pid" 2>/dev/null; do
				if ((waited >= timeout_sec)); then
					kill -TERM "$pid" 2>/dev/null || true
					echo "probe timed out after ${timeout_sec}s"
					exit 124
				fi
				sleep 1
				waited=$((waited + 1))
			done
			wait "$pid"
		)
	) || rc=$?

	if [[ $rc -eq 0 ]]; then
		return 0
	fi

	if echo "$probe_output" | grep -qE '(-1743|not allowed assistive access|not authorized|Not authorised)'; then
		spawn_guards_fail "automation_denied" "AppleScript automation permission is denied for the current process.
  macOS TCC is blocking System Events AppleEvents — the launcher cannot open a visible Ghostty terminal.
  Grant the permission in: System Settings → Privacy & Security → Automation → <caller app> → enable 'System Events' (and 'Ghostty' when prompted).
  Then rerun the spawn. To bypass this preflight (not recommended), set OSTE_SKIP_AUTOMATION_PREFLIGHT=1.
  Probe stderr: ${probe_output}"
	fi

	if [[ $rc -eq 124 ]]; then
		echo "[spawn-guards] WARNING: AppleScript automation probe timed out after ${timeout_sec}s." >&2
		echo "  Visible Ghostty terminal cannot be confirmed responsive." >&2
		echo "  Downgrading to tmux mode so work is not blocked." >&2
		echo "  To diagnose: check that the user session is logged in and System Events is not blocked." >&2
		spawn_guards_emit_openclaw_event "automation_timeout" "probe timed out; downgrading to tmux" || true
		export OSTE_VISIBLE_DOWNGRADED_TO_TMUX=1
		return 0
	fi

	echo "[spawn-guards] WARNING: automation probe exited ${rc} but without a known permission signature: ${probe_output}" >&2
}

# Orchestrator entrypoint — applies every guard in the correct order.
# Must be called AFTER argument parsing but BEFORE any terminal/bundle work.
#
# Usage: spawn_guards_enforce_all <role> <agent> <tmux_mode> <no_bundle> [policy_file] [model]
spawn_guards_enforce_all() {
	local role="${1:-}"
	local agent="${2:-}"
	local tmux_mode="${3:-}"
	local no_bundle="${4:-}"
	local policy_file="${5:-}"
	local model="${6:-}"

	spawn_guards_load_from_policy "$role" "$policy_file"
	spawn_guards_enforce_claude_opus_node "$agent" "$model" "$policy_file"
	spawn_guards_enforce_node
	spawn_guards_enforce_agent "$agent"
	spawn_guards_enforce_multiplexer "$tmux_mode" "$no_bundle"
	spawn_guards_enforce_visible "$tmux_mode" "$no_bundle"
	spawn_guards_preflight_automation
}
