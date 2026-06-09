# Release-Gate Black-Box Receipts — Command Central

- **Task:** `command-central-blackbox-release-gate-20260609`
- **Date:** 2026-06-09
- **Lane scope:** Command Central black-box / extension-host verification **only**
  (Ghostty Launcher showcase + Symphony daemon/Linear lanes are owned elsewhere;
  Symphony daemon path reported green after PAR-187).
- **Verdict:** 🟢 **GREEN** for the Command Central black-box lane.
  One cross-repo gate (`prerelease-gate`) is **deferred / out of this lane's scope**
  and one live action-probe surface (capture/focus) is **attended-only** — both
  documented below. Neither is a Command Central defect.

---

## Host-labeled execution evidence

| Field | Value |
| --- | --- |
| Host / node | `ostehost@MacBookPro.lan` — **node: "Mike MacBook Pro"** |
| Repo | `command-central` @ `/Users/ostehost/projects/command-central` |
| Branch / upstream | `main` → `origin/main` |
| HEAD (start) | `842a0196` `fix(release): harden preview and launcher sync gates` |
| Tree at start | clean (0 dirty / 0 untracked) |
| `package.json` version | `0.6.0-rc.48` |
| Installed VS Code ext | `oste.command-central@0.6.0-rc.48` (matches source + expected VSIX) |
| Toolchain | VS Code `1.122.1`, Bun `1.3.13`, Node `v24.15.0`, just `1.46.0` |
| Node-execution guard | **PASS** — `USER=ostehost`, `HOME` & `cwd` under `/Users/ostehost` |

> Note: the originating ticket text mentioned "v0.5.1-76 is installed". The actual
> installed/source version on this node is **0.6.0-rc.48** (verified three ways:
> `code --list-extensions`, `~/.vscode/extensions`, and `package.json`). The
> "0.5.1-76" string is stale context, not the live state.

---

## Inventory — black-box / integration / VSIX / extension-host surfaces

Discovered release-gate surfaces in this checkout (justfile recipes + scripts):

| Gate (recipe) | Kind | What it proves | Run here? |
| --- | --- | --- | --- |
| `just check` | static | biome ci + `tsc --noEmit` + knip (informational) | ✅ ran |
| `just test` (`bun test`) | unit/integration | 1697 tests across 121 files + `test-quality` | ✅ ran |
| `just ci` | strict | biome ci + tsc + **strict** knip + coverage-ci + test-quality | ✅ ran |
| `just verify-vscode-consumption` | VSIX consumption | the real VS Code profile is consuming the expected VSIX (sha + version) | ✅ ran |
| `just test-installed-vsix-agent-status` | **black-box extension-host** | activates the **installed VSIX** in a real VS Code host; renders Agent Status + Symphony trees, task metadata, action availability; emits a JSON manifest | ✅ ran (passive) |
| `just test-electron` | extension-host integration | builds the in-repo extension, runs it in a real VS Code host via `@vscode/test-electron`; activation, command registration, tree rendering, deactivation cleanup | ✅ ran (found + fixed a defect) |
| `just prerelease-gate` | **cross-repo** release gate | CC `just ci` + ghostty-launcher `just check` + cross-repo launcher contracts + provenance artifact | ⛔ deferred (out of lane scope; launcher dirty — see below) |
| `just preview-status` / `just cut-preview` | release-cut lifecycle | cuts a preview RC (CC + launcher). **Not run** — task says no new release ships until all lanes green | n/a (must not cut) |

Supporting test directories relevant to the surfaces in the objective:
- **Agent Status / task metadata / health:** `test/tree-view/` (17 files), `test/providers/`,
  `test/services/*health*`, `test/utils/*health*`.
- **Capture / focus / receipts:** `test/ghostty/window-focus.test.ts`,
  `test/integration/installed-vsix-proof-*` (passive + live action probes),
  `test/tree-view/agent-status-pending-review-truth.test.ts`, `…review-queue-gap`,
  `…handoff-file`.
- **VSIX / extension-host:** `test/integration/runTest.ts` (+ `suite/`),
  `test/integration/runInstalledVsixAgentStatusProof.ts`,
  `scripts-v2/verify-vscode-extension-consumption.ts`.

---

## Commands run + summarized outputs

### 1. `just check` — 🟢 PASS
`biome ci` checked 245 files, no fixes; `tsc --noEmit` clean; knip informational. Exit 0.

### 2. `just test` — 🟢 PASS
`1696 pass, 1 skip, 0 fail` — 1697 tests / 121 files in **12.25s**. `test-quality` passed
(zero `as any`, zero reflection, zero unsanctioned skips; the 1 skip is the sanctioned
`INTENTIONAL_PROPERTY_DEMO` marker). Exit 0.
(The `fatal: cannot change to '/some/project'` / `/Users/test/projects/my-app` lines are
intentional fixtures invoking git against fake paths inside tests — 0 failures.)

### 3. `just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.48.vsix --expected-version 0.6.0-rc.48` — 🟢 PASS
```
success: true, errors: []
vsixSha256:          8764979aa9b95a0b92fede09771d7e30b62ca86a11ce46f9bc1c30936ffcac68
vsixIdentity:        oste / command-central / 0.6.0-rc.48
installedExtensionId: oste.command-central
installedVersionFromCode: 0.6.0-rc.48
installedPackagePath:     ~/.vscode/extensions/oste.command-central-0.6.0-rc.48/package.json
installedPackageVersion:  0.6.0-rc.48
```
The expected VSIX is exactly what the real VS Code profile is consuming.

### 4. `just test-installed-vsix-agent-status` (passive) — 🟢 PASS
Activated the **installed VSIX** in a real VS Code extension host (pid responsive, exit 0).
```
installed-vsix-agent-status-proof-ok
version:      0.6.0-rc.48
task count:   72
symphony view roots: Operations Dashboard | Running Sessions · 1 | Retry Queue · 0 | Workstreams · 0 | Run Attempts · 72
mode:         passive
actions:      0 passed / 3 skipped     (capture/focus probes are live-only)
duration:     54.26s
manifest:     logs/installed-vsix-agent-status-proof-*.json   (gitignored)
```
Manifest receipts of note:
- `command_central_loaded_from_vsix: true`, `is_extension_development_path_used_for_cc: false`
  → the host is genuinely running the **installed VSIX**, not a dev path.
- `vsix_sha256` matches the consumption receipt above; `commit: 842a0196`.
- `agent_status_tree_snapshot`: `taskCount 72`, `rootChildrenCount 26`; `symphony_tree_snapshot`
  exposes the 5 static Symphony roots.
- `action_probe_results`: `copy`, `open evidence`, `focus terminal` — all `skipped` in passive
  mode and tagged `non_mutating_to: [lifecycle, tracker, workspace]`. The capture/focus action
  surfaces are **present and enumerable on the rows**; only their live execution is deferred.

### 5. `just test-electron` — 🔴 → 🟢 (defect found and fixed in-lane)
**First run FAILED** (pre-existing defect on `main`, exit 1):
```
AssertionError [ERR_ASSERTION]: Agent Status tree inspection should expose the Symphony Workstreams node.
  at run5 (.../suite/index.js)  ← test/integration/suite/tree-view-renders.test.ts
```
Root cause (see analysis below): the suite asserted moved labels against the wrong provider.
**After the fix, re-run PASSED** (exit 0, 46.77s; the transient "unresponsive→responsive
extension host" line is profiler noise during the 14s deactivation-cleanup scenario, recovered).

### 6. `just ci` — 🟢 PASS (strict)
biome ci + `tsc --noEmit` + **strict** knip (no `--no-exit-code`) + coverage-ci entrypoint
(`1696 pass / 1 skip / 0 fail`, 10.45s) + test-quality. `✅ CI checks passed!` Exit 0.
This is exactly the Command Central half of `prerelease-gate`, so the CC release contract is
satisfied independent of the cross-repo launcher half.

---

## Defect found & fixed (isolated to command-central tests/harness)

**Symptom:** `just test-electron` red — `tree-view-renders` could not find a "Workstreams"
node in the Agent Status tree.

**Root cause (not a product regression):** commit `734d7280 "feat(agent-status): promote
symphony tree surface"` moved **Workstreams** and **Run Attempts** out of the Agent Status
tree into the dedicated **Symphony provider/view**, where they are static top-level roots
(`createTaskFlowsItem` → `"Workstreams · N"`, `createCodexRunsItem` → `"Run Attempts · N"`,
always rendered regardless of count). The Agent Status tree now keeps only a single static
`"Symphony Status Surface: …"` summary node (whose own tooltip says *"Open the top-level
Symphony view for … Workstreams, and Run Attempts."*).

That same commit renamed the test's `requiredLabels` to `["Symphony","Workstreams","Run
Attempts"]` but **left all three assertions pointing at `getAgentStatusTreeSnapshot`** — so
the two promoted labels could never be found there. The product is correct: the passing
**installed-VSIX proof** already asserts "Symphony" via `getAgentStatusTreeSnapshot` and
"Workstreams"/"Run Attempts" via `getSymphonyTreeSnapshot`. The electron suite simply lagged
the refactor. `test-electron` is a node-only manual gate (not part of `just test`/`just ci`),
so the rot went unnoticed.

**Why it also looked flaky:** the electron suite reads the **live** launcher registry
(`~/.config/ghostty-launcher/tasks.json`) with no `TASKS_FILE` override, so its outcome
depended on whatever the registry held at runtime.

**Fix (mirrors the passing installed-VSIX proof; uses the existing static Symphony roots, so
it is now deterministic regardless of live registry state):**
- `test/integration/suite/helpers.ts` — declare the already-implemented
  `getSymphonyTreeSnapshot` on the suite's `CommandCentralIntegrationTestApi` interface.
- `test/integration/suite/tree-view-renders.test.ts` — assert `"Symphony"` (summary surface)
  via `getAgentStatusTreeSnapshot`, and `"Workstreams"` + `"Run Attempts"` via
  `getSymphonyTreeSnapshot`.

No product/`src` code changed. Diff: `+22 / -8` across 2 test files. Post-fix gates green:
`just fix` (no changes), `just check`, `just ci`, and `just test-electron` all pass.

---

## Deferred / out-of-scope gates (documented blockers + substitutes)

### A. `just prerelease-gate` — ⛔ deferred (cross-repo; not this lane's to fix)
This gate runs CC `just ci` **and** ghostty-launcher `just check` + cross-repo contract
checks. The launcher working tree is **dirty** right now:
```
~/projects/ghostty-launcher @ main (493b358b)
 M  scripts/oste-spawn.sh
 ?? test/test-visible-lane-metadata.sh
```
That is in-progress launcher dependency work owned by another lane. The task scope explicitly
says **"Do not modify ghostty-launcher"** and **"This lane owns Command Central black-box
verification only,"** so I did not run the cross-repo gate (it would either trip the dirty-tree
preflight or require touching the launcher). **Best substitute already satisfied:** the CC half
(`just ci`) is GREEN above. The launcher half belongs to the Ghostty Launcher showcase lane.

### B. Live capture/focus action receipts — 🟡 attended-only
The capture/focus/copy probes execute real side effects (clipboard write, open evidence file,
**focus a terminal**) and run only in `live` mode with
`COMMAND_CENTRAL_REQUIRED_TASK_ID=<task>`. This task id **is** present in the registry, so a
live run is *possible*, but the focus-terminal probe manipulates real windows and (per the
project's "no silent integrated-terminal fallback" rule) should be exercised attended, not in
an unattended gate. **Best substitute already satisfied:** the passive proof confirms the
capture/focus action surfaces are present and non-mutating on the rows; only live execution is
deferred to an attended smoke. To run later (attended):
```
COMMAND_CENTRAL_REQUIRED_TASK_ID=command-central-blackbox-release-gate-20260609 \
  just test-installed-vsix-agent-status --live
```

---

## Scorecard

| Gate | Result |
| --- | --- |
| `just check` (static) | 🟢 PASS |
| `just test` (1697 tests) | 🟢 PASS |
| `just ci` (strict + coverage) | 🟢 PASS |
| `just verify-vscode-consumption` | 🟢 PASS |
| `just test-installed-vsix-agent-status` (passive) | 🟢 PASS |
| `just test-electron` (extension-host) | 🟢 PASS (after in-lane test fix) |
| Capture/focus **live** receipts | 🟡 attended-only (passive availability proven) |
| `just prerelease-gate` (cross-repo) | ⛔ deferred — launcher dirty, out of lane scope |

---

## Final summary (per verification contract)

- **Tests run:** `just check`, `just test`, `just ci`, `just verify-vscode-consumption`,
  `just test-installed-vsix-agent-status` (passive), `just test-electron` (before + after fix).
- **Result:** all Command Central black-box / extension-host / VSIX gates **GREEN**. One
  pre-existing `test-electron` defect found and fixed in-lane (test/harness only).
- **Changed files:** `test/integration/suite/helpers.ts`,
  `test/integration/suite/tree-view-renders.test.ts` (+ this handoff). No `src`/product changes.
- **HEAD:** `842a0196` at start; the commit carrying this fix is created on `main` in this
  checkout (no push/tag — git push/publish remains user-driven).
- **Verdict:** 🟢 **GREEN — Command Central black-box lane is release-ready.**
- **Next action / remaining blockers (other lanes, not CC black-box):**
  1. Cross-repo `prerelease-gate` once the **ghostty-launcher** tree is clean (Ghostty
     Launcher showcase lane).
  2. Symphony daemon/Linear lane confirmation (reported green post-PAR-187).
  3. Optional attended live capture/focus smoke (`--live`) before publish.
  4. Do **not** cut/publish a new release until showcase + Symphony + receipts are all green.
