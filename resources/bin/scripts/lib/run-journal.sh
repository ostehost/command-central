#!/bin/bash
#
# run-journal.sh — Durable launch/attempt journal for dedupe and audit only.
#
# ADR 0010 §4 pins what this file is allowed to be: launch/event journals are
# persisted "for dedupe and audit only (bounded, replayable); they are never
# replayed as live state". Everything below is shaped by that sentence.
#
#   - The launcher task registry stays the sole authoritative task state. This
#     library never opens it, never takes its lock, and never names its path.
#   - Nothing polls, drains, or reacts to the journal. There is no verb that
#     walks the record space and acts. It is a record, not a control surface.
#   - The only reads a caller is authorized to branch on are (1) the result
#     gate — whether all three owner predecessor records exist for a launch
#     request, which ADR 0012 Decision 4 mandates before a final result may be
#     published — and (2) the dedupe answer, which ADR 0010 §4 explicitly
#     permits.
#
# ── The owner-stage matrix (steering §1) ─────────────────────────────
# The eight stages split into exactly three authority classes, and the split is
# the whole point of this file:
#
#   generic      launch_acknowledged, task_executing, cancel_acknowledged,
#                process_death_authority
#                Observations. Any caller of run_journal_record may append them.
#
#   owner        completion_row_published, review_evidence_settled, owner_handoff
#                Settlements. No approved production owner-authority mechanism
#                exists, so these are UNAVAILABLE in the production durable root
#                — not "guarded by something forgeable", simply absent. They open
#                only under a journal root that carries a harness marker artifact
#                (see run_journal_init_harness_owner_authority), and the
#                production root refuses to initialize one.
#
#   facade       final_result_published
#                Appendable ONLY through run_journal_record_final_result, the
#                entry point `oste-runner result` calls. run_journal_record —
#                the generic path the CLI drives — refuses it, and the facade
#                entry point refuses every OTHER stage, so the facade can never
#                synthesize one of its own predecessors.
#
# Authority is never carried in argv, an environment value, a shell string, a
# mutable temporary receipt, or a generic `--owner` assertion. It is a property
# of the durable root itself. OSTE_RUN_JOURNAL_ROOT can select a root; it cannot
# create authority, because the marker has to already be there and the
# production root can never have one.
#
# Exactly two scripts source this file, and the pair is fenced rather than
# assumed: scripts/oste-run-journal.sh (the thin CLI) and scripts/oste-runner.sh
# (the supervised-runner facade, which sources it deliberately so
# `oste-runner result` can reach run_journal_record_final_result — the one
# facade-owned stage). The claim that the CLI was the sole sourcing script was
# true only before the facade existed; it is not true now, and repeating it here
# would make this header the last place an auditor learns the wiring changed.
#
# The fence lives in test/test-runner-facade.sh, which allowlists exactly those
# executable sources/references and turns red the moment a THIRD script wires
# the journal in. Nothing else in scripts/ may source or call it, and the
# journal stays inert unless explicitly invoked: wiring it any further into the
# lifecycle is a later phase.
#
# ── Durability posture, stated rather than implied ───────────────────
# Every file lands by mktemp-in-the-target-directory + rename(2), so any other
# process sees either the old state or the complete new one, never a torn file.
# That is atomicity, not durability: bash has no fsync, and sync(8) is
# filesystem-wide and would stall a caller's result path for a hazard (host
# power loss) outside this threat model. Same posture as the completion
# publication WAL in oste-complete.sh.
#
# ── errexit contract ─────────────────────────────────────────────────
# Every consumer script in this repo runs `set -euo pipefail`, and P4 sources
# this library into one of them, so the public entry points (run_journal_record,
# run_journal_query_*, run_journal_quarantine_list) are safe to call BARE under
# errexit. Precisely: an accepted record returns 0, and a refusal returns its
# mapped exit code only AFTER its JSON envelope has reached stdout — a caller
# that then aborts on that status aborts holding the whole answer.
#
# What must never happen is an internal non-zero status escaping mid-flight,
# before the envelope is printed and while the lock is still held: that is a
# silent abort with zero bytes on stdout, the failure mode the whole library is
# built to rule out. `inherit_errexit` being off by default is not a defence —
# it only exempts `$(...)` and `if`/`||`-guarded calls, which is a property of
# how a future caller happens to invoke us, not of this contract.
#
# ── Lock ordering (hard) ─────────────────────────────────────────────
# This library acquires exactly one lock: its own per-launch-request lockdir.
# It must never be called while the caller holds the launcher task registry
# lock. That is enforced in-process: a non-empty _TASKS_LOCK_OWNED in the
# calling shell is refused with `lock_order_violation`. The cross-process case
# cannot be detected here and is an accepted residual.
#
# ── Notes for callers ────────────────────────────────────────────────
#   - `process_start_identity` is constrained to the canonical task-id grammar,
#     so a caller must pass a normalized/truncated form of a process start
#     identity, never raw `ps -o lstart=` output and never a full 64-hex digest
#     (a >=64 character opaque run is refused as possible secret material).
#   - `process_death_authority` deliberately has no `observed_at` key: the
#     stored envelope already carries `recorded_at`, and a differing timestamp
#     on a single-shot authority stage would otherwise read to an operator as
#     an authority dispute when it is only a clock difference.

[[ -n "${__OSTE_RUN_JOURNAL_SH:-}" ]] && return 0
__OSTE_RUN_JOURNAL_SH=1

_run_journal_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! declare -f task_id_is_valid >/dev/null 2>&1 && [[ -f "${_run_journal_lib_dir}/task-id.sh" ]]; then
	# shellcheck source=task-id.sh
	source "${_run_journal_lib_dir}/task-id.sh"
fi
unset _run_journal_lib_dir

# ── Constants, expressed as functions so sourcing exports nothing ────

run_journal_schema_version() { printf '1'; }

# The closed stage vocabulary. Stage enumeration always iterates THIS list and
# stat()s each name; it never globs the stage directory. An orphan
# `*.tmp.XXXXXX` left by a killed atomic write is therefore unreadable as a
# stage by construction, not by convention.
run_journal_stage_vocabulary() {
	printf '%s\n' \
		launch_acknowledged \
		task_executing \
		cancel_acknowledged \
		process_death_authority \
		completion_row_published \
		review_evidence_settled \
		owner_handoff \
		final_result_published
}

run_journal_identity_fields() {
	printf '%s\n' \
		launch_request_id \
		launch_attempt_epoch \
		symphony_run_uuid \
		symphony_run_retry \
		symphony_run_turn \
		task_id \
		task_generation \
		work_item_ref \
		workroom_ref \
		issue_scheduler \
		exec_node \
		posture
}

_run_journal_max_payload_bytes() { printf '%s' "${OSTE_RUN_JOURNAL_MAX_PAYLOAD_BYTES:-16384}"; }
_run_journal_max_quarantine() { printf '%s' "${OSTE_RUN_JOURNAL_MAX_QUARANTINE_PER_REQUEST:-64}"; }
_run_journal_lock_max_wait() { printf '%s' "${OSTE_RUN_JOURNAL_LOCK_MAX_WAIT:-10}"; }
_run_journal_lock_stale_age() { printf '%s' "${OSTE_RUN_JOURNAL_LOCK_STALE_AGE:-60}"; }

# The ONE durable state root. Everything else is a redirect.
run_journal_durable_root() {
	printf '%s/ghostty-launcher/runs' "${XDG_STATE_HOME:-${HOME}/.local/state}"
}

# OSTE_RUN_JOURNAL_ROOT exists so tests can redirect the root. Production
# callers never set it, and that is now ENFORCED rather than stated: a redirect
# away from the durable state root is honoured only under OSTE_TEST_MODE=1.
# Without the gate any process that can set one environment variable relocates
# the whole authorization surface — including the result gate — to a directory
# of its choosing. /tmp does not satisfy ADR 0010 §4 durability either way.
#
# Refusal prints NOTHING and returns 1. Every public verb calls
# _run_journal_guard_root_redirect first and answers with a proper refusal
# envelope; the empty return is the backstop for any path that does not.
run_journal_root() {
	local durable
	durable=$(run_journal_durable_root)
	if [[ -n "${OSTE_RUN_JOURNAL_ROOT:-}" ]]; then
		if [[ "${OSTE_TEST_MODE:-}" == "1" ]]; then
			printf '%s' "$OSTE_RUN_JOURNAL_ROOT"
			return 0
		fi
		# Not test mode. The only redirect that survives is a no-op one.
		if [[ "$OSTE_RUN_JOURNAL_ROOT" == "$durable" ]]; then
			printf '%s' "$durable"
			return 0
		fi
		return 1
	fi
	printf '%s' "$durable"
}

# True when the root in force IS the durable production root, or lives inside
# it. Both halves matter: the owner-stage seam is refused for anything at or
# under the durable root, so "plant the marker in a subdirectory of production"
# is not a way in.
_run_journal_root_is_production() {
	local root durable
	root=$(run_journal_root) || return 1
	durable=$(run_journal_durable_root)
	[[ "$root" == "$durable" || "$root" == "${durable}/"* ]]
}

_run_journal_guard_root_redirect() {
	_RUN_JOURNAL_ERROR=""
	if run_journal_root >/dev/null; then
		return 0
	fi
	_RUN_JOURNAL_ERROR="journal_root_redirect_refused"
	return 1
}

# ADR 0010 §4 durability is NOT satisfied by atomic rename: a rename is atomic
# against concurrent readers, not against power loss, because neither the file
# nor its parent directory is fsynced. Until a durable writer exists, no record
# this library writes may authorize a "durably journaled" result. That is
# published positively on every accepted record rather than left as a comment,
# so a consumer that wants to claim durability has to ignore a field that says
# it does not hold.
run_journal_durability_class() { printf 'atomic_rename_not_power_loss_durable'; }

_run_journal_entry_dir() { printf '%s/entries/%s' "$(run_journal_root)" "$1"; }
_run_journal_lock_dir() { printf '%s/.locks/%s.lock' "$(run_journal_root)" "$1"; }
_run_journal_index_task_dir() { printf '%s/index/task/%s' "$(run_journal_root)" "$1"; }
_run_journal_index_claim_path() { printf '%s/index/task/%s/%s/claim.json' "$(run_journal_root)" "$1" "$2"; }

# ── Small primitives ─────────────────────────────────────────────────

_run_journal_now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── SHA-256 primitive ────────────────────────────────────────────────
#
# `shasum` is a Perl script and costs ~14ms per call; a projection recomputes
# about nineteen digests, so the primitive rather than the parse around it is
# the dominant remaining cost of a read. Apple ships a compiled sha256sum at
# /sbin — one of the hardlink family that includes /sbin/md5 — which costs
# ~3.1ms and prints the SAME `<hex>  <name>` line, so it is a drop-in.
#
# A digest here is durable-state integrity, so identity is the gate and speed is
# only the reward. The tool is resolved ONCE per process and ONLY after it
# reproduces two published known answers. A candidate that is absent, that is a
# different algorithm wearing this name, or whose output this parser cannot
# read, is passed over for the next tier rather than trusted: a silently
# different primitive on one machine would be data corruption, not a slow test.
#
# Deliberately local to this library rather than shared with the other shasum
# callers in the repo. The journal is where the digests are hot, and
# `run_journal_payload_digest` is already a deliberate duplicate of the review
# lifecycle recipe (see its comment) which D23 pins byte-for-byte over a corpus.
# Keeping the two on DIFFERENT primitives turns D23 into a cross-tool
# differential check; collapsing both onto one shared helper would make that
# existing test compare a function with itself.
_RUN_JOURNAL_SHA256_ARGV=()
_RUN_JOURNAL_SHA256_READY=""
# Published SHA-256 values, not values this repository computed for itself.
_RUN_JOURNAL_SHA256_KAT_EMPTY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
_RUN_JOURNAL_SHA256_KAT_A="ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"

# Preference is cost, then the proven incumbent, then openssl LAST: its banner
# differs across OpenSSL and LibreSSL releases ("SHA2-256(stdin)= " against
# "(stdin)= "), so it is the most fragile to read even though it beats shasum.
_run_journal_sha256_candidates() {
	printf '%s\n' \
		'/sbin/sha256sum' \
		'sha256sum' \
		'shasum -a 256' \
		'openssl dgst -sha256'
}

# The first lowercase 64-hex word of the first output line. Position
# independent, so it reads `<hex>  -`, `<hex>  <path>` and `SHA2-256(stdin)=
# <hex>` alike, and it refuses anything that is not exactly a 64-character
# lowercase hex word — a truncated, uppercased or differently-sized digest is
# not "close enough" to write into durable state.
_run_journal_sha256_hex() {
	local token
	local -a words=()
	read -r -a words <<<"${1:-}"
	((${#words[@]} > 0)) || return 1
	for token in "${words[@]}"; do
		if [[ "$token" =~ ^[0-9a-f]{64}$ ]]; then
			printf '%s' "$token"
			return 0
		fi
	done
	return 1
}

_run_journal_sha256_resolve() {
	[[ -n "$_RUN_JOURNAL_SHA256_READY" ]] && return 0
	local candidate out
	local -a argv=()
	while IFS= read -r candidate; do
		[[ -n "$candidate" ]] || continue
		read -r -a argv <<<"$candidate"
		((${#argv[@]} > 0)) || continue
		command -v "${argv[0]}" >/dev/null 2>&1 || continue
		# Two anchors, not one: a single vector is also satisfied by a tool that
		# prints one constant whatever its input.
		out=$(printf '' | "${argv[@]}" 2>/dev/null) || continue
		[[ "$(_run_journal_sha256_hex "$out")" == "$_RUN_JOURNAL_SHA256_KAT_EMPTY" ]] || continue
		out=$(printf 'a' | "${argv[@]}" 2>/dev/null) || continue
		[[ "$(_run_journal_sha256_hex "$out")" == "$_RUN_JOURNAL_SHA256_KAT_A" ]] || continue
		_RUN_JOURNAL_SHA256_ARGV=("${argv[@]}")
		_RUN_JOURNAL_SHA256_READY=1
		return 0
	done < <(_run_journal_sha256_candidates)
	return 1
}

# Full 64-character digest of stdin. Callers that want a shorter key truncate
# with a bash slice, which is what the `awk substr` these replaced did.
_run_journal_sha256_stdin() {
	_run_journal_sha256_resolve || return 1
	_run_journal_sha256_hex "$("${_RUN_JOURNAL_SHA256_ARGV[@]}" 2>/dev/null)"
}

_run_journal_sha256_file() {
	_run_journal_sha256_resolve || return 1
	_run_journal_sha256_hex "$("${_RUN_JOURNAL_SHA256_ARGV[@]}" "$1" 2>/dev/null)"
}

# Resolved ONCE here, in the sourcing shell, and this placement is load-bearing
# rather than stylistic. Every digest call site runs inside a command
# substitution, so a resolution performed lazily would set its memo in a
# SUBSHELL and be thrown away with it: measured at 15 tool executions for 5
# digests — three per digest — which made the fast primitive slower overall than
# the shasum it replaces. Probing once per process is what turns the swap into a
# win. Failure is not fatal here: the lazy path inside the helpers retries, so a
# machine that resolves nothing at source time still degrades to a refusal at
# the call rather than breaking the source.
_run_journal_sha256_resolve || true

_run_journal_new_nonce() {
	local value=""
	if command -v uuidgen >/dev/null 2>&1; then
		value=$(uuidgen 2>/dev/null | LC_ALL=C tr 'A-Z' 'a-z')
	fi
	if [[ -z "$value" ]]; then
		value=$(printf '%s' "$(date +%s)-${BASHPID:-$$}-${RANDOM:-0}-${RANDOM:-0}" |
			_run_journal_sha256_stdin)
	fi
	printf '%s' "$value"
}

_run_journal_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

_run_journal_dir_mode() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || printf ''; }

_run_journal_process_start() { ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'; }

# macOS system bash has no BASHPID, and $$ inside a background subshell is
# still the parent. Ask a directly spawned child for its PPID so concurrent
# claimers record distinct owner identities instead of sharing one.
_run_journal_capture_current_pid() {
	if [[ -n "${BASHPID:-}" ]]; then
		_RUN_JOURNAL_CALLER_PID="$BASHPID"
	else
		local probe
		probe=$(mktemp "${TMPDIR:-/tmp}/oste-run-journal-pid.XXXXXX") || return 1
		chmod 600 "$probe" 2>/dev/null || true
		if ! sh -c 'printf "%s" "$PPID" >"$1"' _ "$probe"; then
			rm -f "$probe"
			return 1
		fi
		IFS= read -r _RUN_JOURNAL_CALLER_PID <"$probe" || true
		rm -f "$probe"
	fi
	[[ "${_RUN_JOURNAL_CALLER_PID:-}" =~ ^[0-9]+$ ]]
}

_run_journal_atomic_json_write() {
	local path="$1" json="$2" dir tmp
	dir=$(dirname "$path")
	mkdir -p "$dir" 2>/dev/null || return 1
	tmp=$(mktemp "${path}.tmp.XXXXXX") || return 1
	if printf '%s\n' "$json" | jq -c . >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$path" && return 0
	fi
	rm -f "$tmp"
	return 1
}

# ── Digest ───────────────────────────────────────────────────────────
#
# Deliberately duplicated from the review lifecycle fixup projection digest
# rather than sourced: an inert audit library must not depend on the live
# review state machine. The cost of duplication is drift, so the suite pins
# byte-identical output against the original on a broad corpus.
run_journal_payload_digest() {
	local document="${1:-}" canonical digest
	canonical=$(jq -S -c . <<<"$document" 2>/dev/null) || return 1
	[[ -n "$canonical" && "$canonical" != "null" ]] || return 1
	digest=$(printf '%s' "$canonical" | _run_journal_sha256_stdin)
	digest="${digest:0:24}"
	[[ -n "$digest" ]] || return 1
	printf '%s' "$digest"
}

# Full accepted-record checksum. `payload_digest` deliberately remains the
# stage-CAS key; this checksum catches whole-record corruption but is not the
# independent launch-binding anchor because it is stored beside the bytes it
# covers. The task/generation claim stores that separate one-write identity
# commitment.
run_journal_record_digest() {
	local document="${1:-}" canonical digest
	canonical=$(jq -S -c 'del(.record_digest)' <<<"$document" 2>/dev/null) || return 1
	[[ -n "$canonical" && "$canonical" != "null" ]] || return 1
	digest=$(printf '%s' "$canonical" | _run_journal_sha256_stdin)
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

run_journal_identity_digest() {
	local identity="${1:-}" canonical digest
	canonical=$(jq -S -c . <<<"$identity" 2>/dev/null) || return 1
	[[ -n "$canonical" && "$canonical" != "null" ]] || return 1
	digest=$(printf '%s' "$canonical" | _run_journal_sha256_stdin)
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

# Independent launch-binding commitment. Unlike record_digest, this value is
# stored in the exclusive task/generation claim, outside the mutable record it
# authenticates. It commits BOTH the canonical run identity and every mandatory
# launch echo coordinate in the acknowledgement payload.
run_journal_launch_binding_digest() {
	local identity="${1:-}" payload="${2:-}" canonical digest
	canonical=$(jq -S -cn --argjson identity "$identity" --argjson payload "$payload" \
		'{identity:$identity,payload:$payload}' 2>/dev/null) || return 1
	[[ -n "$canonical" && "$canonical" != "null" ]] || return 1
	digest=$(printf '%s' "$canonical" | _run_journal_sha256_stdin)
	[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$digest"
}

# ── Stage lattice ────────────────────────────────────────────────────

run_journal_stage_is_known() {
	case "${1:-}" in
		launch_acknowledged | task_executing | cancel_acknowledged | process_death_authority) return 0 ;;
		completion_row_published | review_evidence_settled | owner_handoff | final_result_published) return 0 ;;
		*) return 1 ;;
	esac
}

# Exit 0 with empty output for the root stage; exit 1 with no output for an
# unknown stage. The two cases must never be indistinguishable on stdout.
run_journal_stage_predecessors() {
	case "${1:-}" in
		launch_acknowledged) return 0 ;;
		task_executing | cancel_acknowledged | process_death_authority | completion_row_published)
			printf '%s\n' launch_acknowledged
			;;
		review_evidence_settled | owner_handoff)
			printf '%s\n' completion_row_published
			;;
		final_result_published)
			printf '%s\n' review_evidence_settled owner_handoff
			;;
		*) return 1 ;;
	esac
	return 0
}

# Transitive predecessor closure, deduped and emitted in vocabulary (lattice)
# order. The result gate uses THIS, not the direct edges: a valid
# `review_evidence_settled` record says nothing about whether
# `completion_row_published` is STILL satisfied, and satisfaction is re-derived
# from bytes on every read. Checking only the direct edges would let a final
# publication ride on a predecessor whose own predecessor had since been
# hollowed out or quarantined.
_run_journal_stage_predecessors_transitive() {
	local stage="$1" frontier next seen=" " s p
	frontier=$(run_journal_stage_predecessors "$stage") || return 1
	while [[ -n "$frontier" ]]; do
		next=""
		while IFS= read -r s; do
			[[ -n "$s" ]] || continue
			[[ "$seen" == *" ${s} "* ]] && continue
			seen="${seen}${s} "
			while IFS= read -r p; do
				[[ -n "$p" ]] || continue
				next="${next}${p}"$'\n'
			done < <(run_journal_stage_predecessors "$s")
		done <<<"$frontier"
		frontier="$next"
	done
	while IFS= read -r s; do
		[[ "$seen" == *" ${s} "* ]] && printf '%s\n' "$s"
	done < <(run_journal_stage_vocabulary)
	return 0
}

# ── Outcome vocabulary ───────────────────────────────────────────────
#
# Exit codes are a new space, deliberately distinct from oste-wait.sh's 0-7.
# Callers branch on the `outcome` string; the code is the coarse channel only.
run_journal_outcome_exit_code() {
	case "${1:-}" in
		recorded | already_recorded | found | not_found) printf '0' ;;
		invalid_request | secret_material_refused) printf '1' ;;
		binding_conflict | generation_mismatch | generation_claim_conflict) printf '2' ;;
		stage_conflict | stage_out_of_order | predecessor_quarantined) printf '2' ;;
		journal_sealed | stage_quarantined | authority_contradiction) printf '2' ;;
		authority_evidence_lost | quarantine_budget_exhausted | lock_order_violation) printf '2' ;;
		owner_authority_unavailable) printf '2' ;;
		facade_only_stage | facade_stage_not_permitted) printf '2' ;;
		journal_unreadable | indeterminate) printf '3' ;;
		journal_locked) printf '4' ;;
		io_error) printf '5' ;;
		*) printf '1' ;;
	esac
}

# Exactly one refusal family is authorization-bearing: the result gate on
# `final_result_published`. Every other refusal is audit-only and must never
# alter a caller's dispatch, retry, cancel, or cleanup behaviour.
run_journal_refusal_class() {
	local outcome="${1:-}" stage="${2:-}"
	case "$outcome" in
		recorded | already_recorded | found | not_found) return 0 ;;
		stage_out_of_order | predecessor_quarantined | authority_evidence_lost | owner_authority_unavailable | \
			facade_only_stage | facade_stage_not_permitted)
			if [[ "$stage" == "final_result_published" ]]; then
				printf 'authorization'
			else
				printf 'audit'
			fi
			;;
		*) printf 'audit' ;;
	esac
	return 0
}

# One JSON object on stdout in every case, including refusals. Diagnostics go
# to stderr. There is never a partial or second object.
_run_journal_response() {
	local operation="$1" outcome="$2" reason="${3:-}" extra="${4:-}" stage="${5:-}" class
	[[ -n "$extra" ]] || extra='{}'
	class=$(run_journal_refusal_class "$outcome" "$stage")
	jq -cn \
		--arg operation "$operation" \
		--arg outcome "$outcome" \
		--arg reason "$reason" \
		--arg class "$class" \
		--argjson version "$(run_journal_schema_version)" \
		--argjson extra "$extra" '
		{schema_version:$version, operation:$operation, outcome:$outcome}
		+ (if $reason == "" then {} else {reason:$reason} end)
		+ (if $class == "" then {} else {refusal_class:$class} end)
		+ $extra'
}

_run_journal_diag() { printf 'run-journal: %s\n' "$*" >&2; }

# ── Root and mode ────────────────────────────────────────────────────
#
# An insecure mode is refused, never silently repaired: chmod'ing a directory
# this process did not create mutates state whose owner is unknown. No explicit
# chmod follows mkdir either — the umask governs what we create, and anything
# else is somebody else's directory.
_run_journal_guard_secure_mode() {
	local dir="$1" mode
	mode=$(_run_journal_dir_mode "$dir")
	[[ -n "$mode" ]] || return 1
	[[ "$mode" =~ ^[0-7]+$ ]] || return 1
	(((8#$mode & 077) == 0)) || return 1
	return 0
}

_run_journal_ensure_root() {
	local root
	root=$(run_journal_root)
	[[ -d "$root" ]] && return 0
	[[ -e "$root" ]] && return 1
	(umask 077 && mkdir -p "$root") 2>/dev/null || return 1
	return 0
}

# ── Locking ──────────────────────────────────────────────────────────

# Conservative staleness: a live PID whose start identity cannot be read is NOT
# stale. Reaping a lock we cannot prove is dead is the wrong default for a
# durability library; the acquirer falls through to the max-wait timeout and
# `journal_locked` instead. Cost: such a lock blocks that request until its
# owner exits.
_run_journal_lock_is_stale() {
	local lockdir="$1" ownerfile="$2" stale_age="$3"
	[[ -d "$lockdir" ]] || return 1
	local pid="" recorded_start="" current_start="" age
	if [[ -f "$ownerfile" ]]; then
		pid=$(jq -r '.pid // empty' "$ownerfile" 2>/dev/null || true)
		recorded_start=$(jq -r '.process_start // empty' "$ownerfile" 2>/dev/null || true)
	fi
	age=$(($(date +%s) - $(_run_journal_mtime "$lockdir")))
	if [[ "$pid" =~ ^[0-9]+$ ]]; then
		if ! kill -0 "$pid" 2>/dev/null; then
			return 0
		fi
		current_start=$(_run_journal_process_start "$pid")
		if [[ -n "$recorded_start" && -n "$current_start" && "$recorded_start" != "$current_start" ]]; then
			return 0
		fi
		return 1
	fi
	[[ "$age" -ge "$stale_age" ]]
}

_run_journal_lock_acquire() {
	local request_id="$1" lockdir ownerfile lockroot max_wait stale_age waited=0
	lockdir=$(_run_journal_lock_dir "$request_id")
	ownerfile="${lockdir}/owner.json"
	lockroot=$(dirname "$lockdir")
	max_wait=$(_run_journal_lock_max_wait)
	stale_age=$(_run_journal_lock_stale_age)
	(umask 077 && mkdir -p "$lockroot") 2>/dev/null || return 1
	while true; do
		if (umask 077 && mkdir "$lockdir") 2>/dev/null; then
			local token owner_tmp pid process_start
			_run_journal_capture_current_pid || {
				rm -rf "$lockdir" 2>/dev/null || true
				return 1
			}
			pid="$_RUN_JOURNAL_CALLER_PID"
			process_start=$(_run_journal_process_start "$pid")
			if [[ -z "$process_start" ]]; then
				rm -rf "$lockdir" 2>/dev/null || true
				return 1
			fi
			token=$(_run_journal_new_nonce)
			owner_tmp="${ownerfile}.tmp.${pid}"
			if jq -cn --argjson pid "$pid" --arg start "$process_start" --arg token "$token" \
				'{pid:$pid,process_start:$start,token:$token}' >"$owner_tmp" 2>/dev/null &&
				mv "$owner_tmp" "$ownerfile"; then
				_RUN_JOURNAL_LOCK_OWNED="$lockdir"
				_RUN_JOURNAL_LOCK_TOKEN="$token"
				_RUN_JOURNAL_LOCK_PID="$pid"
				return 0
			fi
			rm -f "$owner_tmp"
			rm -rf "$lockdir" 2>/dev/null || true
			return 1
		fi

		if _run_journal_lock_is_stale "$lockdir" "$ownerfile" "$stale_age"; then
			local reapdir="${lockdir}.reap" reap_age
			if mkdir "$reapdir" 2>/dev/null; then
				if _run_journal_lock_is_stale "$lockdir" "$ownerfile" "$stale_age"; then
					rm -rf "$lockdir"
				fi
				rm -rf "$reapdir"
			else
				reap_age=$(($(date +%s) - $(_run_journal_mtime "$reapdir")))
				[[ "$reap_age" -ge 5 ]] && rm -rf "$reapdir"
			fi
		fi
		sleep 0.1
		waited=$((waited + 1))
		if [[ "$waited" -ge $((max_wait * 10)) ]]; then
			return 1
		fi
	done
}

# Release checks BOTH the recorded PID and the unguessable token. A forked
# child inherits the token in its environment; the PID half stops it deleting a
# lock it does not hold, and the token half stops a reclaimed holder deleting
# its successor's lock.
_run_journal_guard_lock_release_ownership() {
	local ownerfile="$1" held_pid held_token
	held_pid=$(jq -r '.pid // empty' "$ownerfile" 2>/dev/null || true)
	held_token=$(jq -r '.token // empty' "$ownerfile" 2>/dev/null || true)
	[[ -n "$held_token" && "$held_token" == "${_RUN_JOURNAL_LOCK_TOKEN:-}" ]] || return 1
	[[ -n "$held_pid" && "$held_pid" == "${_RUN_JOURNAL_LOCK_PID:-}" ]] || return 1
	return 0
}

_run_journal_lock_release() {
	local request_id="$1" lockdir ownerfile
	lockdir=$(_run_journal_lock_dir "$request_id")
	ownerfile="${lockdir}/owner.json"
	[[ "${_RUN_JOURNAL_LOCK_OWNED:-}" == "$lockdir" ]] || return 0
	_RUN_JOURNAL_LOCK_OWNED=""
	if _run_journal_guard_lock_release_ownership "$ownerfile"; then
		rm -rf "$lockdir" 2>/dev/null || true
	fi
	_RUN_JOURNAL_LOCK_TOKEN=""
	_RUN_JOURNAL_LOCK_PID=""
	return 0
}

# The one caller-contract fence that costs nothing to check and catches the
# predictable instinct to record inside a task-registry critical section.
_run_journal_guard_lock_order() {
	[[ -z "${_TASKS_LOCK_OWNED:-}" ]]
}

# ── Identity validation ──────────────────────────────────────────────

_run_journal_identity_field() {
	jq -r --arg k "$2" '.[$k] | if . == null then "" else tostring end' <<<"$1" 2>/dev/null || printf ''
}

# The canonical field vocabulary, C-sorted and space-joined, cached per process:
# both validators compare a candidate key set against it on every call, and the
# vocabulary cannot change within one process lifetime.
_run_journal_identity_fields_expected() {
	[[ -n "${_RUN_JOURNAL_IDENTITY_FIELDS_EXPECTED:-}" ]] && return 0
	_RUN_JOURNAL_IDENTITY_FIELDS_EXPECTED=$(run_journal_identity_fields | LC_ALL=C sort | tr '\n' ' ')
	_RUN_JOURNAL_IDENTITY_FIELDS_EXPECTED="${_RUN_JOURNAL_IDENTITY_FIELDS_EXPECTED% }"
}

# work_item_ref / workroom_ref are the only free-text identity fields, and a P4
# caller populates them from tracker and workroom data. Without a charset they
# accept a whole query string, so `hub.example/cb?session_key=…` reaches durable
# state with the key intact — the value denylist inspects JSON KEY names, never
# the content of a ref. The grammar below admits the `scheme:opaque/path-1`
# shapes real refs use and refuses the query-string punctuation (`?`, `=`, `&`,
# `%`, whitespace) a credential needs to ride along.
_run_journal_identity_ref_is_valid() {
	local value="${1:-}"
	[[ -n "$value" ]] || return 1
	((${#value} <= 200)) || return 1
	if [[ "$value" == *"://"* ]]; then
		return 1
	fi
	[[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$ ]] || return 1
	return 0
}

# The >=64-char hex and opaque-run refusals exist to catch a digest or bearer
# token pasted into a free-text field. Four identity fields are LEGITIMATELY
# high-entropy opaque runs, so they — and only they — are exempt. Exempting the
# whole identity (which is what stage="" used to mean) disabled the rule for
# work_item_ref/workroom_ref/exec_node as well, which are exactly the free-text
# fields it was written for.
#
# task_id belongs on this list for the same reason the other three do: it is
# validated UPSTREAM by OSTE_TASK_ID_RE (scripts/lib/task-id.sh,
# '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'), a closed charset with a 128-character
# cap, and _run_journal_validate_identity applies it before this scan runs. That
# grammar admits none of the punctuation a URL, PEM header, or query string
# needs, so the opaque-run heuristic can only ever fire FALSELY on it — a
# legitimate long task_id was being refused as secret-shaped.
_run_journal_identity_allows_long_runs() {
	case "${1:-}" in
		launch_request_id | symphony_run_uuid | task_generation | task_id) return 0 ;;
		*) return 1 ;;
	esac
}

_run_journal_validate_identity() {
	local identity="$1"
	_RUN_JOURNAL_ERROR=""
	_RUN_JOURNAL_IDENTITY_CANONICAL=""
	_RUN_JOURNAL_IDENTITY_REQUEST_ID=""
	_RUN_JOURNAL_IDENTITY_TASK_ID=""
	_RUN_JOURNAL_IDENTITY_GENERATION=""
	_RUN_JOURNAL_IDENTITY_POSTURE=""
	# One parse for the whole identity: the sorted key set, the nine string
	# fields, and the three integer verdicts arrive NUL-framed from a single jq
	# call, so validation costs one process instead of one per field. The frames
	# ride the same scrub filter as the scan streams, so an embedded control
	# character can never forge a frame boundary — every grammar below rejects
	# the scrubbed '?' exactly as it rejects the byte it replaced. All value
	# verdicts stay in bash, unchanged.
	local shape="" keys="" req="" uuid="" tid="" gen="" work="" room="" node="" sched="" posture=""
	local epoch_ok="" retry_ok="" turn_ok=""
	if ! {
		IFS= read -r -d '' shape &&
			IFS= read -r -d '' keys &&
			IFS= read -r -d '' req &&
			IFS= read -r -d '' uuid &&
			IFS= read -r -d '' tid &&
			IFS= read -r -d '' gen &&
			IFS= read -r -d '' work &&
			IFS= read -r -d '' room &&
			IFS= read -r -d '' node &&
			IFS= read -r -d '' sched &&
			IFS= read -r -d '' posture &&
			IFS= read -r -d '' epoch_ok &&
			IFS= read -r -d '' retry_ok &&
			IFS= read -r -d '' turn_ok
	} < <(jq -j "$(_run_journal_jq_scrub_def)"'
		if type != "object" then "not_object\u0000" else
		"object\u0000"
		+ (keys_unsorted | sort | map(scrub) | join(" ")) + "\u0000"
		+ ([.launch_request_id, .symphony_run_uuid, .task_id, .task_generation,
		    .work_item_ref, .workroom_ref, .exec_node, .issue_scheduler, .posture]
		   | map((if . == null then "" else tostring end | scrub) + "\u0000") | add)
		+ ([.launch_attempt_epoch, .symphony_run_retry, .symphony_run_turn]
		   | map(((type == "number" and . >= 0 and (floor == .)) | tostring) + "\u0000") | add)
		end' <<<"$identity" 2>/dev/null) || [[ "$shape" == "not_object" ]]; then
		_RUN_JOURNAL_ERROR="identity_not_object"
		return 1
	fi
	if [[ "$shape" != "object" ]]; then
		_RUN_JOURNAL_ERROR="identity_not_object"
		return 1
	fi
	_run_journal_identity_fields_expected
	if [[ "$keys" != "$_RUN_JOURNAL_IDENTITY_FIELDS_EXPECTED" ]]; then
		_RUN_JOURNAL_ERROR="identity_field_set_mismatch"
		return 1
	fi

	if ! task_id_is_valid "$req"; then
		_RUN_JOURNAL_ERROR="invalid_launch_request_id"
		return 1
	fi
	if ! task_id_is_valid "$uuid"; then
		_RUN_JOURNAL_ERROR="invalid_symphony_run_uuid"
		return 1
	fi
	if ! task_id_is_valid "$tid"; then
		_RUN_JOURNAL_ERROR="invalid_task_id"
		return 1
	fi
	if ! task_generation_is_valid "$gen"; then
		_RUN_JOURNAL_ERROR="invalid_task_generation"
		return 1
	fi
	if [[ "$epoch_ok" != "true" ]]; then
		_RUN_JOURNAL_ERROR="invalid_launch_attempt_epoch"
		return 1
	fi
	if [[ "$retry_ok" != "true" ]]; then
		_RUN_JOURNAL_ERROR="invalid_symphony_run_retry"
		return 1
	fi
	if [[ "$turn_ok" != "true" ]]; then
		_RUN_JOURNAL_ERROR="invalid_symphony_run_turn"
		return 1
	fi
	if ! _run_journal_identity_ref_is_valid "$work"; then
		_RUN_JOURNAL_ERROR="invalid_work_item_ref"
		return 1
	fi
	if ! _run_journal_identity_ref_is_valid "$room"; then
		_RUN_JOURNAL_ERROR="invalid_workroom_ref"
		return 1
	fi
	if [[ -z "$node" || ${#node} -gt 128 ]] || [[ ! "$node" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
		_RUN_JOURNAL_ERROR="invalid_exec_node"
		return 1
	fi
	case "$sched" in
		launcher | symphony) ;;
		*)
			_RUN_JOURNAL_ERROR="invalid_issue_scheduler"
			return 1
			;;
	esac
	case "$posture" in
		supervised | protected) ;;
		*)
			_RUN_JOURNAL_ERROR="invalid_posture"
			return 1
			;;
	esac

	_RUN_JOURNAL_IDENTITY_CANONICAL=$(jq -S -c . <<<"$identity" 2>/dev/null) || return 1
	# Every field above passed a closed grammar, so the scrub was the identity
	# map on it and the framed copies are byte-equal to the source fields.
	_RUN_JOURNAL_IDENTITY_REQUEST_ID="$req"
	_RUN_JOURNAL_IDENTITY_TASK_ID="$tid"
	_RUN_JOURNAL_IDENTITY_GENERATION="$gen"
	_RUN_JOURNAL_IDENTITY_POSTURE="$posture"
	return 0
}

# ── Payload allowlist (key -> validator), closed per stage ───────────
#
# A closed key->validator map, not key->allowed: an allowlisted free string is
# a place to hide an owner session key. Only `basis` and `reason` are free
# text, and even those pass the value-shape refusals below.
_run_journal_payload_allowlist() {
	case "${1:-}" in
		launch_acknowledged)
			printf '%s\n' \
				accepted_at:iso \
				execution_dir:abspath_normalized \
				canonical_project_dir:abspath_normalized \
				branch:branch \
				start_sha:commit_proven \
				lane_kind:token \
				visibility_verified:bool \
				visibility_degraded:bool
			;;
		task_executing)
			printf '%s\n' \
				observed_at:iso \
				session_ref:taskid \
				pid:uint \
				pgid:uint \
				process_start_identity:taskid
			;;
		cancel_acknowledged)
			printf '%s\n' \
				requested_at:iso \
				requested_by:token \
				cancel_outcome:enum@cancel_requested@already_terminal@generation_mismatch@unknown
			;;
		process_death_authority)
			printf '%s\n' \
				authority:enum@proven@indeterminate \
				basis:text200 \
				residual_ref:taskid
			;;
		completion_row_published)
			printf '%s\n' \
				published_at:iso \
				published_status:terminal_status \
				task_exit_code:int \
				wait_exit_code:int \
				start_commit:commit \
				end_commit:commit
			;;
		review_evidence_settled)
			printf '%s\n' \
				settled_at:iso \
				review_attempt_id:taskid \
				review_verdict:token \
				review_state:token \
				evidence_digest:digest \
				commit_range:commit_range
			;;
		owner_handoff)
			printf '%s\n' \
				handed_off_at:iso \
				handoff_kind:enum@owner_review_required@parked@cancelled \
				owner_review_request_id:taskid \
				reason:text200
			;;
		final_result_published)
			printf '%s\n' \
				published_at:iso \
				result_outcome:token \
				process_death_authority:enum@proven@indeterminate@unrecorded \
				evidence_digest:digest \
				end_commit:commit
			;;
		*) return 1 ;;
	esac
	return 0
}

# Mandatory per-stage schema. Before this existed only
# `process_death_authority` required anything, so `{}` was an accepted record
# for every other stage — including the three owner stages a successor reads as
# proof that something happened. An empty payload is not a weaker record, it is
# a record that says nothing while satisfying a predecessor check.
_run_journal_payload_required_keys() {
	case "${1:-}" in
		launch_acknowledged)
			printf '%s\n' accepted_at execution_dir canonical_project_dir \
				branch start_sha lane_kind visibility_verified
			;;
		task_executing) printf '%s\n' observed_at session_ref pid ;;
		cancel_acknowledged) printf '%s\n' requested_at requested_by cancel_outcome ;;
		process_death_authority) printf '%s\n' authority basis ;;
		completion_row_published) printf '%s\n' published_at published_status ;;
		review_evidence_settled)
			printf '%s\n' settled_at review_attempt_id review_verdict review_state evidence_digest
			;;
		owner_handoff) printf '%s\n' handed_off_at handoff_kind ;;
		final_result_published)
			printf '%s\n' published_at result_outcome process_death_authority evidence_digest
			;;
		*) ;;
	esac
	return 0
}

_run_journal_validate_value() {
	local validator="$1" vtype="$2" value="$3" choice
	case "$validator" in
		iso)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
			;;
		abspath)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^/[A-Za-z0-9._/-]{0,255}$ ]] || return 1
			;;
		# A character class is not normalization: `/a/../b` and `/a/./b` and
		# `/a//b` all satisfy `abspath` while naming something other than what
		# they appear to name. Launch-acknowledgement coordinates are the
		# journal's only claim about WHERE a worker ran, so they must be
		# already-normalized on the wire; the semantic guard then proves the
		# path resolves to itself on disk.
		abspath_normalized)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^/[A-Za-z0-9._/-]{0,255}$ ]] || return 1
			[[ "$value" == "/" || "$value" != */ ]] || return 1
			[[ "$value" != *//* ]] || return 1
			case "/${value}/" in
				*/../* | */./*) return 1 ;;
			esac
			;;
		branch)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] || return 1
			;;
		commit)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" == "unknown" || "$value" =~ ^[0-9a-f]{40}$ ]] || return 1
			;;
		# `unknown` is an admission, not a coordinate. It is tolerable on a
		# completion row (the end state of a run that may genuinely have lost
		# its commit) but never on the launch acknowledgement, which is the
		# record every later fence is compared against.
		commit_proven)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^[0-9a-f]{40}$ ]] || return 1
			;;
		commit_range)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" == "unknown" || "$value" =~ ^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$ ]] || return 1
			;;
		digest)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^[0-9a-f]{24,64}$ ]] || return 1
			;;
		taskid)
			[[ "$vtype" == "string" ]] || return 1
			task_id_is_valid "$value" || return 1
			;;
		token)
			[[ "$vtype" == "string" ]] || return 1
			[[ "$value" =~ ^[a-z][a-z0-9_]{0,63}$ ]] || return 1
			;;
		uint)
			[[ "$vtype" == "number" ]] || return 1
			[[ "$value" =~ ^[0-9]+$ ]] || return 1
			;;
		int)
			[[ "$vtype" == "number" ]] || return 1
			[[ "$value" =~ ^-?[0-9]+$ ]] || return 1
			;;
		bool)
			[[ "$vtype" == "boolean" ]] || return 1
			;;
		text200)
			[[ "$vtype" == "string" ]] || return 1
			[[ ${#value} -le 200 ]] || return 1
			[[ "$value" == *[$'\n\r\t']* ]] && return 1
			;;
		terminal_status)
			[[ "$vtype" == "string" ]] || return 1
			task_status_is_terminal "$value" || return 1
			;;
		enum@*)
			[[ "$vtype" == "string" ]] || return 1
			while IFS= read -r choice; do
				[[ "$choice" == "$value" ]] && return 0
			done < <(printf '%s\n' "${validator#enum@}" | tr '@' '\n')
			return 1
			;;
		*) return 1 ;;
	esac
	return 0
}

_run_journal_validator_for_key() {
	local stage="$1" key="$2" entry
	while IFS= read -r entry; do
		[[ -n "$entry" ]] || continue
		if [[ "${entry%%:*}" == "$key" ]]; then
			printf '%s' "${entry#*:}"
			return 0
		fi
	done < <(_run_journal_payload_allowlist "$stage")
	return 1
}

# A payload KEY is caller-supplied and the allowlist refusal below echoes it
# into the JSON `reason` and onto stderr — BEFORE the secret scan runs, and on a
# path the scan never reaches because the allowlist refused first. A credential
# pasted as a field NAME (`{"ghp_…":1}`) would therefore leak through the
# refusal channel itself, which is the one channel that is supposed to be safe.
# Short keys are reduced to the same closed charset the control-character
# refusal uses, so a mistyped field is still named exactly. A long key is
# already secret-shaped by construction, so it is reported as a bounded prefix
# plus its length and a digest: enough to locate the offending field in the
# caller's own payload, never enough to reproduce the material.
_run_journal_safe_key_label() {
	local raw="${1:-}" safe digest
	safe=$(printf '%s' "$raw" | LC_ALL=C tr -c 'A-Za-z0-9_' '?')
	if ((${#raw} <= 24)); then
		printf '%s' "$safe"
		return 0
	fi
	digest=$(printf '%s' "$raw" | _run_journal_sha256_stdin)
	digest="${digest:0:8}"
	printf '%s~len%s~sha%s' "${safe:0:8}" "${#raw}" "${digest:-unknown}"
}

_run_journal_guard_payload_allowlist() {
	local stage="$1" payload="$2" key vtype value validator required depth arrmax dims
	_RUN_JOURNAL_ERROR=""
	# Shape, depth, and array-length bounds from one jq pass; the refusal order
	# (not-object, then too-deep, then array-too-long) is unchanged.
	dims=$(jq -r '[ type,
		([paths | length] | max // 0),
		([.. | if type == "array" then length else empty end] | max // 0)
	] | map(tostring) | join(" ")' <<<"$payload" 2>/dev/null) || dims=""
	read -r vtype depth arrmax <<<"$dims"
	if [[ "${vtype:-}" != "object" ]]; then
		_RUN_JOURNAL_ERROR="payload_not_object"
		return 1
	fi
	if [[ ! "${depth:-}" =~ ^[0-9]+$ ]] || ((depth > 3)); then
		_RUN_JOURNAL_ERROR="payload_too_deep"
		return 1
	fi
	if [[ ! "${arrmax:-}" =~ ^[0-9]+$ ]] || ((arrmax > 32)); then
		_RUN_JOURNAL_ERROR="payload_array_too_long"
		return 1
	fi
	while IFS= read -r -d '' key && IFS= read -r -d '' vtype && IFS= read -r -d '' value; do
		if ! validator=$(_run_journal_validator_for_key "$stage" "$key"); then
			_RUN_JOURNAL_ERROR="payload_key_not_allowed:$(_run_journal_safe_key_label "$key")"
			return 1
		fi
		if ! _run_journal_validate_value "$validator" "$vtype" "$value"; then
			# Sanitised for the same reason, even though an allowlisted key is by
			# definition one of the closed names: the sanitiser must not be the
			# thing a future allowlist widening quietly steps around.
			_RUN_JOURNAL_ERROR="payload_value_invalid:$(_run_journal_safe_key_label "$key")"
			return 1
		fi
	done < <(jq -j 'to_entries[] | .key + "\u0000" + (.value|type) + "\u0000" + (.value | if type == "string" then . else tostring end) + "\u0000"' <<<"$payload" 2>/dev/null)
	return 0
}

# Completeness is a SEPARATE guard, and it runs after the secret scan on the
# record path. Folding it into the allowlist would let an incomplete payload
# that also carries an owner session key be reported as "missing a key" — a
# weaker refusal than the one it earns, and one that changes which refusal an
# operator sees for a credential leak.
_run_journal_guard_payload_required() {
	local stage="$1" payload="$2" required missing
	_RUN_JOURNAL_ERROR=""
	required=$(_run_journal_payload_required_keys "$stage")
	[[ -n "$required" ]] || return 0
	# One jq names the FIRST missing key, in declaration order — the same key
	# the per-key loop this replaces would have refused on. A payload that does
	# not parse as an object cannot prove it holds any key, so it is missing
	# the first one, exactly as `has` failing reported it before.
	missing=$(jq -r --arg keys "$required" '
		. as $in
		| ($keys | split("\n") | map(select(length > 0))) as $klist
		| if type != "object" then ($klist | first // empty)
		  else ($klist | map(select(. as $k | $in | has($k) | not)) | first // empty) end' \
		<<<"$payload" 2>/dev/null) || missing="${required%%$'\n'*}"
	[[ -n "$missing" ]] || return 0
	_RUN_JOURNAL_ERROR="payload_missing_required:${missing}"
	return 1
}

# ── Control characters ───────────────────────────────────────────────
#
# A journal record is audit text. No control character has any business in a
# key or a value, and admitting one is not merely untidy: the scan loops below
# frame jq's output on NUL, so a value carrying its own NUL bytes can re-align
# the stream and land in a field slot the validator for that slot never
# inspects. That is how `basis` could smuggle a callback URL past a secret
# refusal that rejects the identical payload without the NULs.
#
# This guard runs BEFORE the allowlist and the secret scan on both documents,
# so no forged separator ever reaches a framed loop. `explode` is used rather
# than a regex because oniguruma's behaviour on an embedded NUL is exactly the
# kind of thing this guard exists not to depend on.
_run_journal_guard_control_characters() {
	local document="$1" label="${2:-payload}" offender
	_RUN_JOURNAL_ERROR=""
	# Input jq cannot parse is not this guard's refusal to make — the object
	# checks in the identity validator and the payload allowlist own that
	# message. Deferring is not fail-open: nothing downstream accepts a
	# document that does not parse.
	jq empty >/dev/null 2>&1 <<<"$document" || return 0
	offender=$(jq -r '
		def hasctl: explode | any(. < 32 or . == 127);
		def top: if length == 0 then "<root>" else (.[0] | tostring) end;
		[ (paths | select(any(.[]; (type == "string") and hasctl)) | top),
		  (paths(strings) as $p | select(getpath($p) | hasctl) | ($p | top)) ]
		| first // empty' <<<"$document" 2>/dev/null) || {
		_RUN_JOURNAL_ERROR="${label}_control_character_scan_failed"
		return 1
	}
	if [[ -n "$offender" ]]; then
		# The offender name is itself untrusted; report it through the same
		# charset the stage/identity vocabularies use so a refusal reason can
		# never carry the control bytes it is refusing.
		offender=$(printf '%s' "$offender" | LC_ALL=C tr -c 'A-Za-z0-9_.<>-' '?')
		_RUN_JOURNAL_ERROR="${label}_control_character:${offender:0:64}"
		return 1
	fi
	return 0
}

# The scan streams below are framed on NUL. This filter maps every control
# character to '?' so a value can never forge that separator even if the guard
# above is weakened — belt to the guard's braces. It is a function rather than
# an inline fragment so a mutation test can replace it with an identity filter
# and prove the belt is load-bearing on its own.
_run_journal_jq_scrub_def() {
	printf '%s' 'def scrub: explode | map(if . < 32 or . == 127 then 63 else . end) | implode;'
}

# ── Secret refusal, an independent second layer ──────────────────────
#
# Runs AFTER and independently of the allowlist, so a future edit that widens
# one allowlist still cannot admit token-shaped material. A refusal names the
# offending KEY only and the payload is never canonicalized, hashed, written,
# or quarantined once it is known to be secret-bearing.
# Takes the ALREADY-lowercased key: the scan stream downcases in the same jq
# call that scrubs it, so the denylist match costs no process per key.
_run_journal_secret_key_denylisted() {
	local key="${1:-}"
	case "$key" in
		*token* | *secret* | *password* | *passphrase* | *credential* | *authoriz*) return 0 ;;
		*cookie* | *session_key* | *api_key* | *bearer* | *private_key* | *priv_key*) return 0 ;;
		*access_key* | *refresh* | *jwt* | *otp* | *pin*) return 0 ;;
		*) return 1 ;;
	esac
}

_run_journal_secret_value_shaped() {
	local value="$1" allow_long_runs="${2:-0}"
	[[ ${#value} -gt 512 ]] && return 0
	[[ "$value" =~ [A-Za-z][A-Za-z0-9+.-]*:// ]] && return 0
	local pem_re='-----BEGIN [A-Z ]*PRIVATE KEY'
	[[ "$value" =~ $pem_re ]] && return 0
	[[ "$value" =~ sk-[A-Za-z0-9]{16,} ]] && return 0
	[[ "$value" =~ gh[pousr]_[A-Za-z0-9]{20,} ]] && return 0
	[[ "$value" =~ xox[abprs]- ]] && return 0
	[[ "$value" =~ eyJ[A-Za-z0-9_-]{10,}\. ]] && return 0
	if [[ "$allow_long_runs" != "1" ]]; then
		[[ "$value" =~ [0-9a-fA-F]{64,} ]] && return 0
		[[ "$value" =~ [A-Za-z0-9_-]{64,} ]] && return 0
	fi
	return 1
}

_run_journal_guard_secret_material() {
	local document="$1" stage="${2:-}" key key_lc path value top validator allow_long
	_RUN_JOURNAL_SECRET_KEY=""
	while IFS= read -r -d '' key && IFS= read -r -d '' key_lc; do
		[[ -n "$key" ]] || continue
		if _run_journal_secret_key_denylisted "$key_lc"; then
			_RUN_JOURNAL_SECRET_KEY="$key"
			return 1
		fi
	done < <(jq -j "$(_run_journal_jq_scrub_def) paths | .[] | select(type == \"string\") | scrub | . + \"\u0000\" + ascii_downcase + \"\u0000\"" <<<"$document" 2>/dev/null)
	while IFS= read -r -d '' path && IFS= read -r -d '' value; do
		top="${path%%.*}"
		allow_long=0
		if [[ -n "$stage" ]]; then
			if validator=$(_run_journal_validator_for_key "$stage" "$top"); then
				[[ "$validator" == "digest" ]] && allow_long=1
			fi
		else
			if _run_journal_identity_allows_long_runs "$top"; then
				allow_long=1
			fi
		fi
		if _run_journal_secret_value_shaped "$value" "$allow_long"; then
			_RUN_JOURNAL_SECRET_KEY="${path}"
			return 1
		fi
	done < <(jq -j "$(_run_journal_jq_scrub_def) paths(strings) as \$p | ((\$p | map(tostring) | join(\".\") | scrub) + \"\u0000\" + (getpath(\$p) | scrub) + \"\u0000\")" <<<"$document" 2>/dev/null)
	return 0
}

# ── Quarantine ───────────────────────────────────────────────────────
#
# Quarantine lives inside the request directory, so it is a same-filesystem
# rename, it is visible to a request-scoped query with no scan at all, and it
# is bounded by a per-request budget.
_run_journal_quarantine_dir() { printf '%s/quarantine' "$(_run_journal_entry_dir "$1")"; }

_run_journal_quarantine_count() {
	local dir="$1" f n=0
	[[ -d "$dir" ]] || {
		printf '0'
		return 0
	}
	for f in "$dir"/*; do # BOUNDED-QUARANTINE-ENUMERATION (A17)
		[[ -e "$f" ]] || continue
		# An interrupted atomic write leaves `<name>.json.tmp.XXXXXX` behind (see
		# _run_journal_atomic_json_write). That orphan is not an audit artifact and
		# must not spend the per-request budget — a crashed writer would otherwise
		# push a live request toward quarantine_budget_exhausted for free.
		[[ "$f" == *.json.tmp.* ]] && continue
		n=$((n + 1))
	done
	printf '%s' "$n"
}

_run_journal_guard_quarantine_budget() {
	local request_id="$1" count max
	count=$(_run_journal_quarantine_count "$(_run_journal_quarantine_dir "$request_id")")
	max=$(_run_journal_max_quarantine)
	((count < max))
}

# Rejected in-memory bytes are digest-keyed and first-writer-wins: a retry loop
# with a nondeterministic field would otherwise mint a new file per attempt,
# forever. The first verdict is the record.
_run_journal_quarantine_bytes_locked() {
	local request_id="$1" kind="$2" reason="$3" document="$4" digest dir path json
	digest=$(run_journal_payload_digest "$document") || return 1
	dir=$(_run_journal_quarantine_dir "$request_id")
	path="${dir}/${request_id}.${kind}.${reason}.${digest}.json"
	if [[ -f "$path" ]]; then
		printf '%s' "$path"
		return 0
	fi
	(umask 077 && mkdir -p "$dir") 2>/dev/null || return 1
	json=$(jq -cn \
		--arg schema "oste-run-journal-quarantine/v1" \
		--arg request "$request_id" \
		--arg kind "$kind" \
		--arg reason "$reason" \
		--arg digest "$digest" \
		--arg at "$(_run_journal_now_iso)" \
		--argjson document "$document" \
		'{schema:$schema,launch_request_id:$request,kind:$kind,reason:$reason,
		  document_digest:$digest,quarantined_at:$at,document:$document}') || return 1
	(umask 077 && _run_journal_atomic_json_write "$path" "$json") || return 1
	printf '%s' "$path"
	return 0
}

# Moving a pre-existing file keeps the stamp+nonce name so distinct byte-sets
# survive request-id reuse instead of overwriting each other's audit copy.
#
# TOMBSTONE FIRST, THEN MOVE. A kill between the two must leave the slot CLOSED
# with the evidence still in place, never an open slot whose evidence is gone —
# the second ordering would let fresh bytes silently replace a corrupted record.
_run_journal_quarantine_file_locked() {
	local request_id="$1" path="$2" kind="$3" reason="$4" tombstone="$5"
	local dir stamp nonce destination json digest
	[[ -f "$path" ]] || return 0
	dir=$(_run_journal_quarantine_dir "$request_id")
	(umask 077 && mkdir -p "$dir") 2>/dev/null || return 1
	if [[ -n "$tombstone" && ! -f "$tombstone" ]]; then
		digest=$(_run_journal_sha256_file "$path")
		digest="${digest:0:24}"
		json=$(jq -cn \
			--arg schema "oste-run-journal-tombstone/v1" \
			--arg request "$request_id" \
			--arg kind "$kind" \
			--arg reason "$reason" \
			--arg digest "${digest:-unknown}" \
			--arg at "$(_run_journal_now_iso)" \
			'{schema:$schema,launch_request_id:$request,kind:$kind,reason:$reason,
			  source_digest:$digest,quarantined_at:$at}') || return 1
		(umask 077 && _run_journal_atomic_json_write "$tombstone" "$json") || return 1
	fi
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	nonce=$(_run_journal_new_nonce)
	destination="${dir}/${request_id}.${kind}.${reason}.${stamp}.${nonce}.json"
	mv "$path" "$destination" || return 1
	printf '%s' "$destination"
	return 0
}

# ── Index claim (dedupe fence) ───────────────────────────────────────
#
# The (task_id, task_generation) slot is EXCLUSIVE and is claimed BEFORE the
# WAL, so a crash never leaves a launch that happened with no index trace. The
# claim is a hint, never proof: `stages/launch_acknowledged.json` is the sole
# proof, and a claim that cannot be verified against it is `indeterminate`,
# never `not_found`.
#
# The exclusive test-and-set is a hard link, which is the same lock-free
# primitive as an exclusive mkdir but lands the claim's CONTENT atomically too;
# a bare mkdir leaves a window in which the slot is taken and unattributable.
_run_journal_index_claim() {
	local task_id="$1" generation="$2" request_id="$3" binding_digest="$4" gdir claim tmp json holder anchored
	_RUN_JOURNAL_CLAIM_HOLDER=""
	[[ "$binding_digest" =~ ^[0-9a-f]{64}$ ]] || return 3
	claim=$(_run_journal_index_claim_path "$task_id" "$generation")
	gdir=$(dirname "$claim")
	if [[ -f "$claim" ]]; then
		holder=$(jq -r '.launch_request_id // empty' "$claim" 2>/dev/null || true)
		anchored=$(jq -r '.binding_identity_digest // empty' "$claim" 2>/dev/null || true)
		_RUN_JOURNAL_CLAIM_HOLDER="$holder"
		[[ "$holder" == "$request_id" ]] || return 2
		[[ "$anchored" == "$binding_digest" ]] && return 0
		return 3
	fi
	(umask 077 && mkdir -p "$gdir") 2>/dev/null || return 1
	json=$(jq -cn \
		--arg schema "oste-run-journal-claim/v1" \
		--arg request "$request_id" \
		--arg digest "$binding_digest" \
		--arg at "$(_run_journal_now_iso)" \
		'{schema:$schema,launch_request_id:$request,binding_identity_digest:$digest,claimed_at:$at}') || return 1
	tmp=$(mktemp "${claim}.tmp.XXXXXX") || return 1
	if ! printf '%s\n' "$json" | jq -c . >"$tmp" 2>/dev/null || [[ ! -s "$tmp" ]]; then
		rm -f "$tmp"
		return 1
	fi
	if ln "$tmp" "$claim" 2>/dev/null; then
		rm -f "$tmp"
		_RUN_JOURNAL_CLAIM_HOLDER="$request_id"
		return 0
	fi
	rm -f "$tmp"
	holder=$(jq -r '.launch_request_id // empty' "$claim" 2>/dev/null || true)
	anchored=$(jq -r '.binding_identity_digest // empty' "$claim" 2>/dev/null || true)
	_RUN_JOURNAL_CLAIM_HOLDER="$holder"
	[[ "$holder" == "$request_id" ]] || return 2
	[[ "$anchored" == "$binding_digest" ]] && return 0
	return 3
}

# ── Recovery ─────────────────────────────────────────────────────────

_run_journal_stage_path() { printf '%s/stages/%s.json' "$(_run_journal_entry_dir "$1")" "$2"; }
_run_journal_stage_tombstone() { printf '%s/stages/%s.quarantined.json' "$(_run_journal_entry_dir "$1")" "$2"; }
_run_journal_wal_path() { printf '%s/wal/pending.json' "$(_run_journal_entry_dir "$1")"; }

_run_journal_record_is_wellformed() {
	jq -e '
		type == "object"
		and (.schema | type == "string")
		and (.launch_request_id | type == "string")
		and (.task_generation | type == "string")
		and (.stage | type == "string")
		and (.payload_digest | type == "string")
		and (.record_digest | type == "string")
		and (.recorded_at | type == "string")
		and (.payload | type == "object")' >/dev/null 2>&1 <"$1"
}

_run_journal_binding_identity() {
	local request_id="$1" path
	path=$(_run_journal_stage_path "$request_id" launch_acknowledged)
	[[ -f "$path" ]] || return 1
	jq -ce '.identity' "$path" 2>/dev/null
}

# Runs first on every access, record and query alike, under the lock. A read
# path that skipped recovery could report a hole a write path would immediately
# have filled — which is exactly the "silently empty" failure this phase exists
# to prevent.
_run_journal_guard_recover_on_read() {
	local request_id="$1" entry_dir stage path tombstone wal reason
	entry_dir=$(_run_journal_entry_dir "$request_id")
	[[ -d "$entry_dir" ]] || return 0

	# 1. Corrupt accepted records poison their slot; evidence is preserved.
	while IFS= read -r stage; do
		path=$(_run_journal_stage_path "$request_id" "$stage")
		tombstone=$(_run_journal_stage_tombstone "$request_id" "$stage")
		[[ -f "$path" ]] || continue
		[[ -f "$tombstone" ]] && continue
		_run_journal_record_is_wellformed "$path" && continue
		if [[ "$stage" == "launch_acknowledged" ]]; then
			reason="malformed-binding"
		else
			reason="malformed-record"
		fi
		_run_journal_quarantine_file_locked "$request_id" "$path" record "$reason" "$tombstone" >/dev/null || return 1
	done < <(run_journal_stage_vocabulary)

	# 2. Complete a tombstoned-but-unmoved slot (crash between tombstone and mv).
	while IFS= read -r stage; do
		path=$(_run_journal_stage_path "$request_id" "$stage")
		tombstone=$(_run_journal_stage_tombstone "$request_id" "$stage")
		[[ -f "$tombstone" && -f "$path" ]] || continue
		_run_journal_quarantine_file_locked "$request_id" "$path" record "resumed-quarantine" "" >/dev/null || return 1
	done < <(run_journal_stage_vocabulary)

	# 3. Resolve at most one in-flight append intent.
	wal=$(_run_journal_wal_path "$request_id")
	[[ -f "$wal" ]] || return 0
	_run_journal_recover_wal_locked "$request_id" "$wal"
}

_run_journal_wal_tombstone_path() {
	local request_id="$1" wal="$2" digest
	digest=$(_run_journal_sha256_file "$wal")
	digest="${digest:0:24}"
	printf '%s/wal/quarantined.%s.json' "$(_run_journal_entry_dir "$request_id")" "${digest:-unknown}"
}

_run_journal_wal_slot_is_quarantined() {
	[[ -f "$(_run_journal_stage_tombstone "$1" "$2")" ]]
}

# The front door's validation, re-run over a WAL's own bytes. Sets
# `_RUN_JOURNAL_ERROR` to a short reason the caller folds into the quarantine
# label. Never writes.
_run_journal_replay_validate_locked() {
	local request_id="$1" wal="$2" stage="$3" declared_digest="$4"
	local payload recomputed posture rc=0 record_declared record_recomputed
	_RUN_JOURNAL_ERROR=""

	payload=$(jq -c '.record.payload' "$wal" 2>/dev/null) || payload=""
	if [[ -z "$payload" || "$payload" == "null" ]]; then
		_RUN_JOURNAL_ERROR="payload-unreadable"
		return 1
	fi
	# Recomputed from the payload actually present, never trusted from the
	# declaration beside it.
	recomputed=$(run_journal_payload_digest "$payload" 2>/dev/null) || recomputed=""
	if [[ -z "$recomputed" || "$recomputed" != "$declared_digest" ]]; then
		_RUN_JOURNAL_ERROR="payload-digest-mismatch"
		return 1
	fi
	record_declared=$(jq -r '.record.record_digest // empty' "$wal" 2>/dev/null) || record_declared=""
	record_recomputed=$(run_journal_record_digest "$(jq -c '.record' "$wal" 2>/dev/null)" 2>/dev/null) || record_recomputed=""
	if [[ -z "$record_recomputed" || "$record_recomputed" != "$record_declared" ]]; then
		_RUN_JOURNAL_ERROR="record-digest-mismatch"
		return 1
	fi
	if ! _run_journal_guard_control_characters "$payload" payload; then
		_RUN_JOURNAL_ERROR="payload-control-characters"
		return 1
	fi
	# §P0, at the replay door too. Without this a WAL may publish a record whose
	# complete identity is not the binding's: the read path would refuse it on
	# every access, but it would still OCCUPY the slot, and an occupied slot
	# refuses the honest append (stage_conflict). Refusing here quarantines the
	# intent and leaves the slot open, which is the difference between a
	# tampered journal and a dead one.
	if ! _run_journal_record_complete_identity_ok "$request_id" "$stage" \
		"$(jq -c '.record.identity // empty' "$wal" 2>/dev/null || true)" \
		"$(jq -r '.record.launch_request_id // empty' "$wal" 2>/dev/null || true)" \
		"$(jq -r '.record.task_generation // empty' "$wal" 2>/dev/null || true)" \
		"$(jq -c '.record.payload // empty' "$wal" 2>/dev/null || true)"; then
		# Hyphenated to match every other replay reason: the caller folds this
		# straight into a quarantine FILENAME, which `run_journal_quarantine_list`
		# re-splits on `.`.
		_RUN_JOURNAL_ERROR="${_RUN_JOURNAL_IDENTITY_REFUSAL//_/-}"
		[[ -n "$_RUN_JOURNAL_ERROR" ]] || _RUN_JOURNAL_ERROR="record-identity-unverifiable"
		return 1
	fi
	if ! (_run_journal_guard_payload_allowlist "$stage" "$payload") >/dev/null 2>&1; then
		_RUN_JOURNAL_ERROR="payload-not-allowlisted"
		return 1
	fi
	if ! (_run_journal_guard_payload_required "$stage" "$payload") >/dev/null 2>&1; then
		_RUN_JOURNAL_ERROR="payload-incomplete"
		return 1
	fi
	if ! (_run_journal_guard_secret_material "$payload" "$stage") >/dev/null 2>&1; then
		_RUN_JOURNAL_ERROR="payload-secret-material"
		return 1
	fi
	if _run_journal_stage_is_owner_only "$stage" && ! _run_journal_owner_stage_authority_available; then
		_RUN_JOURNAL_ERROR="owner-stage-authority-absent"
		return 1
	fi
	if [[ "$stage" == "launch_acknowledged" ]]; then
		posture=$(jq -r '.record.identity.posture // empty' "$wal" 2>/dev/null || true)
		if ! (_run_journal_guard_launch_coordinates "$payload") >/dev/null 2>&1; then
			_RUN_JOURNAL_ERROR="launch-coordinates-unproven"
			return 1
		fi
	else
		posture=$(_run_journal_binding_identity "$request_id" 2>/dev/null |
			jq -r '.posture // empty' 2>/dev/null || true)
	fi
	if ! (_run_journal_guard_posture_authority "$posture" "$stage" "$payload") >/dev/null 2>&1; then
		_RUN_JOURNAL_ERROR="posture-authority-refused"
		return 1
	fi
	_run_journal_guard_predecessors "$request_id" "$stage" || rc=$?
	if ((rc != 0)); then
		_RUN_JOURNAL_ERROR="predecessors-unsatisfied"
		return 1
	fi
	if [[ "$stage" == "final_result_published" ]]; then
		if ! (_run_journal_guard_owner_settlement_order "$request_id") >/dev/null 2>&1; then
			_RUN_JOURNAL_ERROR="owner-settlement-order"
			return 1
		fi
		rc=0
		(_run_journal_guard_authority_consistency "$request_id" "$payload") >/dev/null 2>&1 || rc=$?
		if ((rc != 0)); then
			_RUN_JOURNAL_ERROR="authority-contradiction"
			return 1
		fi
		if ! (_run_journal_guard_final_evidence_digest "$request_id" "$payload") >/dev/null 2>&1; then
			_RUN_JOURNAL_ERROR="final-evidence-digest-mismatch"
			return 1
		fi
	fi
	return 0
}

_run_journal_recover_wal_locked() {
	local request_id="$1" wal="$2"
	local wal_request wal_stage wal_generation wal_digest record binding_generation existing existing_digest
	local tombstone

	if ! jq -e '
		type == "object"
		and (.launch_request_id | type == "string")
		and (.stage | type == "string")
		and (.task_generation | type == "string")
		and (.payload_digest | type == "string")
		and (.record | type == "object")' >/dev/null 2>&1 <"$wal"; then
		tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
		_run_journal_quarantine_file_locked "$request_id" "$wal" wal malformed-wal "$tombstone" >/dev/null || return 1
		return 0
	fi
	wal_request=$(jq -r '.launch_request_id' "$wal")
	wal_stage=$(jq -r '.stage' "$wal")
	wal_generation=$(jq -r '.task_generation' "$wal")
	wal_digest=$(jq -r '.payload_digest' "$wal")

	if [[ "$wal_request" != "$request_id" ]] || ! run_journal_stage_is_known "$wal_stage"; then
		tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
		_run_journal_quarantine_file_locked "$request_id" "$wal" wal wal-identity-mismatch "$tombstone" >/dev/null || return 1
		return 0
	fi

	binding_generation=$(_run_journal_binding_identity "$request_id" 2>/dev/null |
		jq -r '.task_generation // empty' 2>/dev/null || true)
	if [[ -n "$binding_generation" && "$binding_generation" != "$wal_generation" ]]; then
		tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
		_run_journal_quarantine_file_locked "$request_id" "$wal" wal stale-task-generation "$tombstone" >/dev/null || return 1
		return 0
	fi

	# Step 1 of recovery may have quarantined this very slot moments ago, which
	# is precisely when the slot's record file is absent — the condition the
	# replay below reads as "nothing here yet, write it". Replaying into a
	# tombstoned slot resurrects a record that the SAME pass just poisoned, and
	# leaves both `<stage>.json` and `<stage>.quarantined.json` present: a state
	# the record path refuses to create (stage_quarantined). A quarantined slot
	# is closed for good; the intent goes to the WAL quarantine under its own
	# reason so an operator reads "collision", not "crash between tombstone and
	# mv".
	if _run_journal_wal_slot_is_quarantined "$request_id" "$wal_stage"; then
		tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
		_run_journal_quarantine_file_locked "$request_id" "$wal" wal wal-slot-quarantined "$tombstone" >/dev/null || return 1
		return 0
	fi

	# A PREDECESSOR the same pass poisoned closes this slot just as firmly. The
	# record path refuses to append above a quarantined predecessor
	# (predecessor_quarantined), so replaying here would let recovery create a
	# lattice state the front door rejects.
	local predecessor
	while IFS= read -r predecessor; do
		[[ -n "$predecessor" ]] || continue
		_run_journal_wal_slot_is_quarantined "$request_id" "$predecessor" || continue
		tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
		_run_journal_quarantine_file_locked "$request_id" "$wal" wal wal-predecessor-quarantined "$tombstone" >/dev/null || return 1
		return 0
	done < <(run_journal_stage_predecessors "$wal_stage")

	existing=$(_run_journal_stage_path "$request_id" "$wal_stage")
	if [[ -f "$existing" ]]; then
		existing_digest=$(jq -r '.payload_digest // empty' "$existing" 2>/dev/null || true)
		if [[ "$existing_digest" != "$wal_digest" ]]; then
			# Impossible while the lock is honoured, therefore corruption. The
			# accepted record stays untouched and authoritative.
			tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
			_run_journal_quarantine_file_locked "$request_id" "$wal" wal wal-record-conflict "$tombstone" >/dev/null || return 1
			return 0
		fi
	else
		# ── Replay the SAME validated transaction as a normal append ──
		#
		# Outer well-formedness is not a transaction. Before this, a WAL whose
		# `.record.payload` had been altered while its declared `payload_digest`
		# was left intact was published on the strength of its shape alone,
		# bypassing the payload allowlist, the mandatory schema, the secret
		# scan, posture-bound authority, the owner-stage gate, launch coordinate
		# proof, predecessors and authority consistency. Every one of those runs
		# here, under the same request lock, and any refusal quarantines the WAL
		# instead of publishing it.
		if ! _run_journal_replay_validate_locked "$request_id" "$wal" "$wal_stage" "$wal_digest"; then
			tombstone=$(_run_journal_wal_tombstone_path "$request_id" "$wal")
			_run_journal_quarantine_file_locked "$request_id" "$wal" wal \
				"wal-${_RUN_JOURNAL_ERROR:-replay-validation-failed}" "$tombstone" >/dev/null || return 1
			return 0
		fi
		record=$(jq -c '.record' "$wal") || return 1
		(umask 077 && _run_journal_atomic_json_write "$existing" "$record") || return 1
	fi

	if [[ "$wal_stage" == "launch_acknowledged" ]]; then
		local task_id binding_digest
		task_id=$(jq -r '.record.identity.task_id // empty' "$wal" 2>/dev/null || true)
		binding_digest=$(run_journal_launch_binding_digest \
			"$(jq -c '.record.identity // empty' "$wal" 2>/dev/null)" \
			"$(jq -c '.record.payload // empty' "$wal" 2>/dev/null)" 2>/dev/null || true)
		if [[ -n "$task_id" && -n "$binding_digest" ]]; then
			_run_journal_index_claim "$task_id" "$wal_generation" "$request_id" "$binding_digest" >/dev/null || true
		fi
	fi
	rm -f "$wal"
	return 0
}

# ── Request readability state ────────────────────────────────────────
#
# `not_found` is the one legitimate "no record". Nothing else ever degrades to
# it: a corrupt or insecure request is `journal_unreadable`, an unverifiable
# index claim is `indeterminate`, and an unobtainable lock is `journal_locked`.
# Prints "<state> <reason>" as ONE NEWLINE-TERMINATED LINE — state in {absent,
# unreadable, present}. It reports through stdout rather than a shell variable
# because every caller reads it through a command substitution, and a variable
# set in that subshell would be silently discarded.
#
# The trailing newline is load-bearing, not cosmetic. Every caller consumes this
# with `read -r state reason < <(...)`, and `read` returns 1 on an unterminated
# final line. Under a caller's `set -e` that non-zero status aborts the whole
# record mid-critical-section: no JSON on stdout at all, the lock still held —
# the exact silently-empty failure this library exists to prevent.
_run_journal_guard_unreadable_binding() {
	local request_id="$1" entry_dir
	entry_dir=$(_run_journal_entry_dir "$request_id")
	if [[ ! -d "$entry_dir" ]]; then
		printf 'absent \n'
		return 0
	fi
	if ! _run_journal_guard_secure_mode "$entry_dir"; then
		printf 'unreadable insecure_permissions\n'
		return 0
	fi
	if [[ -f "$(_run_journal_stage_tombstone "$request_id" launch_acknowledged)" ]]; then
		printf 'unreadable malformed-binding\n'
		return 0
	fi
	if [[ ! -f "$(_run_journal_stage_path "$request_id" launch_acknowledged)" ]]; then
		if [[ -f "${entry_dir}/binding.json" ]]; then
			printf 'unreadable binding-without-acknowledgement\n'
			return 0
		fi
		# Every other stage is gated on the acknowledgement, so a later record
		# cannot exist without it. An entry holding one has LOST its binding, and
		# reporting that as `absent` is exactly the degradation the header refuses:
		# it would tell a scheduler "nothing happened" about a request that
		# demonstrably ran.
		local later
		while IFS= read -r later; do
			[[ "$later" == "launch_acknowledged" ]] && continue
			[[ -f "$(_run_journal_stage_path "$request_id" "$later")" ]] || continue
			printf 'unreadable acknowledgement-lost\n'
			return 0
		done < <(run_journal_stage_vocabulary)
		printf 'absent \n'
		return 0
	fi
	if ! _run_journal_record_integrity_ok "$request_id" launch_acknowledged; then
		printf 'unreadable binding-integrity-refused\n'
		return 0
	fi
	printf 'present \n'
	return 0
}

# ── Projection ───────────────────────────────────────────────────────

_run_journal_quarantined_wal_count() {
	local request_id="$1" f n=0 wal_dir
	wal_dir="$(_run_journal_entry_dir "$request_id")/wal"
	for f in "$wal_dir"/quarantined.*.json; do # BOUNDED-QUARANTINE-ENUMERATION (A17)
		[[ -e "$f" ]] || continue
		n=$((n + 1))
	done
	printf '%s' "$n"
}

# Runs the stage's own allowlist + mandatory-schema check over a payload, in a
# SUBSHELL so the guard's `_RUN_JOURNAL_ERROR` assignment cannot clobber the
# refusal a caller is already carrying.
_run_journal_stage_payload_semantics_ok() {
	(_run_journal_guard_payload_allowlist "$1" "$2" &&
		_run_journal_guard_payload_required "$1" "$2") >/dev/null 2>&1
}

# ── §4 accepted-record integrity ─────────────────────────────────────
#
# Field types and current-schema conformance are NOT integrity. Every check
# above this line is satisfied by a record whose payload has been edited from
# one valid value to another valid value — swap
# `review_evidence_settled.payload.evidence_digest` for a different well-formed
# digest and the type shape holds, the allowlist holds, the mandatory schema
# holds, `result_stage_predecessors_satisfied` stays true, the projection hands
# the caller the now-STALE `payload_digest` beside the new payload, and
# `_run_journal_guard_final_evidence_digest` binds the final publication to
# bytes nobody ever settled. Reproduced before this guard existed.
#
# The digest is therefore RECOMPUTED from the payload actually on disk, and the
# record's complete identity coordinates are compared against the request,
# stage and bound generation the caller is resolving — on every satisfaction
# and every projection, not only on the WAL replay path where it already was.
#
# It REFUSES rather than quarantines: quarantine is permanent and irreversible
# ("a quarantined slot never reopens"), and a read path must not be able to
# destroy a record. A refused record satisfies nothing, projects no payload and
# no digest, and is reported by name, which is what a reader needs in order to
# tell a tampered predecessor from an absent one.
#
# ── Complete-identity comparison (steering P0) ───────────────────────
#
# The three duplicated top-level coordinates — `.launch_request_id`, `.stage`,
# `.task_generation` — are NOT the record's identity. They are three of twelve
# fields, copied out for cheap indexing. Checking only those left nine fields
# (`launch_attempt_epoch`, `symphony_run_uuid`, `symphony_run_retry`,
# `symphony_run_turn`, `task_id`, `work_item_ref`, `workroom_ref`,
# `issue_scheduler`, `exec_node`) with nothing to be compared against, so a
# persisted predecessor could have `.identity.work_item_ref` edited from
# `linear:PAR-1` to `linear:PAR-999` — payload untouched, stored payload_digest
# still recomputing correctly, all three top-level coordinates unchanged — and
# still report `outcome:found`, `result_stage_predecessors_satisfied:true`,
# `missing_result_predecessors:[]`, project as `integrity:"verified"`, and
# authorize a final publication. Reproduced valid-to-valid before this guard
# existed.
#
# The authority compared against is the LAUNCH BINDING: the acknowledgement
# record's `.identity`, which the append path pins for the whole request
# (a differing identity on any later append is refused as `binding_conflict`).
# So a record on disk whose complete identity is not byte-identical to the
# binding is not a stronger or weaker record — it is one nobody ever appended.
#
# Fail-closed in both directions. A record with NO identity object cannot be
# compared, and "cannot be compared" must never read as "compares equal",
# otherwise deleting the object is a cheaper bypass than editing it. An absent
# binding is refused for the same reason.
#
# The acknowledgement is the binding, so comparing it against itself proves
# nothing. It re-runs the front-door grammar and must match the complete-identity
# digest committed independently in its exclusive task/generation claim.
#
# Sets `_RUN_JOURNAL_IDENTITY_REFUSAL` — deliberately NOT `_RUN_JOURNAL_ERROR`,
# which the predecessor and final-evidence guards are already carrying across
# this call. Never writes.
_RUN_JOURNAL_IDENTITY_REFUSAL=""
_run_journal_record_complete_identity_ok() {
	local request_id="$1" stage="$2" identity="$3" declared_request="$4" declared_generation="$5" payload="${6:-}"
	local canonical actual binding claim task_id generation holder anchored computed
	local shape="" ident_request="" ident_generation="" ident_task_id=""
	_RUN_JOURNAL_IDENTITY_REFUSAL=""
	# One parse for the identity: the shape verdict, the canonical bytes, the
	# sorted key set, and the duplicated coordinates arrive NUL-framed from a
	# single jq call. `-S -c` is the same serializer the separate `jq -S -c .`
	# applied, so `canonical` is byte-identical and every digest built from it is
	# unchanged. The bare-string frames ride the shared scrub filter so an
	# embedded control character becomes '?' rather than a forged frame; the
	# canonical frame is not scrubbed, because the JSON encoder already escapes
	# control characters there and scrubbing would change the digested bytes.
	# The verdicts below stay in bash, in the same order, with the same refusal
	# codes.
	if [[ -z "$identity" ]] || ! {
		IFS= read -r -d '' shape &&
			IFS= read -r -d '' canonical &&
			IFS= read -r -d '' actual &&
			IFS= read -r -d '' ident_request &&
			IFS= read -r -d '' ident_generation &&
			IFS= read -r -d '' ident_task_id
	} < <(jq -S -j -c "$(_run_journal_jq_scrub_def)"'
		if type != "object"
		then "not_object", "\u0000", "", "\u0000", "", "\u0000", "", "\u0000", "", "\u0000", "", "\u0000"
		else "object", "\u0000", ., "\u0000",
			(keys_unsorted | sort | map(scrub) | join(" ")), "\u0000",
			((.launch_request_id // "") | scrub), "\u0000",
			((.task_generation // "") | scrub), "\u0000",
			((.task_id // "") | scrub), "\u0000"
		end' <<<"$identity" 2>/dev/null); then
		_RUN_JOURNAL_IDENTITY_REFUSAL="record_identity_absent"
		return 1
	fi
	if [[ "$shape" != "object" || -z "$canonical" ]]; then
		_RUN_JOURNAL_IDENTITY_REFUSAL="record_identity_absent"
		return 1
	fi
	# COMPLETE, not "as many fields as happen to be present": a subset would
	# compare equal on everything it contains while omitting the field that was
	# tampered, and a superset is a shape the append path never produced.
	_run_journal_identity_fields_expected
	if [[ "$_RUN_JOURNAL_IDENTITY_FIELDS_EXPECTED" != "$actual" ]]; then
		_RUN_JOURNAL_IDENTITY_REFUSAL="record_identity_field_set_mismatch"
		return 1
	fi
	# The duplicated coordinates are a COPY of two identity fields. A record
	# whose copy disagrees with its own original is internally inconsistent
	# whatever the binding says.
	if [[ "$ident_request" != "$declared_request" || "$ident_generation" != "$declared_generation" ]]; then
		_RUN_JOURNAL_IDENTITY_REFUSAL="record_identity_incoherent"
		return 1
	fi
	if [[ "$stage" == "launch_acknowledged" ]]; then
		# Subshell: _run_journal_validate_identity assigns _RUN_JOURNAL_ERROR and
		# _RUN_JOURNAL_IDENTITY_CANONICAL, and a read path must not disturb either.
		if ! (_run_journal_validate_identity "$canonical") >/dev/null 2>&1; then
			_RUN_JOURNAL_IDENTITY_REFUSAL="binding_identity_ungrammatical"
			return 1
		fi
		# The root cannot authenticate itself. Its complete canonical identity is
		# committed independently in the exclusive task/generation claim before
		# the acknowledgement is published; that claim is never refreshed by a
		# same-request idempotent read or rewrite.
		task_id="$ident_task_id"
		generation="$ident_generation"
		claim=$(_run_journal_index_claim_path "$task_id" "$generation")
		if [[ ! -f "$claim" ]]; then
			_RUN_JOURNAL_IDENTITY_REFUSAL="binding_identity_anchor_absent"
			return 1
		fi
		holder=$(jq -r '.launch_request_id // empty' "$claim" 2>/dev/null || true)
		anchored=$(jq -r '.binding_identity_digest // empty' "$claim" 2>/dev/null || true)
		computed=$(run_journal_launch_binding_digest "$canonical" "$payload" 2>/dev/null || true)
		if [[ "$holder" != "$request_id" ]]; then
			_RUN_JOURNAL_IDENTITY_REFUSAL="binding_identity_anchor_holder_mismatch"
			return 1
		fi
		if [[ ! "$anchored" =~ ^[0-9a-f]{64}$ || "$computed" != "$anchored" ]]; then
			_RUN_JOURNAL_IDENTITY_REFUSAL="binding_record_digest_mismatch"
			return 1
		fi
		return 0
	fi
	binding=$(_run_journal_binding_identity "$request_id" 2>/dev/null || true)
	# Shape verdict and canonical bytes in one parse. `-S -c` is the same
	# serializer as the separate call it replaces, so the string compared
	# against `canonical` below is byte-identical.
	local binding_shape=""
	if [[ -z "$binding" ]] || ! {
		IFS= read -r -d '' binding_shape &&
			IFS= read -r -d '' binding
	} < <(jq -S -j -c '
		if type != "object" then "not_object", "\u0000", "", "\u0000"
		else "object", "\u0000", ., "\u0000" end' <<<"$binding" 2>/dev/null) ||
		[[ "$binding_shape" != "object" ]]; then
		_RUN_JOURNAL_IDENTITY_REFUSAL="binding_identity_absent"
		return 1
	fi
	if [[ -z "$binding" || "$binding" != "$canonical" ]]; then
		_RUN_JOURNAL_IDENTITY_REFUSAL="record_binding_identity_mismatch"
		return 1
	fi
	return 0
}

# Sets `_RUN_JOURNAL_INTEGRITY_REASON`. Never writes.
_RUN_JOURNAL_INTEGRITY_REASON=""
_run_journal_record_integrity_ok() {
	local request_id="$1" stage="$2" path payload declared recomputed bound record_declared record_recomputed
	local top_request="" top_stage="" top_generation="" identity="" record_canonical=""
	_RUN_JOURNAL_INTEGRITY_REASON=""
	path=$(_run_journal_stage_path "$request_id" "$stage")
	if [[ ! -f "$path" ]]; then
		_RUN_JOURNAL_INTEGRITY_REASON="record_absent"
		return 1
	fi
	if ! _run_journal_record_is_wellformed "$path"; then
		_RUN_JOURNAL_INTEGRITY_REASON="record_not_wellformed"
		return 1
	fi
	# One parse for the whole record, not one per field: the three duplicated
	# coordinates, the identity, the payload, both declared digests, and the
	# canonical bytes each digest is recomputed over arrive NUL-framed from a
	# single jq call. `-S -c` is the SAME serializer the digest helpers apply
	# internally, so every framed canonical value is byte-identical to the one
	# a separate `jq -S -c` produced and no digest changes.
	#
	# Framing safety has two halves. The three JSON values (identity, payload,
	# whole record) are printed by the JSON encoder, which escapes every control
	# character, so their bytes can never contain a raw NUL. The five bare
	# strings are printed RAW by -j, so they ride the shared scrub filter first
	# — exactly as the identity validator's frames do — and a control character
	# inside one becomes '?' instead of a forged frame boundary. Scrubbing
	# cannot mask a bad record: every scrubbed field is compared against an
	# unscrubbed expectation or a recomputed digest, so a scrubbed value refuses.
	# The scrub is defence in depth rather than the thing holding the door shut:
	# even a shifted frame cannot satisfy the two recomputed digests, so forgery
	# fails CLOSED with or without it. Section QF pins that outcome directly.
	# Every verdict below stays in bash, in the same order, with the same
	# refusal codes.
	if ! {
		IFS= read -r -d '' top_request &&
			IFS= read -r -d '' top_stage &&
			IFS= read -r -d '' top_generation &&
			IFS= read -r -d '' identity &&
			IFS= read -r -d '' payload &&
			IFS= read -r -d '' declared &&
			IFS= read -r -d '' record_declared &&
			IFS= read -r -d '' record_canonical
	} < <(jq -S -j -c "$(_run_journal_jq_scrub_def)"'
		(.launch_request_id | scrub), "\u0000",
		(.stage | scrub), "\u0000",
		(.task_generation | scrub), "\u0000",
		(.identity // ""), "\u0000",
		(.payload // ""), "\u0000",
		((.payload_digest // "") | scrub), "\u0000",
		((.record_digest // "") | scrub), "\u0000",
		., "\u0000"' "$path" 2>/dev/null); then
		_RUN_JOURNAL_INTEGRITY_REASON="record_not_wellformed"
		return 1
	fi
	# Complete identity, not merely the filename: a record copied in from
	# another request or another stage has a correct-looking path and wrong
	# coordinates.
	if [[ "$top_request" != "$request_id" || "$top_stage" != "$stage" ]]; then
		_RUN_JOURNAL_INTEGRITY_REASON="record_identity_mismatch"
		return 1
	fi
	# The acknowledgement's identity is the binding for the whole request, so
	# every later record must name the generation it bound. Absent binding =>
	# nothing to compare against (the acknowledgement is itself the record
	# being checked, or the entry has no acknowledgement at all).
	bound=$(jq -r '.identity.task_generation // empty' \
		"$(_run_journal_stage_path "$request_id" launch_acknowledged)" 2>/dev/null || true)
	if [[ -n "$bound" && "$top_generation" != "$bound" ]]; then
		_RUN_JOURNAL_INTEGRITY_REASON="record_generation_mismatch"
		return 1
	fi
	# The COMPLETE identity, before the payload is looked at and before this
	# record may satisfy anything or project as verified. The three coordinates
	# above are the cheap half; this is the other nine fields.
	if ! _run_journal_record_complete_identity_ok "$request_id" "$stage" \
		"$identity" "$top_request" "$top_generation" "$payload"; then
		_RUN_JOURNAL_INTEGRITY_REASON="$_RUN_JOURNAL_IDENTITY_REFUSAL"
		return 1
	fi
	if [[ -z "$payload" || "$payload" == "null" ]]; then
		_RUN_JOURNAL_INTEGRITY_REASON="payload_unreadable"
		return 1
	fi
	recomputed=$(run_journal_payload_digest "$payload" 2>/dev/null) || recomputed=""
	if [[ -z "$recomputed" || "$recomputed" != "$declared" ]]; then
		_RUN_JOURNAL_INTEGRITY_REASON="payload_digest_mismatch"
		return 1
	fi
	record_recomputed=$(run_journal_record_digest "$record_canonical" 2>/dev/null) || record_recomputed=""
	if [[ -z "$record_recomputed" || "$record_recomputed" != "$record_declared" ]]; then
		_RUN_JOURNAL_INTEGRITY_REASON="record_digest_mismatch"
		return 1
	fi
	return 0
}

# Presence is not satisfaction. A predecessor only satisfies a successor if the
# file still parses as a record FOR THAT STAGE and its payload still meets the
# stage's mandatory schema — otherwise a truncated, retyped, or `{}` record
# authorizes everything above it in the lattice on the strength of its filename.
_run_journal_stage_satisfied() {
	local request_id="$1" stage="$2" path payload
	path=$(_run_journal_stage_path "$request_id" "$stage")
	[[ -f "$path" ]] || return 1
	[[ -f "$(_run_journal_stage_tombstone "$request_id" "$stage")" ]] && return 1
	# §4: integrity BEFORE semantics. A valid-to-valid payload edit passes every
	# semantic check below it and is caught only by recomputing the digest.
	_run_journal_record_integrity_ok "$request_id" "$stage" || return 1
	payload=$(jq -c --arg s "$stage" '
		if type == "object" and .stage == $s and (.payload | type) == "object"
		then .payload else empty end' "$path" 2>/dev/null) || return 1
	[[ -n "$payload" ]] || return 1
	_run_journal_stage_payload_semantics_ok "$stage" "$payload" || return 1
	return 0
}

_run_journal_project_request() {
	local request_id="$1" stage path tombstone stages_json recorded_json quarantined_json
	local entry binding binding_digest="" missing_json satisfied=true violating_json violation=false
	local final_recorded=false wal_quarantined integrity_json

	stages_json='[]'
	recorded_json='[]'
	quarantined_json='[]'
	integrity_json='[]'
	while IFS= read -r stage; do # closed vocabulary, never a directory glob
		path=$(_run_journal_stage_path "$request_id" "$stage")
		tombstone=$(_run_journal_stage_tombstone "$request_id" "$stage")
		if [[ -f "$tombstone" ]]; then
			entry=$(jq -cn --arg stage "$stage" \
				'{stage:$stage,payload_digest:null,recorded_at:null,quarantined:true,payload:null}')
			quarantined_json=$(jq -c --arg s "$stage" '. + [$s]' <<<"$quarantined_json")
		elif [[ -f "$path" ]]; then
			# §4: a record that fails the integrity recompute PROJECTS NOTHING.
			# Copying `.payload_digest` and `.payload` straight out of the file
			# is precisely how a stale digest reached a consumer that then bound
			# a durable publication to it.
			if ! _run_journal_record_integrity_ok "$request_id" "$stage"; then
				entry=$(jq -cn --arg stage "$stage" --arg reason "$_RUN_JOURNAL_INTEGRITY_REASON" \
					'{stage:$stage,payload_digest:null,recorded_at:null,quarantined:false,
					  payload:null,integrity:"refused",integrity_reason:$reason}')
				integrity_json=$(jq -c --arg s "$stage" '. + [$s]' <<<"$integrity_json")
				stages_json=$(jq -c --argjson e "$entry" '. + [$e]' <<<"$stages_json")
				continue
			fi
			entry=$(jq -c --arg stage "$stage" \
				'{stage:$stage,payload_digest:.payload_digest,recorded_at:.recorded_at,quarantined:false,payload:.payload,integrity:"verified"}' "$path") || return 1
			recorded_json=$(jq -c --arg s "$stage" '. + [$s]' <<<"$recorded_json")
		else
			continue
		fi
		stages_json=$(jq -c --argjson e "$entry" '. + [$e]' <<<"$stages_json")
	done < <(run_journal_stage_vocabulary)

	# All THREE owner settlements, read from the single source of truth. A
	# published completion row is a settlement like the other two, not a
	# free-for-all observation, and omitting it here is exactly how "the row is
	# terminal" used to look like most of a result gate.
	missing_json='[]'
	while IFS= read -r stage; do
		if ! _run_journal_stage_satisfied "$request_id" "$stage"; then
			missing_json=$(jq -c --arg s "$stage" '. + [$s]' <<<"$missing_json")
			satisfied=false
		fi
	done < <(run_journal_result_predecessors)
	_run_journal_stage_satisfied "$request_id" final_result_published && final_recorded=true

	violating_json='[]'
	if [[ "$final_recorded" == "true" && "$satisfied" == "false" ]]; then
		violation=true
		violating_json="$missing_json"
	fi

	# `jq -ce '.identity'` PRINTS `null` and exits 1 when the field is null, so
	# the obvious `|| printf 'null'` appends a SECOND value and yields the literal
	# two-value stream "null\nnull" — which --argjson below rejects, turning a
	# merely binding-less request into projection_failed. Normalise to exactly one
	# JSON value: anything that is not a lone object is the null binding.
	binding=$(_run_journal_binding_identity "$request_id" 2>/dev/null || true)
	[[ -n "$binding" ]] || binding='null'
	jq -e 'type == "object"' >/dev/null 2>&1 <<<"$binding" || binding='null'
	if [[ "$binding" != "null" ]]; then
		binding_digest=$(run_journal_launch_binding_digest "$binding" \
			"$(jq -c '.payload // empty' "$(_run_journal_stage_path "$request_id" launch_acknowledged)" 2>/dev/null || true)" 2>/dev/null || true)
	fi
	wal_quarantined=$(_run_journal_quarantined_wal_count "$request_id")

	jq -cn \
		--arg request "$request_id" \
		--arg binding_digest "$binding_digest" \
		--argjson binding "$binding" \
		--argjson stages "$stages_json" \
		--argjson recorded "$recorded_json" \
		--argjson quarantined "$quarantined_json" \
		--argjson integrity_refused "$integrity_json" \
		--argjson missing "$missing_json" \
		--argjson violating "$violating_json" \
		--argjson satisfied "$satisfied" \
		--argjson final_recorded "$final_recorded" \
		--argjson violation "$violation" \
		--argjson wal_quarantined "$wal_quarantined" \
		--argjson owner_authority "$(run_journal_owner_authority_block)" \
		--arg durability "$(run_journal_durability_class)" '
		{launch_request_id:$request,
		 binding:$binding,
		 binding_identity_digest:(if $binding_digest == "" then null else $binding_digest end),
		 stages:$stages,
		 recorded_stages:$recorded,
		 quarantined_stages:$quarantined,
		 quarantined_wal_count:$wal_quarantined,
		 # §4: named, not merely omitted. "The predecessor is missing" and "the
		 # predecessor is on disk and its stored digest no longer matches its
		 # own payload" are different operator problems.
		 integrity_refused_stages:$integrity_refused,
		 result_stage_predecessors_satisfied:$satisfied,
		 final_result_recorded:$final_recorded,
		 missing_result_predecessors:$missing,
		 owner_authority:$owner_authority,
		 # §4: carried on every projection so no consumer can publish a durable
		 # settlement claim without stepping over a field that denies it.
		 durability:{durably_journaled:false, durability_class:$durability,
		             power_loss_durable:false,
		             blocker:"power_loss_durability_unimplemented"},
		 lattice_violation:$violation,
		 violating_stages:$violating}'
}

# ── record ───────────────────────────────────────────────────────────
#
# Evaluated refusal order (pinned so overlapping refusals are deterministic):
#   1 lock order · 2 identity grammar · 3 stage vocabulary · 4 payload size
#   5 payload allowlist + per-key grammar · 6 secret scan
#   -- nothing above this line touches disk --
#   7 root mode · 8 lock · 9 recover · 10 request readability · 11 digest
#   12 index claim / binding / generation · 13 stage quarantined
#   14 already-recorded / stage conflict · 15 seal · 16 predecessors
#   17 authority consistency · 18 write

_run_journal_guard_predecessors() {
	local request_id="$1" stage="$2" predecessor
	_RUN_JOURNAL_MISSING_PREDECESSORS='[]'
	_RUN_JOURNAL_UNSATISFIED_PREDECESSOR=""
	_RUN_JOURNAL_ERROR=""
	while IFS= read -r predecessor; do
		[[ -n "$predecessor" ]] || continue
		if [[ -f "$(_run_journal_stage_tombstone "$request_id" "$predecessor")" ]]; then
			_RUN_JOURNAL_ERROR="predecessor_quarantined:${predecessor}"
			_RUN_JOURNAL_MISSING_PREDECESSORS=$(jq -c --arg s "$predecessor" '. + [$s]' <<<"$_RUN_JOURNAL_MISSING_PREDECESSORS")
			return 2
		fi
		# Satisfaction, not presence: a predecessor whose record no longer
		# parses for its own stage, or whose payload no longer meets that
		# stage's mandatory schema, proves nothing about what happened and must
		# not authorize a successor. `_run_journal_stage_satisfied` folds the
		# presence test in, so a genuinely absent file still lands here.
		if ! _run_journal_stage_satisfied "$request_id" "$predecessor"; then
			if [[ -f "$(_run_journal_stage_path "$request_id" "$predecessor")" ]]; then
				_RUN_JOURNAL_UNSATISFIED_PREDECESSOR="$predecessor"
			fi
			_RUN_JOURNAL_MISSING_PREDECESSORS=$(jq -c --arg s "$predecessor" '. + [$s]' <<<"$_RUN_JOURNAL_MISSING_PREDECESSORS")
		fi
	done < <(_run_journal_stage_predecessors_transitive "$stage")
	if [[ "$_RUN_JOURNAL_MISSING_PREDECESSORS" != "[]" ]]; then
		if [[ -n "${_RUN_JOURNAL_UNSATISFIED_PREDECESSOR:-}" ]]; then
			_RUN_JOURNAL_ERROR="predecessor_unsatisfied:${_RUN_JOURNAL_UNSATISFIED_PREDECESSOR}"
		else
			_RUN_JOURNAL_ERROR="missing_predecessor"
		fi
		return 1
	fi
	# Backward transition: execution can never be observed after the row was
	# already published as terminal.
	if [[ "$stage" == "task_executing" ]] && _run_journal_stage_satisfied "$request_id" completion_row_published; then
		_RUN_JOURNAL_ERROR="backward_transition"
		return 1
	fi
	return 0
}

_run_journal_guard_generation() {
	local binding_generation="$1" incoming_generation="$2"
	[[ "$binding_generation" == "$incoming_generation" ]]
}

_run_journal_guard_digest_cas() {
	local existing_digest="$1" incoming_digest="$2"
	[[ "$existing_digest" == "$incoming_digest" ]]
}

# ── Posture-bound authority (ADR 0012 Decision 1) ────────────────────
#
# `posture` used to be a coordinate identity field and nothing more: it was
# validated as an enum and then never consulted again, so a supervised request
# could record — and later publish — `process_death_authority.authority=proven`.
# Supervised posture HAS no process-exit authority; a claim of `proven` under it
# is not a stronger record, it is a forged one. Bound here, at the locked commit
# boundary, so wrappers cannot be the only thing enforcing it.
_run_journal_guard_posture_authority() {
	local posture="$1" stage="$2" payload="$3" value
	_RUN_JOURNAL_ERROR=""
	[[ "$posture" == "supervised" ]] || return 0
	case "$stage" in
		process_death_authority)
			value=$(jq -r '.authority // empty' <<<"$payload" 2>/dev/null || true)
			;;
		final_result_published)
			value=$(jq -r '.process_death_authority // empty' <<<"$payload" 2>/dev/null || true)
			;;
		completion_row_published)
			# ADR 0012 Decision 1: "No supervised receipt may become
			# completed_clean." `completed` is this vocabulary's clean
			# completion (task-id.sh:32); the dirty/stale/failed variants stay
			# recordable because they carry their own uncertainty.
			value=$(jq -r '.published_status // empty' <<<"$payload" 2>/dev/null || true)
			if [[ "$value" == "completed" ]]; then
				_RUN_JOURNAL_ERROR="supervised_clean_completion_refused"
				return 1
			fi
			return 0
			;;
		*) return 0 ;;
	esac
	if [[ "$value" == "proven" ]]; then
		_RUN_JOURNAL_ERROR="supervised_authority_claim_refused"
		return 1
	fi
	return 0
}

# ── Owner-only stage authority ───────────────────────────────────────
#
# Three stages are owner settlements, not observations any process may make:
# completion_row_published, review_evidence_settled and owner_handoff. The
# approved owner-authority mechanism does not exist yet, so per the steering
# these stages are simply UNAVAILABLE in production rather than guarded by
# something forgeable.
#
# `final_result_published` is NOT in this set. It is the facade's own
# publication and is gated separately, by entry point, below.
_run_journal_stage_is_owner_only() {
	case "${1:-}" in
		completion_row_published | review_evidence_settled | owner_handoff) return 0 ;;
		*) return 1 ;;
	esac
}

# The one stage `oste-runner result` may append, and the only stage it may
# append. See `run_journal_record_final_result`.
_run_journal_stage_is_facade_only() {
	[[ "${1:-}" == "final_result_published" ]]
}

# The three stages the result gate reads, in lattice order. Returned from ONE
# place so the projection, the record gate and the facade cannot drift into
# three different opinions about what "the predecessors" are.
run_journal_result_predecessors() {
	printf '%s\n' completion_row_published review_evidence_settled owner_handoff
}

# ── Harness owner-authority seam ─────────────────────────────────────
#
# The seam is a PROPERTY OF THE DURABLE ROOT, not of the caller. A journal root
# only carries owner authority if it holds a marker artifact that was created at
# root-initialization time, that names itself as harness state, and that names
# the very root it lives in. The production durable root refuses to initialize
# one, and the availability predicate refuses the production root outright — so a
# marker copied, planted or symlinked into production is inert twice over.
#
# What this deliberately is NOT: an argv flag, an environment value, a shell
# string, a mutable temporary receipt, or a generic `--owner` assertion. Setting
# OSTE_RUN_JOURNAL_ROOT selects a directory; it cannot manufacture the artifact
# that has to already be inside it.
run_journal_harness_marker_schema() { printf 'oste-run-journal-harness-owner-authority/v1'; }
run_journal_harness_marker_name() { printf '.owner-authority-harness.json'; }

run_journal_harness_marker_path() {
	local root
	root=$(run_journal_root) || return 1
	printf '%s/%s' "$root" "$(run_journal_harness_marker_name)"
}

# Fixture-only initializer. Emits exactly one JSON object like every other verb.
# Returns 0 on success, the mapped refusal code otherwise. Production callers
# have no reason to call it and cannot succeed if they do.
run_journal_init_harness_owner_authority() {
	local root marker resolved json
	if ! root=$(run_journal_root); then
		_run_journal_diag "journal root redirect refused; cannot initialize a harness root"
		_run_journal_response init-harness-owner-authority journal_unreadable journal_root_redirect_refused
		return 3
	fi
	if _run_journal_root_is_production; then
		# The refusal that makes the marker impossible to mistake for production.
		_run_journal_diag "the production durable root refuses to initialize a harness owner-authority marker"
		_run_journal_response init-harness-owner-authority owner_authority_unavailable \
			production_root_refuses_harness_marker \
			"$(jq -cn --arg r "$root" '{journal_root:$r,production_root:true,harness_marker_created:false}')"
		return 2
	fi
	if ! _run_journal_ensure_root; then
		_run_journal_response init-harness-owner-authority io_error journal_root_uncreatable
		return 5
	fi
	# The marker names the root it belongs to, RESOLVED to itself. A marker moved
	# or copied into a different root therefore stops being authority the moment
	# it lands, without anyone having to notice.
	resolved=$(cd "$root" 2>/dev/null && pwd -P) || resolved=""
	if [[ -z "$resolved" ]]; then
		_run_journal_response init-harness-owner-authority io_error journal_root_unresolvable
		return 5
	fi
	marker="${root}/$(run_journal_harness_marker_name)"
	json=$(jq -cn --arg schema "$(run_journal_harness_marker_schema)" \
		--arg root "$resolved" --arg at "$(_run_journal_now_iso)" '
		{schema:$schema, owner_authority:"harness", journal_root:$root,
		 predecessor_producer:"hermetic_owner_fixture", production:false, created_at:$at}') || {
		_run_journal_response init-harness-owner-authority io_error marker_render_failed
		return 5
	}
	if ! (umask 077 && _run_journal_atomic_json_write "$marker" "$json"); then
		_run_journal_response init-harness-owner-authority io_error marker_write_failed
		return 5
	fi
	_run_journal_response init-harness-owner-authority recorded "" \
		"$(jq -cn --arg r "$resolved" --arg m "$marker" \
			'{journal_root:$r, harness_marker:$m, harness_marker_created:true,
			  predecessor_producer:"hermetic_owner_fixture"}')"
	return 0
}

# The predicate. No environment value appears in it: the root must not be
# production, and the marker in that root must exist as a regular file, parse,
# declare the harness schema, and name this very root.
_run_journal_owner_stage_authority_available() {
	local root marker resolved
	root=$(run_journal_root) || return 1
	_run_journal_root_is_production && return 1
	marker="${root}/$(run_journal_harness_marker_name)"
	[[ -f "$marker" && ! -L "$marker" ]] || return 1
	resolved=$(cd "$root" 2>/dev/null && pwd -P) || return 1
	jq -e --arg schema "$(run_journal_harness_marker_schema)" --arg root "$resolved" '
		type == "object"
		and .schema == $schema
		and .owner_authority == "harness"
		and .production == false
		and .journal_root == $root' >/dev/null 2>&1 <"$marker"
}

# ── Honest producer contract (steering §1) ───────────────────────────
#
# `operator_via_oste_run_journal` used to name a production path the CLI itself
# refuses. These two are the ONLY sanctioned answers, and both of them are true:
# in production nothing produces the owner stages, and in the hermetic harness a
# fixture does. Neither token may ever be read as "wait and it will appear" —
# `pollable` and `produced_by_waiting` say so positively so a polling adapter has
# to ignore a field to keep polling.
run_journal_owner_authority_available() {
	_run_journal_owner_stage_authority_available
}

run_journal_predecessor_producer() {
	if _run_journal_owner_stage_authority_available; then
		printf 'hermetic_owner_fixture'
	else
		printf 'owner_settlement_authority_unimplemented'
	fi
}

# The block every consumer embeds verbatim rather than re-deriving.
run_journal_owner_authority_block() {
	local available=false
	_run_journal_owner_stage_authority_available && available=true
	jq -cn --arg p "$(run_journal_predecessor_producer)" --argjson a "$available" \
		--argjson stages "$(run_journal_result_predecessors | jq -R . | jq -sc .)" '
		{predecessor_producer:$p, available:$a, owner_stages:$stages,
		 pollable:false, produced_by_waiting:false}'
}

# ── Final evidence identity ──────────────────────────────────────────
#
# `final_result_published.evidence_digest` and
# `review_evidence_settled.evidence_digest` were both declared `digest` and
# never compared, so a final publication could name evidence that was never the
# settled evidence.
_run_journal_guard_final_evidence_digest() {
	local request_id="$1" payload="$2" final settled
	_RUN_JOURNAL_ERROR=""
	final=$(jq -r '.evidence_digest // empty' <<<"$payload" 2>/dev/null || true)
	# §4, stated at the point of use rather than inherited: this check must
	# consume only an INTEGRITY-VALIDATED settled record. The predecessor gate
	# above already refuses an unsatisfied predecessor, but this is the one
	# guard that lifts a VALUE out of a predecessor's payload and binds a
	# durable publication to it, so it re-derives the record's own integrity
	# before reading the field.
	if ! _run_journal_record_integrity_ok "$request_id" review_evidence_settled; then
		_RUN_JOURNAL_ERROR="settled_evidence_record_integrity:${_RUN_JOURNAL_INTEGRITY_REASON}"
		return 1
	fi
	settled=$(jq -r '.payload.evidence_digest // empty' \
		"$(_run_journal_stage_path "$request_id" review_evidence_settled)" 2>/dev/null || true)
	if [[ -z "$settled" ]]; then
		_RUN_JOURNAL_ERROR="settled_evidence_digest_absent"
		return 1
	fi
	if [[ "$final" != "$settled" ]]; then
		_RUN_JOURNAL_EXPECTED="$settled"
		_RUN_JOURNAL_OBSERVED="$final"
		_RUN_JOURNAL_ERROR="final_evidence_digest_mismatch"
		return 1
	fi
	return 0
}

# ── Launch acknowledgement coordinate proof ──────────────────────────
#
# The acknowledgement is the journal's only statement about WHERE a worker ran
# and from WHAT commit, and every later fence is compared against it. Grammar is
# not proof: the paths must resolve to themselves on disk, be strictly
# different, belong to the SAME repository, and the start SHA must exist as a
# commit object in it.
_run_journal_guard_launch_coordinates() {
	local payload="$1" exec_dir canon start_sha exec_real canon_real exec_common canon_common
	_RUN_JOURNAL_ERROR=""
	exec_dir=$(jq -r '.execution_dir // empty' <<<"$payload" 2>/dev/null || true)
	canon=$(jq -r '.canonical_project_dir // empty' <<<"$payload" 2>/dev/null || true)
	start_sha=$(jq -r '.start_sha // empty' <<<"$payload" 2>/dev/null || true)

	if [[ ! "$start_sha" =~ ^[0-9a-f]{40}$ ]]; then
		_RUN_JOURNAL_ERROR="start_sha_not_proven"
		return 1
	fi
	exec_real=$(cd "$exec_dir" 2>/dev/null && pwd -P) || exec_real=""
	if [[ -z "$exec_real" ]]; then
		_RUN_JOURNAL_ERROR="execution_dir_unresolvable"
		return 1
	fi
	if [[ "$exec_real" != "$exec_dir" ]]; then
		_RUN_JOURNAL_ERROR="execution_dir_not_canonical"
		return 1
	fi
	canon_real=$(cd "$canon" 2>/dev/null && pwd -P) || canon_real=""
	if [[ -z "$canon_real" ]]; then
		_RUN_JOURNAL_ERROR="canonical_project_dir_unresolvable"
		return 1
	fi
	if [[ "$canon_real" != "$canon" ]]; then
		_RUN_JOURNAL_ERROR="canonical_project_dir_not_canonical"
		return 1
	fi
	if [[ "$exec_real" == "$canon_real" ]]; then
		_RUN_JOURNAL_ERROR="execution_dir_equals_canonical_project_dir"
		return 1
	fi
	exec_common=$(cd "$exec_real" 2>/dev/null &&
		GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 git rev-parse --git-common-dir 2>/dev/null &&
		:) || exec_common=""
	if [[ -z "$exec_common" ]]; then
		_RUN_JOURNAL_ERROR="execution_dir_not_a_worktree"
		return 1
	fi
	exec_common=$(cd "$exec_real" 2>/dev/null && cd "$exec_common" 2>/dev/null && pwd -P) || exec_common=""
	canon_common=$(cd "$canon_real" 2>/dev/null &&
		GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 git rev-parse --git-common-dir 2>/dev/null &&
		:) || canon_common=""
	if [[ -n "$canon_common" ]]; then
		canon_common=$(cd "$canon_real" 2>/dev/null && cd "$canon_common" 2>/dev/null && pwd -P) || canon_common=""
	fi
	if [[ -z "$canon_common" ]]; then
		_RUN_JOURNAL_ERROR="canonical_project_dir_not_a_repository"
		return 1
	fi
	if [[ "$exec_common" != "$canon_common" ]]; then
		_RUN_JOURNAL_ERROR="repository_identity_mismatch"
		return 1
	fi
	if ! (cd "$exec_real" 2>/dev/null &&
		GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 git cat-file -e "${start_sha}^{commit}" 2>/dev/null); then
		_RUN_JOURNAL_ERROR="start_sha_not_in_repository"
		return 1
	fi
	return 0
}

# "Transitively ordered", stated as a check rather than inferred from the write
# path. `payload_digest` covers the payload and nothing else, so a hand-edited
# `recorded_at` is invisible to every other integrity check in this file. The two
# settlement leaves are SIBLINGS — a parked attempt hands off with no settled
# review — so only the completion row is ordered against them, never one leaf
# against the other.
_run_journal_guard_owner_settlement_order() {
	local request_id="$1" base leaf at
	_RUN_JOURNAL_ERROR=""
	base=$(jq -r '.recorded_at // empty' \
		"$(_run_journal_stage_path "$request_id" completion_row_published)" 2>/dev/null || true)
	if [[ -z "$base" ]]; then
		_RUN_JOURNAL_ERROR="owner_settlement_timestamp_absent:completion_row_published"
		return 1
	fi
	for leaf in review_evidence_settled owner_handoff; do
		at=$(jq -r '.recorded_at // empty' \
			"$(_run_journal_stage_path "$request_id" "$leaf")" 2>/dev/null || true)
		if [[ -z "$at" ]]; then
			_RUN_JOURNAL_ERROR="owner_settlement_timestamp_absent:${leaf}"
			return 1
		fi
		# ISO-8601 UTC to the second: lexicographic order IS chronological order.
		if [[ "$at" < "$base" ]]; then
			_RUN_JOURNAL_EXPECTED="completion_row_published@${base}"
			_RUN_JOURNAL_OBSERVED="${leaf}@${at}"
			_RUN_JOURNAL_ERROR="owner_settlement_order_violation"
			return 1
		fi
	done
	return 0
}

_run_journal_guard_authority_consistency() {
	local request_id="$1" payload="$2" claimed journaled
	_RUN_JOURNAL_ERROR=""
	claimed=$(jq -r '.process_death_authority // empty' <<<"$payload" 2>/dev/null || true)
	[[ -n "$claimed" ]] || return 0
	if [[ -f "$(_run_journal_stage_tombstone "$request_id" process_death_authority)" ]]; then
		_RUN_JOURNAL_ERROR="authority_evidence_lost"
		return 2
	fi
	if _run_journal_stage_satisfied "$request_id" process_death_authority; then
		journaled=$(jq -r '.payload.authority // empty' "$(_run_journal_stage_path "$request_id" process_death_authority)" 2>/dev/null || true)
	else
		journaled="unrecorded"
	fi
	[[ "$claimed" == "$journaled" ]] && return 0
	_RUN_JOURNAL_EXPECTED="$journaled"
	_RUN_JOURNAL_OBSERVED="$claimed"
	_RUN_JOURNAL_ERROR="authority_contradiction"
	return 1
}

# `missing_result_predecessors` is the key the result gate's caller reads; the
# generic `missing_predecessors` key carries the same answer for every other
# stage so neither name has to mean two different things.
_run_journal_predecessor_extra() {
	local missing="${1:-[]}" stage="${2:-}"
	# `missing_result_predecessors` is narrowed to the three OWNER settlements:
	# the transitive closure also contains launch_acknowledged, and a result gate
	# that named it would be telling its caller to go acknowledge a launch. The
	# honest producer block rides along on the same refusal so a polling adapter
	# reads "nothing produces these" in the same object that says which are
	# missing.
	jq -cn --argjson m "$missing" --arg s "$stage" \
		--argjson owners "$(run_journal_result_predecessors | jq -R . | jq -sc .)" \
		--argjson block "$(run_journal_owner_authority_block)" '
		{missing_predecessors:$m}
		+ (if $s == "final_result_published"
		   then {missing_result_predecessors:[$m[] | select(. as $x | $owners | index($x))]} + $block
		   else {} end)'
}

_run_journal_record_refuse() {
	local outcome="$1" reason="$2" extra="$3" request_id="$4" stage="$5"
	local merged
	[[ -n "$extra" ]] || extra='{}'
	merged=$(jq -cn --arg r "$request_id" --arg s "$stage" --argjson extra "$extra" \
		'{launch_request_id:$r,stage:$s} + $extra')
	_run_journal_response record "$outcome" "$reason" "$merged" "$stage"
	return "$(run_journal_outcome_exit_code "$outcome")"
}

# ── The two record entry points ──────────────────────────────────────
#
# `run_journal_record` is the generic append path — what oste-run-journal.sh
# drives and what any other caller sees. It can never append
# `final_result_published`.
#
# `run_journal_record_final_result` is the facade's path — what `oste-runner
# result` calls. It can append `final_result_published` and NOTHING else, so the
# facade cannot synthesize one of its own owner predecessors even by passing a
# different stage name.
#
# The separation is by ENTRY POINT rather than by an argv role or an environment
# claim, because a role a caller can assert is not a role. Both wrappers hand the
# same locked implementation a role it did not choose.
run_journal_record() {
	_run_journal_record_impl generic "$@"
}

run_journal_record_final_result() {
	local identity="${1:-}" stage="${2:-}" payload="${3:-}"
	if ! _run_journal_stage_is_facade_only "$stage"; then
		_run_journal_diag "the facade may append final_result_published and nothing else; '${stage}' is not facade-appendable"
		_run_journal_record_refuse facade_stage_not_permitted facade_may_not_synthesize_predecessor \
			"$(jq -cn --arg s "$stage" --argjson block "$(run_journal_owner_authority_block)" \
				'{refused_stage:$s, facade_appendable_stage:"final_result_published"} + $block')" \
			"" "$stage"
		return $?
	fi
	_run_journal_record_impl facade "$identity" "$stage" "$payload"
}

_run_journal_record_impl() {
	local role="$1" identity="$2" stage="$3" payload="$4"
	local request_id task_id generation digest entry_dir root now record_digest binding_identity_digest
	local existing existing_digest binding binding_generation state state_reason="" rc quarantine_path record_json wal_json

	if ! _run_journal_guard_lock_order; then
		_run_journal_diag "refusing to record while the launcher task registry lock is held"
		_run_journal_record_refuse lock_order_violation caller_holds_registry_lock '{}' "" "$stage"
		return $?
	fi
	if ! _run_journal_guard_root_redirect; then
		_run_journal_diag "OSTE_RUN_JOURNAL_ROOT redirects the journal away from the durable state root; refusing (test-only: set OSTE_TEST_MODE=1)"
		_run_journal_record_refuse journal_unreadable journal_root_redirect_refused '{}' "" "$stage"
		return $?
	fi
	if ! _run_journal_guard_control_characters "$identity" identity; then
		_run_journal_diag "identity rejected: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse invalid_request "$_RUN_JOURNAL_ERROR" '{}' "" "$stage"
		return $?
	fi
	if ! _run_journal_validate_identity "$identity"; then
		_run_journal_diag "identity rejected: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse invalid_request "$_RUN_JOURNAL_ERROR" '{}' "" "$stage"
		return $?
	fi
	request_id="$_RUN_JOURNAL_IDENTITY_REQUEST_ID"
	task_id="$_RUN_JOURNAL_IDENTITY_TASK_ID"
	generation="$_RUN_JOURNAL_IDENTITY_GENERATION"

	if ! run_journal_stage_is_known "$stage"; then
		_run_journal_diag "unknown stage '${stage}'"
		_run_journal_record_refuse invalid_request unknown_stage '{}' "$request_id" ""
		return $?
	fi
	# ── Authority class, before anything touches disk ────────────
	if _run_journal_stage_is_facade_only "$stage" && [[ "$role" != "facade" ]]; then
		_run_journal_diag "stage '${stage}' is published by the facade (oste-runner result), never by a generic journal caller"
		_run_journal_record_refuse facade_only_stage final_publication_is_facade_owned \
			"$(jq -cn --arg s "$stage" --argjson block "$(run_journal_owner_authority_block)" \
				'{facade_only_stage:$s, facade_producer:"oste_runner_result"} + $block')" \
			"$request_id" "$stage"
		return $?
	fi
	if _run_journal_stage_is_owner_only "$stage" && [[ "$role" == "facade" ]]; then
		# Belt and braces: the facade wrapper already refuses every stage but
		# the final publication. This is the same refusal stated where the
		# authority classes are actually decided.
		_run_journal_diag "the facade may not append owner settlement '${stage}'"
		_run_journal_record_refuse facade_stage_not_permitted facade_may_not_synthesize_predecessor \
			"$(jq -cn --arg s "$stage" --argjson block "$(run_journal_owner_authority_block)" \
				'{refused_stage:$s, facade_appendable_stage:"final_result_published"} + $block')" \
			"$request_id" "$stage"
		return $?
	fi
	if _run_journal_stage_is_owner_only "$stage" && ! _run_journal_owner_stage_authority_available; then
		_run_journal_diag "stage '${stage}' is an owner settlement; no approved owner-authority mechanism exists, so production recording is unavailable"
		_run_journal_record_refuse owner_authority_unavailable owner_stage_authority_mechanism_absent \
			"$(jq -cn --arg s "$stage" --argjson block "$(run_journal_owner_authority_block)" \
				'{owner_only_stage:$s} + $block')" \
			"$request_id" "$stage"
		return $?
	fi
	if ((${#payload} > $(_run_journal_max_payload_bytes))); then
		_run_journal_diag "payload exceeds $(_run_journal_max_payload_bytes) bytes"
		_run_journal_record_refuse invalid_request payload_too_large '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_control_characters "$payload" payload; then
		_run_journal_diag "payload rejected: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse invalid_request "$_RUN_JOURNAL_ERROR" '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_payload_allowlist "$stage" "$payload"; then
		_run_journal_diag "payload rejected: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse invalid_request "$_RUN_JOURNAL_ERROR" '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_payload_required "$stage" "$payload"; then
		_run_journal_diag "payload rejected: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse invalid_request "$_RUN_JOURNAL_ERROR" '{}' "$request_id" "$stage"
		return $?
	fi
	if [[ "$stage" == "launch_acknowledged" ]] && ! _run_journal_guard_launch_coordinates "$payload"; then
		_run_journal_diag "launch acknowledgement coordinates rejected: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse invalid_request "$_RUN_JOURNAL_ERROR" '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_posture_authority \
		"$_RUN_JOURNAL_IDENTITY_POSTURE" "$stage" "$payload"; then
		_run_journal_diag "posture-bound authority refusal: ${_RUN_JOURNAL_ERROR}"
		_run_journal_record_refuse authority_contradiction "$_RUN_JOURNAL_ERROR" \
			"$(jq -cn --arg p "$_RUN_JOURNAL_IDENTITY_POSTURE" '{posture:$p}')" \
			"$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_secret_material "$identity" ""; then
		_run_journal_diag "identity field '${_RUN_JOURNAL_SECRET_KEY}' looks like secret material"
		_run_journal_record_refuse secret_material_refused "identity:${_RUN_JOURNAL_SECRET_KEY}" '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_secret_material "$payload" "$stage"; then
		_run_journal_diag "payload key '${_RUN_JOURNAL_SECRET_KEY}' looks like secret material"
		_run_journal_record_refuse secret_material_refused "payload:${_RUN_JOURNAL_SECRET_KEY}" '{}' "$request_id" "$stage"
		return $?
	fi
	if [[ "$stage" == "launch_acknowledged" ]]; then
		binding_identity_digest=$(run_journal_launch_binding_digest \
			"$_RUN_JOURNAL_IDENTITY_CANONICAL" "$payload") || {
			_run_journal_record_refuse invalid_request binding_not_canonicalizable '{}' "$request_id" "$stage"
			return $?
		}
	fi

	root=$(run_journal_root)
	if ! _run_journal_ensure_root; then
		_run_journal_diag "cannot create journal root ${root}"
		_run_journal_record_refuse io_error root_unavailable '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_secure_mode "$root"; then
		_run_journal_diag "journal root ${root} grants group/other access; refusing (fix: chmod 700)"
		_run_journal_record_refuse journal_unreadable insecure_permissions '{}' "$request_id" "$stage"
		return $?
	fi

	if ! _run_journal_lock_acquire "$request_id"; then
		_run_journal_diag "lock not acquired for ${request_id} within $(_run_journal_lock_max_wait)s"
		_run_journal_record_refuse journal_locked lock_timeout '{}' "$request_id" "$stage"
		return $?
	fi

	entry_dir=$(_run_journal_entry_dir "$request_id")
	if ! (umask 077 && mkdir -p "${entry_dir}/stages" "${entry_dir}/wal") 2>/dev/null; then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error entry_dir_unavailable '{}' "$request_id" "$stage"
		return $?
	fi
	if ! _run_journal_guard_secure_mode "$entry_dir"; then
		_run_journal_lock_release "$request_id"
		_run_journal_diag "request directory ${entry_dir} grants group/other access; refusing"
		_run_journal_record_refuse journal_unreadable insecure_permissions '{}' "$request_id" "$stage"
		return $?
	fi

	if ! _run_journal_guard_recover_on_read "$request_id"; then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error recovery_failed '{}' "$request_id" "$stage"
		return $?
	fi

	read -r state state_reason < <(_run_journal_guard_unreadable_binding "$request_id")
	if [[ "$state" == "unreadable" ]]; then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse journal_unreadable "${state_reason:-}" '{}' "$request_id" "$stage"
		return $?
	fi

	digest=$(run_journal_payload_digest "$payload") || {
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse invalid_request payload_not_canonicalizable '{}' "$request_id" "$stage"
		return $?
	}

	# ── Binding / generation / claim ─────────────────────────────
	if [[ "$state" == "present" ]]; then
		binding=$(_run_journal_binding_identity "$request_id") || binding='null'
		binding_generation=$(jq -r '.task_generation // empty' <<<"$binding")
		if ! _run_journal_guard_generation "$binding_generation" "$generation"; then
			if ! _run_journal_guard_quarantine_budget "$request_id"; then
				_run_journal_lock_release "$request_id"
				_run_journal_record_refuse quarantine_budget_exhausted budget_exhausted '{}' "$request_id" "$stage"
				return $?
			fi
			quarantine_path=$(_run_journal_quarantine_bytes_locked "$request_id" binding stale-task-generation "$_RUN_JOURNAL_IDENTITY_CANONICAL" || true)
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse generation_mismatch stale_task_generation \
				"$(jq -cn --arg e "$binding_generation" --arg o "$generation" --arg q "$quarantine_path" \
					'{expected:$e,observed:$o,quarantine_path:$q}')" "$request_id" "$stage"
			return $?
		fi
		if [[ "$(jq -S -c . <<<"$binding")" != "$_RUN_JOURNAL_IDENTITY_CANONICAL" ]]; then
			if ! _run_journal_guard_quarantine_budget "$request_id"; then
				_run_journal_lock_release "$request_id"
				_run_journal_record_refuse quarantine_budget_exhausted budget_exhausted '{}' "$request_id" "$stage"
				return $?
			fi
			quarantine_path=$(_run_journal_quarantine_bytes_locked "$request_id" binding rejected-conflicting-identity "$_RUN_JOURNAL_IDENTITY_CANONICAL" || true)
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse binding_conflict identity_differs_from_binding \
				"$(jq -cn --arg q "$quarantine_path" '{quarantine_path:$q}')" "$request_id" "$stage"
			return $?
		fi
	else
		if [[ "$stage" != "launch_acknowledged" ]]; then
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse stage_out_of_order missing_predecessor \
				"$(_run_journal_predecessor_extra '["launch_acknowledged"]' "$stage")" "$request_id" "$stage"
			return $?
		fi
	fi

	if [[ "$stage" == "launch_acknowledged" ]]; then
		rc=0
		_run_journal_index_claim "$task_id" "$generation" "$request_id" "$binding_identity_digest" || rc=$?
		if ((rc == 2)); then
			if _run_journal_guard_quarantine_budget "$request_id"; then
				quarantine_path=$(_run_journal_quarantine_bytes_locked "$request_id" binding rejected-generation-claim "$_RUN_JOURNAL_IDENTITY_CANONICAL" || true)
			else
				quarantine_path=""
			fi
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse generation_claim_conflict task_generation_already_claimed \
				"$(jq -cn --arg e "$_RUN_JOURNAL_CLAIM_HOLDER" --arg o "$request_id" --arg q "$quarantine_path" \
					'{expected:$e,observed:$o,quarantine_path:$q}')" "$request_id" "$stage"
			return $?
		elif ((rc == 3)); then
			if _run_journal_guard_quarantine_budget "$request_id"; then
				quarantine_path=$(_run_journal_quarantine_bytes_locked "$request_id" payload \
					rejected-conflicting-launch-binding "$payload" || true)
			else
				quarantine_path=""
			fi
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse stage_conflict binding_record_digest_differs \
				"$(jq -cn --arg h "$_RUN_JOURNAL_CLAIM_HOLDER" --arg q "$quarantine_path" \
					'{claim_holder:$h,quarantine_path:$q}')" "$request_id" "$stage"
			return $?
		elif ((rc != 0)); then
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse io_error index_claim_failed '{}' "$request_id" "$stage"
			return $?
		fi
	fi

	# ── Slot state ───────────────────────────────────────────────
	if [[ -f "$(_run_journal_stage_tombstone "$request_id" "$stage")" ]]; then
		_run_journal_lock_release "$request_id"
		_run_journal_diag "stage ${stage} is permanently quarantined; a new launch request is required"
		_run_journal_record_refuse stage_quarantined slot_poisoned '{}' "$request_id" "$stage"
		return $?
	fi

	existing=$(_run_journal_stage_path "$request_id" "$stage")
	if [[ -f "$existing" ]]; then
		if ! _run_journal_record_integrity_ok "$request_id" "$stage"; then
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse journal_unreadable "${_RUN_JOURNAL_INTEGRITY_REASON:-existing_record_integrity_refused}" '{}' "$request_id" "$stage"
			return $?
		fi
		existing_digest=$(jq -r '.payload_digest // empty' "$existing" 2>/dev/null || true)
		if _run_journal_guard_digest_cas "$existing_digest" "$digest"; then
			now=$(jq -r '.recorded_at // empty' "$existing" 2>/dev/null || true)
			_run_journal_lock_release "$request_id"
			_run_journal_response record already_recorded "" \
				"$(jq -cn --arg r "$request_id" --arg g "$generation" --arg s "$stage" --arg d "$digest" --arg t "$now" \
					'{launch_request_id:$r,task_generation:$g,stage:$s,payload_digest:$d,recorded_at:$t}')" "$stage"
			return 0
		fi
		if ! _run_journal_guard_quarantine_budget "$request_id"; then
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse quarantine_budget_exhausted budget_exhausted '{}' "$request_id" "$stage"
			return $?
		fi
		quarantine_path=$(_run_journal_quarantine_bytes_locked "$request_id" payload rejected-conflicting-payload "$payload" || true)
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse stage_conflict payload_digest_differs \
			"$(jq -cn --arg e "$existing_digest" --arg o "$digest" --arg q "$quarantine_path" \
				'{expected:$e,observed:$o,quarantine_path:$q}')" "$request_id" "$stage"
		return $?
	fi

	if _run_journal_stage_satisfied "$request_id" final_result_published; then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse journal_sealed sealed_by_final_result '{}' "$request_id" "$stage"
		return $?
	fi

	rc=0
	_run_journal_guard_predecessors "$request_id" "$stage" || rc=$?
	if ((rc == 2)); then
		_run_journal_lock_release "$request_id"
		_run_journal_diag "predecessor slot is quarantined; the correct action is a new launch request"
		_run_journal_record_refuse predecessor_quarantined "$_RUN_JOURNAL_ERROR" \
			"$(_run_journal_predecessor_extra "$_RUN_JOURNAL_MISSING_PREDECESSORS" "$stage")" "$request_id" "$stage"
		return $?
	elif ((rc != 0)); then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse stage_out_of_order "$_RUN_JOURNAL_ERROR" \
			"$(_run_journal_predecessor_extra "$_RUN_JOURNAL_MISSING_PREDECESSORS" "$stage")" "$request_id" "$stage"
		return $?
	fi

	if [[ "$stage" == "final_result_published" ]]; then
		if ! _run_journal_guard_owner_settlement_order "$request_id"; then
			_run_journal_lock_release "$request_id"
			_run_journal_diag "the owner settlements are not transitively ordered: ${_RUN_JOURNAL_ERROR}"
			_run_journal_record_refuse stage_out_of_order "$_RUN_JOURNAL_ERROR" \
				"$(jq -cn --arg e "${_RUN_JOURNAL_EXPECTED:-}" --arg o "${_RUN_JOURNAL_OBSERVED:-}" \
					--argjson m "$(run_journal_result_predecessors | jq -R . | jq -sc .)" \
					'{expected:$e,observed:$o,ordered_predecessors:$m}')" "$request_id" "$stage"
			return $?
		fi
		rc=0
		_run_journal_guard_authority_consistency "$request_id" "$payload" || rc=$?
		if ((rc == 2)); then
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse authority_evidence_lost authority_slot_quarantined '{}' "$request_id" "$stage"
			return $?
		elif ((rc != 0)); then
			_run_journal_lock_release "$request_id"
			_run_journal_record_refuse authority_contradiction journal_disagrees \
				"$(jq -cn --arg e "$_RUN_JOURNAL_EXPECTED" --arg o "$_RUN_JOURNAL_OBSERVED" '{expected:$e,observed:$o}')" "$request_id" "$stage"
			return $?
		fi
		if ! _run_journal_guard_final_evidence_digest "$request_id" "$payload"; then
			_run_journal_lock_release "$request_id"
			_run_journal_diag "final publication names evidence that is not the settled evidence record: ${_RUN_JOURNAL_ERROR}"
			_run_journal_record_refuse authority_contradiction "$_RUN_JOURNAL_ERROR" \
				"$(jq -cn --arg e "$_RUN_JOURNAL_EXPECTED" --arg o "$_RUN_JOURNAL_OBSERVED" '{expected:$e,observed:$o}')" "$request_id" "$stage"
			return $?
		fi
	fi

	# ── Write: WAL, record, drop WAL ─────────────────────────────
	now=$(_run_journal_now_iso)
	record_json=$(jq -cn \
		--arg schema "oste-run-journal-record/v1" \
		--arg request "$request_id" \
		--arg generation "$generation" \
		--arg stage "$stage" \
		--arg digest "$digest" \
		--arg at "$now" \
		--argjson identity "$_RUN_JOURNAL_IDENTITY_CANONICAL" \
		--argjson payload "$payload" '
		{schema:$schema,launch_request_id:$request,task_generation:$generation,
		 stage:$stage,payload_digest:$digest,recorded_at:$at,payload:$payload,
		 # §P0: EVERY record carries the complete canonical identity, not only
		 # the acknowledgement. Three duplicated top-level coordinates
		 # (launch_request_id, stage, task_generation) are all a later record
		 # used to carry, so nine of the twelve identity fields had nothing on
		 # the record to be compared against and a valid-to-valid edit of, say,
		 # `.identity.work_item_ref` on a settled predecessor was invisible.
		 # The identity written here is byte-identical to the binding — the
		 # append path refuses any other (binding_conflict) — so this is a
		 # verifiable copy, not a second opinion.
		 identity:$identity}') || {
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error record_render_failed '{}' "$request_id" "$stage"
		return $?
	}
	record_digest=$(run_journal_record_digest "$record_json") || {
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error record_digest_failed '{}' "$request_id" "$stage"
		return $?
	}
	record_json=$(jq -c --arg d "$record_digest" '. + {record_digest:$d}' <<<"$record_json") || {
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error record_digest_attach_failed '{}' "$request_id" "$stage"
		return $?
	}
	wal_json=$(jq -cn \
		--arg schema "oste-run-journal-wal/v1" \
		--arg request "$request_id" \
		--arg generation "$generation" \
		--arg stage "$stage" \
		--arg digest "$digest" \
		--arg target "$existing" \
		--arg at "$now" \
		--argjson record "$record_json" '
		{schema:$schema,launch_request_id:$request,task_generation:$generation,
		 stage:$stage,payload_digest:$digest,record:$record,target_path:$target,created_at:$at}') || {
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error wal_render_failed '{}' "$request_id" "$stage"
		return $?
	}

	if ! (umask 077 && _run_journal_atomic_json_write "$(_run_journal_wal_path "$request_id")" "$wal_json"); then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error wal_write_failed '{}' "$request_id" "$stage"
		return $?
	fi
	if ! (umask 077 && _run_journal_atomic_json_write "$existing" "$record_json"); then
		_run_journal_lock_release "$request_id"
		_run_journal_record_refuse io_error record_write_failed '{}' "$request_id" "$stage"
		return $?
	fi
	rm -f "$(_run_journal_wal_path "$request_id")"
	_run_journal_lock_release "$request_id"

	_run_journal_response record recorded "" \
		"$(jq -cn --arg r "$request_id" --arg g "$generation" --arg s "$stage" --arg d "$digest" --arg t "$now" \
			--arg dc "$(run_journal_durability_class)" \
			'{launch_request_id:$r,task_generation:$g,stage:$s,payload_digest:$d,recorded_at:$t,
			  durably_journaled:false,durability_class:$dc,power_loss_durable:false,
			  durability_blocker:"power_loss_durability_unimplemented"}')" "$stage"
	return 0
}

# ── query ────────────────────────────────────────────────────────────
#
# `record` is the only verb that accepts NEW content. `query` may complete an
# in-flight append from that request's own WAL — it never writes content the
# caller did not already durably intend — and it never degrades to a lock-free
# read or to `not_found` when the lock cannot be taken.

# Emits one JSON envelope — {outcome, reason?, projection?} — rather than
# signalling through shell variables: every caller reads it through a command
# substitution, and a variable set inside that subshell would never reach the
# caller. Losing a refusal that way is exactly how a corrupt journal starts
# looking like an empty one.
_run_journal_query_envelope() {
	local request_id="$1" state state_reason="" projection
	if ! _run_journal_lock_acquire "$request_id"; then
		_run_journal_diag "lock not acquired for ${request_id}"
		jq -cn '{outcome:"journal_locked",reason:"lock_timeout"}'
		return 0
	fi
	if ! _run_journal_guard_recover_on_read "$request_id"; then
		_run_journal_lock_release "$request_id"
		jq -cn '{outcome:"journal_unreadable",reason:"recovery_failed"}'
		return 0
	fi
	read -r state state_reason < <(_run_journal_guard_unreadable_binding "$request_id")
	if [[ "$state" == "unreadable" ]]; then
		_run_journal_lock_release "$request_id"
		jq -cn --arg reason "${state_reason:-}" '{outcome:"journal_unreadable",reason:$reason}'
		return 0
	fi
	if [[ "$state" == "absent" ]]; then
		_run_journal_lock_release "$request_id"
		jq -cn '{outcome:"not_found",reason:""}'
		return 0
	fi
	projection=$(_run_journal_project_request "$request_id") || {
		_run_journal_lock_release "$request_id"
		jq -cn '{outcome:"journal_unreadable",reason:"projection_failed"}'
		return 0
	}
	_run_journal_lock_release "$request_id"
	jq -cn --argjson projection "$projection" '{outcome:"found",reason:"",projection:$projection}'
	return 0
}

run_journal_query_by_request() {
	local request_id="$1" root
	if ! _run_journal_guard_lock_order; then
		_run_journal_response query lock_order_violation caller_holds_registry_lock '{}' ""
		return 2
	fi
	if ! _run_journal_guard_root_redirect; then
		_run_journal_diag "OSTE_RUN_JOURNAL_ROOT redirects the journal away from the durable state root; refusing (test-only: set OSTE_TEST_MODE=1)"
		_run_journal_response query journal_unreadable journal_root_redirect_refused '{}' ""
		return 3
	fi
	if ! task_id_is_valid "$request_id"; then
		_run_journal_diag "invalid launch-request-id"
		_run_journal_response query invalid_request invalid_launch_request_id '{}' ""
		return 1
	fi
	root=$(run_journal_root)
	# A pure stat. Query never creates the root, the lock directory, or anything
	# else: the journal is inert unless a record is explicitly appended.
	if [[ ! -d "$(_run_journal_entry_dir "$request_id")" ]]; then
		if [[ -d "$root" ]] && ! _run_journal_guard_secure_mode "$root"; then
			_run_journal_response query journal_unreadable insecure_permissions \
				"$(jq -cn --arg r "$request_id" '{launch_request_id:$r}')" ""
			return 3
		fi
		_run_journal_response query not_found "" "$(jq -cn --arg r "$request_id" '{launch_request_id:$r}')" ""
		return 0
	fi
	if ! _run_journal_guard_secure_mode "$root"; then
		_run_journal_response query journal_unreadable insecure_permissions \
			"$(jq -cn --arg r "$request_id" '{launch_request_id:$r}')" ""
		return 3
	fi
	local envelope envelope_outcome envelope_reason
	envelope=$(_run_journal_query_envelope "$request_id")
	envelope_outcome=$(jq -r '.outcome' <<<"$envelope")
	envelope_reason=$(jq -r '.reason // ""' <<<"$envelope")
	if [[ "$envelope_outcome" == "found" ]]; then
		_run_journal_response query found "" "$(jq -c '.projection' <<<"$envelope")" ""
		return 0
	fi
	_run_journal_response query "$envelope_outcome" "$envelope_reason" \
		"$(jq -cn --arg r "$request_id" '{launch_request_id:$r}')" ""
	return "$(run_journal_outcome_exit_code "$envelope_outcome")"
}

# ── Task-index claim resolution is not proof ─────────────────────────
#
# `index/task/<task>/<generation>/claim.json` merely NAMES a launch request.
# Nothing inside the claim proves the named request is bound to the task and
# generation whose directory happens to hold it, and the claim file is ordinary
# filesystem state: a restore, a copy, a merge of two roots, or a hostile write
# can leave a syntactically valid claim under `task-b/gen-b` that names a
# request bound to `task-a/gen-a`. Resolving it and answering `found` hands the
# caller a task-a binding under a task-b question — and the dedupe answer is one
# of exactly two reads ADR 0010 §4 authorises a caller to BRANCH on, so a wrong
# one is not an audit blemish, it is a dispatch decision made about another task.
#
# The loaded request's own acknowledgement binding is the only proof. Both
# `binding.task_id` AND `binding.task_generation` must equal the queried pair.
# Anything else — mismatch, absent binding, unreadable binding — is
# `indeterminate`, the same fail-closed vocabulary an unresolvable claim already
# uses: a launch MAY have been acknowledged for this pair, we cannot say. Never
# `found` (which would assert the wrong request answers this pair) and never
# `not_found` (which would assert nothing was ever claimed).
#
# Prints the refusal reason on stdout and returns non-zero; verified prints
# nothing and returns 0.
_run_journal_claim_binding_state() {
	local binding="${1:-}" task_id="$2" generation="$3" bound_task bound_generation
	if [[ -z "$binding" ]] || ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$binding"; then
		printf 'index_claim_binding_unverifiable'
		return 1
	fi
	bound_task=$(jq -r '.task_id // empty' <<<"$binding" 2>/dev/null || true)
	bound_generation=$(jq -r '.task_generation // empty' <<<"$binding" 2>/dev/null || true)
	if [[ -z "$bound_task" || -z "$bound_generation" ]]; then
		printf 'index_claim_binding_unverifiable'
		return 1
	fi
	if [[ "$bound_task" != "$task_id" || "$bound_generation" != "$generation" ]]; then
		printf 'index_claim_binding_mismatch'
		return 1
	fi
	return 0
}

_run_journal_binding_field() {
	local binding="${1:-}" field="$2"
	[[ -n "$binding" ]] || {
		printf ''
		return 0
	}
	jq -r --arg k "$field" '(.[$k] // "") | tostring' <<<"$binding" 2>/dev/null || printf ''
}

run_journal_query_by_task_generation() {
	local task_id="$1" generation="$2" claim holder root
	if ! _run_journal_guard_lock_order; then
		_run_journal_response query lock_order_violation caller_holds_registry_lock '{}' ""
		return 2
	fi
	if ! _run_journal_guard_root_redirect; then
		_run_journal_diag "OSTE_RUN_JOURNAL_ROOT redirects the journal away from the durable state root; refusing (test-only: set OSTE_TEST_MODE=1)"
		_run_journal_response query journal_unreadable journal_root_redirect_refused '{}' ""
		return 3
	fi
	if ! task_id_is_valid "$task_id" || ! task_id_is_valid "$generation"; then
		_run_journal_response query invalid_request invalid_task_identity '{}' ""
		return 1
	fi
	root=$(run_journal_root)
	claim=$(_run_journal_index_claim_path "$task_id" "$generation")
	if [[ ! -f "$claim" ]]; then
		_run_journal_response query not_found "" \
			"$(jq -cn --arg t "$task_id" --arg g "$generation" '{task_id:$t,task_generation:$g,launch_request_ids:[]}')" ""
		return 0
	fi
	if ! _run_journal_guard_secure_mode "$root"; then
		_run_journal_response query journal_unreadable insecure_permissions \
			"$(jq -cn --arg t "$task_id" --arg g "$generation" '{task_id:$t,task_generation:$g}')" ""
		return 3
	fi
	holder=$(jq -r '.launch_request_id // empty' "$claim" 2>/dev/null || true)
	if [[ -z "$holder" ]] || ! task_id_is_valid "$holder"; then
		_run_journal_response query journal_unreadable malformed_index_claim \
			"$(jq -cn --arg t "$task_id" --arg g "$generation" '{task_id:$t,task_generation:$g}')" ""
		return 3
	fi
	# An index claim is a HINT. The acknowledgement record is the only proof, so
	# an unverifiable claim is `indeterminate` — a launch MAY have been
	# acknowledged — and never `not_found`.
	if [[ ! -d "$(_run_journal_entry_dir "$holder")" ]]; then
		_run_journal_diag "index claim for ${task_id}/${generation} has no request directory"
		_run_journal_response query indeterminate index_claim_unresolved \
			"$(jq -cn --arg t "$task_id" --arg g "$generation" --arg h "$holder" \
				'{task_id:$t,task_generation:$g,launch_request_ids:[$h]}')" ""
		return 3
	fi
	local envelope envelope_outcome envelope_reason
	envelope=$(_run_journal_query_envelope "$holder")
	envelope_outcome=$(jq -r '.outcome' <<<"$envelope")
	envelope_reason=$(jq -r '.reason // ""' <<<"$envelope")
	if [[ "$envelope_outcome" == "found" ]]; then
		local projection binding binding_reason
		projection=$(jq -c '.projection' <<<"$envelope")
		binding=$(jq -c '.binding' <<<"$projection" 2>/dev/null || printf 'null')
		# Resolution succeeded; that is not the same as the claim being TRUE.
		if binding_reason=$(_run_journal_claim_binding_state "$binding" "$task_id" "$generation"); then
			binding_reason=""
		fi
		if [[ -n "$binding_reason" ]]; then
			_run_journal_diag "index claim for ${task_id}/${generation} resolves to ${holder}, whose binding does not match the queried pair"
			_run_journal_response query indeterminate "$binding_reason" \
				"$(jq -cn --arg t "$task_id" --arg g "$generation" --arg h "$holder" \
					--arg bt "$(_run_journal_binding_field "$binding" task_id)" \
					--arg bg "$(_run_journal_binding_field "$binding" task_generation)" \
					'{task_id:$t,task_generation:$g,launch_request_ids:[$h],
					  bound_task_id:$bt,bound_task_generation:$bg}')" ""
			return 3
		fi
		_run_journal_response query found "" \
			"$(jq -cn --arg t "$task_id" --arg g "$generation" --arg h "$holder" \
				--argjson p "$projection" \
				'{task_id:$t,task_generation:$g,launch_request_ids:[$h]} + $p')" ""
		return 0
	fi
	if [[ "$envelope_outcome" == "not_found" ]]; then
		_run_journal_response query indeterminate index_claim_unresolved \
			"$(jq -cn --arg t "$task_id" --arg g "$generation" --arg h "$holder" \
				'{task_id:$t,task_generation:$g,launch_request_ids:[$h]}')" ""
		return 3
	fi
	_run_journal_response query "$envelope_outcome" "$envelope_reason" \
		"$(jq -cn --arg t "$task_id" --arg g "$generation" --arg h "$holder" \
			'{task_id:$t,task_generation:$g,launch_request_ids:[$h]}')" ""
	return "$(run_journal_outcome_exit_code "$envelope_outcome")"
}

# The only listing over the index, and the only way a caller can prove that one
# task ID did not produce two accepted generations. One bounded directory level
# of `index/`, read-only, no action taken, never touches the record space.
_run_journal_index_generations_for_task() {
	local task_id="$1" task_dir entry generation claim holder at rows='[]' binding state
	task_dir=$(_run_journal_index_task_dir "$task_id")
	[[ -d "$task_dir" ]] || {
		printf '%s' "$rows"
		return 0
	}
	for entry in "$task_dir"/*; do # BOUNDED-INDEX-ENUMERATION (A2)
		[[ -d "$entry" ]] || continue
		generation=$(basename "$entry")
		claim="${entry}/claim.json"
		[[ -f "$claim" ]] || continue
		holder=$(jq -r '.launch_request_id // empty' "$claim" 2>/dev/null || true)
		at=$(jq -r '.claimed_at // empty' "$claim" 2>/dev/null || true)
		# A task-only listing is an authorized dedupe answer, not an index dump.
		# Resolve every claim through the same request envelope used by the
		# single-generation query. That envelope validates the root record and its
		# independently anchored complete launch binding against this claim before
		# any binding can be called verified. Reading raw acknowledgement identity
		# here would let a checksum-refreshed root edit or a forged claim digest
		# bypass the request query's binding-integrity gate.
		binding=""
		state="index_claim_unresolved"
		if [[ -n "$holder" ]] && task_id_is_valid "$holder"; then
			local envelope envelope_outcome projection
			envelope=$(_run_journal_query_envelope "$holder")
			envelope_outcome=$(jq -r '.outcome // "journal_unreadable"' <<<"$envelope")
			if [[ "$envelope_outcome" == "found" ]]; then
				projection=$(jq -c '.projection' <<<"$envelope" 2>/dev/null || printf 'null')
				binding=$(jq -c '.binding' <<<"$projection" 2>/dev/null || printf 'null')
				if state=$(_run_journal_claim_binding_state "$binding" "$task_id" "$generation"); then
					state="verified"
				fi
			else
				state=$(jq -r '.reason // .outcome // "journal_unreadable"' <<<"$envelope")
			fi
		fi
		rows=$(jq -c --arg g "$generation" --arg h "$holder" --arg a "$at" --arg s "$state" \
			'. + [{task_generation:$g,launch_request_id:$h,claimed_at:$a,binding_state:$s}]' <<<"$rows")
	done
	printf '%s' "$rows"
	return 0
}

run_journal_query_by_task() {
	local task_id="$1" rows count root
	if ! _run_journal_guard_lock_order; then
		_run_journal_response query lock_order_violation caller_holds_registry_lock '{}' ""
		return 2
	fi
	if ! _run_journal_guard_root_redirect; then
		_run_journal_diag "OSTE_RUN_JOURNAL_ROOT redirects the journal away from the durable state root; refusing (test-only: set OSTE_TEST_MODE=1)"
		_run_journal_response query journal_unreadable journal_root_redirect_refused '{}' ""
		return 3
	fi
	if ! task_id_is_valid "$task_id"; then
		_run_journal_response query invalid_request invalid_task_id '{}' ""
		return 1
	fi
	root=$(run_journal_root)
	if [[ -d "$root" ]] && ! _run_journal_guard_secure_mode "$root"; then
		_run_journal_response query journal_unreadable insecure_permissions \
			"$(jq -cn --arg t "$task_id" '{task_id:$t}')" ""
		return 3
	fi
	rows=$(_run_journal_index_generations_for_task "$task_id")
	count=$(jq -r 'length' <<<"$rows")
	if ((count == 0)); then
		_run_journal_response query not_found "" \
			"$(jq -cn --arg t "$task_id" '{task_id:$t,claimed_generations:[],count:0}')" ""
		return 0
	fi
	# One unproven row poisons the whole answer: the value of this listing is the
	# claim "these, and only these, generations were accepted for this task", and
	# that sentence cannot be half true. The rows are still returned so an
	# operator can see WHICH claim failed, but the outcome is indeterminate.
	local unverified first_reason
	unverified=$(jq -r '[.[] | select(.binding_state != "verified")] | length' <<<"$rows")
	if [[ "$unverified" =~ ^[0-9]+$ ]] && ((unverified > 0)); then
		first_reason=$(jq -r '[.[] | select(.binding_state != "verified")] | .[0].binding_state' <<<"$rows")
		_run_journal_diag "task ${task_id} has ${unverified} index claim(s) whose request binding does not match"
		_run_journal_response query indeterminate "${first_reason:-index_claim_binding_unverifiable}" \
			"$(jq -cn --arg t "$task_id" --argjson rows "$rows" --argjson c "$count" --argjson u "$unverified" \
				'{task_id:$t,claimed_generations:$rows,count:$c,unverified_claims:$u}')" ""
		return 3
	fi
	_run_journal_response query found "" \
		"$(jq -cn --arg t "$task_id" --argjson rows "$rows" --argjson c "$count" \
			'{task_id:$t,claimed_generations:$rows,count:$c}')" ""
	return 0
}

# ── quarantine-list ──────────────────────────────────────────────────
#
# The only listing verb, scoped to one request's inert quarantine directory.
# There is deliberately no global form: a root-wide walk is the one unbounded
# scan this contract refuses to contain.
run_journal_quarantine_list() {
	local request_id="$1" limit="${2:-100}" dir f name rest kind reason mtime rows='[]' total=0 truncated=false
	if ! _run_journal_guard_lock_order; then
		_run_journal_response quarantine-list lock_order_violation caller_holds_registry_lock '{}' ""
		return 2
	fi
	if ! _run_journal_guard_root_redirect; then
		_run_journal_diag "OSTE_RUN_JOURNAL_ROOT redirects the journal away from the durable state root; refusing (test-only: set OSTE_TEST_MODE=1)"
		_run_journal_response quarantine-list journal_unreadable journal_root_redirect_refused '{}' ""
		return 3
	fi
	if ! task_id_is_valid "$request_id"; then
		_run_journal_response quarantine-list invalid_request invalid_launch_request_id '{}' ""
		return 1
	fi
	if [[ ! "$limit" =~ ^[0-9]+$ ]] || ((limit < 1)); then
		_run_journal_response quarantine-list invalid_request invalid_limit '{}' ""
		return 1
	fi
	dir=$(_run_journal_quarantine_dir "$request_id")
	if [[ ! -d "$dir" ]]; then
		_run_journal_response quarantine-list not_found "" \
			"$(jq -cn --arg r "$request_id" --argjson l "$limit" \
				'{launch_request_id:$r,entries:[],count:0,limit:$l,truncated:false}')" ""
		return 0
	fi
	local sorted
	sorted=$(
		for f in "$dir"/*; do # BOUNDED-QUARANTINE-ENUMERATION (A17)
			[[ -f "$f" ]] || continue
			# Same exclusion as _run_journal_quarantine_count: an atomic-write temp
			# orphan is not an entry, and listing it would also mis-parse into a
			# kind/reason pair that never existed.
			[[ "$f" == *.json.tmp.* ]] && continue
			printf '%s\t%s\n' "$(_run_journal_mtime "$f")" "$f"
		done | LC_ALL=C sort -rn -k1,1
	)
	while IFS=$'\t' read -r mtime f; do
		[[ -n "$f" ]] || continue
		total=$((total + 1))
		((total > limit)) && continue
		name=$(basename "$f")
		rest="${name#"${request_id}."}"
		kind="${rest%%.*}"
		rest="${rest#*.}"
		reason="${rest%%.*}"
		rows=$(jq -c --arg p "$f" --arg r "$request_id" --arg k "$kind" --arg re "$reason" \
			--arg at "$(date -u -r "$mtime" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@${mtime}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")" \
			'. + [{path:$p,launch_request_id:$r,kind:$k,reason:$re,quarantined_at:$at}]' <<<"$rows")
	done <<<"$sorted"
	if ((total > limit)); then
		truncated=true
	fi
	if ((total == 0)); then
		_run_journal_response quarantine-list not_found "" \
			"$(jq -cn --arg r "$request_id" --argjson l "$limit" \
				'{launch_request_id:$r,entries:[],count:0,limit:$l,truncated:false}')" ""
		return 0
	fi
	_run_journal_response quarantine-list found "" \
		"$(jq -cn --arg r "$request_id" --argjson rows "$rows" --argjson l "$limit" --argjson t "$truncated" \
			'{launch_request_id:$r,entries:$rows,count:($rows|length),limit:$l,truncated:$t}')" ""
	return 0
}
