# Command Central — Prerelease Dogfood (2026-04-20)

**Task:** `cc-prerelease-dogfood-20260420-1546`
**HEAD:** `1a52857` fix(focus): skip bundle surface when tmux session is dead
**Current `package.json` version:** `0.6.0-rc.3` (last cut: `releases/digest-v0.6.0-rc.3.md`)
**Recommendation:** **Cut a new prerelease (0.6.0-rc.4) for internal testing.** No release-blocking issues found. Scope is narrow and additive; full CI + cross-repo prerelease gate are green against the new HEAD.

## Recent focus-truth / launcher-truth commits under test

| SHA | Scope |
| --- | --- |
| `1a52857` | **fix(focus): skip bundle surface when tmux session is dead** — new `shouldTrustBundleSurface(task, tmuxAlive)` gate. Running tmux-backed task + dead session ⇒ Strategies 0/1/2 are skipped and click falls through to Strategy 3's dead-session quickpick. Completed/failed/stopped tasks and non-tmux tasks still focus the bundle unconditionally. `tmuxAlive == null` is treated as *trust the bundle* (fail-open). |
| `cf6dbef` | **refactor(agent-status): launcher truth hierarchy** — `AgentRegistry.getDiscoveredAgents` now per-task `matchesLauncherTask()` (PID, session_id, or project_dir + compatible backend + 15-min start-time window). An external Claude in a shared project dir no longer vanishes from the tree. Explicit Tier 1–4 comment on `toDisplayTask()`. |
| `2e72f91` | **fix(agent-status): keep launcher-managed interactive Claude lanes visible** — tri-state `inspectTmuxPaneAgent` (alive/dead/**unknown**), positive pane evidence short-circuits the stale-stream heuristic, UI shows honest "(interactive)" hint instead of "(possibly stuck)". |
| `37e0417` | **fix(agent-status): trust pending-review receipt over stale tasks.json** — tier-1 beat on tier-4 when the write hasn't flushed yet. |

## Tests run

### 1. Targeted suites around the changes (6 files, 142 tests)
```
bun test test/commands/extension-commands.test.ts \
         test/tree-view/agent-status-launcher-interactive-claude.test.ts \
         test/tree-view/agent-status-pending-review-truth.test.ts \
         test/tree-view/agent-status-dead-process-running.test.ts \
         test/utils/tmux-pane-health.test.ts \
         test/discovery/agent-registry.test.ts
→ 142 pass / 0 fail (95 ms)
```
`describe("shouldTrustBundleSurface (launcher-truth gate)")` in
`test/commands/extension-commands.test.ts:1064` covers every branch of the
new gate: running tmux + alive/dead/null, completed + dead session, ghostty
backend, missing session_id.

### 2. Unit subset
```
just test-unit → 478 pass / 0 fail (git-sort 129 + utils/services 349)
```

### 3. Full suite + CI gate
```
just check → biome ci + tsc + knip clean (213 files)
just test  → 1404 pass / 0 fail across 107 files (5.41 s)
just ci    → PASS (strict: warnings = errors, 0 skipped, 0 `as any`, 0 reflection)
```
Prior flaky test `test/tree-view/agent-status-tree-provider-discovery.test.ts`
("discovery diagnostics report shows retained vs filtered scanner matches") is
now stable — commit `6671a0b` primes `_tmuxSessionHealthCache` and
`_tmuxPaneAgentCache`. Re-running the file in isolation: 76 pass / 0 fail.
(Stale memory note from 2026-04-19 was removed as part of this dogfood.)

### 4. Cross-repo prerelease gate
```
just prerelease-gate → PASS
  command-central   @ 1a52857 (just ci)        8.93 s
  ghostty-launcher  @ aa5899c (just check)    12.68 s
  launcher --parse-name / --parse-icon / --session-id / --help  all pass
Artifact: research/prerelease-gate/prerelease-gate-2026-04-20T19-47-08.327Z.json
latest.json rewritten to point at the new SHAs.
```

## Operator-grade runtime check (live launcher state)

**Environment:** this very task is running under a live launcher-managed tmux
session, so the probes the new focus gate depends on are exercised against
real state rather than fixtures.

```
~/.config/ghostty-launcher/tasks.json → 190 records, 2 running
  - ghl-discord-node-reporting-20260420-1542
  - cc-prerelease-dogfood-20260420-1546   (this task)
```

Live probe results:
- `tmux -S /…/command-central-spoke.sock has-session -t agent-command-central-spoke` → **alive**
- `tmux -S /…/ghostty-launcher-discord-notify-…sock  has-session -t agent-ghostty-launcher-discord-notify-0420-spoke` → **alive**
- `tmux has-session -t agent-definitely-not-here` → **error** (expected: dead)
- `inspectTmuxPaneAgent("agent-command-central-spoke", socket)` → **"alive"** (positive pane evidence, Claude is the `pane_current_command`)
- `inspectTmuxPaneAgent("agent-not-here", socket)` → **"unknown"** (fail-open, matches docstring)

These exercise exactly the two probes (`isTaskTmuxSessionAlive` in
`src/extension.ts:1012` and `inspectTmuxPaneAgent` in
`src/utils/tmux-pane-health.ts:69`) that the new focus gate and the interactive
Claude visibility hint consume. Both behave as specified.

Note on the "garbled surface" failure mode the fix targets: it can only occur
when a running tmux-backed task's session has *died* but `tasks.json` still
says `running`. In the live launcher state today, all running sessions are
alive, so we can't force the negative pre-fix behaviour without killing a
session out of band. Unit coverage in `extension-commands.test.ts` pins every
branch of the gate (running+dead ⇒ skip bundle; completed+dead ⇒ focus bundle;
non-tmux ⇒ focus bundle; missing session_id ⇒ focus bundle; probe-unknown ⇒
focus bundle). Combined with the live probe confirmation, I'm comfortable the
observed surface behaviour will match the asserted contract.

## Prerelease recommendation

**Ship `0.6.0-rc.4` for internal testing.** No blockers.

Rationale:
- Four focused, tier-aware fixes land safely on top of the rc.3 baseline: dead-session focus gate, launcher truth hierarchy for discovered agents, interactive Claude visibility, pending-review receipt precedence.
- All three gates (targeted, full suite, cross-repo prerelease) are green. Biome CI, tsc, knip, and quality invariants (zero `as any`, zero reflection tests, zero skipped) all pass.
- Previously flaky `agent-status-tree-provider-discovery.test.ts` is now deterministic.
- Live-host probes confirm the runtime contract the focus gate depends on.
- Changes are incremental and additive — no schema changes, no user-visible command renames, no tasks.json migration, no launcher protocol change.

Suggested release blurb for internal testers: *"rc.4 tightens launcher-truth hierarchy and stops focus from raising a stale/garbled Ghostty bundle surface when the tmux session is dead. Interactive Claude lanes no longer disappear while the REPL goes quiet mid-turn."*

### Not blockers, but worth noting for testers
- **No negative-path live dogfood coverage.** Cannot synthesize a dead-session + still-running-task scenario without disruptive action. Tester validation should include: open a running tmux task, `tmux kill-session` its target, click focus in Command Central, expect Strategy 3's dead-session quickpick (transcript / diff / resume / launcher) rather than an empty or mis-targeted Ghostty tab.
- **Fail-open semantics.** `shouldTrustBundleSurface` returns `true` when the session-alive probe returns `null` (couldn't tell). This is deliberate — the gate only *subtracts* behaviour when it has positive "dead" evidence. Testers who see Ghostty raise a stale bundle despite the fix should attach the extension host log so we can check whether the probe timed out.

## Commit behaviour

No code change was required during this dogfood. I did drop one stale entry
from the external user memory system (`project_flaky_tree_view_test_2026_04_19.md`)
because commit `6671a0b` already addresses it. That's outside the repo, so no
tree change.

Working tree:
```
 M research/prerelease-gate/latest.json                                         # auto-written by prerelease-gate
?? research/prerelease-gate/prerelease-gate-2026-04-20T19-47-08.327Z.json       # new gate provenance artifact
```
Both are gate artifacts from running `just prerelease-gate` and match the
existing `research/prerelease-gate/*.json` pattern — they will be included in
the completion commit.

## Next step

Run `just cut-preview` (the master recipe) at HEAD `1a52857` to bump to
`0.6.0-rc.4`, build the VSIX, and produce the release digest. The skill is
already available as `/cut-preview`.
