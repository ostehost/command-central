# Release Smoke — Handoff (2026-04-19, rc.3)

## Scope and honesty disclosure

This smoke test was run by a background agent that cannot drive the VS
Code UI (no keyboard input, no command palette, no tree clicks). The
agent gathered evidence from the installed extension's logs, from the
host's process/tmux state, and from the on-disk VSIX. Any check
marked **blocked (UI)** below requires a human with hands on the
window to complete.

Source of record for the release itself:
`research/RELEASE-BLOCKER-FIX-HANDOFF-2026-04-19.md`.

## Install sanity

- `code --list-extensions --show-versions | grep command-central` →
  `oste.command-central@0.6.0-rc.3` ✅
- `releases/command-central-0.6.0-rc.3.vsix` on disk, 1.30 MB,
  SHA-256 matches the digest
  (`4e47418420c33804e5cf47e6e142dcc80d74155e01625d267788fefe2b55162f`)
  ✅
- VS Code is running against the `command-central` workspace
  (pid 32956) ✅
- `just ci` status pre-cut: 1367/0/0 (per blocker handoff) ✅

## Extension activation — rc.3 reload at 22:19 local (02:19 UTC)

From
`~/Library/Application Support/Code/logs/20260417T180606/window2/exthost/output_logging_20260419T221934/1-Command Central.log`:

```
02:19:34 Extension starting... (v0.6.0-rc.3)
02:19:34 ProjectIconService initialized
02:19:34 Extension filter view manager initialized
02:19:34 Grouping state manager initialized
02:19:34 ✅ Dynamic project views registered successfully
02:19:36 Cron Jobs view initialized
02:19:47 Agent Status panel initialized
02:19:47 Ghostty integration initialized
02:19:47 Test count status bar initialized
02:19:47 Infrastructure health status bar initialized
02:19:47 ✅ Extension activated in 13102ms
02:19:47 📦 Command Central v0.6.0-rc.3 ready
```

Zero `ERROR`/`WARN` lines in the Command Central output channel for
this session. The `onView:commandCentral.agentStatus` activation event
fired in `exthost.log` at 22:19:34.525 — i.e. the Agent Status tree
was actually mounted, not just registered.

From
`.../output_logging_20260419T221934/2-Command Central Git Sort.log`:

```
02:19:48 [slot1] refresh() called - forcing TreeView update
02:19:48 [slot1] TreeView refresh event fired (prev count: 0)
02:19:48 [slot1] refresh() called - forcing TreeView update
02:19:48 [slot1] TreeView refresh event fired (prev count: -1)
02:21:42 🎯 Attempting to reveal: …/VISIBLE-MULTILANE-POLICY-…
02:21:46 🎯 Attempting to reveal: …/spawn-guards.sh
02:21:52 🎯 Attempting to reveal: …/oste-spawn.sh
02:21:56 🎯 Attempting to reveal: …/test-spawn-guards.sh
02:22:12 🎯 Attempting to reveal: …/oste-spawn.sh
02:22:14 🎯 Attempting to reveal: …/spawn-guards.sh
```

Git Sort TreeView initialized and is reacting to editor-navigation
events live — evidence that the extension host stays responsive to
user activity under rc.3.

## Smoke matrix

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Agent Status tree renders project/status/time grouping without hanging | **pass (indirect)** | `onView:commandCentral.agentStatus` activation fired at 02:19:34.525 in `exthost.log`; `Agent Status panel initialized` at 02:19:47.710; no UNRESPONSIVE host warning for `oste.command-central` after reload (contrast with the pre-reload 20:29:26 entry on the *previous* build). Cannot visually confirm the project→status→time subgrouping from the CLI. |
| 2 | Toolbar — Clear Completed Agents / Reap Stale Agents run cleanly | **blocked (UI)** | Commands are registered (confirmed via `package.json` contributes, untouched since rc.1); no way to invoke them headlessly against a running VS Code window. Needs human click-through. |
| 3 | Stale → right-click → Mark as Failed persists across reload | **blocked (UI)** | Same — requires a real tree context-menu click plus a reload. |
| 4 | Focus Terminal routes to the correct tmux pane for a running task | **pass (preconditions ok), click blocked** | Running spoke session confirmed: `tmux list-sessions` shows `agent-command-central-spoke` with 2 windows (attached), pane `2.0` is the `developer:command-central-*` window this agent is executing in. The tree-view task fixture for the spoke exists live on the host. Cannot click the tree item from the CLI, but the target pane is present and reachable (`tmux capture-pane -t agent-command-central-spoke:2.0` returns live content). |
| 5 | Output channel shows zero activation errors | **pass** | Full `1-Command Central.log` for this session captured — 23 lines, all `INFO`, terminates at `📦 Command Central v0.6.0-rc.3 ready` / `📝 Git Sort + Project Views ready`. No `ERROR`/`WARN` under `oste.command-central` in `exthost.log` after 22:19:34. The renderer-log `[error]` lines post-reload are `terminal.integrated.initialHint.copilotCli`, `workbench.contrib.agentHostTerminal`, and a Node `DEP0040 punycode` deprecation — all unrelated to Command Central. |
| 6 | Discovery diagnostics registry counts render without N/A | **blocked (UI)** | The `6-Agent Discovery Diagnostics` output channel file is 0 bytes — the channel is lazy-created, so it's only written when the command `Command Central: Show Discovery Diagnostics` actually runs. Cannot fire that from the CLI. The fix from `6671a0b` is covered hermetically by `test/tree-view/agent-status-tree-provider-discovery.test.ts`, which passed in the rc.3 rehearsal run (1367/0/0). |

## What did not regress vs. previous build

- The previous install's extension host under the old version logged
  `UNRESPONSIVE extension host: 'oste.command-central' took 100% of
  5001.751ms` at `2026-04-19 20:29:26` plus two bare `[Extension Host] {`
  entries at 20:28:57 and 20:29:04. Those signals do **not** recur
  between 22:19:34 and 22:22:14 under rc.3. No cpuprofile was written
  for the rc.3 session.
- Extension activation path under rc.3 was `onView:commandCentral.agentStatus`,
  not `onStartupFinished` — consistent with the sidebar being visible
  on reload and the tree actually being asked for data.

## Blockers remaining for a full release sign-off

1. A human needs to confirm the three UI-only smoke items (toolbar
   actions #2, Mark-as-Failed persistence #3, Discovery Diagnostics
   render #6). None of these are newly suspected — they are just
   unobservable from a background agent.
2. The `research/prerelease-gate/` extras and the orphan
   `releases/digest-v0.6.0-rc.2.md` still need to be cleaned per the
   cut-preview contract before the release-churn commit. (See
   blocker handoff §"Repo state at handoff".) That is the
   user-owned finalize step; the smoke agent does not touch those.

## Recommendation

rc.3 is installed and activating cleanly. The evidence available
without a UI-driving agent is all green. Ship the human-side smoke
pass (#2, #3, #6) and then finalize the cut-preview churn commit —
do not push/tag per the cut-preview skill contract.
