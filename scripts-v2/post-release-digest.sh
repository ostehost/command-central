#!/usr/bin/env bash
# post-release-digest.sh — Post the latest release digest to Discord
#
# Usage:
#   bash scripts-v2/post-release-digest.sh           # Post latest version
#   bash scripts-v2/post-release-digest.sh --dry-run  # Preview without posting
#
# Reads the CHANGELOG, generates a Discord-formatted digest, and posts it
# via openclaw message send.

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# Generate digest
DIGEST=$(bun run scripts-v2/release-digest.ts --format discord 2>/dev/null)
if [[ -z "$DIGEST" ]]; then
	echo "❌ No digest generated (CHANGELOG.md may be empty or malformed)"
	exit 1
fi

echo "$DIGEST"
echo ""

if [[ "$DRY_RUN" -eq 1 ]]; then
	echo "--- DRY RUN: would post above to Discord ---"
	exit 0
fi

# Post to Discord
DISCORD_CHANNEL="${OPENCLAW_DISCORD_CHANNEL:-channel:1473741285088039115}"
if command -v openclaw >/dev/null 2>&1; then
	openclaw message send \
		--channel discord \
		--target "$DISCORD_CHANNEL" \
		--message "$DIGEST" && echo "✅ Posted to Discord" || echo "⚠️ Discord post failed (non-fatal)"
else
	echo "⚠️ openclaw not found — digest printed above, post manually"
fi
