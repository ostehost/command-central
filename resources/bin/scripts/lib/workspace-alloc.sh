#!/bin/bash
#
# workspace-alloc.sh — Launcher-owned supervised workspace allocation.
#
# Given a supervised launch intent this library (a) proves the base commit,
# (b) creates ONE git worktree under Launcher-owned durable state on a fresh
# issue branch, (c) writes an allocation marker that makes the workspace
# retained-by-default, (d) emits an authoritative allocation record, and
# (e) removes ONLY its own workspace on a pre-registration failure.
#
# ── What this file deliberately is NOT ───────────────────────────────
# It is a sourceable library: no `main`, no CLI dispatch, no argument
# dispatcher, not executable. It never invokes the spawn writer, never opens
# the task registry except for two read-only cross-checks (reclaim rule R3 and
# the disposition late-binding recovery path), never takes the registry lock,
# and never sources any lifecycle library. Those couplings would turn an
# allocator into a control surface; a coupling assertion in
# test/test-workspace-alloc.sh keeps that true.
#
# ── errexit contract ─────────────────────────────────────────────────
# Every public entry point is safe to call BARE from a `set -euo pipefail`
# caller: internal statuses never escape mid-flight, and a refusal returns its
# mapped exit code only AFTER its JSON envelope has reached stdout, so a caller
# that aborts on that status aborts holding the whole answer. This library
# never sets shell options and never installs a trap — it is sourced into
# long-lived callers that own both.
#
# ── Ownership, and why cleanup can never hit the wrong directory ─────
# The removal path consults exactly one ownership record: the leaf path, its
# device:inode captured at the instant the exclusive mkdir won, and a per-call
# token. All of them are declared `local` by each public entry point, so bash's
# dynamic scope makes them visible to the private removal helper for exactly
# the duration of one call and unreachable afterwards. A second allocation in
# the same shell therefore cannot inherit a stale pointer to the first one's
# live workspace. The file-scope assignments below exist so the names have a
# definition when no call is in flight; they are never the value a removal
# reads during a call.
#
# ── Exit codes (consumers branch on `outcome`, never on the code) ────
#   0 allocated / accepted, 1 internal error, 2 refusal.

[[ -n "${__OSTE_WORKSPACE_ALLOC_SH:-}" ]] && return 0
__OSTE_WORKSPACE_ALLOC_SH=1

_wsa_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if ! declare -f task_id_is_valid >/dev/null 2>&1 && [[ -f "${_wsa_lib_dir}/task-id.sh" ]]; then
	# shellcheck source=task-id.sh
	source "${_wsa_lib_dir}/task-id.sh"
fi
unset _wsa_lib_dir

# ── Per-call ownership record (see the header note) ──────────────────

_WSA_OWNED_CALL_ID=""
_WSA_OWNED_LEAF=""
_WSA_OWNED_IDENT=""
_WSA_OWNED_ROOT=""
_WSA_OWNED_CANONICAL=""
_WSA_OWNED_TREE=""
_WSA_OWNED_BRANCH=""
_WSA_OWNED_START_SHA=""
_WSA_OWNED_ADMIN_DIR=""

# Result of the most recent removal attempt. Genuinely global (a caller reads
# it after the call returns); it carries no ownership authority.
_WSA_LAST_CLEANUP="none"
_WSA_LAST_CLEANUP_DETAIL=""

# ── Constants, expressed as functions so sourcing exports nothing ────

workspace_alloc_schema_version() { printf '1'; }
workspace_alloc_marker_kind() { printf 'oste.workspace-allocation'; }

# NOT `workspace.json`: that name collides with editor/build-tool files and a
# legacy worktree with an unrelated sibling of that name would silently flip
# gc from collect to preserve.
workspace_alloc_marker_filename() { printf 'oste-workspace-allocation.json'; }

workspace_alloc_entropy_bits() { printf '64'; }
_wsa_reclaim_min_age() { printf '%s' "${OSTE_WORKSPACE_RECLAIM_MIN_AGE_SECONDS:-900}"; }

# The supervised residual, stated once. ADR 0011 Decision 2 is NOT satisfied by
# a same-UID linked worktree; saying so in the receipt is the whole point.
_wsa_private_git_residual() {
	printf '%s' "supervised same-UID worktree: the canonical Git common directory is shared and the worker runs as the operator's UID with ordinary write access to canonical refs, index, and config. ADR 0011 Decision 2 is NOT satisfied; ADR 0012 Decision 3 names this an accepted residual of the supervised trust model. Does not advance hard production blocker #10."
}

# OSTE_WORKSPACE_ROOT exists for hermetic tests. Production callers never set
# it. Never /tmp: ADR 0010 §4 durability, ADR 0012 Decision 5 prohibition.
# Distinct from the runs journal root (…/ghostty-launcher/runs), which is
# append/CAS audit state; this is mutable execution state.
workspace_alloc_root() {
	local configured
	if [[ -n "${OSTE_WORKSPACE_ROOT:-}" ]]; then
		configured="$OSTE_WORKSPACE_ROOT"
	else
		configured="${XDG_STATE_HOME:-${HOME}/.local/state}/ghostty-launcher/workspaces"
	fi
	# Normalize when it exists so every comparison is physical; fall back to the
	# best-effort form so a read-only caller (gc) never has to create anything.
	_wsa_normalize_best_effort "$configured" || printf '%s' "$configured"
}

_wsa_journal_root_default() {
	printf '%s' "${XDG_STATE_HOME:-${HOME}/.local/state}/ghostty-launcher/runs"
}

_wsa_tasks_file() {
	printf '%s' "${TASKS_FILE:-${HOME}/.config/ghostty-launcher/tasks.json}"
}

# ── Small primitives ─────────────────────────────────────────────────

_wsa_now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
_wsa_lc() { LC_ALL=C tr '[:upper:]' '[:lower:]'; }

# `realpath` is absent on stock macOS; `cd … && pwd -P` is the primitive
# oste-gc.sh's is_git_worktree already uses, and matching it keeps the two
# files' notion of directory identity identical.
_wsa_normalize() {
	local p="${1:-}"
	[[ -n "$p" ]] || return 1
	(cd "$p" 2>/dev/null && pwd -P) || return 1
}

_wsa_nearest_existing_dir() {
	local p="${1:-}"
	[[ -n "$p" ]] || return 1
	while [[ ! -d "$p" ]]; do
		local parent
		parent=$(dirname "$p")
		[[ "$parent" != "$p" ]] || return 1
		p="$parent"
	done
	printf '%s' "$p"
}

# Physical form of a path whose leaf components may not exist yet: normalize
# the deepest existing ancestor and re-append the remainder verbatim.
_wsa_normalize_best_effort() {
	local p="${1:-}" head tail="" real
	[[ -n "$p" ]] || return 1
	head="$p"
	while [[ ! -d "$head" ]]; do
		local parent
		parent=$(dirname "$head")
		[[ "$parent" != "$head" ]] || return 1
		tail="$(basename "$head")${tail:+/${tail}}"
		head="$parent"
	done
	real=$(_wsa_normalize "$head") || return 1
	if [[ -n "$tail" ]]; then
		printf '%s/%s' "$real" "$tail"
	else
		printf '%s' "$real"
	fi
}

_wsa_dev_inode() {
	local p="${1:-}"
	[[ -n "$p" ]] || return 1
	stat -f '%d:%i' "$p" 2>/dev/null || stat -c '%d:%i' "$p" 2>/dev/null || return 1
}

# A SUCCESS here means the path lies inside a work tree. Used positively: the
# Launcher state root must be outside every repository, or one allocation
# leaves the canonical checkout dirty and the clean-tree gate then refuses
# every future spawn in that project.
_wsa_dir_is_inside_repo() {
	local dir="${1:-}"
	[[ -n "$dir" && -d "$dir" ]] || return 1
	git -C "$dir" rev-parse --show-toplevel >/dev/null 2>&1
}

_wsa_is_absolute() { [[ "${1:-}" == /* ]]; }

# Number of path components of $2 below $1 ("" when $2 is not under $1).
_wsa_components_below() {
	local base="${1:-}" path="${2:-}" rest
	[[ -n "$base" && -n "$path" ]] || return 1
	[[ "$path" == "$base"/* ]] || return 1
	rest="${path#"$base"/}"
	printf '%s' "$(awk -F/ '{print NF}' <<<"$rest")"
}

_wsa_diag() { printf 'workspace-alloc: %s\n' "$*" >&2; }

# ── Marker access ────────────────────────────────────────────────────

workspace_alloc_marker_path_for_execution_dir() {
	local exec_dir="${1:-}" exec_real
	exec_real=$(_wsa_normalize "$exec_dir") || return 1
	printf '%s/%s' "$(dirname "$exec_real")" "$(workspace_alloc_marker_filename)"
}

_wsa_marker_path_for_leaf() {
	printf '%s/%s' "${1:-}" "$(workspace_alloc_marker_filename)"
}

_wsa_marker_field() {
	local marker="${1:-}" filter="${2:-}"
	jq -r "$filter" "$marker" 2>/dev/null || return 1
}

# Ours, and a version we understand. Anything else: every reader preserves and
# refuses to act.
_wsa_marker_is_ours() {
	local marker="${1:-}" kind version
	[[ -n "$marker" && -f "$marker" && -r "$marker" ]] || return 1
	jq -e . "$marker" >/dev/null 2>&1 || return 1
	kind=$(_wsa_marker_field "$marker" '.kind // ""') || return 1
	version=$(_wsa_marker_field "$marker" '.schema_version // ""') || return 1
	[[ "$kind" == "$(workspace_alloc_marker_kind)" ]] || return 1
	[[ "$version" == "$(workspace_alloc_schema_version)" ]]
}

# tmp-file + rename(2) inside the leaf. Atomic within one filesystem, which
# holds by construction because the allocator created the leaf. Atomicity, not
# power-loss durability — bash has no fsync.
_wsa_marker_write() {
	local marker="${1:-}" json="${2:-}" dir tmp
	[[ -n "$marker" && -n "$json" ]] || return 1
	dir=$(dirname "$marker")
	[[ -d "$dir" ]] || return 1
	tmp=$(mktemp "${dir}/.oste-workspace-marker.tmp.XXXXXX") || return 1
	if printf '%s\n' "$json" | jq -S -c . >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
		mv "$tmp" "$marker" && return 0
	fi
	rm -f "$tmp"
	return 1
}

_wsa_marker_update() {
	local marker="${1:-}" filter="${2:-}"
	shift 2
	local updated
	[[ -f "$marker" ]] || return 1
	updated=$(jq -c "$@" "$filter" "$marker" 2>/dev/null) || return 1
	[[ -n "$updated" && "$updated" != "null" ]] || return 1
	_wsa_marker_write "$marker" "$updated"
}

# ── The ONLY removal primitive in this library ───────────────────────
#
# One literal `rm -rf --` with a single unglobbed argument. No trailing `/*`,
# no `$(dirname …)`, no glob, no `find`, no loop over a parent directory.
# Callers must have proven ownership before calling; this function only
# re-asserts the two properties a typo would break.
_wsa_rm_rf_owned() {
	local target="${1:-}"
	[[ -n "$target" ]] || return 1
	_wsa_is_absolute "$target" || return 1
	rm -rf -- "$target"
}

# ── Cleanup: the single teardown path ────────────────────────────────
#
# INV-C1 empty ownership removes nothing. INV-C3 re-verification. INV-C4
# ordered git teardown (`remove -f -f`, verified, no blanket prune). INV-C5 the
# only canonical-repo mutations are our own admin entry and our own ref.
# INV-C6 no sibling enumeration.
#
# Reads the per-call ownership record its caller declared `local`.
# Sets _WSA_LAST_CLEANUP ∈ {none, removed_own_workspace, refused_manual}.
_wsa_remove_owned_leaf() {
	local expected_call_id="${1:-}" reason="${2:-}"
	_WSA_LAST_CLEANUP="none"
	_WSA_LAST_CLEANUP_DETAIL=""

	# INV-C1: a caller that never won the exclusive mkdir owns nothing.
	if [[ -z "$_WSA_OWNED_LEAF" ]]; then
		return 0
	fi

	# Per-call token: a removal may only act for the call that established
	# ownership, never for a value another call left behind.
	if [[ -z "$expected_call_id" || "$expected_call_id" != "$_WSA_OWNED_CALL_ID" ]]; then
		_WSA_LAST_CLEANUP="refused_manual"
		_WSA_LAST_CLEANUP_DETAIL="cleanup_refused: ownership token mismatch for ${_WSA_OWNED_LEAF}"
		_wsa_diag "cleanup_refused (${reason}): ownership token mismatch for ${_WSA_OWNED_LEAF}"
		return 1
	fi

	# INV-C3: every one of these is required before anything is removed.
	local components current_ident
	if ! _wsa_is_absolute "$_WSA_OWNED_LEAF" ||
		[[ -z "$_WSA_OWNED_ROOT" ]] ||
		[[ "$_WSA_OWNED_LEAF" != "$_WSA_OWNED_ROOT"/* ]] ||
		[[ ! -d "$_WSA_OWNED_LEAF" ]]; then
		_WSA_LAST_CLEANUP="refused_manual"
		_WSA_LAST_CLEANUP_DETAIL="cleanup_refused: leaf failed structural re-verification: ${_WSA_OWNED_LEAF}"
		_wsa_diag "cleanup_refused (${reason}): leaf failed structural re-verification: ${_WSA_OWNED_LEAF}"
		return 1
	fi
	components=$(_wsa_components_below "$_WSA_OWNED_ROOT" "$_WSA_OWNED_LEAF" || printf '0')
	if [[ ! "$components" =~ ^[0-9]+$ ]] || ((components < 3)); then
		_WSA_LAST_CLEANUP="refused_manual"
		_WSA_LAST_CLEANUP_DETAIL="cleanup_refused: leaf is not three components below the workspace root: ${_WSA_OWNED_LEAF}"
		_wsa_diag "cleanup_refused (${reason}): leaf is not three components below the workspace root: ${_WSA_OWNED_LEAF}"
		return 1
	fi
	current_ident=$(_wsa_dev_inode "$_WSA_OWNED_LEAF" || printf '')
	if [[ -z "$_WSA_OWNED_IDENT" || "$current_ident" != "$_WSA_OWNED_IDENT" ]]; then
		_WSA_LAST_CLEANUP="refused_manual"
		_WSA_LAST_CLEANUP_DETAIL="cleanup_refused: leaf device:inode changed since it was created (${_WSA_OWNED_IDENT} -> ${current_ident}): ${_WSA_OWNED_LEAF}"
		_wsa_diag "cleanup_refused (${reason}): leaf device:inode changed since it was created (${_WSA_OWNED_IDENT} -> ${current_ident}): ${_WSA_OWNED_LEAF}"
		return 1
	fi

	local manual=""

	# INV-C4 step 1: unlock, rc CAPTURED not swallowed. `unlock` fails in
	# exactly the crash-partial window this teardown exists for (the tree
	# directory is already gone), which is why the removal below needs -f -f
	# rather than relying on the unlock having worked.
	if [[ -n "$_WSA_OWNED_CANONICAL" && -n "$_WSA_OWNED_TREE" && -d "$_WSA_OWNED_CANONICAL" ]]; then
		local unlock_err unlock_rc=0
		unlock_err=$(git -C "$_WSA_OWNED_CANONICAL" worktree unlock -- "$_WSA_OWNED_TREE" 2>&1) || unlock_rc=$?
		if ((unlock_rc != 0)); then
			_wsa_diag "worktree unlock rc=${unlock_rc} (not fatal, 'remove --force --force' subsumes it): ${unlock_err}"
		fi

		# INV-C4 step 2: --force --force is REQUIRED. A single --force fails
		# rc 128 on a locked worktree ("use 'remove -f -f' to override").
		local remove_err remove_rc=0
		remove_err=$(git -C "$_WSA_OWNED_CANONICAL" worktree remove --force --force -- "$_WSA_OWNED_TREE" 2>&1) || remove_rc=$?
		if ((remove_rc != 0)); then
			_wsa_diag "worktree remove rc=${remove_rc}: ${remove_err}"
		fi

		# A removal whose success is inferred from an exit code and never
		# checked is the class of claim the fleet policy forbids: re-verify.
		if git -C "$_WSA_OWNED_CANONICAL" worktree list --porcelain 2>/dev/null |
			LC_ALL=C grep -Fxq "worktree ${_WSA_OWNED_TREE}"; then
			manual="worktree list still names ${_WSA_OWNED_TREE}"
		fi

		# INV-C4 step 3, replacing the struck blanket `git worktree prune`:
		# remove OUR admin entry and nothing else, and only when its gitdir
		# still points into our leaf. A repo-wide prune would delete another
		# lane's entry whose volume is merely unmounted.
		if [[ -n "$_WSA_OWNED_ADMIN_DIR" && -d "$_WSA_OWNED_ADMIN_DIR" ]]; then
			local admin_gitdir=""
			[[ -f "${_WSA_OWNED_ADMIN_DIR}/gitdir" ]] && admin_gitdir=$(<"${_WSA_OWNED_ADMIN_DIR}/gitdir")
			admin_gitdir="${admin_gitdir%$'\n'}"
			if [[ "$admin_gitdir" == "$_WSA_OWNED_LEAF"/* ]]; then
				_wsa_rm_rf_owned "$_WSA_OWNED_ADMIN_DIR" || true
			else
				manual="${manual:+${manual}; }admin entry ${_WSA_OWNED_ADMIN_DIR} does not point into ${_WSA_OWNED_LEAF}"
			fi
		fi

		# Branch deletion ONLY when nothing was committed, and the decision and
		# the deletion must be ONE operation.
		#
		# A read-then-delete pair is a TOCTOU: another actor can advance the ref
		# between the compare and the `update-ref -d`, and an unguarded delete
		# then destroys a commit that the guard was written to protect
		# (reproduced: the advanced commit became `unreachable` in `git fsck`).
		# `git update-ref -d <ref> <expected-old-sha>` is git's own
		# compare-and-delete: it deletes only while the ref still equals the
		# expected value and fails closed otherwise. The tip read below is a
		# cheap pre-check that produces the informative "tip moved" message; it
		# is NEVER the authority for the deletion, and the expected-old-sha
		# argument is not optional.
		if [[ -n "$_WSA_OWNED_BRANCH" ]]; then
			local branch_ref="refs/heads/${_WSA_OWNED_BRANCH}"
			local branch_tip=""
			branch_tip=$(git -C "$_WSA_OWNED_CANONICAL" rev-parse --verify --quiet "$branch_ref" 2>/dev/null || printf '')
			if [[ -z "$branch_tip" ]]; then
				: # no ref to dispose of
			elif [[ -z "$_WSA_OWNED_START_SHA" || "$branch_tip" != "$_WSA_OWNED_START_SHA" ]]; then
				manual="${manual:+${manual}; }branch ${branch_ref} tip moved past the base commit and was kept"
			else
				local del_err del_rc=0
				del_err=$(git -C "$_WSA_OWNED_CANONICAL" update-ref -d "$branch_ref" "$_WSA_OWNED_START_SHA" 2>&1) || del_rc=$?
				if ((del_rc != 0)); then
					# The ref advanced inside the compare/delete window. The
					# branch is RETAINED and the disposition is the operator's.
					_wsa_diag "compare-and-delete refused for ${branch_ref} (rc=${del_rc}): ${del_err}"
					manual="${manual:+${manual}; }branch ${branch_ref} advanced during teardown and was kept (compare-and-delete refused: ${del_err})"
				elif git -C "$_WSA_OWNED_CANONICAL" show-ref --verify --quiet "$branch_ref"; then
					manual="${manual:+${manual}; }branch ${branch_ref} still exists after a successful compare-and-delete"
				fi
			fi
		fi
	fi

	_wsa_rm_rf_owned "$_WSA_OWNED_LEAF" || {
		_WSA_LAST_CLEANUP="refused_manual"
		_WSA_LAST_CLEANUP_DETAIL="cleanup_refused: removal of ${_WSA_OWNED_LEAF} failed"
		_wsa_diag "cleanup_refused (${reason}): removal of ${_WSA_OWNED_LEAF} failed"
		return 1
	}

	_WSA_LAST_CLEANUP="removed_own_workspace"
	if [[ -n "$manual" ]]; then
		_WSA_LAST_CLEANUP_DETAIL="manual_disposition_required: ${manual}"
		_wsa_diag "manual_disposition_required (${reason}): ${manual}"
	fi
	return 0
}

# ── Derivations (side-effect free) ───────────────────────────────────

# 16 hex = exactly 64 bits, ADR 0008 Decision 2's floor. printf '%s\0%s' so
# (a,bc) and (ab,c) cannot collide.
workspace_alloc_suffix() {
	local task_id="${1:-}" allocation_id="${2:-}" digest
	[[ -n "$task_id" && -n "$allocation_id" ]] || return 1
	digest=$(printf '%s\0%s' "$task_id" "$allocation_id" | shasum -a 256 | awk '{print substr($1,1,16)}') || return 1
	[[ "$digest" =~ ^[0-9a-f]{16}$ ]] || return 1
	printf '%s' "$digest"
}

# One leaf ref component: nesting the suffix would make
# refs/heads/oste/supervised/<issue> a directory and permanently block a future
# branch of that exact name.
workspace_alloc_branch_name() {
	local work_item_ref="${1:-}" task_id="${2:-}" allocation_id="${3:-}"
	local issue_raw issue_component suffix
	[[ -n "$work_item_ref" ]] || return 1
	suffix=$(workspace_alloc_suffix "$task_id" "$allocation_id") || return 1
	issue_raw="${work_item_ref##*:}"
	[[ -n "$issue_raw" ]] || issue_raw="$work_item_ref"
	issue_component=$(task_id_slug_component "$issue_raw")
	# The shared slug helper truncates AFTER stripping, so a 48-char cut can
	# land on a separator. Re-strip so the branch stays a clean function of the
	# issue key.
	issue_component=$(printf '%s' "$issue_component" | LC_ALL=C sed -E 's/[._-]+$//')
	[[ -n "$issue_component" ]] || return 1
	printf 'oste/supervised/%s-%s' "$issue_component" "$suffix"
}

# leaf, tree, marker — three lines, no side effects.
workspace_alloc_paths() {
	local task_id="${1:-}" allocation_id="${2:-}" canonical="${3:-}"
	local root slug base suffix leaf
	task_id_validate "$task_id" >/dev/null 2>&1 || return 1
	suffix=$(workspace_alloc_suffix "$task_id" "$allocation_id") || return 1
	root=$(workspace_alloc_root) || return 1
	base=$(_wsa_normalize "$canonical" 2>/dev/null || printf '%s' "$canonical")
	slug=$(task_id_slug_component "$(basename "$base")")
	leaf="${root}/${slug}/${task_id}/${suffix}"
	printf '%s\n%s\n%s\n' "$leaf" "${leaf}/tree" "${leaf}/$(workspace_alloc_marker_filename)"
}

# uuidgen when present, else a real 256-bit /dev/urandom draw. NEVER
# task_generation_new(): its sha256 fallback digests date/$$/$RANDOM/$RANDOM,
# roughly 30-46 bits of preimage entropy — below ADR 0008 Decision 2's floor —
# and a 64-hex shape gate cannot tell that preimage from a real one.
# Prints "<allocation_id> <source>".
_wsa_mint_allocation_id() {
	local id=""
	if command -v uuidgen >/dev/null 2>&1; then
		id=$(uuidgen 2>/dev/null | _wsa_lc)
		if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
			printf '%s uuidgen' "$id"
			return 0
		fi
	fi
	id=$(LC_ALL=C od -An -tx1 -N32 /dev/urandom | tr -d ' \n') || return 1
	[[ "$id" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s urandom' "$id"
}

_wsa_allocation_id_shape_ok() {
	local id="${1:-}"
	[[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && return 0
	[[ "$id" =~ ^[0-9a-f]{64}$ ]]
}

# ── JSON envelopes ───────────────────────────────────────────────────

_wsa_emit_refusal() {
	local outcome="${1:-}" cleanup="${2:-none}" diagnostic="${3:-}"
	local task_id="${4:-}" allocation_id="${5:-}"
	[[ -n "$diagnostic" ]] && _wsa_diag "${outcome}: ${diagnostic}"
	jq -n \
		--argjson schema_version "$(workspace_alloc_schema_version)" \
		--arg outcome "$outcome" \
		--arg cleanup "$cleanup" \
		--arg diagnostic "$diagnostic" \
		--arg task_id "$task_id" \
		--arg allocation_id "$allocation_id" \
		'{schema_version: $schema_version,
		  operation: "allocate",
		  outcome: $outcome,
		  posture: "supervised",
		  task_id: $task_id,
		  allocation_id: (if $allocation_id == "" then null else $allocation_id end),
		  cleanup: $cleanup,
		  diagnostic: $diagnostic}'
	return 2
}

# ── S0 gates ─────────────────────────────────────────────────────────

# Rejects the literal `unknown` sentinel the clean-tree gate writes when
# `git log -1` fails, plus uppercase hex, abbreviated SHAs, refs, HEAD, and
# any ^/~ suffix.
_wsa_start_sha_shape_ok() {
	local sha="${1:-}"
	[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
}

# ── workspace_alloc_create ───────────────────────────────────────────

# Wrapper: the single funnel that restores the caller's umask on EVERY exit.
# A `trap … RETURN` is forbidden here — this library is sourced into callers
# that install their own RETURN traps, and clobbering one is a side effect.
workspace_alloc_create() {
	local _wsa_saved_umask rc=0
	local _WSA_OWNED_CALL_ID="" _WSA_OWNED_LEAF="" _WSA_OWNED_IDENT="" _WSA_OWNED_ROOT=""
	local _WSA_OWNED_CANONICAL="" _WSA_OWNED_TREE="" _WSA_OWNED_BRANCH=""
	local _WSA_OWNED_START_SHA="" _WSA_OWNED_ADMIN_DIR=""
	_wsa_saved_umask=$(umask)
	umask 077
	_wsa_create_inner "$@" || rc=$?
	umask "$_wsa_saved_umask"
	return "$rc"
}

_wsa_fault_at() {
	local point="${1:-}" configured="${OSTE_WORKSPACE_ALLOC_FAULT:-}"
	[[ -n "$configured" ]] || return 1
	# Ignored entirely outside test mode.
	[[ "${OSTE_TEST_MODE:-}" == "1" ]] || return 1
	[[ "$configured" == "$point" ]]
}

_wsa_fault_name_known() {
	case "${1:-}" in
		after_leaf_mkdir | after_marker | after_worktree_add | before_marker_allocated | after_emit) return 0 ;;
		*) return 1 ;;
	esac
}

_wsa_create_inner() {
	local task_id="" allocation_id="" allocation_id_supplied=0 canonical="" start_sha=""
	local work_item_ref="" workroom_ref="" node="" posture="" journal_root=""

	while (($# > 0)); do
		case "${1:-}" in
			--task-id)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--task-id requires a value"
					return 2
				}
				task_id="$2"
				shift 2
				;;
			--allocation-id)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--allocation-id requires a value"
					return 2
				}
				allocation_id="$2"
				allocation_id_supplied=1
				shift 2
				;;
			--canonical-project-dir)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--canonical-project-dir requires a value"
					return 2
				}
				canonical="$2"
				shift 2
				;;
			--start-sha)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--start-sha requires a value"
					return 2
				}
				start_sha="$2"
				shift 2
				;;
			--work-item-ref)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--work-item-ref requires a value"
					return 2
				}
				work_item_ref="$2"
				shift 2
				;;
			--workroom-ref)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--workroom-ref requires a value"
					return 2
				}
				workroom_ref="$2"
				shift 2
				;;
			--node)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--node requires a value"
					return 2
				}
				node="$2"
				shift 2
				;;
			--posture)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--posture requires a value"
					return 2
				}
				posture="$2"
				shift 2
				;;
			--journal-root)
				[[ $# -ge 2 ]] || {
					_wsa_emit_refusal invalid_arguments none "--journal-root requires a value"
					return 2
				}
				journal_root="$2"
				shift 2
				;;
			*)
				_wsa_emit_refusal invalid_arguments none "unknown argument: ${1:-}"
				return 2
				;;
		esac
	done

	# Fault-injection hygiene: an unknown fault name is a hard error, and the
	# variable is ignored entirely without test mode.
	if [[ -n "${OSTE_WORKSPACE_ALLOC_FAULT:-}" && "${OSTE_TEST_MODE:-}" == "1" ]] &&
		! _wsa_fault_name_known "$OSTE_WORKSPACE_ALLOC_FAULT"; then
		_wsa_diag "unknown OSTE_WORKSPACE_ALLOC_FAULT: ${OSTE_WORKSPACE_ALLOC_FAULT}"
		return 1
	fi

	local missing=""
	[[ -n "$task_id" ]] || missing="--task-id"
	[[ -n "$canonical" ]] || missing="${missing:---canonical-project-dir}"
	[[ -n "$start_sha" ]] || missing="${missing:---start-sha}"
	[[ -n "$node" ]] || missing="${missing:---node}"
	[[ -n "$posture" ]] || missing="${missing:---posture}"
	if [[ -n "$missing" ]]; then
		_wsa_emit_refusal invalid_arguments none "missing required flag: ${missing}" "$task_id"
		return 2
	fi
	if [[ -z "$work_item_ref" ]]; then
		_wsa_emit_refusal missing_work_item_ref none "--work-item-ref is required and must be non-empty" "$task_id"
		return 2
	fi
	if [[ -z "$workroom_ref" ]]; then
		_wsa_emit_refusal missing_workroom_ref none "--workroom-ref is required and must be non-empty" "$task_id"
		return 2
	fi
	if ! task_id_validate "$task_id" 2>/dev/null; then
		_wsa_emit_refusal invalid_task_id none "task id does not match the canonical grammar: ${task_id}"
		return 2
	fi
	# Protected posture allocates through the daemon per unamended ADR 0011 D1.
	if [[ "$posture" != "supervised" ]]; then
		_wsa_emit_refusal posture_unsupported none "only the supervised posture allocates here; received: ${posture}" "$task_id"
		return 2
	fi

	local allocation_id_source=""
	if ((allocation_id_supplied == 1)); then
		# Determinism tests only. A production caller cannot inject a
		# low-entropy id.
		if [[ "${OSTE_TEST_MODE:-}" != "1" ]]; then
			_wsa_emit_refusal invalid_allocation_id none "--allocation-id is accepted only under OSTE_TEST_MODE=1" "$task_id"
			return 2
		fi
		if ! _wsa_allocation_id_shape_ok "$allocation_id"; then
			_wsa_emit_refusal invalid_allocation_id none "allocation id is neither a lowercase UUIDv4 nor 64 hex characters: ${allocation_id}" "$task_id"
			return 2
		fi
		allocation_id_source="supplied"
	else
		local minted
		minted=$(_wsa_mint_allocation_id) || {
			_wsa_diag "could not mint an allocation id"
			return 1
		}
		allocation_id="${minted%% *}"
		allocation_id_source="${minted##* }"
	fi

	# The diagnostic prints the received value verbatim so an `unknown`
	# sentinel is visible, never "invalid SHA" alone.
	if ! _wsa_start_sha_shape_ok "$start_sha"; then
		_wsa_emit_refusal invalid_start_sha none "start sha is not 40 lowercase hex characters; received: ${start_sha}" "$task_id" "$allocation_id"
		return 2
	fi

	# ── canonical checkout identity ──────────────────────────────────
	local canonical_real toplevel toplevel_real git_dir common_dir
	if [[ ! -d "$canonical" ]] || ! canonical_real=$(_wsa_normalize "$canonical"); then
		_wsa_emit_refusal canonical_dir_missing none "canonical project dir does not exist: ${canonical}" "$task_id" "$allocation_id"
		return 2
	fi
	if [[ "$canonical_real" == "/" ]]; then
		_wsa_emit_refusal canonical_not_repo_root none "canonical project dir resolves to / which is never a supported checkout" "$task_id" "$allocation_id"
		return 2
	fi
	if ! toplevel=$(git -C "$canonical_real" rev-parse --show-toplevel 2>/dev/null) ||
		! toplevel_real=$(_wsa_normalize "$toplevel"); then
		_wsa_emit_refusal canonical_not_git none "canonical project dir is not inside a git work tree: ${canonical_real}" "$task_id" "$allocation_id"
		return 2
	fi
	if [[ "$canonical_real" != "$toplevel_real" ]]; then
		_wsa_emit_refusal canonical_not_repo_root none "canonical project dir is not the work tree root (toplevel: ${toplevel_real})" "$task_id" "$allocation_id"
		return 2
	fi
	# `toplevel == canonical_real` does NOT prove "main checkout": a LINKED
	# worktree passes it. This is the exact inverse of oste-gc.sh's
	# is_git_worktree, deliberately: one predicate read in two directions.
	git_dir=$(cd "$canonical_real" && cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P) || git_dir=""
	common_dir=$(cd "$canonical_real" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || common_dir=""
	if [[ -z "$git_dir" || -z "$common_dir" || "$git_dir" != "$common_dir" ]]; then
		_wsa_emit_refusal canonical_not_main_worktree none "canonical project dir is a linked worktree, not the main checkout (git-dir ${git_dir}, common-dir ${common_dir})" "$task_id" "$allocation_id"
		return 2
	fi

	# Supervised posture wants an ordinary full checkout. In a shallow clone
	# history-derived claims are meaningless; in a promisor clone the base
	# proof would be a network fetch rather than a local fact.
	local is_shallow promisor
	is_shallow=$(git -C "$canonical_real" rev-parse --is-shallow-repository 2>/dev/null || printf 'false')
	promisor=$(git -C "$canonical_real" config --get-regexp '^remote\..*\.promisor$' 2>/dev/null || printf '')
	if [[ "$is_shallow" == "true" || -n "$promisor" ]]; then
		_wsa_emit_refusal canonical_repo_unsupported none "canonical repository is shallow or partial (shallow=${is_shallow}); the base commit cannot be proven local" "$task_id" "$allocation_id"
		return 2
	fi

	# ── base-commit proof, BEFORE anything is created ────────────────
	# GIT_NO_LAZY_FETCH=1: a missing object must be a refusal, never a
	# download.
	if ! GIT_NO_LAZY_FETCH=1 git -C "$canonical_real" cat-file -e "${start_sha}^{commit}" 2>/dev/null; then
		_wsa_emit_refusal base_commit_absent none "base commit is not present in the canonical repository: ${start_sha}" "$task_id" "$allocation_id"
		return 2
	fi
	local resolved
	resolved=$(GIT_NO_LAZY_FETCH=1 git -C "$canonical_real" rev-parse --verify --quiet "${start_sha}^{commit}" 2>/dev/null || printf '')
	if [[ "$resolved" != "$start_sha" ]]; then
		# A 40-hex string naming a tag object peels to a different commit; the
		# pre-worker ref must BE the commit.
		_wsa_emit_refusal base_commit_not_a_commit none "start sha peels to a different commit (${start_sha} -> ${resolved:-<none>}); the pre-worker ref must be the commit itself" "$task_id" "$allocation_id"
		return 2
	fi
	# base_verified means "object exists and is a commit". base_reachable is the
	# separate, weaker claim. Never conflate the two.
	local base_reachable="false"
	if GIT_NO_LAZY_FETCH=1 git -C "$canonical_real" for-each-ref --contains "$start_sha" \
		--format='%(refname)' refs/heads refs/tags refs/remotes 2>/dev/null | grep -q .; then
		base_reachable="true"
	fi

	# ── derived names ────────────────────────────────────────────────
	local suffix branch
	suffix=$(workspace_alloc_suffix "$task_id" "$allocation_id") || {
		_wsa_diag "could not derive the collision suffix"
		return 1
	}
	if ! branch=$(workspace_alloc_branch_name "$work_item_ref" "$task_id" "$allocation_id") ||
		[[ -z "$branch" ]] ||
		! git check-ref-format --branch "$branch" >/dev/null 2>&1 ||
		((${#branch} > 180)); then
		_wsa_emit_refusal branch_name_invalid none "derived branch name is not a valid ref: ${branch:-<empty>}" "$task_id" "$allocation_id"
		return 2
	fi

	# ── workspace paths + canonical inequality (tests 1-3) ───────────
	local root_cfg root_pre slug leaf tree marker
	root_cfg=$(workspace_alloc_root) || {
		_wsa_diag "could not resolve the workspace root"
		return 1
	}
	root_pre="$root_cfg"
	if [[ "$root_pre" == "/" ]]; then
		_wsa_emit_refusal state_root_unusable none "workspace root resolves to /" "$task_id" "$allocation_id"
		return 2
	fi
	slug=$(task_id_slug_component "$(basename "$canonical_real")")
	leaf="${root_pre}/${slug}/${task_id}/${suffix}"
	tree="${leaf}/tree"
	if ! _wsa_check_inequality "$tree" "$canonical_real" "$task_id" "$allocation_id"; then
		return 2
	fi

	# ── branch collision ─────────────────────────────────────────────
	# `show-ref --verify` has a case-fold blind spot that flips with
	# pack-refs (loose refs are looked up through the filesystem; packed-refs
	# is compared case-sensitively), so pair it with a case-folded scan.
	if git -C "$canonical_real" show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null ||
		git -C "$canonical_real" for-each-ref --format='%(refname)' refs/heads 2>/dev/null |
		LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C grep -Fxq "refs/heads/${branch}"; then
		_wsa_emit_refusal branch_exists none "branch already exists and is never reused or reset: refs/heads/${branch}" "$task_id" "$allocation_id"
		return 2
	fi

	# ── the state root must lie outside every git repository ─────────
	# A worktree created inside the canonical checkout succeeds silently and
	# leaves that checkout dirty, which then makes the clean-tree gate refuse
	# every future spawn there: one bad allocation bricks the project.
	local probe
	probe=$(_wsa_nearest_existing_dir "$root_pre" || printf '')
	if [[ -n "$probe" ]] && _wsa_dir_is_inside_repo "$probe"; then
		_wsa_emit_refusal workspace_root_inside_repo none "workspace root lies inside a git work tree (${probe}); allocation would dirty that checkout" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S1: shared, idempotent, never removed ────────────────────────
	local root_real
	if ! mkdir -p "$root_pre" 2>/dev/null || ! root_real=$(_wsa_normalize "$root_pre"); then
		_wsa_emit_refusal state_root_unusable none "could not create or resolve the workspace root: ${root_pre}" "$task_id" "$allocation_id"
		return 2
	fi
	if [[ "$root_real" == "/" ]]; then
		_wsa_emit_refusal state_root_unusable none "workspace root resolves to /" "$task_id" "$allocation_id"
		return 2
	fi
	# Re-derive against the authoritative physical root and re-run the
	# inequality tests: the pre-S1 pass used a best-effort normalization.
	leaf="${root_real}/${slug}/${task_id}/${suffix}"
	tree="${leaf}/tree"
	marker=$(_wsa_marker_path_for_leaf "$leaf")
	if ! _wsa_check_inequality "$tree" "$canonical_real" "$task_id" "$allocation_id"; then
		return 2
	fi
	if _wsa_dir_is_inside_repo "$root_real"; then
		_wsa_emit_refusal workspace_root_inside_repo none "workspace root lies inside a git work tree: ${root_real}" "$task_id" "$allocation_id"
		return 2
	fi
	if ! mkdir -p "${root_real}/${slug}/${task_id}" 2>/dev/null; then
		_wsa_emit_refusal state_root_unusable none "could not create the per-task workspace parent: ${root_real}/${slug}/${task_id}" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S2: exclusive mkdir — the ownership moment ───────────────────
	if ! mkdir "$leaf" 2>/dev/null; then
		if [[ -d "$leaf" ]]; then
			# The loser owns nothing and therefore tears down nothing.
			_wsa_emit_refusal workspace_path_exists none "workspace path already exists and is never reused: ${leaf}" "$task_id" "$allocation_id"
			return 2
		fi
		_wsa_emit_refusal state_root_unusable none "could not create the workspace leaf: ${leaf}" "$task_id" "$allocation_id"
		return 2
	fi
	_WSA_OWNED_CALL_ID="${allocation_id}:${BASHPID:-$$}:$(date -u +%s%N 2>/dev/null || date -u +%s)"
	_WSA_OWNED_LEAF="$leaf"
	_WSA_OWNED_IDENT=$(_wsa_dev_inode "$leaf" || printf '')
	_WSA_OWNED_ROOT="$root_real"
	_WSA_OWNED_CANONICAL="$canonical_real"
	_WSA_OWNED_TREE="$tree"
	_WSA_OWNED_BRANCH="$branch"
	_WSA_OWNED_START_SHA="$start_sha"
	_WSA_OWNED_ADMIN_DIR=""

	if _wsa_dir_is_inside_repo "$leaf"; then
		_wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "workspace_root_inside_repo" || true
		_wsa_emit_refusal workspace_root_inside_repo "$_WSA_LAST_CLEANUP" "workspace leaf lies inside a git work tree: ${leaf}" "$task_id" "$allocation_id"
		return 2
	fi

	if _wsa_fault_at after_leaf_mkdir; then
		_wsa_emit_refusal fault_injected none "fault injected at after_leaf_mkdir" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S3: marker, state=allocating ─────────────────────────────────
	local allocated_at journal_root_effective marker_json
	allocated_at=$(_wsa_now_iso)
	journal_root_effective="${journal_root:-$(_wsa_journal_root_default)}"
	marker_json=$(jq -n \
		--argjson schema_version "$(workspace_alloc_schema_version)" \
		--arg kind "$(workspace_alloc_marker_kind)" \
		--arg task_id "$task_id" \
		--arg allocation_id "$allocation_id" \
		--arg allocation_id_source "$allocation_id_source" \
		--arg work_item_ref "$work_item_ref" \
		--arg workroom_ref "$workroom_ref" \
		--arg node "$node" \
		--arg canonical "$canonical_real" \
		--arg tree "$tree" \
		--arg leaf "$leaf" \
		--arg branch "$branch" \
		--arg start_sha "$start_sha" \
		--argjson base_reachable "$base_reachable" \
		--arg suffix "$suffix" \
		--argjson entropy_bits "$(workspace_alloc_entropy_bits)" \
		--arg allocated_at "$allocated_at" \
		'{schema_version: $schema_version,
		  kind: $kind,
		  posture: "supervised",
		  state: "allocating",
		  disposition: "held",
		  task_id: $task_id,
		  allocation_id: $allocation_id,
		  allocation_id_source: $allocation_id_source,
		  task_generation: null,
		  binding_anomaly: false,
		  binding_anomaly_reason: null,
		  binding_anomaly_at: null,
		  work_item_ref: $work_item_ref,
		  workroom_ref: $workroom_ref,
		  node: $node,
		  issue_scheduler: "symphony",
		  canonical_project_dir: $canonical,
		  execution_dir: $tree,
		  workspace_root: $leaf,
		  worktree_admin_dir: null,
		  branch: $branch,
		  start_sha: $start_sha,
		  base_reachable: $base_reachable,
		  collision_suffix: $suffix,
		  entropy_bits: $entropy_bits,
		  allocated_at: $allocated_at,
		  registered_at: null,
		  released_at: null,
		  released_by: null,
		  release_reason: null}') || {
		_wsa_diag "could not build the allocation marker"
		return 1
	}
	if ! _wsa_marker_write "$marker" "$marker_json"; then
		_wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "marker_write_failed" || true
		_wsa_emit_refusal postcondition_failed "$_WSA_LAST_CLEANUP" "could not write the allocation marker: ${marker}" "$task_id" "$allocation_id"
		return 2
	fi

	if _wsa_fault_at after_marker; then
		_wsa_emit_refusal fault_injected none "fault injected at after_marker" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S4: the worktree ─────────────────────────────────────────────
	# -b never -B (-B resets an existing branch: silent destruction of another
	# lane's ref). --no-track so no upstream is ever configured. --lock is
	# defense in depth BEHIND the explicit gc gate, never a substitute for it.
	# `--` so a path beginning with `-` cannot become a flag.
	local add_err add_rc=0
	add_err=$(git -C "$canonical_real" worktree add \
		--quiet \
		-b "$branch" \
		--no-track \
		--lock --reason "supervised allocation ${task_id}/${allocation_id}; owner disposition required" \
		-- "$tree" "$start_sha" 2>&1) || add_rc=$?
	if ((add_rc != 0)); then
		_wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "worktree_add_failed" || true
		_wsa_emit_refusal worktree_add_failed "$_WSA_LAST_CLEANUP" "git worktree add rc=${add_rc}: ${add_err}" "$task_id" "$allocation_id"
		return 2
	fi

	if _wsa_fault_at after_worktree_add; then
		_wsa_emit_refusal fault_injected none "fault injected at after_worktree_add" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S5: post-conditions ──────────────────────────────────────────
	local head_sha tree_branch tree_toplevel tree_git_dir tree_common_dir porcelain
	local fail=""
	head_sha=$(git -C "$tree" rev-parse --verify HEAD 2>/dev/null || printf '')
	[[ "$head_sha" == "$start_sha" ]] || fail="worktree HEAD is ${head_sha:-<none>}, expected ${start_sha}"
	if [[ -z "$fail" ]]; then
		tree_branch=$(git -C "$tree" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '')
		[[ "$tree_branch" == "$branch" ]] || fail="worktree branch is ${tree_branch:-<none>}, expected ${branch}"
	fi
	if [[ -z "$fail" ]]; then
		porcelain=$(git -C "$tree" status --porcelain 2>/dev/null || printf 'unknown')
		[[ -z "$porcelain" ]] || fail="fresh worktree is not clean: ${porcelain}"
	fi
	if [[ -z "$fail" ]]; then
		# Test 4: the only check that catches two textually distinct paths
		# reaching one directory (firmlinks, bind-style mounts, a symlinked
		# parent pwd -P resolved differently on each side).
		local tree_ident canonical_ident
		tree_ident=$(_wsa_dev_inode "$tree" || printf 'tree-unknown')
		canonical_ident=$(_wsa_dev_inode "$canonical_real" || printf 'canonical-unknown')
		[[ "$tree_ident" != "$canonical_ident" ]] || fail="execution dir and canonical checkout are the same directory (device:inode ${tree_ident})"
	fi
	if [[ -z "$fail" ]]; then
		# Test 5: prove we created a LINKED worktree, not a nested checkout.
		tree_git_dir=$(cd "$tree" && cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P) || tree_git_dir=""
		tree_common_dir=$(cd "$tree" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || tree_common_dir=""
		tree_toplevel=$(git -C "$tree" rev-parse --show-toplevel 2>/dev/null || printf '')
		tree_toplevel=$(_wsa_normalize "$tree_toplevel" 2>/dev/null || printf '')
		if [[ -z "$tree_git_dir" || -z "$tree_common_dir" || "$tree_git_dir" == "$tree_common_dir" ]]; then
			fail="allocated dir is not a linked worktree (git-dir ${tree_git_dir}, common-dir ${tree_common_dir})"
		elif [[ "$tree_toplevel" != "$tree" ]]; then
			fail="allocated dir is not the worktree root (toplevel ${tree_toplevel})"
		fi
	fi
	if [[ -n "$fail" ]]; then
		_wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "postcondition_failed" || true
		_wsa_emit_refusal postcondition_failed "$_WSA_LAST_CLEANUP" "$fail" "$task_id" "$allocation_id"
		return 2
	fi

	if _wsa_fault_at before_marker_allocated; then
		_wsa_emit_refusal fault_injected none "fault injected at before_marker_allocated" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S6: resolve the admin entry, then marker -> allocated ────────
	# git names the admin entry after the BASENAME of the target path, which is
	# `tree` for every allocation, with a numeric suffix on collision. It is
	# therefore NOT derivable from (task_id, allocation_id) and must be
	# resolved by matching gitdir contents, once, here — so teardown targets it
	# exactly instead of enumerating at cleanup time.
	local admin_dir="" candidate gitdir_contents
	if [[ -d "${common_dir}/worktrees" ]]; then
		for candidate in "${common_dir}"/worktrees/*; do
			[[ -d "$candidate" && -f "${candidate}/gitdir" ]] || continue
			gitdir_contents=$(<"${candidate}/gitdir")
			gitdir_contents="${gitdir_contents%$'\n'}"
			if [[ "$gitdir_contents" == "${tree}/.git" ]]; then
				admin_dir=$(_wsa_normalize "$candidate" 2>/dev/null || printf '%s' "$candidate")
				break
			fi
		done
	fi
	_WSA_OWNED_ADMIN_DIR="$admin_dir"
	if ! _wsa_marker_update "$marker" '.state = "allocated" | .worktree_admin_dir = (if $admin == "" then null else $admin end)' --arg admin "$admin_dir"; then
		_wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "marker_update_failed" || true
		_wsa_emit_refusal postcondition_failed "$_WSA_LAST_CLEANUP" "could not promote the marker to state=allocated" "$task_id" "$allocation_id"
		return 2
	fi

	# ── S7: the allocation record ────────────────────────────────────
	jq -n \
		--argjson schema_version "$(workspace_alloc_schema_version)" \
		--arg task_id "$task_id" \
		--arg allocation_id "$allocation_id" \
		--arg canonical "$canonical_real" \
		--arg tree "$tree" \
		--arg leaf "$leaf" \
		--arg marker "$marker" \
		--arg branch "$branch" \
		--arg start_sha "$start_sha" \
		--argjson base_reachable "$base_reachable" \
		--arg suffix "$suffix" \
		--argjson entropy_bits "$(workspace_alloc_entropy_bits)" \
		--arg work_item_ref "$work_item_ref" \
		--arg workroom_ref "$workroom_ref" \
		--arg node "$node" \
		--arg journal_root "$journal_root_effective" \
		--arg admin_dir "$admin_dir" \
		--arg residual "$(_wsa_private_git_residual)" \
		--arg allocated_at "$allocated_at" \
		'{schema_version: $schema_version,
		  operation: "allocate",
		  outcome: "allocated",
		  posture: "supervised",
		  task_id: $task_id,
		  allocation_id: $allocation_id,
		  task_generation: null,
		  canonical_project_dir: $canonical,
		  execution_dir: $tree,
		  workspace_root: $leaf,
		  workspace_marker_path: $marker,
		  worktree_admin_dir: (if $admin_dir == "" then null else $admin_dir end),
		  branch: $branch,
		  start_sha: $start_sha,
		  base_verified: true,
		  base_reachable: $base_reachable,
		  collision_suffix: $suffix,
		  entropy_bits: $entropy_bits,
		  work_item_ref: $work_item_ref,
		  workroom_ref: $workroom_ref,
		  node: $node,
		  issue_scheduler: "symphony",
		  writable_roots: [$leaf, $journal_root],
		  writable_roots_enforced: false,
		  excluded_roots: [$canonical],
		  excluded_roots_enforced: false,
		  excluded_refs: ["refs/heads/main"],
		  excluded_refs_enforced: false,
		  posture_recorded_in_task_row: false,
		  private_git: {mode: "shared_common_dir",
		                identity: null,
		                digest: null,
		                contained: false,
		                residual: $residual},
		  conventions: {no_push: "operator_inspected",
		                no_canonical_main_mutation: "operator_inspected"},
		  enforced_refusals: [
		    "execution_dir != canonical_project_dir (exact, case-folded, containment, inode)",
		    "start_sha is 40-hex and proven present as a commit in the canonical repository before creation",
		    "branch collision suffix carries >= 64 bits of hash entropy",
		    "existing workspace path or branch refuses; never reuses"
		  ],
		  cleanup: "none",
		  allocated_at: $allocated_at}' || {
		_wsa_diag "could not emit the allocation record"
		return 1
	}

	# after_emit models "the allocator returned and the caller then died": the
	# library has nothing further to do, so the fault point is a no-op that
	# exists to be a valid, asserted name.
	return 0
}

# §3.2 tests 1-3. Zero residue by construction: this runs before S2.
_wsa_check_inequality() {
	local tree="${1:-}" canonical_real="${2:-}" task_id="${3:-}" allocation_id="${4:-}"
	local tree_lc canonical_lc
	tree_lc=$(printf '%s' "$tree" | _wsa_lc)
	canonical_lc=$(printf '%s' "$canonical_real" | _wsa_lc)

	if [[ "$tree" == "$canonical_real" || "$tree_lc" == "$canonical_lc" ]]; then
		# The fold is applied unconditionally rather than probing volume
		# case-sensitivity: on a case-sensitive volume the only cost is
		# refusing a pair of genuinely distinct case-variant paths, which is
		# fail-closed and which our own deterministic root can never produce.
		_wsa_emit_refusal execution_equals_canonical none "execution dir equals the canonical checkout: ${tree}" "$task_id" "$allocation_id"
		return 1
	fi
	# The trailing `/` in each pattern is load-bearing: without it `/repo-2`
	# matches prefix `/repo`.
	if [[ "$tree" == "$canonical_real"/* || "$tree_lc" == "$canonical_lc"/* ]]; then
		_wsa_emit_refusal execution_inside_canonical none "execution dir lies inside the canonical checkout: ${tree}" "$task_id" "$allocation_id"
		return 1
	fi
	if [[ "$canonical_real" == "$tree"/* || "$canonical_lc" == "$tree_lc"/* ]]; then
		_wsa_emit_refusal canonical_inside_execution none "canonical checkout lies inside the execution dir: ${canonical_real}" "$task_id" "$allocation_id"
		return 1
	fi
	return 0
}

# ── Marker state transitions ─────────────────────────────────────────

# S9: bind the REGISTERED task generation into the marker. The allocator mints
# allocation_id (the generation is minted inside the spawn writer at
# registration and cannot be pre-supplied); the two identifiers are both
# recorded and neither is invented.
# The Launcher mints exactly one task generation per registration, with
# `task_generation_new()` (task-id.sh:74-84): a lowercase UUIDv4, or a 64-hex
# sha256 when `uuidgen` is absent. Those two shapes are the whole grammar. The
# marker is a fencing token for `dispose`, so binding a string the Launcher
# could not have minted would make the fence uncomparable — validate before
# binding, never after.
_wsa_generation_shape_ok() {
	task_generation_is_valid "${1:-}"
}

# S9 binding, as an idempotent compare-and-set — never a blind write.
#
# The façade can lose the spawn acknowledgement and retry, so an exact replay
# (same leaf, same task, same generation) must be SUCCESS with no rewrite: a
# refusal there would turn a recoverable lost ack into a permanently uncertain
# launch. A DIFFERENT generation for an already-bound marker is the opposite
# case — two mints for one workspace — and is a binding anomaly: it is recorded
# through `workspace_alloc_mark_binding_anomaly`, the bound generation is never
# overwritten, and the workspace is preserved (a workspace with a durable row is
# retained; an anomaly is a reason to refuse the launch as uncertain, never a
# reason to delete).
workspace_alloc_mark_registered() {
	local leaf="${1:-}" task_id="${2:-}" task_generation="${3:-}" marker marker_task_id state bound
	if [[ -z "$leaf" || -z "$task_id" || -z "$task_generation" ]]; then
		_wsa_diag "mark_registered requires <leaf> <task_id> <task_generation>"
		return 2
	fi
	if ! _wsa_generation_shape_ok "$task_generation"; then
		_wsa_diag "invalid_task_generation: mark_registered refused: '${task_generation}' is not a Launcher-minted task generation (lowercase UUIDv4 or 64-hex)"
		return 2
	fi
	marker=$(_wsa_marker_path_for_leaf "$leaf")
	if [[ ! -f "$marker" ]]; then
		_wsa_diag "mark_registered refused: no allocation marker at ${marker}"
		return 2
	fi
	if ! _wsa_marker_is_ours "$marker"; then
		_wsa_diag "mark_registered refused: foreign or unknown-version marker at ${marker}"
		return 2
	fi
	marker_task_id=$(_wsa_marker_field "$marker" '.task_id // ""')
	if [[ "$marker_task_id" != "$task_id" ]]; then
		# The caller handed us another task's allocation. Refuse WITHOUT
		# writing: recording an anomaly here would mutate a marker this call
		# has no claim to.
		_wsa_diag "mark_registered refused: marker task_id ${marker_task_id} != ${task_id}"
		return 2
	fi
	state=$(_wsa_marker_field "$marker" '.state // ""')

	if [[ "$state" == "registered" ]]; then
		bound=$(_wsa_marker_field "$marker" '.task_generation // ""')
		if [[ "$bound" == "$task_generation" ]]; then
			# Exact replay: already true, so there is nothing to write. The
			# marker is left byte-identical on purpose — a rewrite would move
			# `registered_at` and make a retry indistinguishable from a rebind.
			return 0
		fi
		_wsa_diag "binding_anomaly: mark_registered refused to rebind ${marker}: generation ${bound} is already bound, ${task_generation} was offered"
		if ! workspace_alloc_mark_binding_anomaly "$leaf" \
			"mark_registered offered task_generation ${task_generation} for a workspace already bound to ${bound}"; then
			_wsa_diag "mark_registered could not record the binding anomaly at ${marker}"
			return 1
		fi
		return 2
	fi

	if [[ "$state" != "allocated" ]]; then
		_wsa_diag "mark_registered refused: marker state is ${state}, expected allocated"
		return 2
	fi

	# CAS: bind only while the marker still says `allocated` with no generation.
	if ! _wsa_marker_update "$marker" \
		'if (.state == "allocated") and ((.task_generation // null) == null) then .state = "registered" | .task_generation = $gen | .registered_at = $now else empty end' \
		--arg gen "$task_generation" --arg now "$(_wsa_now_iso)"; then
		_wsa_diag "mark_registered failed to write ${marker} (the marker changed under the binding, or the write failed)"
		return 1
	fi
	return 0
}

# R-18: record that the post-registration binding verification disagreed with
# the authoritative row. Additive marker state only — it never changes `state`
# or `disposition`, because a workspace with a row is RETAINED and the anomaly
# is a reason to refuse the launch as uncertain, never a reason to delete.
# Refuses (never overwrites) when the marker is missing or foreign.
workspace_alloc_mark_binding_anomaly() {
	local leaf="${1:-}" reason="${2:-}" marker
	if [[ -z "$leaf" || -z "$reason" ]]; then
		_wsa_diag "mark_binding_anomaly requires <leaf> <reason>"
		return 2
	fi
	marker=$(_wsa_marker_path_for_leaf "$leaf")
	if [[ ! -f "$marker" ]]; then
		_wsa_diag "mark_binding_anomaly refused: no allocation marker at ${marker}"
		return 2
	fi
	if ! _wsa_marker_is_ours "$marker"; then
		_wsa_diag "mark_binding_anomaly refused: foreign or unknown-version marker at ${marker}"
		return 2
	fi
	if ! _wsa_marker_update "$marker" '.binding_anomaly = true | .binding_anomaly_reason = $reason | .binding_anomaly_at = $now' \
		--arg reason "$reason" --arg now "$(_wsa_now_iso)"; then
		_wsa_diag "mark_binding_anomaly failed to write ${marker}"
		return 1
	fi
	return 0
}

# ── Pre-registration release (the S7↔S8 window) ──────────────────────

workspace_alloc_release_preregistration() {
	local rc=0
	local _WSA_OWNED_CALL_ID="" _WSA_OWNED_LEAF="" _WSA_OWNED_IDENT="" _WSA_OWNED_ROOT=""
	local _WSA_OWNED_CANONICAL="" _WSA_OWNED_TREE="" _WSA_OWNED_BRANCH=""
	local _WSA_OWNED_START_SHA="" _WSA_OWNED_ADMIN_DIR=""
	_wsa_release_preregistration_inner "$@" || rc=$?
	return "$rc"
}

_wsa_release_preregistration_inner() {
	local leaf="${1:-}" reason="${2:-unspecified}" marker state root_real leaf_real
	if [[ -z "$leaf" ]]; then
		_wsa_diag "release_preregistration requires <leaf> [reason]"
		return 2
	fi
	# Never accepts a bare path without a valid marker.
	if ! leaf_real=$(_wsa_normalize "$leaf"); then
		_wsa_diag "release_preregistration refused: leaf does not exist: ${leaf}"
		return 2
	fi
	marker=$(_wsa_marker_path_for_leaf "$leaf_real")
	if [[ ! -f "$marker" ]] || ! _wsa_marker_is_ours "$marker"; then
		_wsa_diag "release_preregistration refused: missing, unreadable, or foreign marker at ${marker}"
		return 2
	fi
	state=$(_wsa_marker_field "$marker" '.state // ""')
	if [[ "$state" == "registered" ]]; then
		_wsa_diag "release_refused_registered: ${leaf_real} has a durable task row; only an owner disposition may release it"
		return 2
	fi
	if [[ "$state" != "allocating" && "$state" != "allocated" ]]; then
		_wsa_diag "release_preregistration refused: unexpected marker state ${state}"
		return 2
	fi

	root_real=$(workspace_alloc_root)
	_WSA_OWNED_CALL_ID="release:${BASHPID:-$$}:$(date -u +%s%N 2>/dev/null || date -u +%s)"
	_WSA_OWNED_LEAF="$leaf_real"
	_WSA_OWNED_IDENT=$(_wsa_dev_inode "$leaf_real" || printf '')
	_WSA_OWNED_ROOT="$root_real"
	_WSA_OWNED_CANONICAL=$(_wsa_marker_field "$marker" '.canonical_project_dir // ""')
	_WSA_OWNED_TREE=$(_wsa_marker_field "$marker" '.execution_dir // ""')
	_WSA_OWNED_BRANCH=$(_wsa_marker_field "$marker" '.branch // ""')
	_WSA_OWNED_START_SHA=$(_wsa_marker_field "$marker" '.start_sha // ""')
	_WSA_OWNED_ADMIN_DIR=$(_wsa_marker_field "$marker" '.worktree_admin_dir // ""')

	if ! _wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "$reason"; then
		return 2
	fi
	return 0
}

# ── Owner disposition ────────────────────────────────────────────────

workspace_alloc_dispose() {
	local rc=0 leaf="${1:-}" lock=""
	local _WSA_OWNED_CALL_ID="" _WSA_OWNED_LEAF="" _WSA_OWNED_IDENT="" _WSA_OWNED_ROOT=""
	local _WSA_OWNED_CANONICAL="" _WSA_OWNED_TREE="" _WSA_OWNED_BRANCH=""
	local _WSA_OWNED_START_SHA="" _WSA_OWNED_ADMIN_DIR=""
	if [[ -z "$leaf" || ! -d "$leaf" ]]; then
		_wsa_diag "dispose requires an existing <leaf>"
		return 2
	fi
	lock="${leaf}/.dispose.lock"
	# Atomic. No stale-lock stealing: disposition is a one-shot operator act,
	# and a stuck lock is a directory an operator can see and remove.
	if ! mkdir "$lock" 2>/dev/null; then
		_wsa_diag "dispose_locked: ${lock} already exists"
		return 2
	fi
	_wsa_dispose_inner "$@" || rc=$?
	rmdir "$lock" 2>/dev/null || true
	return "$rc"
}

_wsa_dispose_inner() {
	local leaf="${1:-}"
	shift || true
	local expect_generation="" by="" reason=""
	while (($# > 0)); do
		case "${1:-}" in
			--expect-generation)
				expect_generation="${2:-}"
				shift 2
				;;
			--by)
				by="${2:-}"
				shift 2
				;;
			--reason)
				reason="${2:-}"
				shift 2
				;;
			*)
				_wsa_diag "dispose: unknown argument: ${1:-}"
				return 2
				;;
		esac
	done
	if [[ -z "$expect_generation" || -z "$by" || -z "$reason" ]]; then
		_wsa_diag "dispose requires --expect-generation, --by and --reason"
		return 2
	fi

	local leaf_real marker state disposition generation canonical tree
	leaf_real=$(_wsa_normalize "$leaf") || return 2
	marker=$(_wsa_marker_path_for_leaf "$leaf_real")
	if [[ ! -f "$marker" ]] || ! _wsa_marker_is_ours "$marker"; then
		_wsa_diag "dispose refused: missing, unreadable, or foreign marker at ${marker}"
		return 2
	fi
	state=$(_wsa_marker_field "$marker" '.state // ""')
	disposition=$(_wsa_marker_field "$marker" '.disposition // ""')
	generation=$(_wsa_marker_field "$marker" '.task_generation // ""')
	canonical=$(_wsa_marker_field "$marker" '.canonical_project_dir // ""')
	tree=$(_wsa_marker_field "$marker" '.execution_dir // ""')

	# Step 0 — late binding. A crash between registration and S9 leaves a
	# marker stuck at `allocated` with a null generation: dispose would refuse
	# (state + generation), reclaim would refuse (a row exists), and gc would
	# preserve — a workspace nothing sanctioned can release. This is a recovery
	# path, never a bypass: the operator still supplies --expect-generation and
	# it is still compared, only against a generation now sourced from the
	# registry rather than from a marker that never got written.
	if [[ "$state" == "allocated" && -z "$generation" ]]; then
		local tasks_file marker_task_id row_exec row_gen row_exec_norm tree_norm
		tasks_file=$(_wsa_tasks_file)
		marker_task_id=$(_wsa_marker_field "$marker" '.task_id // ""')
		if [[ ! -r "$tasks_file" ]]; then
			_wsa_diag "dispose_unbindable: task registry unreadable at ${tasks_file}"
			return 2
		fi
		row_exec=$(jq -r --arg id "$marker_task_id" '.tasks[$id].execution_dir // ""' "$tasks_file" 2>/dev/null || printf '')
		row_gen=$(jq -r --arg id "$marker_task_id" '.tasks[$id].task_generation // ""' "$tasks_file" 2>/dev/null || printf '')
		if [[ -z "$row_exec" || -z "$row_gen" ]]; then
			_wsa_diag "dispose_unbindable: no usable registry row for ${marker_task_id}"
			return 2
		fi
		row_exec_norm=$(_wsa_normalize "$row_exec" 2>/dev/null || printf '%s' "$row_exec")
		tree_norm=$(_wsa_normalize "$tree" 2>/dev/null || printf '%s' "$tree")
		if [[ "$row_exec_norm" != "$tree_norm" ]]; then
			_wsa_diag "dispose_unbindable: registry execution_dir ${row_exec_norm} does not match the marker's ${tree_norm}"
			return 2
		fi
		if ! _wsa_marker_update "$marker" '.state = "registered" | .task_generation = $gen | .registered_at = $now | .binding_anomaly = true | .binding_anomaly_reason = "late_binding_from_registry"' \
			--arg gen "$row_gen" --arg now "$(_wsa_now_iso)"; then
			_wsa_diag "dispose_unbindable: could not bind the registry generation into ${marker}"
			return 2
		fi
		state="registered"
		generation="$row_gen"
	fi

	if [[ "$disposition" == "released" ]]; then
		_wsa_diag "already_released: ${leaf_real}"
		return 0
	fi
	if [[ "$state" != "registered" ]]; then
		_wsa_diag "dispose refused: marker state is ${state}, expected registered"
		return 2
	fi
	if [[ "$generation" != "$expect_generation" ]]; then
		_wsa_diag "generation_mismatch: marker generation ${generation:-<null>} != --expect-generation ${expect_generation}"
		return 2
	fi

	# Unlock BEFORE the flip: a crash between the two leaves the marker `held`,
	# so gc still preserves — strictly fail-closed. The reverse order would
	# leave a released-but-locked worktree that gc tries and fails to remove,
	# producing a warning instead of a decision.
	if [[ -n "$canonical" && -d "$canonical" && -n "$tree" ]]; then
		local unlock_err unlock_rc=0
		unlock_err=$(git -C "$canonical" worktree unlock -- "$tree" 2>&1) || unlock_rc=$?
		if ((unlock_rc != 0)); then
			_wsa_diag "worktree unlock rc=${unlock_rc} during disposition: ${unlock_err}"
		fi
	fi
	if ! _wsa_marker_update "$marker" '.disposition = "released" | .released_at = $now | .released_by = $by | .release_reason = $reason' \
		--arg now "$(_wsa_now_iso)" --arg by "$by" --arg reason "$reason"; then
		_wsa_diag "dispose failed to write ${marker}"
		return 1
	fi
	return 0
}

# ── Out-of-band orphan sweep ─────────────────────────────────────────
#
# Explicitly invoked. NEVER called from workspace_alloc_create, from
# oste-gc.sh, or from any spawn path — an allocator that sweeps other
# allocations is exactly the collateral-damage class this library exists to
# prevent. Discovery enumerates (that is the verb's job); removal never does.
workspace_alloc_reclaim() {
	local rc=0
	local _WSA_OWNED_CALL_ID="" _WSA_OWNED_LEAF="" _WSA_OWNED_IDENT="" _WSA_OWNED_ROOT=""
	local _WSA_OWNED_CANONICAL="" _WSA_OWNED_TREE="" _WSA_OWNED_BRANCH=""
	local _WSA_OWNED_START_SHA="" _WSA_OWNED_ADMIN_DIR=""
	_wsa_reclaim_inner "$@" || rc=$?
	return "$rc"
}

_wsa_reclaim_inner() {
	local dry_run=false
	while (($# > 0)); do
		case "${1:-}" in
			--dry-run)
				dry_run=true
				shift
				;;
			*)
				_wsa_diag "reclaim: unknown argument: ${1:-}"
				return 2
				;;
		esac
	done

	# R7: a TASKS_FILE that is present and parseable but WRONG defeats R3's
	# fail-closed shape — every leaf would look unreferenced and reclaim would
	# delete live workspaces.
	if [[ -n "${TASKS_FILE:-}" && "${OSTE_TEST_MODE:-}" != "1" ]]; then
		_wsa_diag "reclaim_registry_ambiguous: TASKS_FILE is set in the environment; production reclaim resolves the registry itself"
		return 2
	fi
	local tasks_file
	tasks_file=$(_wsa_tasks_file)
	# R3 fail-closed: unknown ⇒ preserve, and "unknown" includes "no registry".
	if [[ ! -r "$tasks_file" ]] || ! jq -e . "$tasks_file" >/dev/null 2>&1; then
		_wsa_diag "reclaim refused: registry unavailable or unparseable at ${tasks_file}; nothing is reclaimable while the second source is unknown"
		return 2
	fi

	local root_real
	root_real=$(_wsa_normalize "$(workspace_alloc_root)" 2>/dev/null || printf '')
	if [[ -z "$root_real" || ! -d "$root_real" ]]; then
		printf 'reclaim: no workspace root at %s\n' "$(workspace_alloc_root)"
		return 0
	fi

	local now leaf
	now=$(date -u +%s)
	while IFS= read -r leaf; do
		[[ -n "$leaf" ]] || continue
		_wsa_reclaim_one "$leaf" "$root_real" "$tasks_file" "$now" "$dry_run"
	done < <(find "$root_real" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | sort)
	return 0
}

_wsa_reclaim_one() {
	local leaf="${1:-}" root_real="${2:-}" tasks_file="${3:-}" now="${4:-0}" dry_run="${5:-false}"
	local marker state disposition allocated_at allocated_epoch age tree start_sha referenced

	marker=$(_wsa_marker_path_for_leaf "$leaf")
	# R1
	if [[ ! -f "$marker" ]]; then
		# A markerless leaf is the S2↔S3 residue. It is reclaimable only when
		# it is empty of everything else — otherwise we cannot prove ownership.
		if [[ -z "$(find "$leaf" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]] &&
			((now - $(_wsa_dir_mtime_epoch "$leaf") >= $(_wsa_reclaim_min_age))); then
			_wsa_reclaim_remove "$leaf" "$root_real" "" "" "" "" "" "$dry_run"
			return 0
		fi
		printf 'KEPT %s rule=R1 (no allocation marker)\n' "$leaf"
		return 0
	fi
	if ! _wsa_marker_is_ours "$marker"; then
		printf 'KEPT %s rule=R1 (foreign or unknown-version marker)\n' "$leaf"
		return 0
	fi
	state=$(_wsa_marker_field "$marker" '.state // ""')
	if [[ "$state" == "registered" ]]; then
		printf 'KEPT %s rule=R1 (state=registered)\n' "$leaf"
		return 0
	fi
	disposition=$(_wsa_marker_field "$marker" '.disposition // ""')
	tree=$(_wsa_marker_field "$marker" '.execution_dir // ""')
	start_sha=$(_wsa_marker_field "$marker" '.start_sha // ""')

	# R3: best-effort second source, read WITHOUT the registry lock (taking it
	# would make this library a control surface). What makes it safe is R4: a
	# row appearing 900+ seconds after allocated_at for a workspace whose
	# marker never reached `registered` is pathological.
	referenced=$(jq -r --arg t "$tree" \
		'[.tasks[]? | select((.execution_dir // "") == $t or (.exec_cwd // "") == $t or (.project_dir // "") == $t)] | length' \
		"$tasks_file" 2>/dev/null || printf '1')
	if [[ "$referenced" != "0" ]]; then
		printf 'KEPT %s rule=R3 (a task row references %s)\n' "$leaf" "$tree"
		return 0
	fi

	# R4
	allocated_at=$(_wsa_marker_field "$marker" '.allocated_at // ""')
	allocated_epoch=$(_wsa_epoch_from_iso "$allocated_at" || printf '')
	if [[ -z "$allocated_epoch" ]]; then
		printf 'KEPT %s rule=R4 (unparseable allocated_at)\n' "$leaf"
		return 0
	fi
	age=$((now - allocated_epoch))
	if ((age < $(_wsa_reclaim_min_age))); then
		printf 'KEPT %s rule=R4 (allocated %ss ago)\n' "$leaf" "$age"
		return 0
	fi

	# R5
	if [[ -n "$tree" && -d "$tree" ]]; then
		local porcelain head
		porcelain=$(git -C "$tree" status --porcelain 2>/dev/null || printf 'unknown')
		if [[ -n "$porcelain" ]]; then
			printf 'KEPT %s rule=R5 (uncommitted work in %s)\n' "$leaf" "$tree"
			return 0
		fi
		head=$(git -C "$tree" rev-parse --verify HEAD 2>/dev/null || printf '')
		if [[ "$head" != "$start_sha" ]]; then
			printf 'KEPT %s rule=R5 (tip moved past the base commit)\n' "$leaf"
			return 0
		fi
	fi

	if [[ "$disposition" == "released" ]]; then
		printf 'KEPT %s rule=R2 (released registered workspaces are gc business, not reclaim)\n' "$leaf"
		return 0
	fi

	_wsa_reclaim_remove "$leaf" "$root_real" \
		"$(_wsa_marker_field "$marker" '.canonical_project_dir // ""')" \
		"$tree" \
		"$(_wsa_marker_field "$marker" '.branch // ""')" \
		"$start_sha" \
		"$(_wsa_marker_field "$marker" '.worktree_admin_dir // ""')" \
		"$dry_run"
}

_wsa_reclaim_remove() {
	local leaf="${1:-}" root_real="${2:-}" canonical="${3:-}" tree="${4:-}"
	local branch="${5:-}" start_sha="${6:-}" admin_dir="${7:-}" dry_run="${8:-false}"
	if [[ "$dry_run" == "true" ]]; then
		printf 'WOULD RECLAIM %s\n' "$leaf"
		return 0
	fi
	_WSA_OWNED_CALL_ID="reclaim:${BASHPID:-$$}:$(date -u +%s%N 2>/dev/null || date -u +%s)"
	_WSA_OWNED_LEAF="$leaf"
	_WSA_OWNED_IDENT=$(_wsa_dev_inode "$leaf" || printf '')
	_WSA_OWNED_ROOT="$root_real"
	_WSA_OWNED_CANONICAL="$canonical"
	_WSA_OWNED_TREE="$tree"
	_WSA_OWNED_BRANCH="$branch"
	_WSA_OWNED_START_SHA="$start_sha"
	_WSA_OWNED_ADMIN_DIR="$admin_dir"
	if _wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "reclaim"; then
		printf 'RECLAIMED %s\n' "$leaf"
	else
		printf 'KEPT %s rule=R6 (%s)\n' "$leaf" "${_WSA_LAST_CLEANUP_DETAIL:-cleanup refused}"
	fi
	_WSA_OWNED_CALL_ID=""
	_WSA_OWNED_LEAF=""
	_WSA_OWNED_IDENT=""
}

_wsa_epoch_from_iso() {
	local ts="${1:-}"
	[[ -n "$ts" && "$ts" != "null" ]] || return 1
	date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null ||
		date -u -d "$ts" +%s 2>/dev/null ||
		return 1
}

_wsa_dir_mtime_epoch() {
	local p="${1:-}"
	stat -f '%m' "$p" 2>/dev/null || stat -c '%Y' "$p" 2>/dev/null || printf '0'
}

# ── The gc gate ──────────────────────────────────────────────────────
#
# rc 0 = MAY collect, rc 1 = MUST preserve.
#
# Supervised-posture workspaces (ADR 0012 D1/D3) are retained until an owner
# explicitly disposes of them. The marker is authority; anything unreadable,
# unknown-version, or identity-mismatched preserves. Marker-ABSENT is the
# fail-open branch, so it is scoped: only a worktree OUTSIDE the Launcher
# workspace root may take it.
workspace_alloc_gc_allows_collection() {
	local exec_dir="${1:-}" task_id="${2:-}"
	local exec_real marker root_real under_root=false
	local kind version marker_task_id marker_exec disposition released_at

	# A failed normalization preserves; it never collects.
	exec_real=$(_wsa_normalize "$exec_dir") || return 1
	# `dirname` the command, on a normalized path: `${p%/*}` on `/a/b/tree/`
	# yields `/a/b/tree`, which is wrong.
	marker="$(dirname "$exec_real")/$(workspace_alloc_marker_filename)"

	root_real=$(_wsa_normalize "$(workspace_alloc_root)" 2>/dev/null || printf '')
	if [[ -n "$root_real" && "$exec_real" == "$root_real"/* ]]; then
		under_root=true
	fi

	if [[ ! -f "$marker" || ! -r "$marker" ]]; then
		if [[ "$under_root" == true ]]; then
			echo "WARN supervised workspace root without a valid marker: ${exec_real}" >&2
			return 1
		fi
		# Not a supervised workspace: legacy/daemon worktrees are unaffected.
		return 0
	fi
	if ! jq -e . "$marker" >/dev/null 2>&1; then
		[[ "$under_root" == true ]] && echo "WARN supervised workspace root without a valid marker: ${exec_real}" >&2
		return 1
	fi
	kind=$(_wsa_marker_field "$marker" '.kind // ""')
	version=$(_wsa_marker_field "$marker" '.schema_version // ""')
	if [[ "$kind" != "$(workspace_alloc_marker_kind)" || "$version" != "$(workspace_alloc_schema_version)" ]]; then
		# An unknown future marker preserves.
		return 1
	fi
	marker_task_id=$(_wsa_marker_field "$marker" '.task_id // ""')
	if [[ -n "$task_id" && "$marker_task_id" != "$task_id" ]]; then
		echo "WARN mismatched workspace marker: ${marker} names task ${marker_task_id}, row is ${task_id}" >&2
		return 1
	fi
	marker_exec=$(_wsa_marker_field "$marker" '.execution_dir // ""')
	marker_exec=$(_wsa_normalize "$marker_exec" 2>/dev/null || printf '%s' "$marker_exec")
	if [[ "$marker_exec" != "$exec_real" ]]; then
		echo "WARN mismatched workspace marker: ${marker} names ${marker_exec}, row is ${exec_real}" >&2
		return 1
	fi
	disposition=$(_wsa_marker_field "$marker" '.disposition // ""')
	released_at=$(_wsa_marker_field "$marker" '.released_at // ""')
	if [[ "$disposition" == "released" && -n "$released_at" && "$released_at" != "null" ]]; then
		return 0
	fi
	return 1
}

# After gc removed the worktree, the leaf still holds the marker and an emptied
# mount point. Without this, released allocations accumulate marker-only leaves
# forever. Residue is preferable to collateral loss: anything unproven returns 0
# without removing.
workspace_alloc_gc_finalize() {
	local rc=0
	local _WSA_OWNED_CALL_ID="" _WSA_OWNED_LEAF="" _WSA_OWNED_IDENT="" _WSA_OWNED_ROOT=""
	local _WSA_OWNED_CANONICAL="" _WSA_OWNED_TREE="" _WSA_OWNED_BRANCH=""
	local _WSA_OWNED_START_SHA="" _WSA_OWNED_ADMIN_DIR=""
	_wsa_gc_finalize_inner "$@" || rc=$?
	return "$rc"
}

_wsa_gc_finalize_inner() {
	local exec_dir="${1:-}" leaf marker root_real disposition marker_exec
	[[ -n "$exec_dir" ]] || return 0
	leaf=$(_wsa_normalize "$(dirname "$exec_dir")" 2>/dev/null || printf '')
	[[ -n "$leaf" ]] || return 0
	marker=$(_wsa_marker_path_for_leaf "$leaf")
	[[ -f "$marker" ]] || return 0
	_wsa_marker_is_ours "$marker" || return 0
	disposition=$(_wsa_marker_field "$marker" '.disposition // ""')
	[[ "$disposition" == "released" ]] || return 0
	marker_exec=$(_wsa_marker_field "$marker" '.execution_dir // ""')
	# The tree must be gone: a leaf whose worktree still exists is never
	# finalized.
	[[ -n "$marker_exec" && ! -e "$marker_exec" ]] || return 0

	root_real=$(_wsa_normalize "$(workspace_alloc_root)" 2>/dev/null || printf '')
	[[ -n "$root_real" ]] || return 0
	_WSA_OWNED_CALL_ID="finalize:${BASHPID:-$$}:$(date -u +%s%N 2>/dev/null || date -u +%s)"
	_WSA_OWNED_LEAF="$leaf"
	_WSA_OWNED_IDENT=$(_wsa_dev_inode "$leaf" || printf '')
	_WSA_OWNED_ROOT="$root_real"
	# The worktree is already gone; there is nothing to unlock or remove on the
	# git side beyond the admin entry the marker recorded.
	_WSA_OWNED_CANONICAL=$(_wsa_marker_field "$marker" '.canonical_project_dir // ""')
	_WSA_OWNED_TREE="$marker_exec"
	_WSA_OWNED_BRANCH=""
	_WSA_OWNED_START_SHA=""
	_WSA_OWNED_ADMIN_DIR=$(_wsa_marker_field "$marker" '.worktree_admin_dir // ""')
	_wsa_remove_owned_leaf "$_WSA_OWNED_CALL_ID" "gc_finalize" || return 0
	return 0
}
