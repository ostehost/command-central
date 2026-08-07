#!/bin/bash
#
# review-target-reconcile.sh — Immutable pre-review review-target reconciliation
# (PAR-595)
#
# A completed lane publishes an immutable pending-review receipt whose
# end_commit is the AGENT's last commit. The task ledger, however, settles on the
# manager commit — the later, lane-owned commit that records the handoff. When
# those two disagree, a reviewer dispatched at the receipt's recorded target
# reviews a strict prefix of what the ledger calls the lane's end: the manager
# commit's content is never seen, and nothing anywhere states what that
# difference actually is.
#
# This is NOT the lineage problem lineage-reconcile.sh solves. There the
# recorded shas were displaced by a replay and survive only as unreachable
# objects; here BOTH commits are reachable and the recorded lineage is intact.
# oste-reconcile-lineage.sh refuses exactly this case ("still reachable; nothing
# to reconcile"), and this library refuses the inverse (a displaced source),
# so the two capabilities can never be pointed at each other's evidence.
#
# The unsafe repair is to edit the live receipt's end_commit forward, or to let
# the existing owner-review request silently start covering a wider range than
# the owner saw when they were asked. The first destroys completion evidence;
# the second launders an unreviewed delta through an old authorization.
#
# The safe alternative implemented here: a SEPARATE, immutable receipt that binds
#
#   - the source receipt's byte digest, review revision, and recorded end commit
#   - the task ledger's row digest, task generation, and authoritative end commit
#   - the exact declared delta between the two ends (per path, per line count)
#   - the prior and reconciled review target ranges
#   - a NEWLY MINTED, target-bound owner-review request that starts owner-gated
#   - provenance and the non-mutation contract
#
# and never touches the source receipt, the task row, or the original owner
# request. Every helper here is READ-ONLY with respect to existing lifecycle
# state; the single writer refuses to overwrite anything.
#
# Receipts are content-addressed by their evidence, so identical evidence always
# names the same receipt path and mints the same request id: re-running is an
# idempotent no-op instead of a rewrite or a second request, and changed evidence
# can only ever create a NEW document.
#
# The generic digest/publish/commit primitives are reused from
# lineage-reconcile.sh rather than re-implemented, so both reconciliation
# capabilities share one create-once publisher and one digest convention.
#
# Public API:
#   review_target_reconcile_dir
#   review_target_reconcile_task_dir <task_id>
#   review_target_reconcile_receipt_path <task_id> <reconciliation_id>
#   review_target_reconcile_sha256_stdin
#   review_target_reconcile_file_sha256 <file>
#   review_target_reconcile_json_sha256 <file>
#   review_target_reconcile_binding_id           (evidence JSON on stdin)
#   review_target_reconcile_request_id <task_id> <reconciliation_id>
#   review_target_reconcile_lock_acquire <task_id>
#   review_target_reconcile_lock_release <task_id>
#   review_target_reconcile_resolve_commit <repo> <rev>
#   review_target_reconcile_is_ancestor <repo> <maybe_ancestor> <descendant>
#   review_target_reconcile_is_proper_ancestor <repo> <ancestor> <descendant>
#   review_target_reconcile_range_commits <repo> <base> <head>
#   review_target_reconcile_no_merge_commits <repo> <base> <head>
#   review_target_reconcile_delta_paths <repo> <from> <to>
#   review_target_reconcile_numstat <repo> <from> <to>
#   review_target_reconcile_numstat_is_countable  (numstat TSV on stdin)
#   review_target_reconcile_numstat_to_json       (numstat TSV on stdin)
#   review_target_reconcile_publish_once <path>   (receipt JSON on stdin)

[[ -n "${_OSTE_REVIEW_TARGET_RECONCILE_SH_LOADED:-}" ]] && return 0
readonly _OSTE_REVIEW_TARGET_RECONCILE_SH_LOADED=1

_review_target_reconcile_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly _review_target_reconcile_lib_dir
# shellcheck source=lineage-reconcile.sh
source "${_review_target_reconcile_lib_dir}/lineage-reconcile.sh"

# Bump when the receipt schema changes shape. Recorded in every receipt so a
# consumer never has to guess which contract it is reading.
# shellcheck disable=SC2034  # consumed by sourcing CLIs, not by this library
readonly OSTE_REVIEW_TARGET_RECONCILE_SCHEMA_VERSION=1
# Stable type tag for the operation itself. Also the namespace the minted
# owner-review request id is derived under.
readonly OSTE_REVIEW_TARGET_RECONCILE_SCHEMA_ID="oste.review_target_reconciliation.v1"

# ── Paths ────────────────────────────────────────────────────────────

review_target_reconcile_dir() {
	printf '%s' "${OSTE_REVIEW_TARGET_RECONCILE_DIR:-/tmp/oste-review-target-reconcile}"
}

_review_target_reconcile_safe_id() {
	printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

review_target_reconcile_task_dir() {
	local task_id="${1:-}"
	[[ -n "$task_id" ]] || return 1
	printf '%s/%s' "$(review_target_reconcile_dir)" "$(_review_target_reconcile_safe_id "$task_id")"
}

review_target_reconcile_receipt_path() {
	local task_id="${1:-}" reconciliation_id="${2:-}" dir
	[[ -n "$task_id" && -n "$reconciliation_id" ]] || return 1
	dir=$(review_target_reconcile_task_dir "$task_id") || return 1
	printf '%s/%s.json' "$dir" "$(_review_target_reconcile_safe_id "$reconciliation_id")"
}

# ── Digests and the create-once publisher (shared primitives) ────────
#
# Thin, deliberate aliases: one digest convention and one create-once publisher
# serve both reconciliation capabilities, while call sites keep a single
# vocabulary instead of reaching into the other capability's namespace.

review_target_reconcile_sha256_stdin() {
	lineage_reconcile_sha256_stdin
}

review_target_reconcile_file_sha256() {
	lineage_reconcile_file_sha256 "$@"
}

review_target_reconcile_json_sha256() {
	lineage_reconcile_json_sha256 "$@"
}

# Content address for the evidence document. The id deliberately excludes
# provenance (timestamps, host, operator reason) AND the minted request, so the
# same evidence always resolves to the same receipt path and the request the
# receipt mints can be derived from that address without circularity.
review_target_reconcile_binding_id() {
	lineage_reconcile_binding_id
}

review_target_reconcile_publish_once() {
	lineage_reconcile_publish_once "$@"
}

# ── The minted owner-review request identity ─────────────────────────

# Deterministic, target-bound owner-review request id: derived from a fixed
# namespace, the task, and the reconciliation id. Never random, so replaying the
# same evidence mints the SAME request instead of a second one; never derived
# from a prior request, so an old authorization can never be reused or renamed
# into the new target. Formatted uuid-shaped so it drops into the existing
# owner_review_request_id field convention — it is a digest, not an RFC 4122
# random uuid, and the receipt records that derivation explicitly.
review_target_reconcile_request_id() {
	local task_id="${1:-}" reconciliation_id="${2:-}" digest
	[[ -n "$task_id" && -n "$reconciliation_id" ]] || return 1
	digest=$(printf '%s' \
		"${OSTE_REVIEW_TARGET_RECONCILE_SCHEMA_ID}|owner-review-request|${task_id}|${reconciliation_id}" |
		review_target_reconcile_sha256_stdin) || return 1
	[[ ${#digest} -ge 32 ]] || return 1
	printf '%s-%s-%s-%s-%s' \
		"${digest:0:8}" "${digest:8:4}" "${digest:12:4}" "${digest:16:4}" "${digest:20:12}"
}

# ── Locking (fail-closed) ────────────────────────────────────────────

# Serialize reconciliation for one task. A lock we cannot take is a hard failure:
# publishing without it could race a concurrent operator into a half-verified
# receipt.
review_target_reconcile_lock_acquire() {
	local task_id="${1:-}" lockdir waited=0 max_wait lock_mtime now
	[[ -n "$task_id" ]] || return 1
	max_wait="${OSTE_REVIEW_TARGET_RECONCILE_LOCK_MAX_WAIT:-10}"
	lockdir="$(review_target_reconcile_task_dir "$task_id").lock"
	mkdir -p "$(review_target_reconcile_dir)" 2>/dev/null || return 1
	while ! mkdir "$lockdir" 2>/dev/null; do
		lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
		now=$(date +%s)
		if [[ $((now - lock_mtime)) -ge "${OSTE_REVIEW_TARGET_RECONCILE_LOCK_STALE_AGE:-60}" ]]; then
			rm -rf "$lockdir" 2>/dev/null || true
		else
			sleep 0.05
		fi
		waited=$((waited + 1))
		if [[ "$waited" -ge $((max_wait * 20)) ]]; then
			return 1
		fi
	done
	return 0
}

review_target_reconcile_lock_release() {
	local task_id="${1:-}"
	[[ -n "$task_id" ]] || return 0
	rm -rf "$(review_target_reconcile_task_dir "$task_id").lock" 2>/dev/null || true
	return 0
}

# ── Git evidence (read-only) ─────────────────────────────────────────

# Every git call is routed through here so colour is never interpreted and no
# call can accidentally be a write.
_review_target_reconcile_git() {
	local repo="$1"
	shift
	git -C "$repo" -c color.ui=never "$@"
}

review_target_reconcile_resolve_commit() {
	lineage_reconcile_resolve_commit "$@"
}

review_target_reconcile_is_ancestor() {
	lineage_reconcile_is_ancestor "$@"
}

# Strictly behind: an ancestor that is not the same commit. A reconciliation that
# moved nothing is not a reconciliation.
review_target_reconcile_is_proper_ancestor() {
	local repo="${1:-}" ancestor="${2:-}" descendant="${3:-}"
	[[ -n "$repo" && -n "$ancestor" && -n "$descendant" ]] || return 1
	[[ "$ancestor" != "$descendant" ]] || return 1
	lineage_reconcile_is_ancestor "$repo" "$ancestor" "$descendant"
}

review_target_reconcile_range_commits() {
	lineage_reconcile_range_commits "$@"
}

# rc 0 only when every commit in <base>..<head> has exactly one parent. A merge
# inside the extension would make its cumulative delta ambiguous (it depends on
# which side you diff from), so an exact declared delta could not mean one thing.
review_target_reconcile_no_merge_commits() {
	local repo="${1:-}" base="${2:-}" head="${3:-}" out line count
	[[ -n "$repo" && -n "$base" && -n "$head" ]] || return 1
	# Collected before the loop so a failed rev-list is a refusal rather than an
	# empty loop body that silently reports "no merges found".
	out=$(_review_target_reconcile_git "$repo" rev-list --parents "${base}..${head}" 2>/dev/null) || return 1
	[[ -n "$out" ]] || return 1
	while IFS= read -r line; do
		[[ -n "$line" ]] || continue
		count=$(($(printf '%s' "$line" | wc -w) - 1))
		[[ "$count" -eq 1 ]] || return 1
	done <<<"$out"
	return 0
}

review_target_reconcile_delta_paths() {
	lineage_reconcile_delta_paths "$@"
}

# Cumulative per-path delta as TSV: <path>\t<additions>\t<deletions>, LC_ALL=C
# sorted by path. --no-renames keeps every row a plain path, so a rename can
# never arrive as a "{old => new}" token the declared form cannot express. A
# binary path reports "-" for both counts and is passed through unchanged: the
# caller must fail closed on it rather than invent a line count.
review_target_reconcile_numstat() {
	local repo="${1:-}" from="${2:-}" to="${3:-}"
	[[ -n "$repo" && -n "$from" && -n "$to" ]] || return 1
	_review_target_reconcile_git "$repo" diff --numstat --no-renames "$from" "$to" 2>/dev/null |
		awk -F'\t' 'NF >= 3 { printf "%s\t%s\t%s\n", $3, $1, $2 }' | LC_ALL=C sort -u
}

# rc 0 only when every row carries countable line numbers, i.e. nothing binary.
review_target_reconcile_numstat_is_countable() {
	awk -F'\t' '
		{ if ($2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/) bad = 1 }
		END { if (bad) exit 1; exit 0 }'
}

review_target_reconcile_numstat_to_json() {
	jq -R -s -c '
		split("\n")
		| map(select(length > 0) | split("\t")
		| {path: .[0], additions: (.[1] | tonumber), deletions: (.[2] | tonumber)})'
}
