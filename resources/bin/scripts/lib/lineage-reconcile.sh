#!/bin/bash
#
# lineage-reconcile.sh — Immutable lineage-reconciliation receipts (PAR-595)
#
# A completed lane's review target can become unreviewable without anything
# being wrong with the lane. On a shared single-main lane the lane's commits get
# replayed onto the trunk, so the shas recorded in the immutable pending-review
# receipt and in the task ledger survive only as unreachable objects while the
# byte-identical patches live on canonical main under NEW shas. A reviewer
# dispatched at the recorded range then reviews nothing.
#
# The unsafe repair is to hand-edit the live receipt so it names the new shas.
# That destroys the completion evidence the receipt exists to preserve, and it
# silently re-points an owner-gated review at a range no owner authorized.
#
# This library provides the safe alternative: a SEPARATE, immutable
# reconciliation receipt that binds
#
#   - the original receipt's identity, path, and content hash
#   - the task-ledger end commit the receipt was published against
#   - the canonical patch-equivalent range and its per-commit mapping
#   - the explicitly declared allowed unrelated delta
#   - the exact post-reconciliation review target
#   - provenance and timestamps
#
# and never touches the original receipt, the task row, or the owner review
# authorization. Every helper here is READ-ONLY with respect to existing
# lifecycle state; the single writer, lineage_reconcile_publish_once, refuses to
# overwrite anything.
#
# Receipts are content-addressed by their binding, so identical evidence always
# names the same receipt path: re-running is an idempotent no-op instead of a
# rewrite, and a changed binding can only ever create a NEW document.
#
# Public API:
#   lineage_reconcile_dir
#   lineage_reconcile_task_dir <task_id>
#   lineage_reconcile_receipt_path <task_id> <reconciliation_id>
#   lineage_reconcile_sha256_stdin
#   lineage_reconcile_file_sha256 <file>
#   lineage_reconcile_json_sha256 <file>
#   lineage_reconcile_binding_id            (binding JSON on stdin)
#   lineage_reconcile_lock_acquire <task_id>
#   lineage_reconcile_lock_release <task_id>
#   lineage_reconcile_resolve_commit <repo> <rev>
#   lineage_reconcile_sole_parent <repo> <commit>
#   lineage_reconcile_is_ancestor <repo> <maybe_ancestor> <descendant>
#   lineage_reconcile_range_commits <repo> <base> <head>
#   lineage_reconcile_range_diff_pairs <repo> <ob> <oh> <cb> <ch>
#   lineage_reconcile_pairs_are_equivalent  (pair TSV on stdin)
#   lineage_reconcile_pairs_to_json         (pair TSV on stdin)
#   lineage_reconcile_aggregate_patch_id <repo> <from> <to>
#   lineage_reconcile_delta_paths <repo> <from> <to>
#   lineage_reconcile_publish_once <path>   (receipt JSON on stdin)

[[ -n "${_OSTE_LINEAGE_RECONCILE_SH_LOADED:-}" ]] && return 0
readonly _OSTE_LINEAGE_RECONCILE_SH_LOADED=1

# Bump when the receipt schema changes shape. Recorded in every receipt so a
# consumer never has to guess which contract it is reading.
# shellcheck disable=SC2034  # consumed by sourcing CLIs, not by this library
readonly OSTE_LINEAGE_RECONCILE_SCHEMA_VERSION=1

# ── Paths ────────────────────────────────────────────────────────────

lineage_reconcile_dir() {
	printf '%s' "${OSTE_LINEAGE_RECONCILE_DIR:-/tmp/oste-lineage-reconcile}"
}

_lineage_reconcile_safe_id() {
	printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

lineage_reconcile_task_dir() {
	local task_id="${1:-}"
	[[ -n "$task_id" ]] || return 1
	printf '%s/%s' "$(lineage_reconcile_dir)" "$(_lineage_reconcile_safe_id "$task_id")"
}

lineage_reconcile_receipt_path() {
	local task_id="${1:-}" reconciliation_id="${2:-}" dir
	[[ -n "$task_id" && -n "$reconciliation_id" ]] || return 1
	dir=$(lineage_reconcile_task_dir "$task_id") || return 1
	printf '%s/%s.json' "$dir" "$(_lineage_reconcile_safe_id "$reconciliation_id")"
}

# ── Digests ──────────────────────────────────────────────────────────

lineage_reconcile_sha256_stdin() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 | awk '{print $1}'
	elif command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{print $1}'
	else
		return 1
	fi
}

# Raw-byte digest: proves the file on disk was not rewritten at all.
lineage_reconcile_file_sha256() {
	local file="${1:-}"
	[[ -f "$file" ]] || return 1
	lineage_reconcile_sha256_stdin <"$file"
}

# Canonical-content digest: proves the JSON *meaning* did not change even if a
# writer reformatted or reordered keys.
lineage_reconcile_json_sha256() {
	local file="${1:-}"
	[[ -f "$file" ]] || return 1
	jq -S -c . "$file" | lineage_reconcile_sha256_stdin
}

# Content address for a binding document. The id deliberately excludes
# provenance (timestamps, host, operator reason) so the same evidence always
# resolves to the same receipt path.
lineage_reconcile_binding_id() {
	local digest
	digest=$(jq -S -c . | lineage_reconcile_sha256_stdin) || return 1
	[[ ${#digest} -ge 32 ]] || return 1
	printf '%s' "${digest:0:32}"
}

# ── Locking (fail-closed) ────────────────────────────────────────────

# Serialize reconciliation for one task. Unlike the fail-soft notification
# receipt lock, a lock we cannot take is a hard failure: publishing without it
# could race a concurrent operator into a half-verified receipt.
lineage_reconcile_lock_acquire() {
	local task_id="${1:-}" lockdir waited=0 max_wait lock_mtime now
	[[ -n "$task_id" ]] || return 1
	max_wait="${OSTE_LINEAGE_RECONCILE_LOCK_MAX_WAIT:-10}"
	lockdir="$(lineage_reconcile_task_dir "$task_id").lock"
	mkdir -p "$(lineage_reconcile_dir)" 2>/dev/null || return 1
	while ! mkdir "$lockdir" 2>/dev/null; do
		lock_mtime=$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo 0)
		now=$(date +%s)
		if [[ $((now - lock_mtime)) -ge "${OSTE_LINEAGE_RECONCILE_LOCK_STALE_AGE:-60}" ]]; then
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

lineage_reconcile_lock_release() {
	local task_id="${1:-}"
	[[ -n "$task_id" ]] || return 0
	rm -rf "$(lineage_reconcile_task_dir "$task_id").lock" 2>/dev/null || true
	return 0
}

# ── Git evidence (read-only) ─────────────────────────────────────────

# Every git call is routed through here so colour is never interpreted and no
# call can accidentally be a write.
_lineage_reconcile_git() {
	local repo="$1"
	shift
	git -C "$repo" -c color.ui=never "$@"
}

lineage_reconcile_resolve_commit() {
	local repo="${1:-}" rev="${2:-}"
	[[ -n "$repo" && -n "$rev" ]] || return 1
	_lineage_reconcile_git "$repo" rev-parse --verify --quiet "${rev}^{commit}" 2>/dev/null
}

# A range hangs off its first commit's single parent. A merge commit has no
# unambiguous base, so report failure rather than silently picking first-parent.
# Prints the sole parent sha; rc 1 when the commit is a merge or a root.
lineage_reconcile_sole_parent() {
	local repo="${1:-}" commit="${2:-}" parents count
	[[ -n "$repo" && -n "$commit" ]] || return 1
	parents=$(_lineage_reconcile_git "$repo" rev-list --parents -n 1 "$commit" 2>/dev/null) || return 1
	count=$(($(printf '%s' "$parents" | wc -w) - 1))
	[[ "$count" -eq 1 ]] || return 1
	printf '%s' "$parents" | awk '{print $2}'
}

lineage_reconcile_is_ancestor() {
	local repo="${1:-}" ancestor="${2:-}" descendant="${3:-}"
	[[ -n "$repo" && -n "$ancestor" && -n "$descendant" ]] || return 1
	_lineage_reconcile_git "$repo" merge-base --is-ancestor "$ancestor" "$descendant" 2>/dev/null
}

# Commits in <base>..<head>, oldest first.
lineage_reconcile_range_commits() {
	local repo="${1:-}" base="${2:-}" head="${3:-}"
	[[ -n "$repo" && -n "$base" && -n "$head" ]] || return 1
	_lineage_reconcile_git "$repo" rev-list --reverse "${base}..${head}" 2>/dev/null
}

# Per-commit mapping between two ranges as TSV: <original>\t<marker>\t<canonical>.
# --no-patch keeps the output to header lines only, so the mapping is parsed from
# a fixed five-field shape rather than scraped out of a diff-of-diffs body.
# Markers: '=' identical, '!' differing, '<' original-only, '>' canonical-only.
lineage_reconcile_range_diff_pairs() {
	local repo="${1:-}" ob="${2:-}" oh="${3:-}" cb="${4:-}" ch="${5:-}" out
	[[ -n "$repo" && -n "$ob" && -n "$oh" && -n "$cb" && -n "$ch" ]] || return 1
	out=$(_lineage_reconcile_git "$repo" range-diff --no-patch \
		"${ob}..${oh}" "${cb}..${ch}" 2>/dev/null) || return 1
	[[ -n "$out" ]] || return 1
	printf '%s\n' "$out" | awk '
		($3 == "=" || $3 == "!" || $3 == "<" || $3 == ">") &&
		$1 ~ /^([0-9]+|-):$/ && $4 ~ /^([0-9]+|-):$/ {
			printf "%s\t%s\t%s\n", $2, $3, $5
		}'
}

# rc 0 only when there is at least one pair and every pair is an exact match.
lineage_reconcile_pairs_are_equivalent() {
	awk -F'\t' '
		{ n++; if ($2 != "=") bad = 1 }
		END { if (n == 0 || bad) exit 1; exit 0 }'
}

lineage_reconcile_pairs_to_json() {
	jq -R -s -c '
		split("\n")
		| map(select(length > 0) | split("\t")
		| {original: .[0], marker: .[1], canonical: .[2]})'
}

# Independent corroboration of per-commit equivalence: the cumulative tree delta
# of the two ranges must hash to the same stable patch id. range-diff proves the
# commits map one-to-one; this proves the aggregate change is the same change.
lineage_reconcile_aggregate_patch_id() {
	local repo="${1:-}" from="${2:-}" to="${3:-}" out
	[[ -n "$repo" && -n "$from" && -n "$to" ]] || return 1
	out=$(_lineage_reconcile_git "$repo" diff "$from" "$to" |
		_lineage_reconcile_git "$repo" patch-id --stable | awk '{print $1}') || return 1
	[[ -n "$out" ]] || return 1
	printf '%s' "$out"
}

lineage_reconcile_delta_paths() {
	local repo="${1:-}" from="${2:-}" to="${3:-}"
	[[ -n "$repo" && -n "$from" && -n "$to" ]] || return 1
	_lineage_reconcile_git "$repo" diff --name-only "$from" "$to" 2>/dev/null
}

# ── Publish (the only writer) ────────────────────────────────────────

# Create <path> exactly once from the JSON on stdin.
#
# Immutability is enforced by the filesystem, not by convention: the document is
# staged in the same directory and hard-linked into place, so an existing
# receipt makes ln fail with EEXIST instead of being truncated. The published
# inode is mode 0400, so a later careless write fails too.
#
# rc 0 = created, 1 = failed (nothing published), 4 = a receipt already exists.
lineage_reconcile_publish_once() {
	local path="${1:-}" dir tmp
	[[ -n "$path" ]] || return 1
	dir=$(dirname "$path")
	mkdir -p "$dir" 2>/dev/null || return 1
	if [[ -e "$path" ]]; then
		return 4
	fi
	tmp=$(mktemp "${path}.tmp.XXXXXX" 2>/dev/null) || return 1
	if ! cat >"$tmp"; then
		rm -f "$tmp"
		return 1
	fi
	if ! jq -e . "$tmp" >/dev/null 2>&1; then
		rm -f "$tmp"
		return 1
	fi
	chmod 0400 "$tmp" 2>/dev/null || true
	if ln "$tmp" "$path" 2>/dev/null; then
		rm -f "$tmp"
		return 0
	fi
	rm -f "$tmp"
	if [[ -e "$path" ]]; then
		return 4
	fi
	return 1
}
