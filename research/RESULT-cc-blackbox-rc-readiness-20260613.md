# Command Central — Black-Box Agent Status RC-Readiness Receipt

- **Task:** `cc-blackbox-rc-readiness-20260613`
- **Date:** 2026-06-13
- **Lane scope:** Command Central black-box receipt / read-model honesty check toward the
  next internal RC (rc.61 candidate). **No release was cut, built, pushed, tagged, or published.**
- **Verdict:** 🟢 **GREEN — the Command Central black-box / read-model lane is RC-ready.**
  One real but small honesty defect was found **in the readiness tooling itself** (the committed
  `agent_status_audit.sh`) and **fixed in-lane with a regression test**. The product read-model is
  honest as-is. One cross-repo gate (`prerelease-gate`) remains **out of this lane's scope** and is
  owned by the launcher/Symphony lanes (documented below).

---

## Host-labeled execution evidence

| Field | Value |
| --- | --- |
| Host / node | `ostehost@MacBookPro` — **Mike MacBook Pro** (node-visible Claude Code lane) |
| Repo | `command-central` @ `/Users/ostehost/projects/command-central` |
| Branch | `main` |
| HEAD (start) | `3c03b509` `docs(agent-status): record independent review receipt for render perf polish` (== `origin/main`, 0/0) |
| HEAD (end) | `9ace3f74` `fix(agent-status-audit): keep status breakdown honest for null-status rows` (**+1 local, not pushed**) |
| Tree at end | **clean** (`git status --porcelain` empty) |
| `package.json` version | `0.6.0-rc.60` (unchanged — no bump, no cut) |
| Installed VS Code ext | `oste.command-central@0.6.0-rc.60` — **matches source exactly** (live profile consumes current rc) |
| Toolchain | VS Code `1.124.0`, Bun `1.3.13`, Node `v24.15.0`, just `1.46.0` |
| Node-execution guard | PASS — `USER=ostehost`, `HOME` & `cwd` under `/Users/ostehost` |

---

## Black-box live data-source audit (read-only — no mutation)

Captured via the committed `agent_status_audit.sh` plus direct `jq` reads. **No live state was
written.** All values are a point-in-time snapshot of a live, actively-churning system.

| Source | Path / command | Snapshot |
| --- | --- | --- |
| Launcher registry (deprecated compat path) | `~/.config/ghostty-launcher/tasks.json` | 106–107 tasks; **by_status `{completed: 102, running: 3, unknown: 2}`** |
| Lanes projection (primary lane registry) | `~/.config/openclaw/lanes.json` | `work-system-lanes-projection` v1, **29 lanes** |
| Pending-review receipts | `/tmp/oste-pending-review` | 35 active · 34 reviewed · 17 quarantined (86 total) |
| Reviewed-task tracker | `~/.config/command-central/reviewed-tasks.json` | v1, 7 reviewed |
| Stream JSONL files | `/tmp/*-stream-*.jsonl` | 68 |
| OpenClaw | `openclaw tasks list / flow list --json` | available; **0 tasks / 0 flows** via the legacy SQLite read-model (Work System has moved to the lanes projection / `workSystem.lanes.list`) |
| Discovery | VS Code `commandCentral.discovery.enabled` | `false` (deliberate setting on this node; matches the test-suite default) |

**This lane in the live registries:** `cc-blackbox-rc-readiness-20260613` is present and `running`
in **both** the launcher registry and the lanes projection, with `project_ref.id = command-central`
and `lane_kind = implementation` — i.e. it is correctly representable in the Agent Status read-model.
The other two running rows (`dogfood-stale-worktree-hygiene-20260613` → ghostty-launcher,
`symphony-integration-ready-20260613` → symphony-daemon) likewise carry valid `project_ref`s.

---

## Read-model honesty finding (the core black-box question)

**Is what the extension would render an honest reflection of live state? — Yes.**

- The two `null`-status rows in the live launcher registry
  (`symphony-daemon-slice9-cli-codex-worker-wiring-4p8-20260605`,
  `cc-worksystem-projection-reader-20260611-fixup-1`) are **launcher-era rows with no
  `project_ref`**. The extension's primary lane registry uses **`lane-records-only` ingestion**
  (`src/utils/tasks-file-resolver.ts`), and `applyIngestFilter`
  (`src/providers/agent-status-tree-provider.ts:3503`) **quarantines** any record lacking
  `project_ref.id`, logging the count. So these malformed rows **never reach the tree** — the
  product read-model is honest.
- Defensive note: status normalization (`agent-status-tree-provider.ts:901`) maps a missing/empty
  status to `running`. That is only reachable for a registry-backed (`project_ref`-bearing) row;
  no such null-status row exists in live data today, so there is **no false-running** surface in
  practice. Worth a future hardening test, but not a blocker.

### Defect found & fixed (in the readiness *tooling*, not the product)

The committed audit tool `agent_status_audit.sh` (used as the certification instrument for this very
gate) grouped `by_status` on the raw `.value.status`. A `null`/missing status produced a **null jq
group key**, making `from_entries` error and **silently collapse the entire `by_status` object to
`{}`** — hiding even the valid `running`/`completed` counts. Because malformed launcher-era rows
**do** occur in live registries (2 right now), any reviewer running `agent_status_audit.sh --json`
against the live state got an empty, misleading status breakdown.

- **Fix:** coerce null/missing status to a stable `"unknown"` bucket
  (`(.value.status // "unknown")`) so the breakdown stays honest and surfaces malformed rows
  explicitly. Live result after fix: `{completed: 102, running: 3, unknown: 2}`.
- **Test:** `test/scripts/agent-status-audit.test.ts` — hermetic (stubbed `openclaw`, isolated
  `--home`/`--pending-dir`) regression test asserting (a) a full breakdown for well-formed rows and
  (b) no silent collapse when a row has null/missing status. Follows the existing
  `test/scripts/backend-commands.test.ts` `spawnSync` pattern.
- **Commit:** `9ace3f74` — 2 files, +127/-1. `shellcheck` clean.

---

## Gates run (fastest meaningful first) + results

| Gate | Result |
| --- | --- |
| `just test-unit` | 🟢 622 pass / 0 fail |
| Focused tree-view contract tests (10 files: pending-review-truth, review-queue-gap, review-and-handoff, task-classification, read-registry, project-ref-grouping, completed-tmux-regression, dead-process-running, limbo-tier, handoff-file) | 🟢 97 pass / 0 fail |
| Focused utils + ghostty (tasks-file-resolver, agent-task-registry, pending-review-probe, review-queue-health, window-focus) | 🟢 75 pass / 0 fail |
| `agent_status_audit.sh --json` (live + fixture) | 🟢 honest breakdown (post-fix) |
| New `test/scripts/agent-status-audit.test.ts` | 🟢 2 pass / 0 fail |
| `just check` (biome ci + tsc + knip) | 🟢 PASS (8 informational knip warnings, pre-existing) |
| `just test-validate` | 🟢 100% partition coverage (no orphaned tests) |
| `just test` (full suite) | 🟢 **2062 pass / 1 skip (sanctioned) / 0 fail**; test-quality clean |
| `git diff --check` | 🟢 no whitespace errors |
| `shellcheck agent_status_audit.sh` | 🟢 OK |

---

## Out-of-scope / deferred gates (not this lane's to run)

- **`just prerelease-gate` (cross-repo)** — ⛔ deferred. It runs CC `just ci` **and**
  ghostty-launcher `just check` + cross-repo contracts. Task constraints forbid mutating the
  launcher/daemon repos from this lane, and those repos hold in-progress dogfood work (launcher node
  +3, Symphony node +26) owned by other lanes. Running it here would either trip a dirty-tree
  preflight or require touching those repos. **Substitute already satisfied:** the CC half of the
  gate (`just check` + full `just test`) is GREEN above.
- **Installed-VSIX black-box proof (`just test-installed-vsix-agent-status`) + live capture/focus
  receipts** — not run (each is ~50s, spawns a real VS Code host, and the focus probe manipulates
  real windows so it is attended-only per the "no silent integrated-terminal fallback" rule). The
  cheap consumption check is satisfied: the installed extension is `0.6.0-rc.60`, exactly the source
  version, so the live profile renders the current rc. Run the full proof attended before any
  publish decision.

---

## Blocker assessment & RC recommendation

- **Is there any blocker that would make an rc.61 candidate *dishonest*?** No, not at the product /
  read-model level. The Agent Status read-model honestly quarantines malformed rows and correctly
  represents all live running lanes. The single defect found was in the readiness *audit tool*, now
  fixed + tested.
- **CC black-box receipt:** 🟢 GREEN. This lane delivers the "black-box CC test receipts" portion of
  the TODO release gate.
- **Recommendation:** The Command Central read-model lane is RC-ready. **Do not cut rc.61 yet** — the
  release-gate chain still requires the upstream lanes to prove green with visible-terminal evidence:
  Ghostty Launcher visible lane → Symphony spec/daemon → Linear candidate/issue flow → worker →
  black-box receipts (this 🟢) → manager review. Next integration step is to land/verify the launcher
  (+3) and Symphony (+26) dogfood work and run the cross-repo `prerelease-gate`, **then** cut rc.61.

### Recommended follow-ups (not done here — out of constraints)

1. Propagate the skill fix to OpenClaw once approved:
   `openclaw skills install .claude/skills/command-central-vscode-extension --as command-central-vscode-extension --force`
   (skipped here: constraints forbid config writes / external installs).
2. Optional hardening: a test asserting a registry-backed (`project_ref`-bearing) row with
   null/empty status is not silently shown as `running`.
3. The audit script still resolves the **deprecated** `~/.config/ghostty-launcher/tasks.json` path
   and probes the legacy `openclaw tasks list` read-model (returns 0). Consider teaching it the
   primary `~/.config/openclaw/lanes.json` projection so the audit matches the extension's actual
   primary source. Tracked as a non-blocking enhancement.

---

## Constraints honored

No push, fetch, pull, tag, marketplace publish, deploy, external comms, terminal kills, or config
writes. No launcher/daemon repo mutations. No prerelease cut/build. No `--no-verify`. Only two CC
files changed, committed locally on `main` after all gates passed.
