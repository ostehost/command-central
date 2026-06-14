# RESULT — cc-high-benefit-bug-hunt-20260614

High-benefit Agent Status bug hunt: focused audit across tree identity/refresh,
launcher truthfulness, installed-VSIX proof/release-gate truth, and refresh hot
paths. Fixes committed locally with failing-before/passing-after regression
tests. No push, tag, publish, or VSIX install performed.

## Threshold reached

**A — three real P1/P2 bugs fixed with tests** (four fixes total across two
commits). The launcher-action group is also one **systemic** root cause, so
threshold **B** ("one P0/P1 systemic bug fixed and fully verified") is met as
well.

## Method

Audited HEAD + the canonical tree-identity research note first (do-not-revert
honored). Fanned out four skeptical, scoped audits (tree identity/refresh,
launcher truthfulness, VSIX/release-gate truth, refresh-churn hot paths), then
personally verified every candidate against the source and the existing tests
before touching code. Rejected everything I could not prove reachable.

---

## Bugs fixed

### Bug class 1 (systemic) — `agentTask` menu gates do not survive the `.linked` contextValue suffix

**Commit `0372cc37`.** Root cause: the provider appends a `.linked` suffix
(after any `.reviewed` suffix) whenever a Claude session UUID is captured —
`agent-status-tree-provider.ts:9248-9254, 9351-9354`. `hasClaudeUuidLink` is
computed independent of status, so the suffix lands on **running** lanes too. A
running Claude lane with a captured UUID is `agentTask.running.linked`; a
reviewed one is `agentTask.<status>.reviewed.linked`. Three `view/item/context`
gates in `package.json` were not suffix-robust while their siblings already used
the regex-prefix convention (focus/capture/showOutput match `=~ /^agentTask\.running/`).

| # | Action | Old gate | Effect | Severity |
|---|--------|----------|--------|----------|
| 1a | `killAgent` (inline **and** 2_actions) | `viewItem == agentTask.running` (exact) | **Kill silently vanishes** from running Claude lanes — the common case. You can focus/capture/view the lane but cannot kill it from the tree. | **P1** |
| 1b | `markStaleAgentFailed` (inline) | `viewItem == agentTask.completed_stale` (exact) | "Mark Failed" vanishes from stale Claude lanes — exactly the interactive lanes you most want to clear. | **P2** |
| 1c | `markAgentReviewed` (2_actions) | guard `!(viewItem =~ /\.reviewed$/)` | `$`-anchor defeated by trailing `.linked`, so `agentTask.<status>.reviewed.linked` is treated as un-reviewed → **"Mark Reviewed" re-appears on already-reviewed Claude lanes**. | **P2** |

**Why P1 for killAgent:** Kill is the one irreversible, high-consequence action
on a running row, and it disappears precisely for the most common lane shape (a
Claude lane that has recorded its session UUID). This is an action-correctness /
launcher-truthfulness defect — the affordance set no longer matches the row's
real state.

**Fix:** converted all three to the established suffix-robust regex form
(`=~ /^agentTask\.running/`, `=~ /^agentTask\.completed_stale/`, and the
reviewed guard broadened to `/\.reviewed(\.|$)/`). The compound killAgent
clause keeps its `&& commandCentral.hasLauncher` and `|| viewItem ==
discoveredAgent.running` semantics intact.

**Independent corroboration:** two separate audit agents found 1a and 1b
independently; 1c surfaced from mapping the full class. All three share the one
root cause (the `.linked` suffix ordering), so this is a single systemic fix.

### Bug 2 — Symphony root containers have undefined tree ids → expand-state loss / orphaned refreshes (P1)

**Commit `15ecd13a`.** The canonical identity refactor enumerated every
`agentStatus` node type but missed the always-on **Symphony** view.
`getStableTreeItemId` returned `undefined` for the four Symphony root
containers, so VS Code fell back to its parent-handle + position + label scheme
— the exact scheme the refactor set out to eliminate.

`getSymphonyChildren` (`:6410-6437`) pushes `taskflows`/`codexRuns` **after** a
conditional `released` run-group, so the moment a run becomes (or stops being)
released, both containers shift sibling position and their derived handles go
stale — collapsing any expanded "Workstreams"/"Run Attempts" subtree and
orphaning in-flight targeted refreshes. The count embedded in each label
(`Run Attempts · N`) re-keys them on the 30s global refresh too.

**Fix:** content-free, render-stable ids for the four singleton containers:
`symphony:dashboard`, `symphony:run-group:<kind>`, `symphony:taskflows`,
`symphony:codexRuns`. **`codexRun`/`symphonySnapshotEntry` deliberately stay
`undefined`**: the same run renders as a `codexRun` under BOTH its run-group and
the `codexRuns` container (`:4009-4011` and `:4053-4055`), so a per-run id would
be a duplicate-id ("element already registered") tree crash — a test now locks
that invariant.

---

## Files changed & commits

| Commit | Files | Lines |
|--------|-------|-------|
| `0372cc37` fix(agent-status): make agentTask menu gates survive the .linked suffix | `package.json`, `test/package-json/agent-menu-contributions.test.ts` | +85 / −11 |
| `15ecd13a` fix(agent-status): give Symphony root containers stable tree ids | `src/providers/agent-status-tree-provider.ts`, `test/tree-view/agent-status-tree-item-stable-id.test.ts` | +109 |

Each commit stages only its own paths (sibling-lane commit-sweep hazard), passed
the Biome pre-commit hook, and carries a failing-before / passing-after
regression test.

## Tests & commands run

| Command | Result |
|---------|--------|
| `bun test test/package-json/agent-menu-contributions.test.ts` (post-fix) | 22 pass / 0 fail |
| same, against **stashed pre-fix** `package.json` | 4 fail (the killAgent, markStaleAgentFailed, markAgentReviewed, and the systemic exact-equality guard) → proves real regressions |
| `bun test test/tree-view/agent-status-tree-item-stable-id.test.ts` (post-fix) | 19 pass / 0 fail (+2 new) |
| same, against **stashed pre-fix** provider | "symphony root containers…" fails → proves real regression |
| `bunx tsc --noEmit` | exit 0 |
| `bun test test/tree-view/` | 485 pass / 0 fail |
| `just check` | ✅ Checks complete (8 pre-existing informational warnings — Knip + a non-null-assertion in `agent-status-perf-caches.test.ts`, all in untouched files; matches the prior baseline, no new warnings) |
| `just test-unit` | 129 + 512 pass / 0 fail |
| `just test` (full) | **2131 pass / 1 skip / 0 fail**; quality checks passed (zero `as any`, zero reflection tests, zero skips) |

---

## Symphony Daemon dogfood — release-gate truthfulness assessment

Black-box question (per Oste): *can installed/source Agent Status truthfully
consume and render launcher + daemon lane state — launched-terminal rows only,
correct actions per lifecycle state, no synthetic OpenClaw-subagent rows — and
what test/proof gaps would block the Symphony Daemon dogfood decision?*

### What is proven sound (no fake rows, correct provenance)

- **No synthetic OpenClaw-subagent rows.** OpenClaw tasks render through a
  separate `openclawTask.*` contextValue (`:9404`) and never merge into launcher
  `agentTask.*` rows. Verified, well-tested (`openclaw-task-nodes.test.ts`).
- **Provenance / quarantine is honest.** The lanes projection ingests
  `lane-records-only`: only Work-Registry-backed `LaneRef` records (carrying
  `project_ref.id`) are admitted (`isRegistryBackedLaneTask`, `applyIngestFilter`
  `:3587`); launcher-era rows and `project_ref`-less projection envelopes stay
  quarantined; a primary registry record always wins the merge over a projection
  row (`:3407-3413`). Tested in `worksystem-lanes-projection.test.ts`.
- **No synthetic running state for local tasks.** Every task passes
  `toDisplayTask` (`:2189`), a 4-tier truth hierarchy that demotes
  `running → stopped/completed/failed` via pending-review receipts, JSONL stream
  terminal events, launcher completion fields, and real tmux session+pane
  liveness (`isRunningTaskHealthy` `:2024`, dead-pane→`stopped` overlay tested in
  `agent-status-dead-process-running.test.ts`).
- **Actions match lifecycle state (now, post-fix).** With Bug-class 1 fixed, the
  inline/context affordances are gated correctly for running vs completed/dead
  rows including the `.linked`/`.reviewed` suffix variants. At the command layer,
  `captureAgentOutput`/`killAgent` refuse on `!isValidSessionId`, and
  `focusAgentTerminal` on a dead-session row shows an explicit warning +
  dead-session QuickPick — never a wrong surface, never a silent
  integrated-terminal fallback (that path is behind an explicit prompt).

### The two gaps that should gate the dogfood decision

1. **Session-less daemon/projection `running` lanes render a live spinner with
   zero liveness evidence (P2 truthfulness gap — the daemon-shaped case).**
   A projection envelope with `session:null, surface:null, status:"running"`
   renders with the animated `sync~spin` "running" icon (`getStatusThemeIcon`
   `:689`); `isRunningTaskHealthy` keeps non-tmux/non-persist + invalid-session
   lanes `running` until they are 1h-old **and** stuck (`:2073-2074`). This is a
   deliberate, documented "detached ≠ dead" fail-open — but it is **exactly the
   shape the Symphony Daemon will emit**, so a daemon lane can imply ongoing work
   without proof. Actions on such a row refuse cleanly (no destructive false
   action), so it is a *visual* truthfulness gap, not a destructive one. The
   `worksystem-lanes-projection.test.ts` (~line 283) explicitly **defers** display
   liveness as "a separate concern from the reader." **Before trusting the
   surface as a dogfood truth source, the daemon should supply a liveness signal,
   or the row should be visually marked "detached" rather than spinning.** No
   regression test asserts truthful rendering of a session-less projection
   `running` lane today.

2. **No automated installed-VSIX activation/render proof on the release path
   (P1 — the bundle-load blind spot).** The strong proof
   (`test/integration/runInstalledVsixAgentStatusProof.ts`) is genuinely honest —
   it installs the VSIX into an isolated `--extensions-dir`, activates by
   published extension ID, and asserts `extensionPath.startsWith(repoRoot) ===
   false` (`installed-vsix-proof-suite.ts:388`) so it cannot accidentally test the
   source tree. **But nothing on the automated release path runs it.** `cut-preview
   → prerelease → prerelease-gate + dist` runs `just ci` (source typecheck/lint/
   unit) + the launcher contract + the VSIX **content** gate (file presence/size),
   and then *installs* the VSIX — but never **activates** it. A bundle that builds
   and passes the size/content gate yet fails to *load* (an ESM/`.js`-extension
   import error surfacing only at activation, an unbundled runtime dep, a bad
   `activationEvents`) would sail through `cut-preview` with zero signal that the
   installed extension renders daemon lanes at all. **For a dogfood decision that
   depends on the installed surface, this is the #1 proof gap: nothing proves the
   shipped bundle activates and renders.**

   Compounding (release-gate hygiene, not strictly dogfood-blocking):
   - CI's real-VS-Code job `test-electron` is structurally dead in CI —
     `scripts-v2/node-execution-guard.ts:31-41` hard-requires user `ostehost` and
     `/Users/ostehost` home, so it throws on `ubuntu-latest` before launching VS
     Code, and it is gated behind a `needs: check` job. There is currently **no
     live extension-host signal in CI**. (P1)
   - `dist` runs the VSIX content gate only inside `if (!versionExists)`
     (`scripts-v2/dist-simple.ts:185-214`); re-running on an unchanged version
     re-installs and blesses the existing artifact with no content-gate recheck.
     (P2)

### Dogfood verdict

Agent Status's **provenance and row-construction are trustworthy** for a
Symphony Daemon dogfood — no fake rows, correct quarantine, and (post-fix)
correct per-state actions. The decision should be gated on closing **(1)** the
session-less `running`-spinner liveness ambiguity for daemon-emitted lanes, and
**(2)** wiring the existing installed-VSIX activation proof into the
prerelease/cut-preview path so the dogfood is not flying blind on whether the
shipped bundle renders. Neither is fixed here (out of this lane's small-change
scope); both are concrete, scoped follow-ups.

---

## Remaining risks & recommended next lanes

1. **[P0 — highest user-pain] Agent Status refresh storm (the real "rattle").**
   `reload()` fires `_onDidChangeTreeData.fire(undefined)` unconditionally
   (`agent-status-tree-provider.ts:2907`), and three services
   (`openclaw-task-service`, `acp-session-service`, `taskflow-service`) each watch
   the **same** `~/.openclaw/tasks/runs.sqlite-wal` and call `onChange?.()` with
   **no change-gating** (`*-service.ts` `debouncedReload`), each wired to both
   `agentStatusProvider.reload()` and `symphonyTreeProvider.reload()`. During an
   active run, WAL churn drives up to ~6 full-tree fires per ~150ms — and each
   per-event `lastEventAt` bump re-renders the row's relative-time label. The
   just-shipped identity work makes each fire *less destructive* (stable ids
   preserve expand state) but does **not** stop the storm. **This is a separate,
   higher-benefit fix that deserves its own focused lane** — I scoped it out here
   because the correct fix (content-digest gating that excludes pure-timestamp
   churn, mirroring `AgentRegistry.fireIfChanged`) is a judgment call with
   stale-UI regression risk that should not be bundled into a small, certain
   commit. Recommended approach: gate each service's `onChange` on a digest of
   the *meaningful* task fields (status/progress/summary/error, not bare
   `lastEventAt`), plus a defense-in-depth dirty-check in `reload()`. No test
   currently asserts `reload()`/`onChange` is suppressed when state is unchanged.

2. **Symphony dogfood gaps (1) and (2) above** — session-less `running`-lane
   liveness truthfulness, and wiring the installed-VSIX activation proof into the
   release path. Both scoped, both real.

3. **Release-gate hygiene** — the CI `test-electron` machine guard and the `dist`
   version-exists content-gate skip (details above).

## Final state

- `git status --short --branch`: `## main...origin/main [ahead 43]` — working
  tree **clean** (`git status --porcelain` empty).
- HEAD: `15ecd13a` — `fix(agent-status): give Symphony root containers stable tree ids`
- Two new commits this lane: `0372cc37`, `15ecd13a`. Not pushed.
