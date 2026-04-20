# Command Central Preview — RELEASE HANDOFF 2026-04-19

**Status:** ❌ **BLOCKED — preview was NOT cut.**
**Hub:** `ostehost@MacBookPro` (correct hub, per memory)
**HEAD:** `83a1b87 fix(discovery): eliminate ReDoS in process-scanner agent regexes`
**Target skill:** `.claude/skills/cut-preview/SKILL.md` → `just cut-preview`

## What happened

Preflight passed (both repos clean; hub confirmed). `sync-launcher` reported "already in sync" (bundled launcher `0.1.0` = source `0.1.0`). The rehearsal step — `just ci`, which is identical to what the cross-repo gate would then run — failed on one unit test:

```
test/tree-view/agent-status-tree-provider-discovery.test.ts
  > AgentStatusTreeProvider — discovery
    > dogfood discovery integration
      > discovery diagnostics report shows retained vs filtered scanner matches

error: expect(received).toContain(expected)
Expected: "Registry: 4 tasks (1 running, 3 completed/archived)"
Received: "Registry: 4 tasks (0 running, 4 completed/archived)"
```

Final tally: `1356 pass / 1 fail / 2799 expect()` across 104 files in ~5s. Per the skill's "Failure paths" section — "Fix upstream. Do NOT silence knip, skip tests, or use --no-verify" — the cut was stopped here. No `package.json` bump, no VSIX produced, no install, no commits.

## Artifacts produced

**None.** Expected `releases/command-central-0.6.0-rc.3.vsix` + `releases/digest-v0.6.0-rc.3.md` were never built because the rehearsal aborted before `dist --prerelease` ran. `package.json` remains at `0.6.0-rc.1`. Gate record `research/prerelease-gate/latest.json` is unchanged (still the passing 2026-04-18T17:01 record at sha `415e5f9`).

## Gate & rehearsal results

| Stage | Result | Notes |
|---|---|---|
| `_preview-preflight` | ✅ pass | Both repos clean, host = `ostehost@MacBookPro` |
| `sync-launcher` | ✅ pass | Already in sync at 0.1.0 |
| `_preview-rehearsal` (`just ci`) | ❌ **fail** | 1 failing test (see below) |
| `prerelease-gate` | ⏭ not reached | |
| `dist --prerelease` | ⏭ not reached | |

## Extension install status

**Not installed.** The previously-installed `0.6.0-rc.2` VSIX remains active. No new build was produced, so nothing to reload.

## Root cause of the blocker (precise)

The failing test at `test/tree-view/agent-status-tree-provider-discovery.test.ts:346` ("discovery diagnostics report shows retained vs filtered scanner matches") sets up a running task `run-1` with `terminal_backend: "tmux"` and `session_id: "agent-command-central"`, but does NOT prime the provider's tmux health caches:

```ts
// Current test (broken) — omits cache priming for run-1
provider.readRegistry = () => createMockRegistry({
  [running.id]: running, /* status: "running", terminal_backend: "tmux",
                            session_id: "agent-command-central" */
  [recentCompleted.id]: recentCompleted,
  [dayCompleted.id]: dayCompleted,
  [oldCompleted.id]: oldCompleted,
});
provider.reload();
// ... sets _openclawTaskService, _agentRegistry, _discoveredAgents ...
// ← never sets _tmuxSessionHealthCache or _tmuxPaneAgentCache for run-1
```

`getDiscoveryDiagnosticsReport()` iterates `getDisplayLauncherTasks()`, which runs every task through `toDisplayTask` (`src/providers/agent-status-tree-provider.ts:1343`). For the running task it calls `isRunningTaskHealthy` (`:1301`), which — with no cached entry and TTL expired — calls the **real** `isTmuxSessionAlive` and `isTmuxPaneAgentAlive` against the host tmux server. On the hub machine no `agent-command-central` session with a live codex/claude pane exists, so the task is reclassified as `stopped`, and the Registry line becomes `(0 running, 4 completed/archived)`.

### Why the previous gate passed

The recorded gate at sha `415e5f9` on 2026-04-18T17:01 shows `1356 pass / 0 fail / 2819 expect()`. The current run at sha `83a1b87` shows `1356 pass / 1 fail / 2799 expect()`. The diff of `2819 − 2799 = 20` matches the expects downstream of line 683 that don't run when the test aborts — i.e. only this one test diverged. The test's environmental dependency on real tmux state means the prior pass was a coincidence (warm cache, or a matching live pane on Mike's box at that instant), not a real green. I reproduced the failure cleanly on the current tree AND on the parent commit `008d17a`, AND at the gate-passing sha `415e5f9` itself, AND even after spawning an `agent-command-central` tmux session manually (the pane is still empty, so `isTmuxPaneAgentAlive` returns false). Introduced in `49f57ec` (2026-04-16).

## Suggested fix (test-only, unblocks cut)

Mirror the priming pattern from the sibling test at line ~310 ("live tasks snapshot stays within the large-registry render budget"). In the failing test, immediately after `provider.reload();` and before calling `getDiscoveryDiagnosticsReport()`, add:

```ts
const now = Date.now();
(provider as unknown as {
  _tmuxSessionHealthCache: Map<string, { alive: boolean; checkedAt: number }>;
  _tmuxPaneAgentCache: Map<string, { alive: boolean; checkedAt: number }>;
})._tmuxSessionHealthCache.set("__default__::agent-command-central", {
  alive: true, checkedAt: now,
});
(provider as unknown as {
  _tmuxPaneAgentCache: Map<string, { alive: boolean; checkedAt: number }>;
})._tmuxPaneAgentCache.set("__default__::agent-command-central", {
  alive: true, checkedAt: now,
});
```

This keeps the test hermetic and pins `run-1` as a healthy running task regardless of host tmux state. After landing that commit, re-run `just cut-preview` and the rehearsal should be deterministic.

## Smoke-test steps for Mike (for the next successful cut)

Since nothing was built this run, the smoke test is deferred. When the next preview cuts cleanly, follow the skill's happy-path checklist:

1. `Cmd+Shift+P` → `Developer: Reload Window`
2. Agent Status sidebar: confirm project → status → time sub-groups render.
3. Toolbar: `Clear Completed Agents` and `Reap Stale Agents` both fire without errors.
4. Right-click a stale task → `Mark as Failed` — refresh, confirm state persists.
5. `Focus Terminal` on a running task routes to the exact tmux pane.
6. Output channel (`Command Central`): no activation errors.
7. Spot-check process-scanner fix: open Agent Status on the affected MacBook and confirm it no longer stalls for ≥30s on large `ps` outputs. (The commit that motivated this preview — `83a1b87` — is what we wanted out the door.)

## Tree state

`git status --porcelain` at exit time shows only this handoff file (untracked/new). No source or config changes.

## Next action for Mike

1. Either fix the flaky test as described above (preferred — test is genuinely broken), or temporarily skip it with a tracked `// TODO` and ticket.
2. Re-run `just cut-preview` from this same HEAD (`83a1b87`). The bundled launcher is already in sync, so the cycle should be fast.
3. If the fix lands on top of `83a1b87`, the resulting RC will include both the ReDoS fix and the test hardening — which is the correct payload for a preview.
