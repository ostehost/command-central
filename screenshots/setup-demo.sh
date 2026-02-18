#!/usr/bin/env bash
# setup-demo.sh — Creates realistic demo git repos for Command Central screenshots
# Creates time-grouped changes (today, yesterday, this week, older) with staged/unstaged/deleted files
set -euo pipefail

DEMO_BASE="${1:-/tmp/command-central-demo}"
PROJ1="$DEMO_BASE/my-app"
PROJ2="$DEMO_BASE/api-server"

rm -rf "$DEMO_BASE"
mkdir -p "$PROJ1" "$PROJ2"

# Helper: commit with a past date (use relative like "-14d", "-4d", "-1d", "-8h")
commit_at() {
  local dir="$1" msg="$2" offset="$3"
  local date
  date=$(date -v"$offset" "+%Y-%m-%dT%H:%M:%S")
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" \
    git -C "$dir" commit -m "$msg" 2>/dev/null
}

###############################################################################
# Project 1: my-app (main demo project)
###############################################################################
git -C "$PROJ1" init -b main

# --- Older commits (> 1 week ago) ---
cat > "$PROJ1/README.md" << 'EOF'
# My App
A modern web application built with TypeScript.
EOF
cat > "$PROJ1/package.json" << 'EOF'
{ "name": "my-app", "version": "1.0.0", "scripts": { "dev": "vite", "build": "tsc && vite build" } }
EOF
mkdir -p "$PROJ1/src/components" "$PROJ1/src/utils" "$PROJ1/src/hooks" "$PROJ1/tests"
cat > "$PROJ1/src/index.ts" << 'EOF'
import { App } from './components/App';
import { initRouter } from './utils/router';
const app = new App();
initRouter(app);
app.mount('#root');
EOF
cat > "$PROJ1/src/components/App.ts" << 'EOF'
export class App {
  private root: HTMLElement | null = null;
  mount(selector: string) {
    this.root = document.querySelector(selector);
    this.render();
  }
  render() { if (this.root) this.root.innerHTML = '<h1>My App</h1>'; }
}
EOF
cat > "$PROJ1/src/utils/router.ts" << 'EOF'
export function initRouter(app: any) {
  window.addEventListener('popstate', () => app.render());
}
EOF
cat > "$PROJ1/src/utils/helpers.ts" << 'EOF'
export const formatDate = (d: Date) => d.toISOString().split('T')[0];
export const debounce = (fn: Function, ms: number) => {
  let timer: any;
  return (...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
};
EOF
git -C "$PROJ1" add -A
commit_at "$PROJ1" "Initial project setup" "-14d"

# --- This week commits ---
cat > "$PROJ1/src/components/Header.tsx" << 'EOF'
export function Header({ title }: { title: string }) {
  return `<header><h1>${title}</h1><nav>Home | About | Settings</nav></header>`;
}
EOF
cat > "$PROJ1/src/components/Sidebar.tsx" << 'EOF'
export function Sidebar({ items }: { items: string[] }) {
  return `<aside>${items.map(i => `<div class="item">${i}</div>`).join('')}</aside>`;
}
EOF
git -C "$PROJ1" add -A
commit_at "$PROJ1" "Add Header and Sidebar components" "-4d"

cat > "$PROJ1/src/hooks/useTheme.ts" << 'EOF'
export function useTheme() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return { theme: isDark ? 'dark' : 'light', toggle: () => {} };
}
EOF
git -C "$PROJ1" add -A
commit_at "$PROJ1" "Add theme hook" "-3d"

# --- Yesterday commits ---
cat > "$PROJ1/src/components/Footer.tsx" << 'EOF'
export function Footer() {
  return `<footer><p>&copy; 2026 My App</p></footer>`;
}
EOF
cat > "$PROJ1/tests/app.test.ts" << 'EOF'
import { describe, it, expect } from 'vitest';
describe('App', () => {
  it('should mount', () => { expect(true).toBe(true); });
});
EOF
git -C "$PROJ1" add -A
commit_at "$PROJ1" "Add Footer component and tests" "-1d"

# --- Today: create unstaged + staged changes ---
# File that will be deleted (tracked, then removed)
cat > "$PROJ1/src/utils/deprecated-api.ts" << 'EOF'
// This API is deprecated and will be removed
export function oldFetch(url: string) { return fetch(url); }
EOF
cat > "$PROJ1/src/utils/legacy-helpers.ts" << 'EOF'
// Legacy helper functions - to be removed
export const oldFormat = (s: string) => s.trim();
EOF
git -C "$PROJ1" add -A
commit_at "$PROJ1" "Add deprecated APIs (to be removed)" "-8H"

# Now create current working state:
# 1. Delete tracked files (shows as deleted in git)
rm "$PROJ1/src/utils/deprecated-api.ts"
rm "$PROJ1/src/utils/legacy-helpers.ts"

# 2. Modify existing files (unstaged)
cat >> "$PROJ1/src/components/App.ts" << 'EOF'

// TODO: Add dark mode support
// TODO: Implement lazy loading
EOF

cat >> "$PROJ1/src/index.ts" << 'EOF'

// Enable hot module replacement
if (import.meta.hot) {
  import.meta.hot.accept();
}
EOF

# 3. Add new files
cat > "$PROJ1/src/components/Dashboard.tsx" << 'EOF'
export function Dashboard({ stats }: { stats: Record<string, number> }) {
  return `<main class="dashboard">
    ${Object.entries(stats).map(([k, v]) => `<div class="stat"><h3>${k}</h3><span>${v}</span></div>`).join('')}
  </main>`;
}
EOF

cat > "$PROJ1/src/hooks/useAuth.ts" << 'EOF'
export function useAuth() {
  return { user: null, login: async () => {}, logout: async () => {} };
}
EOF

mkdir -p "$PROJ1/src/services"
cat > "$PROJ1/src/services/api.ts" << 'EOF'
const BASE_URL = '/api/v1';
export async function get(path: string) { return fetch(`${BASE_URL}${path}`).then(r => r.json()); }
export async function post(path: string, body: any) {
  return fetch(`${BASE_URL}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
}
EOF

# 4. Stage some changes, leave others unstaged
git -C "$PROJ1" add src/components/Dashboard.tsx src/hooks/useAuth.ts
git -C "$PROJ1" add src/utils/deprecated-api.ts src/utils/legacy-helpers.ts 2>/dev/null || true
# The deletions should show as staged

echo "✅ Project 1 (my-app) created at $PROJ1"
echo "   - Staged: Dashboard.tsx, useAuth.ts, 2 deleted files"
echo "   - Unstaged: App.ts (modified), index.ts (modified), api.ts (new)"

###############################################################################
# Project 2: api-server (for multi-root workspace demo)
###############################################################################
git -C "$PROJ2" init -b main

cat > "$PROJ2/README.md" << 'EOF'
# API Server
Backend service for My App.
EOF
mkdir -p "$PROJ2/src/routes" "$PROJ2/src/middleware"
cat > "$PROJ2/src/server.ts" << 'EOF'
import express from 'express';
const app = express();
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.listen(3000);
EOF
cat > "$PROJ2/src/routes/users.ts" << 'EOF'
export function usersRouter() { /* ... */ }
EOF
cat > "$PROJ2/src/middleware/auth.ts" << 'EOF'
export function authMiddleware(req: any, res: any, next: any) { next(); }
EOF
git -C "$PROJ2" add -A
commit_at "$PROJ2" "Initial API server" "-3d"

# Add unstaged changes
cat >> "$PROJ2/src/server.ts" << 'EOF'

// Add CORS support
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});
EOF
cat > "$PROJ2/src/routes/posts.ts" << 'EOF'
export function postsRouter() { /* TODO */ }
EOF

echo "✅ Project 2 (api-server) created at $PROJ2"
echo "   - Unstaged: server.ts (modified), posts.ts (new)"

###############################################################################
# Multi-root workspace file
###############################################################################
cat > "$DEMO_BASE/demo.code-workspace" << EOF
{
  "folders": [
    { "path": "my-app", "name": "🚀 My App" },
    { "path": "api-server", "name": "⚡ API Server" }
  ],
  "settings": {
    "commandCentral.gitSort.enabled": true,
    "commandCentral.gitStatusGrouping.enabled": true,
    "workbench.colorTheme": "Default Dark Modern"
  }
}
EOF

echo ""
echo "✅ Multi-root workspace created at $DEMO_BASE/demo.code-workspace"
echo ""
echo "To open: code $DEMO_BASE/demo.code-workspace"
echo "Or single project: code $PROJ1"
