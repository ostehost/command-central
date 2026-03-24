#!/bin/bash
# install-hooks.sh — Install git hooks for Command Central
# Idempotent: safe to run multiple times

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

# Ensure hooks directory exists
mkdir -p "$HOOKS_DIR"

# Install pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'HOOKEOF'
#!/bin/bash
# Pre-commit hook — validates code quality for human commits
# Agents skip this hook (they're validated by orchestrator review)

AUTHOR_EMAIL=$(git var GIT_AUTHOR_IDENT | sed -n 's/.*<\(.*\)>.*/\1/p')

# Agent authors bypass — they must be able to commit for:
# 1. Completion chain (git clean triggers stop hook)
# 2. Max turn safety (save work before exit)
case "$AUTHOR_EMAIL" in
    *@agent.local)
        exit 0
        ;;
esac

# Human commits: run validation
just check
HOOKEOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "pre-commit hook installed at $HOOKS_DIR/pre-commit"
