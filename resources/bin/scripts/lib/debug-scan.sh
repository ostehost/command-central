#!/bin/bash
# debug-scan.sh — shared comment-aware debug-statement scanner.
#
# Single pattern source for BOTH git-hook debug gates (.githooks/pre-commit
# and .githooks/pre-push): detection and the printed diagnostics come from
# the same function over the same patterns, so a hook can never block on a
# line it does not show — and a fix to the patterns can never reach only one
# gate.
#
# Contract
#   debug_scan_file <path|-> [label] [extra_ere]
#     Reads file content from <path>, or from stdin when <path> is "-"
#     (pre-commit feeds staged blob content via `git show :<file>`). <label>
#     (default: <path>) prefixes each reported hit.
#   debug_scan_files [--extra <ere>] <path>...
#     Scans each path with debug_scan_file; rc 1 if ANY file hit.
#
#   Comment stripping: lines whose first non-whitespace character is '#'
#   (full-line comments) and blank lines are dropped BEFORE matching, so a
#   comment that merely mentions a forbidden construct never blocks (the
#   oste-runner.sh safety-comment regression).
#   The REMAINING lines are matched against the forbidden classes:
#     - executable xtrace enablement: the `set` builtin followed by a flag
#       group containing `x` (plain, or combined as in `-xe`/`-ex`/`-euxo`)
#       or by `-o xtrace`. Word-boundary on the left, so `unset`/`dataset`
#       never match; leading indentation and compound statements
#       (`true; ...`) DO match.
#     - a `DEBUG`-tagged echo line.
#   Optional extra class: pass a third argument (or --extra) with an ERE to
#   OR in one more class. pre-commit passes DEBUG_SCAN_CONSOLE_LOG_ERE so its
#   staged-file gate keeps its historical console-log parity; pre-push keeps
#   the two default classes only.
#
#   Output: one `label:line:content` per hit, with ORIGINAL line numbers
#   (stripped lines still advance the count).
#   Exit status: 0 clean, 1 when any hit was reported.
#
# Residual lexical limitations — DELIBERATE. This is a line-lexical scanner,
# not a shell parser. Pinned as KNOWN verdicts by test/test-debug-scan.sh:
#   - Inline TRAILING comments are NOT stripped: forbidden text after a `#`
#     on a code line still hits (false positive); only full-line comments
#     are dropped.
#   - Quoted strings are not parsed: a string literal spelling a forbidden
#     construct hits (false positive).
#   - Heredoc bodies are scanned as ordinary lines: forbidden text inside a
#     heredoc hits (false positive), and a heredoc body line starting with
#     '#' is dropped like a comment (false negative).
#
# The pattern constants are assembled from string fragments so this file's
# own lines never contain the forbidden byte sequences: this library lives
# in scripts/lib/, inside the tree the pre-push gate scans.

# ── Pattern constants (the single source of truth) ───────────────────

# Left word boundary (start of line or a non-word char) keeps `unset`,
# `dataset`, function names and the like from matching.
_DEBUG_SCAN_LWB='(^|[^[:alnum:]_])'

# Executable xtrace: a flag group containing x, or `-o xtrace`.
DEBUG_SCAN_XTRACE_ERE="${_DEBUG_SCAN_LWB}"'s''et[[:space:]]+(-[[:alpha:]]*x|-o[[:space:]]+xtrace)'

# DEBUG-tagged echo lines.
DEBUG_SCAN_ECHO_DEBUG_ERE='ec''ho.*DE''BUG'

# Optional console-log class (pre-commit parity; not a pre-push class).
# shellcheck disable=SC2034  # consumed by sourcing hooks, not in this file
DEBUG_SCAN_CONSOLE_LOG_ERE='conso''le[.]log'

DEBUG_SCAN_DEFAULT_ERE="(${DEBUG_SCAN_XTRACE_ERE})|(${DEBUG_SCAN_ECHO_DEBUG_ERE})"

# One awk program serves detection AND diagnostics: it prints every hit and
# encodes the verdict in its exit status, so the two can never disagree.
_DEBUG_SCAN_AWK='
{
	if ($0 ~ /^[[:space:]]*#/) next
	if ($0 ~ /^[[:space:]]*$/) next
	if ($0 ~ pat) {
		printf "%s:%d:%s\n", label, NR, $0
		hits = 1
	}
}
END { exit hits ? 1 : 0 }
'

# debug_scan_file <path|-> [label] [extra_ere]
debug_scan_file() {
	local path="$1"
	local label="${2:-$1}"
	local extra="${3:-}"
	local pattern="$DEBUG_SCAN_DEFAULT_ERE"
	if [[ -n "$extra" ]]; then
		pattern="${pattern}|(${extra})"
	fi
	if [[ "$path" == "-" ]]; then
		LC_ALL=C awk -v label="$label" -v pat="$pattern" "$_DEBUG_SCAN_AWK"
	else
		LC_ALL=C awk -v label="$label" -v pat="$pattern" "$_DEBUG_SCAN_AWK" "$path"
	fi
}

# debug_scan_files [--extra <ere>] <path>...
debug_scan_files() {
	local extra=""
	if [[ "${1:-}" == "--extra" ]]; then
		extra="${2:-}"
		shift 2
	fi
	local rc=0 path
	for path in "$@"; do
		debug_scan_file "$path" "$path" "$extra" || rc=1
	done
	return "$rc"
}
