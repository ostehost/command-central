#!/bin/bash
#
# test-fast-select.sh — changed-file → fast-gate suite selection (RAGL-01).
#
# Pure mapping from a set of changed repo paths to the suites the fast pre-push
# gate should run. Separated from the git diff that produces the change set so
# the selection is unit-testable with synthetic inputs and the always-on smoke
# set has a single source of truth. The justfile `test-fast` recipe sources this
# and feeds it the real diff on stdin.
#
# Selection (unchanged from the original inline recipe logic):
#   * always include the smoke set (cheap, high-signal core paths)
#   * a changed test/test-*.sh suite covers itself
#   * any suite that references a changed file by basename exercises it
# Output: newline-separated, de-duplicated, existing test/test-*.sh paths.
#
# DESIGN NOTE / FUTURE (RAGL-01 follow-up, intentionally deferred): basename
# references are a coarse proxy. A literal basename can collide (two files share
# a basename in different dirs) or match as a substring (e.g. "idle.sh" inside
# "not-idle.sh"), so this can over- or under-select. A declarative source->suite
# coverage map would be less fragile but is a larger change; it was deferred to
# keep the just-stabilized gate's selection behavior byte-identical. Revisit if
# selection noise becomes a problem.

# Always-on smoke set: cheap, high-signal core paths that gate gross breakage
# regardless of what changed (each <2s). Single source of truth.
OSTE_FAST_SMOKE_SUITES=(
	test/test-parse-settings.sh
	test/test-path-detection.sh
	test/test-ghostty-path.sh
	test/test-launcher-eligibility.sh
	test/test-role-config.sh
)

# test_fast_select_suites
#   Reads changed paths (one per line) on stdin; prints selected suite paths
#   (one per line: sorted, unique, existing) on stdout. Always emits the smoke
#   set even when stdin is empty. Run from the repo root.
test_fast_select_suites() {
	local want changed_path bn hits # 'changed_path' not 'path': zsh ties $path to the PATH array
	want="$(printf '%s\n' "${OSTE_FAST_SMOKE_SUITES[@]}")"
	while IFS= read -r changed_path; do
		[ -n "$changed_path" ] || continue
		case "$changed_path" in
			test/test-*.sh) [ -f "$changed_path" ] && want="${want}"$'\n'"${changed_path}" ;;
		esac
		bn="$(basename "$changed_path")"
		hits="$(grep -rlF -- "$bn" test/test-*.sh 2>/dev/null || true)"
		[ -n "$hits" ] && want="${want}"$'\n'"${hits}"
	done
	printf '%s\n' "$want" | grep -E '^test/test-.*\.sh$' | LC_ALL=C sort -u | while IFS= read -r s; do
		[ -f "$s" ] && printf '%s\n' "$s"
	done
}
