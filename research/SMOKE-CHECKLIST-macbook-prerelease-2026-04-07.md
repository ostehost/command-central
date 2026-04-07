# Smoke Checklist — Command Central Prerelease

| Field | Value |
|-------|-------|
| Installed | `oste.command-central@0.5.1-77` |
| Workspace HEAD | `0.5.1-77` (match) |
| Date | 2026-04-07 |
| Host | MacBook Pro |

---

## 0. Pre-flight

- [ ] **Reload Window** (`Cmd+Shift+P` → `Developer: Reload Window`)
- [ ] Activity bar shows Command Central icon — click it, sidebar opens
- [ ] `Output → Command Central` channel exists, no activation errors
- [ ] Status bar shows project icon (bottom-left area)

---

## 1. What's New Notification (M3.5-8 — commit `2a7124b`)

> The notice fires once per version for returning users. It references version `0.6.0` in code (`WHATS_NEW_VERSION`), so it may **not** fire on `0.5.1-77` unless globalState already has a stale key.

- [ ] If the notification appears: confirm text mentions "recency by default", has a "Got it" button
- [ ] Dismiss it → reload → confirm it does **not** re-appear
- [ ] If it never appears: acceptable — version string mismatch (`0.6.0` vs `0.5.1-77`). Note this for follow-up.

---

## 2. Agent Status — Noise Reduction & Detail Rows (commits `23aea5a`, `b2d64c3`)

- [ ] Open **Agent Status** view (`commandCentral.agentStatus`) in sidebar
- [ ] If agents exist: expand a task → detail rows show **icons** and formatted info (model, duration, project), no raw placeholder text like `—` or empty strings
- [ ] Completed/failed agents: descriptions show `name · time ago · project` pattern, not noisy raw data
- [ ] If no agents: welcome message appears ("discovers your AI coding agents automatically…")

---

## 3. Project Sections in Agent Status (commit `39bdc49`)

- [ ] Confirm `commandCentral.agentStatus.groupByProject` is `true` (default)
- [ ] Agents are grouped under **project headers** (e.g., `command-central`, `ghostty-launcher`)
- [ ] Toggle flat list: toolbar button `$(list-tree)` → agents show as flat list
- [ ] Toggle back to grouped: toolbar button `$(list-flat)` → project headers return

---

## 4. Project Filter UI (commit `dde80c1`)

- [ ] Toolbar shows filter icon (`commandCentral.selectProjectFilter`) when agents present
- [ ] Click filter → QuickPick lists available projects
- [ ] Select a project → only that project's agents visible
- [ ] Filter-active icon changes to `$(filter-filled)` (`commandCentral.clearProjectFilter`)
- [ ] Click filled-filter icon → filter clears, all agents return

---

## 5. Unified File Items & Smart File Open (commit `7b4082c`)

- [ ] Expand a completed agent with file changes → file items show in both Agent Status and Git Sort views
- [ ] Click a file item in Agent Status → opens the file (or diff) in editor
- [ ] Confirm file items have consistent appearance across both views

---

## 6. Infrastructure Health Status Bar (commit `bc60811`)

- [ ] Look for an infra-health indicator in the status bar (bottom)
- [ ] Click it (if present) → should show diagnostics or a popup
- [ ] If not visible: check `Output → Command Central` for health-related log lines

---

## 7. Regression Sniff

- [ ] **Git Sort refresh**: click `$(refresh)` in any Git Sort slot toolbar → tree reloads without error
- [ ] **Sort order toggle**: click `$(fold)` toggle → sort order changes (recency ↔ alphabetical)
- [ ] **Extension filter**: click `$(filter)` → QuickPick shows file extensions → select one → tree filters
- [ ] **Launch Agent** (`commandCentral.launchAgent`): `Cmd+Shift+P` → "Launch Agent" → confirm dialog/picker appears (cancel before launching)
- [ ] **Cron Jobs view** (`commandCentral.cronJobs`): visible in sidebar, loads without error

---

## 8. Stop Conditions

Abort smoke test and report if any of these occur:

- Extension fails to activate (check Output channel)
- Sidebar shows only "Loading…" for > 10 seconds
- Any uncaught exception toast from the extension
- Agent Status tree is completely empty despite tasks.json having entries
- VS Code becomes unresponsive after opening Command Central sidebar
