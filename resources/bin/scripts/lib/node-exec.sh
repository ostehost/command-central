#!/bin/bash
#
# node-exec.sh — Remote node execution via OpenClaw gateway
#
# Replaces the removed `openclaw nodes run` with the modern
# `system.run.prepare` -> `system.run` node.invoke flow.
#
# Usage:
#   source "${SCRIPT_DIR}/lib/node-exec.sh"
#   node_exec <node-id> <command-string>
#
# Prints remote stdout/stderr locally and returns the remote exit code.
#

resolve_node_id() {
	local query="$1"
	local nodes_json=""
	local match=""

	[[ -n "$query" ]] || return 1

	nodes_json=$(openclaw nodes list --json 2>/dev/null || true)
	[[ -n "$nodes_json" ]] || {
		echo "$query"
		return 0
	}

	match=$(echo "$nodes_json" | jq -r \
		--arg q "$query" \
		'.paired[]? | select(.nodeId == $q) | .nodeId' | head -1)
	[[ -n "$match" ]] && {
		echo "$match"
		return 0
	}

	match=$(echo "$nodes_json" | jq -r \
		--arg q "$query" \
		'.paired[]? | select((.displayName // "") | ascii_downcase == ($q | ascii_downcase)) | .nodeId' | head -1)
	[[ -n "$match" ]] && {
		echo "$match"
		return 0
	}

	match=$(echo "$nodes_json" | jq -r \
		--arg q "$query" \
		'.paired[]? | select((.displayName // "") | ascii_downcase | contains($q | ascii_downcase)) | .nodeId' | head -1)
	[[ -n "$match" ]] && {
		echo "$match"
		return 0
	}

	echo "$query"
}

node_exec_preflight() {
	local query="$1"
	local nodes_json match_count node_json display connected paired missing_commands required_commands

	[[ -n "$query" ]] || {
		echo "node_exec_preflight: node-id is required" >&2
		return 1
	}

	nodes_json=$(openclaw nodes status --json 2>/dev/null) || {
		echo "node-preflight: nodes-status-failed: openclaw nodes status --json failed" >&2
		return 1
	}

	match_count=$(printf '%s' "$nodes_json" | jq -r --arg q "$query" '
		[ (.nodes // [])[]?
		  | select(
				(.nodeId == $q)
				or ((.displayName // "") | ascii_downcase == ($q | ascii_downcase))
				or ((.displayName // "") | ascii_downcase | contains($q | ascii_downcase))
			)
		] | length
	' 2>/dev/null) || {
		echo "node-preflight: nodes-status-unparseable" >&2
		return 1
	}

	if [[ "$match_count" == "0" ]]; then
		echo "node-preflight: node-not-found: ${query}" >&2
		return 1
	fi
	if [[ "$match_count" != "1" ]]; then
		echo "node-preflight: node-ambiguous: ${query} matched ${match_count} nodes" >&2
		return 1
	fi

	node_json=$(printf '%s' "$nodes_json" | jq -c --arg q "$query" '
		[ (.nodes // [])[]?
		  | select(
				(.nodeId == $q)
				or ((.displayName // "") | ascii_downcase == ($q | ascii_downcase))
				or ((.displayName // "") | ascii_downcase | contains($q | ascii_downcase))
			)
		][0]
	')
	display=$(printf '%s' "$node_json" | jq -r '.displayName // .nodeId // "unknown-node"')
	paired=$(printf '%s' "$node_json" | jq -r '.paired // false')
	connected=$(printf '%s' "$node_json" | jq -r '.connected // false')

	if [[ "$paired" != "true" ]]; then
		echo "node-preflight: node-not-paired: ${display}" >&2
		return 1
	fi
	if [[ "$connected" != "true" ]]; then
		echo "node-preflight: node-not-connected: ${display} is paired but disconnected; remote launcher work is blocked until ai.openclaw.node reannounces" >&2
		return 1
	fi

	required_commands='["system.run","system.run.prepare","system.which"]'
	missing_commands=$(printf '%s' "$node_json" | jq -r --argjson required "$required_commands" '
		($required - (.commands // [])) | join(",")
	')
	if [[ -n "$missing_commands" ]]; then
		echo "node-preflight: node-missing-capability: ${display} lacks ${missing_commands}" >&2
		return 1
	fi
}

build_node_shell_argv_json() {
	local command="$1"
	jq -cn --arg cmd "$command" '["/bin/sh", "-lc", $cmd]'
}

node_exec_gateway_call() {
	local params="$1"
	local timeout_ms="${OSTE_NODE_EXEC_TIMEOUT_MS:-30000}"
	openclaw gateway call node.invoke --json --timeout "$timeout_ms" --params "$params"
}

node_exec() {
	local node_id="$1"
	local command="$2"

	[[ -n "$node_id" ]] || {
		echo "node_exec: node-id is required" >&2
		return 1
	}
	[[ -n "$command" ]] || {
		echo "node_exec: command is required" >&2
		return 1
	}

	local resolved_node_id prepare_idem run_idem shell_argv_json prepare_params prepare_response
	local prepared_plan run_params run_response stdout stderr exit_code error

	resolved_node_id=$(resolve_node_id "$node_id")
	shell_argv_json=$(build_node_shell_argv_json "$command")
	prepare_idem="node-exec-prepare-$$-$(date +%s)"
	prepare_params=$(jq -cn \
		--arg nodeId "$resolved_node_id" \
		--argjson command "$shell_argv_json" \
		--arg rawCommand "$command" \
		--arg idempotencyKey "$prepare_idem" \
		'{"nodeId": $nodeId, "command": "system.run.prepare", "params": {"command": $command, "rawCommand": $rawCommand}, "idempotencyKey": $idempotencyKey}')

	prepare_response=$(node_exec_gateway_call "$prepare_params") || return $?
	prepared_plan=$(printf '%s' "$prepare_response" | jq -c '.payload.plan // empty')
	[[ -n "$prepared_plan" && "$prepared_plan" != "null" ]] || {
		echo "node_exec: invalid system.run.prepare response" >&2
		return 1
	}

	run_idem="node-exec-run-$$-$(date +%s)"
	run_params=$(jq -cn \
		--arg nodeId "$resolved_node_id" \
		--arg idempotencyKey "$run_idem" \
		--argjson plan "$prepared_plan" \
		'{"nodeId": $nodeId, "command": "system.run", "params": ({"command": $plan.argv, "rawCommand": $plan.commandText, "systemRunPlan": $plan} + (if $plan.cwd != null then {"cwd": $plan.cwd} else {} end)), "idempotencyKey": $idempotencyKey}')

	run_response=$(node_exec_gateway_call "$run_params") || return $?
	stdout=$(printf '%s' "$run_response" | jq -r '.payload.stdout // ""')
	stderr=$(printf '%s' "$run_response" | jq -r '.payload.stderr // ""')
	error=$(printf '%s' "$run_response" | jq -r '.payload.error // ""')
	exit_code=$(printf '%s' "$run_response" | jq -r '.payload.exitCode // 1')

	[[ -n "$stdout" ]] && printf '%s' "$stdout"
	[[ -n "$stderr" ]] && printf '%s' "$stderr" >&2
	if [[ -n "$error" && "$error" != "null" && -z "$stderr" ]]; then
		printf '%s\n' "$error" >&2
	fi

	return "$exit_code"
}
