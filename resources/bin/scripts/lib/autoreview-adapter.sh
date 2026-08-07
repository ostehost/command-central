#!/bin/bash
# autoreview-adapter.sh — adapter for the canonical autoreview receipt v2
# helper (agent-skills). Not wired into any production dispatch path: the
# watchdog/review-agent chain never sources this file, and wiring remains a
# separately authorized slice. It carries exactly one composition over its
# verified primitives: the store-free core
# (autoreview_adapter_invoke_canonical_core +
# autoreview_adapter_emit_lifecycle_evidence) — canonical identity -> bounded
# launch -> stdout-pin capture -> byte-exact authentication -> payload
# validation -> 20-key lifecycle evidence emission. Nothing here persists:
# evidence persistence is solely the lifecycle's dedicated record operation,
# under its lock/WAL/CAS authority (GHLAR-04 retired the duplicate fixture
# persistence model that used to live alongside this path).
#
# Trust model:
# - The helper identity binds repository origin + exact revision + in-tree
#   location + resolved realpath + executable bit + SHA-256. The checkout
#   root is the only caller-supplied coordinate (hub and node roots differ);
#   HOME, PATH, and ambient environment can never redirect resolution.
# - The stdout `receipt_artifact_digest:` marker is captured directly from
#   the child and pinned before any receipt-file content is trusted.
# - Payload bytes are authenticated exactly as stored; nothing is ever
#   re-serialized before hashing.
# - A clean receipt is closeout-eligible EVIDENCE only. Nothing in this file
#   approves, closes, or transitions workroom lifecycle state.

if declare -f autoreview_adapter_verify_helper_identity >/dev/null 2>&1; then
	return 0
fi

# Canonical helper pins and key sets live in the shared contract module,
# adjacent to this file (the deployment closure must carry both together).
# The adapter never restates a pin literal; a missing, unreadable, or
# incoherent contract fails this whole source (fail closed).
if ! source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/autoreview-contract.sh" ||
	! declare -f autoreview_contract_loaded >/dev/null 2>&1; then
	printf 'autoreview-adapter: contract_unavailable: refusing to load (fail closed)\n' >&2
	return 1
fi

_autoreview_adapter_fail() {
	printf 'autoreview-adapter: %s: %s\n' "${2:-rejected}" "$1" >&2
	return 1
}

_autoreview_adapter_sha256_file() {
	local digest
	digest=$(shasum -a 256 "${1:-}" 2>/dev/null | awk '{print $1}')
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

_autoreview_adapter_realdir() {
	(cd "${1:-}" 2>/dev/null && pwd -P)
}

# Origin normalization is contract-owned policy; this name is kept for
# existing callers and delegates without restating any semantics.
autoreview_adapter_normalize_origin() {
	autoreview_contract_normalize_origin "$@"
}

# Verify that a checkout root holds the trusted helper. Every coordinate is
# proven: repo-root realpath, origin identity, exact HEAD revision, committed
# 100755 tree entry at the expected relative location, on-disk regular file
# whose realpath stays inside the checkout, executable bit, and SHA-256.
# Prints the resolved helper realpath on success. Never executes the helper.
autoreview_adapter_verify_helper_identity() {
	local root="${1:-}" origin="${2:-}" revision="${3:-}" relpath="${4:-}" digest="${5:-}"
	[[ -n "$root" && -n "$origin" && -n "$relpath" ]] || {
		_autoreview_adapter_fail args_missing identity_rejected
		return 1
	}
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
		_autoreview_adapter_fail revision_invalid identity_rejected
		return 1
	}
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
		_autoreview_adapter_fail digest_invalid identity_rejected
		return 1
	}
	[[ -d "$root" ]] || {
		_autoreview_adapter_fail checkout_missing identity_rejected
		return 1
	}
	local root_real toplevel
	root_real=$(_autoreview_adapter_realdir "$root") || {
		_autoreview_adapter_fail checkout_missing identity_rejected
		return 1
	}
	toplevel=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || {
		_autoreview_adapter_fail not_a_repo identity_rejected
		return 1
	}
	[[ "$(_autoreview_adapter_realdir "$toplevel")" == "$root_real" ]] || {
		_autoreview_adapter_fail not_repo_root identity_rejected
		return 1
	}
	local remote_url norm_actual norm_expected
	remote_url=$(git -C "$root" remote get-url origin 2>/dev/null) || {
		_autoreview_adapter_fail origin_missing identity_rejected
		return 1
	}
	norm_actual=$(autoreview_adapter_normalize_origin "$remote_url") || {
		_autoreview_adapter_fail origin_unparseable identity_rejected
		return 1
	}
	norm_expected=$(autoreview_adapter_normalize_origin "$origin") || {
		_autoreview_adapter_fail origin_unparseable identity_rejected
		return 1
	}
	[[ "$norm_actual" == "$norm_expected" ]] || {
		_autoreview_adapter_fail origin_mismatch identity_rejected
		return 1
	}
	local head_sha
	head_sha=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null) || {
		_autoreview_adapter_fail revision_unreadable identity_rejected
		return 1
	}
	[[ "$head_sha" == "$revision" ]] || {
		_autoreview_adapter_fail revision_mismatch identity_rejected
		return 1
	}
	local tree_mode
	tree_mode=$(git -C "$root" ls-tree HEAD -- "$relpath" 2>/dev/null | awk 'NR==1 {print $1}')
	[[ "$tree_mode" == "$AUTOREVIEW_CONTRACT_TREE_MODE" ]] || {
		_autoreview_adapter_fail tree_entry_invalid identity_rejected
		return 1
	}
	local helper_path="$root/$relpath"
	[[ ! -L "$helper_path" && -f "$helper_path" ]] || {
		_autoreview_adapter_fail not_regular_file identity_rejected
		return 1
	}
	local helper_real
	helper_real="$(_autoreview_adapter_realdir "$(dirname "$helper_path")")/$(basename "$helper_path")" || {
		_autoreview_adapter_fail realpath_unresolvable identity_rejected
		return 1
	}
	[[ "$helper_real" == "$root_real/$relpath" ]] || {
		_autoreview_adapter_fail realpath_escape identity_rejected
		return 1
	}
	[[ -x "$helper_path" ]] || {
		_autoreview_adapter_fail not_executable identity_rejected
		return 1
	}
	local actual_digest
	actual_digest=$(_autoreview_adapter_sha256_file "$helper_path") || {
		_autoreview_adapter_fail digest_unreadable identity_rejected
		return 1
	}
	[[ "$actual_digest" == "$digest" ]] || {
		_autoreview_adapter_fail digest_mismatch identity_rejected
		return 1
	}
	printf '%s\n' "$helper_real"
}

# Resolve the canonical helper from an application-owned checkout root using
# only the baked-in pins. The root is the sole variable coordinate; the
# config-managed fork, a reviewed repository, or any other checkout fails on
# origin, revision, or digest before anything could execute.
autoreview_adapter_resolve_canonical_helper() {
	autoreview_adapter_verify_helper_identity "${1:-}" \
		"$AUTOREVIEW_CONTRACT_ORIGIN_FETCH_URL" \
		"$AUTOREVIEW_CONTRACT_REVISION" \
		"$AUTOREVIEW_CONTRACT_RELPATH" \
		"$AUTOREVIEW_CONTRACT_SHA256"
}

# Verified helper identity as a first-class gate result: the exact six-key
# object lifecycle evidence carries. Every value is the contract's or the
# gate's own output — the caller supplies only the checkout root, and no
# caller JSON or ambient environment can substitute a coordinate. The gate
# runs (or re-runs) here so a printed identity always reflects a checkout
# that proved origin, revision, tree mode, containment, and digest NOW.
autoreview_adapter_canonical_helper_identity() {
	local root="${1:-}" helper_real
	helper_real=$(autoreview_adapter_resolve_canonical_helper "$root") || return 1
	jq -cn \
		--arg origin "$AUTOREVIEW_CONTRACT_ORIGIN_IDENTITY" \
		--argjson policy_version "$AUTOREVIEW_CONTRACT_HELPER_POLICY_VERSION" \
		--arg realpath "$helper_real" \
		--arg relpath "$AUTOREVIEW_CONTRACT_RELPATH" \
		--arg revision "$AUTOREVIEW_CONTRACT_REVISION" \
		--arg sha256 "$AUTOREVIEW_CONTRACT_SHA256" \
		'{origin: $origin, policy_version: $policy_version, realpath: $realpath,
			relpath: $relpath, revision: $revision, sha256: $sha256}'
}

# Launch the helper with an argv vector under a controlled child environment:
# bounded wall clock, stdout/stderr caps enforced LIVE during execution,
# receipt and report forced outside the reviewed repository. The child is a
# session leader (perl setsid shim — Darwin ships no setsid(1)), so a bound
# violation retires the whole process group, then sweeps for setsid-escaped
# descendants that reference the capture dir. Returns the child's exit code,
# 124 on timeout, 125 on an output-cap violation, 1 on usage/containment
# errors — including survivors that outlive the post-exit sweep (fail-closed;
# ADR 0003: process groups are containment, never complete exit authority).
autoreview_adapter_run_helper() {
	local helper="" python="" repo="" out_dir="" commit="" expect_override=""
	local timeout_seconds="" cap_bytes="" engine_bin="" ecpd=""
	local binds=() child_env=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--helper)
				helper="${2:-}"
				shift 2
				;;
			--python)
				python="${2:-}"
				shift 2
				;;
			--repo)
				repo="${2:-}"
				shift 2
				;;
			--out-dir)
				out_dir="${2:-}"
				shift 2
				;;
			--commit)
				commit="${2:-}"
				shift 2
				;;
			--expect-commit-override)
				expect_override="${2:-}"
				shift 2
				;;
			--timeout-seconds)
				timeout_seconds="${2:-}"
				shift 2
				;;
			--output-cap-bytes)
				cap_bytes="${2:-}"
				shift 2
				;;
			--engine-bin)
				engine_bin="${2:-}"
				shift 2
				;;
			--expect-changed-paths-digest)
				ecpd="${2:-}"
				shift 2
				;;
			--bind)
				binds+=("${2:-}")
				shift 2
				;;
			--child-env)
				child_env+=("${2:-}")
				shift 2
				;;
			*)
				_autoreview_adapter_fail "unknown argument: $1" run_rejected
				return 1
				;;
		esac
	done
	[[ -n "$helper" && -f "$helper" && -x "$helper" ]] || {
		_autoreview_adapter_fail helper_invalid run_rejected
		return 1
	}
	[[ -n "$repo" && -d "$repo" ]] || {
		_autoreview_adapter_fail repo_invalid run_rejected
		return 1
	}
	[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || {
		_autoreview_adapter_fail commit_invalid run_rejected
		return 1
	}
	[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
		_autoreview_adapter_fail timeout_invalid run_rejected
		return 1
	}
	[[ "$cap_bytes" =~ ^[1-9][0-9]*$ ]] || {
		_autoreview_adapter_fail cap_invalid run_rejected
		return 1
	}
	[[ -n "$engine_bin" && -f "$engine_bin" && -x "$engine_bin" ]] || {
		_autoreview_adapter_fail engine_bin_invalid run_rejected
		return 1
	}
	# --child-env is a fixture-only channel: only the AUTOREVIEW_FAKE_*
	# namespace may pass through env -i. Production callers pass none; any
	# other name is refused before a child could exist (semantic allowlist,
	# not a syntax check — the namespace makes the intent unmistakable).
	local ce_pair
	for ce_pair in "${child_env[@]+"${child_env[@]}"}"; do
		[[ "$ce_pair" =~ ^AUTOREVIEW_FAKE_[A-Z0-9_]*=[[:print:]]*$ ]] || {
			_autoreview_adapter_fail child_env_forbidden run_rejected
			return 1
		}
	done
	[[ -n "$out_dir" ]] || {
		_autoreview_adapter_fail out_dir_missing run_rejected
		return 1
	}
	mkdir -p "$out_dir" || {
		_autoreview_adapter_fail out_dir_uncreatable run_rejected
		return 1
	}
	local out_real repo_real
	out_real=$(_autoreview_adapter_realdir "$out_dir") || {
		_autoreview_adapter_fail out_dir_uncreatable run_rejected
		return 1
	}
	repo_real=$(_autoreview_adapter_realdir "$repo") || {
		_autoreview_adapter_fail repo_invalid run_rejected
		return 1
	}
	if [[ "$out_real" == "$repo_real" || "$out_real" == "$repo_real"/* ]]; then
		rmdir "$out_real" 2>/dev/null || true
		_autoreview_adapter_fail output_inside_repo run_rejected
		return 1
	fi
	mkdir -p "$out_real/home" "$out_real/tmp"
	local expect_commit="${expect_override:-$commit}"
	local argv=()
	[[ -n "$python" ]] && argv+=("$python")
	argv+=("$helper" --mode commit --commit "$commit" --expect-commit "$expect_commit")
	argv+=(--engine codex --codex-bin "$engine_bin")
	argv+=(--receipt-output "$out_real/receipt.json" --json-output "$out_real/report.json")
	[[ -n "$ecpd" ]] && argv+=(--expect-changed-paths-digest "$ecpd")
	local b
	for b in "${binds[@]+"${binds[@]}"}"; do
		argv+=(--bind "$b")
	done
	local envp=("HOME=$out_real/home" "USERPROFILE=$out_real/home" "PATH=/usr/bin:/bin" "LC_ALL=C" "TMPDIR=$out_real/tmp")
	for b in "${child_env[@]+"${child_env[@]}"}"; do
		envp+=("$b")
	done
	# The perl shim makes the child a session leader before exec, so its pgid
	# equals its pid and the whole helper/engine tree lands in one group.
	# /usr/bin/perl is inside the fixed child PATH roots; Darwin has no
	# setsid(1) executable. The leader stays unreaped until after any group
	# signal, so the pgid cannot be recycled out from under a kill.
	(cd "$repo_real" && exec env -i "${envp[@]}" /usr/bin/perl -e \
		'use POSIX qw(setsid); setsid() != -1 or die "setsid: $!\n"; exec { $ARGV[0] } @ARGV or die "exec: $!\n";' \
		-- "${argv[@]}") >"$out_real/stdout.log" 2>"$out_real/stderr.log" &
	local pid=$!
	local rc=0 bound_rc=0
	_autoreview_adapter_supervise "$pid" "$timeout_seconds" "$cap_bytes" "$out_real" || bound_rc=$?
	if [[ "$bound_rc" -eq 125 ]]; then
		_autoreview_adapter_fail output_cap_exceeded run_rejected || true
		return 125
	fi
	if [[ "$bound_rc" -ne 0 ]]; then
		printf 'autoreview-adapter: run_timeout after %ss\n' "$timeout_seconds" >&2
		return 124
	fi
	wait "$pid" || rc=$?
	if ! _autoreview_adapter_post_exit_sweep "$pid" "$out_real"; then
		_autoreview_adapter_fail residual_children_unretirable run_rejected
		return 1
	fi
	local size
	for f in "$out_real/stdout.log" "$out_real/stderr.log"; do
		size=$(wc -c <"$f" | tr -d ' ')
		if [[ "$size" -gt "$cap_bytes" ]]; then
			_autoreview_adapter_fail output_cap_exceeded run_rejected || true
			return 125
		fi
	done
	return "$rc"
}

# Supervise the session leader: enforce the wall clock AND the output caps
# live, retiring the whole tree the moment either bound is violated. rc 0 =
# child exited within bounds; 124 = timeout; 125 = live cap breach.
_autoreview_adapter_supervise() {
	local pid="${1:-}" timeout_seconds="${2:-}" cap_bytes="${3:-}" out_real="${4:-}"
	local ticks=$((timeout_seconds * 5)) waited=0 f size
	while kill -0 "$pid" 2>/dev/null; do
		for f in "$out_real/stdout.log" "$out_real/stderr.log"; do
			size=$(wc -c <"$f" 2>/dev/null | tr -d ' ')
			if [[ "${size:-0}" -gt "$cap_bytes" ]]; then
				_autoreview_adapter_retire_tree "$pid" "$out_real" live_output_cap || true
				return 125
			fi
		done
		if [[ "$waited" -ge "$ticks" ]]; then
			_autoreview_adapter_retire_tree "$pid" "$out_real" timeout || true
			return 124
		fi
		sleep 0.2
		waited=$((waited + 1))
	done
	return 0
}

# List pids (one per line) whose command references the application-owned
# capture dir. The path reaches awk via the environment, never argv, so the
# scan can never match itself.
_autoreview_adapter_capture_survivors() {
	ps -axo pid=,command= 2>/dev/null |
		OUT_REAL="${1:-}" awk 'ENVIRON["OUT_REAL"] != "" && index($0, ENVIRON["OUT_REAL"]) {print $1}'
}

# Retire the helper's entire session on a bound violation: group-TERM, drain,
# group-KILL, reap the leader, then sweep for setsid-escaped survivors that
# reference the capture dir. The leader is still unreaped when the group
# signals fire, so the pgid is pinned (PID-reuse-safe by construction).
# Writes containment.json diagnostics; rc 1 when survivors persist — the run
# already never settles (124/125), so uncertainty stays fail-closed.
_autoreview_adapter_retire_tree() {
	local pid="${1:-}" out_real="${2:-}" event="${3:-retire}"
	kill -TERM -- "-$pid" 2>/dev/null || true
	sleep 0.5
	kill -KILL -- "-$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	# Group death is proven, never assumed: a group signal can miss a member
	# forked concurrently with its enumeration, and members without the capture
	# dir in their argv are invisible to the sweep below. Surviving members
	# alone keep the reaped leader's pgid alive, so a recycled pgid is never
	# re-signalled here.
	local members="" _drain
	for _drain in 1 2 3 4 5 6 7 8 9 10; do
		members=$(pgrep -g "$pid" 2>/dev/null || true)
		[[ -z "$members" ]] && break
		kill -KILL -- "-$pid" 2>/dev/null || true
		sleep 0.1
	done
	local found="" remaining="" p
	found=$(_autoreview_adapter_capture_survivors "$out_real")
	if [[ -n "$found" ]]; then
		while IFS= read -r p; do
			[[ -n "$p" ]] && kill -KILL "$p" 2>/dev/null
		done <<<"$found" || true
		sleep 0.2
	fi
	remaining=$({
		pgrep -g "$pid" 2>/dev/null || true
		_autoreview_adapter_capture_survivors "$out_real"
	} | sed '/^$/d')
	jq -n --arg event "$event" --arg group "$pid" \
		--arg found "$found" --arg remaining "$remaining" \
		'{event: $event, session_group: ($group | tonumber),
			escaped_survivors_found: ($found | split("\n") | map(select(length > 0))),
			survivors_remaining: ($remaining | split("\n") | map(select(length > 0)))}' \
		>"$out_real/containment.json" 2>/dev/null || true
	[[ -z "$remaining" ]]
}

# After a normal exit, retire anything the helper left behind: same-group
# members (which alone keep the reaped leader's pgid alive — group signals
# fire only while members exist, so a recycled pgid is never signalled) and
# capture-dir survivors. rc 1 = survivors persist after the sweep; the caller
# fails the run closed rather than settling beside live strays.
_autoreview_adapter_post_exit_sweep() {
	local pid="${1:-}" out_real="${2:-}"
	local members survivors p
	members=$(pgrep -g "$pid" 2>/dev/null || true)
	survivors=$(_autoreview_adapter_capture_survivors "$out_real")
	if [[ -z "$members" && -z "$survivors" ]]; then
		# Containment is proven, never assumed: a clean exit must mint the
		# positive empty-survivor record. An unwritable record fails the run
		# closed — absent diagnostics are not evidence of absent survivors.
		jq -n --arg group "$pid" \
			'{event: "post_exit_sweep", session_group: ($group | tonumber),
				escaped_survivors_found: [], survivors_remaining: []}' \
			>"$out_real/containment.json" 2>/dev/null || return 1
		return 0
	fi
	if [[ -n "$members" ]]; then
		kill -TERM -- "-$pid" 2>/dev/null || true
		sleep 0.5
		kill -KILL -- "-$pid" 2>/dev/null || true
	fi
	while IFS= read -r p; do
		[[ -n "$p" ]] && kill -KILL "$p" 2>/dev/null
	done <<<"$survivors" || true
	sleep 0.2
	local remaining
	remaining=$({
		pgrep -g "$pid" 2>/dev/null || true
		_autoreview_adapter_capture_survivors "$out_real"
	} | sed '/^$/d')
	jq -n --arg group "$pid" \
		--arg found "$(printf '%s\n%s' "$members" "$survivors")" \
		--arg remaining "$remaining" \
		'{event: "post_exit_sweep", session_group: ($group | tonumber),
			escaped_survivors_found: ($found | split("\n") | map(select(length > 0))),
			survivors_remaining: ($remaining | split("\n") | map(select(length > 0)))}' \
		>"$out_real/containment.json" 2>/dev/null || return 1
	[[ -z "$remaining" ]]
}

# Extract the trusted stdout pin: the final non-empty stdout line must be the
# single column-0 `receipt_artifact_digest: <64-hex>` marker in the capture.
# Missing, malformed, duplicated, non-final, or post-marker output all fail;
# neutralized (indented) or mid-line marker-like text never authenticates.
autoreview_adapter_extract_stdout_pin() {
	local file="${1:-}"
	[[ -f "$file" ]] || {
		_autoreview_adapter_fail pin_missing pin_rejected
		return 1
	}
	local marker_count
	marker_count=$(grep -cE '^receipt_artifact_digest: [0-9a-f]{64}$' "$file" || true)
	if [[ "$marker_count" -eq 0 ]]; then
		_autoreview_adapter_fail pin_missing pin_rejected
		return 1
	fi
	if [[ "$marker_count" -gt 1 ]]; then
		_autoreview_adapter_fail pin_ambiguous pin_rejected
		return 1
	fi
	local last_nonempty
	last_nonempty=$(awk 'NF {line = $0} END {print line}' "$file")
	if [[ ! "$last_nonempty" =~ ^receipt_artifact_digest:\ ([0-9a-f]{64})$ ]]; then
		_autoreview_adapter_fail pin_not_final pin_rejected
		return 1
	fi
	printf '%s\n' "${BASH_REMATCH[1]}"
}

# Verify the exact three-field v2 envelope and authenticate the stored
# payload bytes against both the embedded digest and the directly captured
# stdout pin. The payload string is hashed exactly as JSON parsing returns
# it (jq -j) — never parsed and re-serialized. On success the payload bytes
# are written to payload_out for semantic validation.
autoreview_adapter_verify_receipt_envelope() {
	local receipt="${1:-}" expected_pin="${2:-}" payload_out="${3:-}"
	[[ -n "$payload_out" ]] || {
		_autoreview_adapter_fail payload_out_missing envelope_rejected
		return 1
	}
	[[ "$expected_pin" =~ ^[0-9a-f]{64}$ ]] || {
		_autoreview_adapter_fail expected_pin_invalid envelope_rejected
		return 1
	}
	[[ -s "$receipt" ]] || {
		_autoreview_adapter_fail receipt_missing envelope_rejected
		return 1
	}
	jq -e -s 'length == 1 and (.[0] | type == "object")' <"$receipt" >/dev/null 2>&1 ||
		{
			_autoreview_adapter_fail receipt_malformed envelope_rejected
			return 1
		}
	jq -e 'keys == ["artifact_digest", "payload", "receipt_version"]' <"$receipt" >/dev/null ||
		{
			_autoreview_adapter_fail envelope_keys_invalid envelope_rejected
			return 1
		}
	jq -e '(.receipt_version | type == "number") and .receipt_version == 2' <"$receipt" >/dev/null ||
		{
			_autoreview_adapter_fail receipt_version_invalid envelope_rejected
			return 1
		}
	jq -e '.payload | type == "string"' <"$receipt" >/dev/null ||
		{
			_autoreview_adapter_fail payload_not_string envelope_rejected
			return 1
		}
	local embedded
	embedded=$(jq -r '.artifact_digest' <"$receipt")
	[[ "$embedded" =~ ^[0-9a-f]{64}$ ]] || {
		_autoreview_adapter_fail embedded_digest_invalid envelope_rejected
		return 1
	}
	jq -j '.payload' <"$receipt" >"$payload_out"
	local computed
	computed=$(_autoreview_adapter_sha256_file "$payload_out") || {
		rm -f "$payload_out"
		_autoreview_adapter_fail payload_unhashable envelope_rejected
		return 1
	}
	if [[ "$computed" != "$embedded" ]]; then
		rm -f "$payload_out"
		_autoreview_adapter_fail embedded_digest_mismatch envelope_rejected
		return 1
	fi
	if [[ "$computed" != "$expected_pin" ]]; then
		rm -f "$payload_out"
		_autoreview_adapter_fail stdout_pin_mismatch envelope_rejected
		return 1
	fi
}

_autoreview_adapter_validate_report() {
	local payload_file="${1:-}" status="${2:-}"
	jq -e '
		.report | type == "object" and
		(keys == ["findings", "overall_confidence", "overall_correctness", "overall_explanation"]) and
		(.overall_correctness == "patch is correct" or .overall_correctness == "patch is incorrect") and
		(.overall_explanation | type == "string" and length > 0) and
		(.overall_confidence | type == "number" and . >= 0 and . <= 1) and
		(.findings | type == "array")' <"$payload_file" >/dev/null ||
		{
			_autoreview_adapter_fail payload_report_shape_invalid payload_rejected
			return 1
		}
	jq -e '
		.report.findings | all(.[];
			type == "object" and
			(keys == ["body", "category", "code_location", "confidence", "priority", "title"]) and
			(.title | type == "string" and length > 0) and
			(.body | type == "string" and length > 0) and
			(.priority | IN("P0", "P1", "P2", "P3")) and
			(.confidence | type == "number" and . >= 0 and . <= 1) and
			(.category | IN("bug", "security", "regression", "test_gap", "maintainability")) and
			(.code_location | type == "object" and (keys == ["file_path", "line"]) and
				(.file_path | type == "string") and (.line | type == "number" and . >= 1)))' \
		<"$payload_file" >/dev/null ||
		{
			_autoreview_adapter_fail payload_finding_invalid payload_rejected
			return 1
		}
	local consistent
	consistent=$(jq -r --arg status "$status" '
		if $status == "clean" then
			((.report.findings | length) == 0 and .report.overall_correctness == "patch is correct")
		else
			((.report.findings | length) > 0 or .report.overall_correctness == "patch is incorrect")
		end' <"$payload_file")
	[[ "$consistent" == "true" ]] || {
		_autoreview_adapter_fail payload_report_inconsistent payload_rejected
		return 1
	}
}

_autoreview_adapter_validate_target() {
	local payload_file="${1:-}" expect_commit="${2:-}" ecpd="${3:-}" esd="${4:-}"
	jq -e '
		.target | type == "object" and
		(keys == ["base_commit", "base_ref", "bundle_digest", "changed_paths",
			"changed_paths_digest", "mode", "reviewed_commit", "scope_digest",
			"tree_digest"]) and
		.mode == "commit" and
		(.reviewed_commit | type == "string" and test("^[0-9a-f]{40}$")) and
		(.bundle_digest | type == "string" and test("^[0-9a-f]{64}$")) and
		(.changed_paths_digest | type == "string" and test("^[0-9a-f]{64}$")) and
		(.scope_digest | type == "string" and test("^[0-9a-f]{64}$")) and
		(.changed_paths | type == "array" and all(.[]; type == "string"))' \
		<"$payload_file" >/dev/null ||
		{
			_autoreview_adapter_fail payload_target_invalid payload_rejected
			return 1
		}
	local reviewed_commit
	reviewed_commit=$(jq -r '.target.reviewed_commit' <"$payload_file")
	[[ "$reviewed_commit" == "$expect_commit" ]] || {
		_autoreview_adapter_fail target_mismatch payload_rejected
		return 1
	}
	if [[ -n "$ecpd" ]]; then
		[[ "$(jq -r '.target.changed_paths_digest' <"$payload_file")" == "$ecpd" ]] ||
			{
				_autoreview_adapter_fail changed_paths_digest_mismatch payload_rejected
				return 1
			}
	fi
	if [[ -n "$esd" ]]; then
		[[ "$(jq -r '.target.scope_digest' <"$payload_file")" == "$esd" ]] ||
			{
				_autoreview_adapter_fail scope_digest_mismatch payload_rejected
				return 1
			}
	fi
}

_autoreview_adapter_validate_binding() {
	local payload_file="${1:-}"
	shift
	local expected="{}" pair key value
	for pair in "$@"; do
		key="${pair%%=*}"
		value="${pair#*=}"
		[[ -n "$key" && "$key" != "$pair" ]] || {
			_autoreview_adapter_fail expect_bind_invalid payload_rejected
			return 1
		}
		expected=$(jq -c --arg k "$key" --arg v "$value" '. + {($k): $v}' <<<"$expected")
	done
	local actual
	actual=$(jq -S -c '.binding' <"$payload_file")
	expected=$(jq -S -c '.' <<<"$expected")
	[[ "$actual" == "$expected" ]] || {
		_autoreview_adapter_fail binding_mismatch payload_rejected
		return 1
	}
}

# Validate v2 payload semantics fail-closed: exact key set, version, status
# vocabulary, reviewer entries, report/error exclusivity, immutable target
# binding, and exact opaque-binding equality. Prints a compact summary
# {status, blocker_count, error_kind} on success.
autoreview_adapter_validate_payload() {
	local payload_file="${1:-}"
	shift || true
	local expect_commit="" ecpd="" esd="" expect_binds=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--expect-commit)
				expect_commit="${2:-}"
				shift 2
				;;
			--expect-changed-paths-digest)
				ecpd="${2:-}"
				shift 2
				;;
			--expect-scope-digest)
				esd="${2:-}"
				shift 2
				;;
			--expect-bind)
				expect_binds+=("${2:-}")
				shift 2
				;;
			*)
				_autoreview_adapter_fail "unknown argument: $1" payload_rejected
				return 1
				;;
		esac
	done
	[[ "$expect_commit" =~ ^[0-9a-f]{40}$ ]] || {
		_autoreview_adapter_fail expect_commit_invalid payload_rejected
		return 1
	}
	[[ -s "$payload_file" ]] || {
		_autoreview_adapter_fail payload_missing payload_rejected
		return 1
	}
	jq -e -s 'length == 1 and (.[0] | type == "object")' <"$payload_file" >/dev/null 2>&1 ||
		{
			_autoreview_adapter_fail payload_parse_failed payload_rejected
			return 1
		}
	jq -e 'keys == ["binding", "error", "receipt_version", "report", "reviewers", "status", "target"]' \
		<"$payload_file" >/dev/null || {
		_autoreview_adapter_fail payload_keys_invalid payload_rejected
		return 1
	}
	jq -e '(.receipt_version | type == "number") and .receipt_version == 2' <"$payload_file" >/dev/null ||
		{
			_autoreview_adapter_fail payload_version_invalid payload_rejected
			return 1
		}
	local status
	status=$(jq -r '.status' <"$payload_file")
	case "$status" in
		clean | findings | error) ;;
		*)
			_autoreview_adapter_fail payload_status_invalid payload_rejected
			return 1
			;;
	esac
	jq -e '
		.reviewers | type == "array" and length >= 1 and all(.[];
			type == "object" and
			(keys == ["engine", "fallback_model", "model", "model_used", "thinking"]) and
			(.engine | type == "string" and length > 0))' <"$payload_file" >/dev/null ||
		{
			_autoreview_adapter_fail payload_reviewers_invalid payload_rejected
			return 1
		}
	jq -e '.binding | type == "object" and all(.[]; type == "string")' <"$payload_file" >/dev/null ||
		{
			_autoreview_adapter_fail payload_binding_invalid payload_rejected
			return 1
		}
	if [[ "$status" == "error" ]]; then
		jq -e '
			.report == null and
			(.error | type == "object" and (keys == ["kind", "message"]) and
				(.kind | type == "string" and length > 0) and
				(.message | type == "string"))' <"$payload_file" >/dev/null ||
			{
				_autoreview_adapter_fail payload_error_shape_invalid payload_rejected
				return 1
			}
		jq -e '.target == null or (.target | type == "object")' <"$payload_file" >/dev/null ||
			{
				_autoreview_adapter_fail payload_target_invalid payload_rejected
				return 1
			}
	else
		jq -e '.error == null' <"$payload_file" >/dev/null ||
			{
				_autoreview_adapter_fail payload_error_shape_invalid payload_rejected
				return 1
			}
		_autoreview_adapter_validate_report "$payload_file" "$status" || return 1
		_autoreview_adapter_validate_target "$payload_file" "$expect_commit" "$ecpd" "$esd" || return 1
	fi
	if [[ ${#expect_binds[@]} -gt 0 ]]; then
		_autoreview_adapter_validate_binding "$payload_file" "${expect_binds[@]}" || return 1
	fi
	jq -c --arg status "$status" '{
		status: $status,
		blocker_count: (if .report == null then 0 else (.report.findings | length) end),
		error_kind: (if .error == null then null else .error.kind end)
	}' <"$payload_file"
}

# Canonicalize and validate the nine-coordinate lifecycle tuple that a pin
# binds to: task, generation, revision, attempt, owner request, immutable
# end commit, and workroom ownership refs.
_autoreview_adapter_tuple_canon() {
	local tuple="${1:-}"
	jq -e '
		type == "object" and
		(.task_id | type == "string" and length > 0) and
		(.task_generation | type == "string" and length > 0) and
		(.review_revision | type == "number" and . == floor and . >= 0) and
		(.review_attempt_id | type == "string" and length > 0) and
		(.owner_review_request_id | type == "string" and length > 0) and
		(.end_commit | type == "string" and test("^[0-9a-f]{40}$")) and
		(.work_item_ref | type == "string" and length > 0) and
		(.workroom_ref | type == "string" and length > 0) and
		(.session_key | type == "string" and length > 0)' <<<"$tuple" >/dev/null 2>&1 || return 1
	jq -S -c '{task_id, task_generation, review_revision, review_attempt_id,
		owner_review_request_id, end_commit, work_item_ref, workroom_ref,
		session_key}' <<<"$tuple"
}

# Emit "<flag>\n<key>=<value>\n" pairs for every contract binding coordinate
# of a canonical tuple, so no caller maintains a private copy of the nine-key
# list. Read line-pairs into an argv array.
_autoreview_adapter_binding_args() {
	local flag="${1:-}" canon="${2:-}" key
	while IFS= read -r key; do
		printf '%s\n%s=%s\n' "$flag" "$key" \
			"$(jq -r --arg k "$key" '.[$k] | tostring' <<<"$canon")"
	done < <(jq -r '.[]' <<<"$AUTOREVIEW_CONTRACT_BINDING_KEYS_JSON")
}

# The production evidence composer: derive the exact 20-key lifecycle
# evidence object from a successful identity gate, the exact authenticated
# payload bytes, the captured stdout artifact pin, and the canonical
# nine-coordinate tuple. Everything of authority is DERIVED, never accepted:
# there is no argument for a helper identity, status, posture, digest, or
# blocker count, and the payload is re-hashed and re-validated here even if
# a caller already did both. Emits evidence only — it never persists a pin,
# touches a store, mutates lifecycle state, or makes a decision.
autoreview_adapter_emit_lifecycle_evidence() {
	local checkout_root="" payload_file="" stdout_log="" tuple=""
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--checkout-root)
				checkout_root="${2:-}"
				shift 2
				;;
			--payload)
				payload_file="${2:-}"
				shift 2
				;;
			--stdout-log)
				stdout_log="${2:-}"
				shift 2
				;;
			--tuple)
				tuple="${2:-}"
				shift 2
				;;
			*)
				_autoreview_adapter_fail "unknown argument: $1" emit_rejected
				return 1
				;;
		esac
	done
	local canon helper_identity pin digest
	canon=$(_autoreview_adapter_tuple_canon "$tuple") || {
		_autoreview_adapter_fail tuple_invalid emit_rejected
		return 1
	}
	helper_identity=$(autoreview_adapter_canonical_helper_identity "$checkout_root") || return 1
	pin=$(autoreview_adapter_extract_stdout_pin "$stdout_log") || return 1
	[[ -s "$payload_file" ]] || {
		_autoreview_adapter_fail payload_missing emit_rejected
		return 1
	}
	digest=$(_autoreview_adapter_sha256_file "$payload_file") || {
		_autoreview_adapter_fail payload_unhashable emit_rejected
		return 1
	}
	if [[ "$digest" != "$pin" ]]; then
		_autoreview_adapter_fail stdout_pin_mismatch emit_rejected
		return 1
	fi
	local expect_args=() line summary status posture end_commit
	while IFS= read -r line; do expect_args+=("$line"); done \
		< <(_autoreview_adapter_binding_args --expect-bind "$canon")
	end_commit=$(jq -r '.end_commit' <<<"$canon")
	summary=$(autoreview_adapter_validate_payload "$payload_file" \
		--expect-commit "$end_commit" "${expect_args[@]}") || return 1
	status=$(jq -r '.status' <<<"$summary")
	posture=$(jq -r --arg status "$status" '.[$status] // empty' \
		<<<"$AUTOREVIEW_CONTRACT_POSTURE_MAP_JSON")
	[[ -n "$posture" ]] || {
		_autoreview_adapter_fail posture_unmapped emit_rejected
		return 1
	}
	local evidence
	evidence=$(jq -c \
		--argjson tuple "$canon" \
		--argjson helper "$helper_identity" \
		--argjson version "$AUTOREVIEW_CONTRACT_EVIDENCE_SCHEMA_VERSION" \
		--argjson receipt_version "$AUTOREVIEW_CONTRACT_RECEIPT_VERSION" \
		--arg digest "$digest" \
		--arg status "$status" \
		--arg posture "$posture" \
		--argjson blocker_count "$(jq -r '.blocker_count' <<<"$summary")" \
		'. as $payload | $tuple + {
			version: $version,
			helper: $helper,
			receipt_version: $receipt_version,
			stdout_artifact_digest: $digest,
			payload_sha256: $digest,
			status: $status,
			posture: $posture,
			blocker_count: $blocker_count,
			target_commit: (if $status == "error" then null else $payload.target.reviewed_commit end),
			changed_paths_digest: (if $status == "error" then null else $payload.target.changed_paths_digest end),
			scope_digest: (if $status == "error" then null else $payload.target.scope_digest end)
		}' <"$payload_file") || {
		_autoreview_adapter_fail evidence_compose_failed emit_rejected
		return 1
	}
	# Emit-time self-proof against the contract: the composed object must have
	# exactly the twenty evidence keys and the six helper keys, by construction
	# AND by check, so schema drift can never leave this function silently.
	jq -e \
		--argjson evidence_keys "$AUTOREVIEW_CONTRACT_EVIDENCE_KEYS_JSON" \
		--argjson helper_keys "$AUTOREVIEW_CONTRACT_HELPER_KEYS_JSON" \
		'keys == $evidence_keys and (.helper | keys == $helper_keys)' \
		>/dev/null 2>&1 <<<"$evidence" || {
		_autoreview_adapter_fail evidence_keys_drift emit_rejected
		return 1
	}
	printf '%s\n' "$evidence"
}

# Store-free production core: one operation from canonical identity to
# lifecycle-ready evidence. verify identity -> bounded invoke -> capture ->
# authenticate -> validate -> emit. No fixture-store dependency anywhere on
# this path; persistence remains solely the lifecycle's dedicated operation.
# Returns the helper/bound-launch exit semantics of the composed chain: 124
# timeout, 125 output cap, 1 for any authentication/validation failure.
# Prints the emitted 20-key evidence object on success.
autoreview_adapter_invoke_canonical_core() {
	local checkout_root="" python="" repo="" out_dir="" commit="" tuple=""
	local timeout_seconds="" cap_bytes="" engine_bin="" child_env=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--checkout-root)
				checkout_root="${2:-}"
				shift 2
				;;
			--python)
				python="${2:-}"
				shift 2
				;;
			--repo)
				repo="${2:-}"
				shift 2
				;;
			--out-dir)
				out_dir="${2:-}"
				shift 2
				;;
			--commit)
				commit="${2:-}"
				shift 2
				;;
			--timeout-seconds)
				timeout_seconds="${2:-}"
				shift 2
				;;
			--output-cap-bytes)
				cap_bytes="${2:-}"
				shift 2
				;;
			--engine-bin)
				engine_bin="${2:-}"
				shift 2
				;;
			--tuple)
				tuple="${2:-}"
				shift 2
				;;
			--child-env)
				child_env+=("${2:-}")
				shift 2
				;;
			*)
				_autoreview_adapter_fail "unknown argument: $1" invoke_rejected
				return 1
				;;
		esac
	done
	local canon helper
	canon=$(_autoreview_adapter_tuple_canon "$tuple") || {
		_autoreview_adapter_fail tuple_invalid invoke_rejected
		return 1
	}
	helper=$(autoreview_adapter_resolve_canonical_helper "$checkout_root") || return 1
	local bind_args=() line
	while IFS= read -r line; do bind_args+=("$line"); done \
		< <(_autoreview_adapter_binding_args --bind "$canon")
	local env_args=() pair
	for pair in "${child_env[@]+"${child_env[@]}"}"; do
		env_args+=(--child-env "$pair")
	done
	local run_rc=0
	autoreview_adapter_run_helper --helper "$helper" ${python:+--python "$python"} \
		--repo "$repo" --out-dir "$out_dir" --commit "$commit" \
		--timeout-seconds "$timeout_seconds" --output-cap-bytes "$cap_bytes" \
		--engine-bin "$engine_bin" "${bind_args[@]}" \
		"${env_args[@]+"${env_args[@]}"}" || run_rc=$?
	if [[ "$run_rc" -eq 124 || "$run_rc" -eq 125 ]]; then
		# A launch-bound violation is a harness failure: whatever landed in
		# out_dir — including an engine-forged receipt and marker — must never
		# be settled as evidence.
		_autoreview_adapter_fail "run_bound_violated (rc=$run_rc)" invoke_rejected || true
		return "$run_rc"
	fi
	local out_real
	out_real=$(_autoreview_adapter_realdir "$out_dir") || {
		_autoreview_adapter_fail out_dir_unresolvable invoke_rejected
		return 1
	}
	local pin
	if ! pin=$(autoreview_adapter_extract_stdout_pin "$out_real/stdout.log"); then
		_autoreview_adapter_fail "helper failed without a trusted pin (rc=$run_rc)" invoke_rejected
		return 1
	fi
	autoreview_adapter_verify_receipt_envelope "$out_real/receipt.json" "$pin" \
		"$out_real/payload.bytes" || return 1
	autoreview_adapter_emit_lifecycle_evidence --checkout-root "$checkout_root" \
		--payload "$out_real/payload.bytes" --stdout-log "$out_real/stdout.log" \
		--tuple "$canon"
}
