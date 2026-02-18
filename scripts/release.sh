#!/usr/bin/env bash
# Release script for Command Central VS Code extension
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.1.1

set -euo pipefail

VERSION="${1:?Usage: $0 <version> (e.g. 0.1.1)}"

# Strip leading 'v' if provided
VERSION="${VERSION#v}"

echo "🚀 Releasing v${VERSION}..."

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
echo "   git push origin main --tags"
echo ""
echo "GitHub Actions will handle testing and publishing to the Marketplace."
