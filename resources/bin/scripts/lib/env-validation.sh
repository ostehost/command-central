#!/bin/bash
#
# env-validation.sh — shared env-var normalization for oste-* tuning knobs.
#
# Numeric tuning knobs (poll intervals, graceful-wait seconds) are read from the
# environment so tests can override them. An invalid or non-positive override is
# unsafe in production: interval 0 busy-loops, a negative value skips the wait
# entirely, and non-numeric text makes `sleep` abort the script. These helpers
# fail closed to the production default for any such value (warning to stderr),
# while letting every valid positive value pass through unchanged. Production
# defaults are never altered. Pick the variant by how the knob is consumed:
#   normalize_positive_number   — `sleep`-consumed knobs; allows decimals (0.1).
#   normalize_positive_integer  — arithmetic-consumed knobs ($(( ))); integer
#                                 only (a decimal or leading-zero value aborts
#                                 shell arithmetic under set -e).

# Guard against double-sourcing (these are pure function defs; a guard keeps
# repeated in-function sourcing — e.g. from reaper.sh — cheap).
[[ -n "${_ENV_VALIDATION_SH_LOADED:-}" ]] && return 0
readonly _ENV_VALIDATION_SH_LOADED=1

# normalize_positive_number <raw> <default> <name>
#   Echoes <raw> when it is a strictly positive number (integer or decimal),
#   otherwise echoes <default>. A non-empty invalid value also warns to stderr,
#   naming the offending variable; an empty <raw> (an unset/blank override) falls
#   back silently.
normalize_positive_number() {
	local raw="$1" default="$2" name="$3"
	if [ -z "$raw" ]; then
		printf '%s' "$default"
		return 0
	fi
	# Reject anything that is not digits with at most one dot (no signs, no
	# whitespace, no letters, no lone/multiple dots). The >0 awk check below then
	# rejects all-zero values (0, 0.0, .0) that pass this format gate.
	case "$raw" in
		'.' | *.*.* | *[!0-9.]*)
			_normalize_positive_reject "$raw" "$default" "$name"
			return 0
			;;
	esac
	if awk -v v="$raw" 'BEGIN { exit (v + 0 > 0) ? 0 : 1 }'; then
		printf '%s' "$raw"
	else
		_normalize_positive_reject "$raw" "$default" "$name"
	fi
}

# normalize_positive_integer <raw> <default> <name>
#   Like normalize_positive_number, but for knobs consumed in shell INTEGER
#   arithmetic ($(( ... ))) rather than `sleep`. Accepts only a plain base-10
#   positive integer: a decimal (0.5), a negative, non-numeric text, OR a
#   leading-zero value (08/09 are invalid octal and abort $(( )); 010 is silently
#   octal) all fall closed to <default> with a stderr warning. An empty <raw>
#   falls back silently.
normalize_positive_integer() {
	local raw="$1" default="$2" name="$3"
	if [ -z "$raw" ]; then
		printf '%s' "$default"
		return 0
	fi
	# Reject a leading zero (0, 00, 08 — octal/arithmetic-unsafe) or any non-digit
	# (sign, dot, letters, whitespace). What survives starts 1-9 and is all
	# digits: a base-10 positive integer, safe in $(( )).
	case "$raw" in
		0* | *[!0-9]*)
			_normalize_positive_reject "$raw" "$default" "$name"
			return 0
			;;
	esac
	printf '%s' "$raw"
}

# Internal: emit the default and a stderr warning for a rejected value.
_normalize_positive_reject() {
	printf '%s' "$2"
	printf 'WARN: %s=%s is not a positive number; using default %s\n' \
		"$3" "$1" "$2" >&2
}
