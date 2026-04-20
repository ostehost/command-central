# Release Blocker Fix — Handoff (2026-04-19)

## Outcome

Preview cut succeeded. Built and locally installed
`command-central-0.6.0-rc.3` after fixing the deterministic test
failure in
`test/tree-view/agent-status-tree-provider-discovery.test.ts`.

## What was wrong

`AgentStatusTreeProvider — discovery > dogfood discovery integration >
discovery diagnostics report shows retained vs filtered scanner
matches` created a synthetic running tmux task (`run-1`,
`session_id: agent-command-central`, `terminal_backend: "tmux"`) but
never primed `_tmuxSessionHealthCache` or `_tmuxPaneAgentCache`. The
provider therefore shelled out to the real `tmux has-session`, the
session did not exist on the host, `isRunningTaskHealthy` returned
`false`, and `toDisplayTask` overlayed `running → stopped`. The
diagnostics report then printed
`Registry: 4 tasks (0 running, 4 completed/archived)` instead of the
expected `(1 running, 3 completed/archived)`. The failure was 100%
host-state dependent and blocked `just cut-preview` rehearsal.

## Fix

Mirrored the cache-priming pattern from the sibling dogfood tests at
`test/tree-view/agent-status-tree-provider-discovery.test.ts:252-277`:
seeded both `_tmuxSessionHealthCache` and `_tmuxPaneAgentCache` with
`{ alive: true, checkedAt: now }` keyed by
`getTmuxHealthCacheKey(running)` before `provider.reload()`.

- Commit: `6671a0b test(tree-view): prime tmux caches in discovery
  diagnostics test`
- Test now passes hermetically (76/0/0 in the file, 1367/0/0 across
  the whole suite during rehearsal).

## Release

- **Version:** `0.6.0-rc.3`
  (note: the first `cut-preview` run bumped to `rc.2`, but the
  Apr-18 stale `rc.2.vsix` was still on disk and `dist-simple` skipped
  the production rebuild; re-running `cut-preview` bumped to `rc.3`
  and produced a fresh artifact off current HEAD)
- **VSIX:** `releases/command-central-0.6.0-rc.3.vsix` (1.30 MB)
- **SHA-256:**
  `4e47418420c33804e5cf47e6e142dcc80d74155e01625d267788fefe2b55162f`
- **Digest:** `releases/digest-v0.6.0-rc.3.md`
- **Provenance:** `research/prerelease-gate/latest.json` →
  `prerelease-gate-2026-04-20T01-14-42.491Z.json`
  - command-central SHA: `6671a0bd0738ac9bdea37ebf6f5f20158f055a82`
  - ghostty-launcher SHA: `3b4a58b7385c28dc4dad99623d74772a0c0b96a5`

## Gate / rehearsal status

All checks passed in the rc.3 run:

- `command-central validation` (`just ci`) — passed (1367/0/0)
- `ghostty-launcher validation` (`just check`) — passed
- `launcher cli parse-name sanity` — passed
- `launcher cli parse-icon sanity` — passed
- `launcher cli session-id sanity` — passed
- `cross-repo launcher contract` — passed

Production VSIX was built fresh, installed to VS Code, and the stale
`rc.2.vsix` was rotated out of the releases archive.

## Commits already landed in this build

- `6671a0b test(tree-view): prime tmux caches in discovery
  diagnostics test`  ← this fix
- `8b0b031 feat(diagnostics): add wall-clock instrumentation for scan
  and tree paths`
- `83a1b87 fix(discovery): eliminate ReDoS in process-scanner agent
  regexes`  ← previously requested

## Repo state at handoff

`git status --porcelain` (all on the cut-preview allowlist —
package.json, releases/, research/prerelease-gate/):

```
 M package.json                                          # 0.6.0-rc.1 → 0.6.0-rc.3
 M research/prerelease-gate/latest.json                  # rc.3 gate snapshot
?? releases/digest-v0.6.0-rc.2.md                        # leftover from first run
?? releases/digest-v0.6.0-rc.3.md                        # rc.3 release digest
?? research/prerelease-gate/prerelease-gate-2026-04-20T01-12-37.892Z.json
?? research/prerelease-gate/prerelease-gate-2026-04-20T01-14-42.491Z.json
```

The user finalizes the release-churn commit per the cut-preview
contract; the agent does not commit/push the bump or stage the
digest. The orphan `digest-v0.6.0-rc.2.md` can be deleted before
committing — rc.2.vsix was rotated out and never represents a real
build of current HEAD.

## Smoke test (Cmd+Shift+P → `Developer: Reload Window`, then)

1. **Agent Status sidebar** renders the project → status → time
   sub-groups without errors.
2. **Toolbar** — `Clear Completed Agents` and `Reap Stale Agents`
   both run cleanly.
3. **Stale → right-click → `Mark as Failed`** persists across a
   reload.
4. **`Focus Terminal`** routes to the exact tmux pane for a running
   task.
5. **Output channel** (`View → Output → Command Central`) shows zero
   activation errors.
6. **Discovery diagnostics** (`Command Central: Show Discovery
   Diagnostics` from the command palette, if the running set
   includes a tmux-backed task) — registry counts and active-agent
   list render without N/A.

If the smoke test passes, finalize the release per the cut-preview
skill's hand-off step (review `git status`, stage + commit the churn,
do not push/tag).
