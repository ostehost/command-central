#!/usr/bin/env bash
# Release script for Command Central VS Code extension
# Usage: ./scripts/release.sh [--dry-run] <version>
# Example: ./scripts/release.sh 0.1.1
#          ./scripts/release.sh --dry-run 0.1.1
#
# CCSTD-05 split-identity guardrail: Command Central and ghostty-launcher are a
# split identity (two repos, two GitHub remotes). Before committing/tagging this
# script asserts that the push remote ("origin") matches the canonical
# `repository` declared in package.json. If they disagree it refuses — this
# prevents tagging/pushing the wrong checkout (or a fork / mis-set remote) into
# the wrong repository. The check is non-destructive: it never pushes or tags
# on its own, and this script still only commits+tags locally and prints the
# push command for an operator to run after review.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
	DRY_RUN=1
	shift
fi

VERSION="${1:?Usage: $0 [--dry-run] <version> (e.g. 0.1.1)}"

# Strip leading 'v' if provided
VERSION="${VERSION#v}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUSH_REMOTE="${PUSH_REMOTE:-origin}"

# Normalize a GitHub remote URL to a lowercase owner/repo slug so SSH/HTTPS, a
# trailing .git, a trailing slash, and case differences all compare equal.
# Echoes the slug, or nothing when the URL is not a recognizable GitHub remote.
normalize_github_remote() {
	local url="$1"
	# Strip protocol/host prefixes down to owner/repo.
	url="${url%%[[:space:]]}"
	url="${url#https://github.com/}"
	url="${url#http://github.com/}"
	url="${url#ssh://git@github.com/}"
	url="${url#git@github.com:}"
	# If any host prefix remains, this is not a github.com remote we recognize.
	case "$url" in
	*github.com* | *://*) echo "" && return 0 ;;
	esac
	url="${url%.git}"
	url="${url%/}"
	# Must be exactly owner/repo.
	case "$url" in
	*/*/*) echo "" && return 0 ;;
	*/*) printf '%s' "$url" | tr '[:upper:]' '[:lower:]' ;;
	*) echo "" ;;
	esac
}

assert_push_target_identity() {
	local expected_url remote_url expected_slug remote_slug
	expected_url="$(bun -e "const p = await Bun.file('${REPO_ROOT}/package.json').json(); const r = p.repository; process.stdout.write(typeof r === 'string' ? r : (r && r.url) || '');")"
	remote_url="$(git -C "${REPO_ROOT}" remote get-url "${PUSH_REMOTE}")"

	expected_slug="$(normalize_github_remote "${expected_url}")"
	remote_slug="$(normalize_github_remote "${remote_url}")"

	if [[ -z "${expected_slug}" ]]; then
		echo "❌ Could not parse expected GitHub repo from package.json repository: '${expected_url}'" >&2
		exit 1
	fi
	if [[ -z "${remote_slug}" ]]; then
		echo "❌ Could not parse GitHub repo from remote '${PUSH_REMOTE}' url: '${remote_url}'" >&2
		exit 1
	fi
	if [[ "${expected_slug}" != "${remote_slug}" ]]; then
		echo "❌ Push remote '${PUSH_REMOTE}' points at ${remote_slug} but package.json declares ${expected_slug}." >&2
		echo "   Refusing to commit/tag across the split identity (command-central vs ghostty-launcher)." >&2
		exit 1
	fi
	echo "✅ Push-target identity OK: ${PUSH_REMOTE} → ${remote_slug} matches package.json"
}

echo "🚀 Releasing v${VERSION}..."

# 0. Split-identity / push-target guardrail (CCSTD-05) — assert BEFORE any mutation.
assert_push_target_identity

if [[ "${DRY_RUN}" -eq 1 ]]; then
	echo ""
	echo "🧪 --dry-run: no files changed, no commit, no tag."
	echo "   Would bump package.json to ${VERSION}, commit 'chore: release v${VERSION}', and tag v${VERSION}."
	echo "   Then an operator would run: git push ${PUSH_REMOTE} main --tags"
	exit 0
fi

# 1. Bump version in package.json
bun -e "
const pkg = await Bun.file('package.json').json();
pkg.version = '${VERSION}';
await Bun.write('package.json', JSON.stringify(pkg, null, '\t') + '\n');
"
echo "✅ Bumped package.json to ${VERSION}"

# 2. Remind to update CHANGELOG
echo ""
echo "📝 Don't forget to update CHANGELOG.md!"
echo "   Press Enter when ready, or Ctrl+C to abort."
read -r

# 3. Commit and tag
git add -A
git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"

echo "✅ Committed and tagged v${VERSION}"
echo ""
echo "📦 To publish, run:"
echo "   git push ${PUSH_REMOTE} main --tags"
echo ""
echo "GitHub Actions will handle testing and publishing to the Marketplace."
