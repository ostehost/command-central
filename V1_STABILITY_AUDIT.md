# V1 Stability Audit — Command Central VS Code Extension

**Date:** 2026-02-21  
**Goal:** Maximum stability, leverage native VS Code APIs, eliminate dead code and over-engineering.

## Completed Actions

### Task 1: Fix duplicate findRepositoryForFile ✅
- Extracted fixed `findRepositoryForFile` from `sorted-changes-provider.ts` into `src/utils/git-repo-utils.ts`
- Both `sorted-changes-provider.ts` and `three-way-diff-command.ts` now use the shared implementation
- The three-way-diff version had the path-boundary bug (`startsWith` without separator check)
- Shared function handles: forward match, reverse match (nested repos), symlink resolution, longest/shallowest match

### Task 2: Dead Code Removed ✅
Removed 4 modules (1,042 production LOC) + 94 tests (1,886 LOC) that were never imported in production:

| File | LOC | Why Dead |
|------|-----|----------|
| `src/git-sort/circuit-breaker.ts` | 55 | Not imported anywhere since git sort refactor |
| `src/services/git-status-cache.ts` | 337 | Redundant with VS Code's git API caching; never wired in |
| `src/utils/config-validator.ts` | 380 | Duplicates VS Code `contributes.configuration` validation; not imported |
| `src/types/tree-element-validator.ts` | 270 | Runtime type validation; TypeScript compile-time types sufficient; not imported |

### Task 3: Test Count Updated ✅
- README.md, site/index.html, CHANGELOG.md updated from 536→455

---

## Audit Findings (Not Yet Actioned)

### 🔴 Terminal Launcher Subsystem — Candidate for v1 Removal

**Size:** 2,811 production LOC + 3,121 test LOC (109 tests)  
**Files:** 19 source files across `src/services/`, `src/commands/`, `src/security/`, `src/terminal/`, `src/utils/`

**Problem:** This is NOT a git change viewer feature. It's a separate terminal launcher that:
- Spawns child processes via `node:child_process` (not `vscode.window.createTerminal()`)
- Has its own security service, process manager, config validator (now removed), strategy pattern
- Supports macOS-only bundled launcher binaries
- Has 7 registered commands in `extension.ts`

**Files involved:**
- `src/services/terminal-launcher-service.ts` (791 LOC) — spawns child processes
- `src/utils/process-manager.ts` (265 LOC) — tracks/kills PIDs
- `src/security/security-service.ts` (203 LOC) — workspace trust checks
- `src/security/validator.ts` (240 LOC) — command validation
- `src/terminal/terminal-link-provider.ts` (193 LOC) — terminal link handling
- `src/terminal/app-bundle-generator.ts` (171 LOC) — macOS .app bundle generation
- `src/services/launcher/` (4 files, 517 LOC) — strategy pattern for launcher selection
- `src/commands/launch-*.ts`, `list-launchers`, `remove-*-launcher`, `configure-project` (380 LOC)
- `src/types/launcher-config.ts` (51 LOC) — launcher types

**Recommendation:** Remove for v1. It's fragile (child process spawning), not core to the git change viewer, and adds significant surface area. The git change viewer functionality is solid without it.

### 🟡 Logger Service — Appropriate Thin Wrapper
**Size:** 291 LOC  
**Verdict:** Uses `vscode.window.createOutputChannel()` correctly. Adds level filtering, history, and structured formatting. Reasonable for the extension's needs. **Keep.**

### 🟡 Dead Code Flagged (Not Removed)
These are not imported in production code but have tests:

| File | LOC | Notes |
|------|-----|-------|
| `src/types/tree-element-guards.ts` | 80 | Type guards — useful pattern, just not called yet |
| `src/types/tree-element-helpers.ts` | 180 | Helper functions for tree navigation — not imported |

26 tests exist for these. Consider removing if they stay unused.

### 🟢 Project Icon Service — Small, Clean
**Size:** 171 LOC  
**Verdict:** Uses `vscode.StatusBarItem` API properly. Lean. **Keep.**

### 🟢 Extension Filter System — Core Feature, Well-Built
Uses proper VS Code TreeView checkbox API, ExtensionFilterState with persistence, and FilterStateManager for event-driven state. **Keep.**

### 🟢 Grouping System — Core Feature, Well-Built
Uses VS Code TreeView API properly with GitStatusGroup/TimeGroup hierarchy. **Keep.**

---

## Architecture Summary (Post-Audit)

### Core (Keep for v1)
- Git sort provider (`sorted-changes-provider.ts`) — the heart of the extension
- Git timestamps, deleted file tracker, storage adapters
- Extension filter (checkbox TreeView for filtering by file type)
- Grouping (git status groups: staged/working)
- Three-way diff command
- Tree view utilities (copy path, reveal in explorer, etc.)
- Logger service (thin wrapper around VS Code output channel)
- Project view manager, provider factory
- Project icon service

### Non-Core (Remove for v1)
- Terminal launcher subsystem (2,811 LOC, 109 tests)
- Security service + validator (only used by terminal launcher)
- Process manager (only used by terminal launcher)
- App bundle generator (only used by terminal launcher)
- 7 terminal launcher commands in extension.ts

### Already Removed
- Circuit breaker (dead code)
- Git status cache (dead code, redundant)
- Config validator (dead code, redundant)
- Tree element validator (dead code, redundant)
