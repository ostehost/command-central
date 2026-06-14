# RESULT — Agent Status V2 implementation (cc-agent-status-v2-implementation-20260613)

- **Task id:** `cc-agent-status-v2-implementation-20260613`
- **Date:** 2026-06-13 · **Host:** Mike MacBook Pro (node lane)
- **Repo:** `~/projects/command-central` (branch `main`)
- **Status:** ⏸️ **PAUSED MID-FLIGHT by explicit operator steer.** Working tree is
  intentionally **dirty and uncommitted**; a fresh registered recovery lane will
  take over the V2 implementation from this dirty tree. **Do not commit, push,
  tag, or revert this diff.** This handoff is the continuation contract.
- **Why paused:** this lane's own launcher record went `contract_failure` /
  missing-artifact, so Command Central correctly shows no running agent for this
  pane. Oste is spinning up a registered recovery lane so the UI has a real
  running task again; that lane continues from here.

---

## 0. TL;DR for the recovery lane

The V2 **model + count wiring + Sources reframe + label centralization** are done
and compile clean (`tsc --noEmit` = 0). What remains is **mechanical**: finish
updating ~10 existing test assertions to the new V2 vocabulary (exact list in §5),
write the multi-project / project-first grouping test (§6), then run the full
gate. No architecture work is left for the RC-safe slice. Everything is
label-flexible and centralized per Oste's steers (§3).

Current test state:
- `bunx tsc --noEmit` → **clean (0 errors)**.
- `bun test test/utils/agent-status-sections.test.ts` → **19 pass / 0 fail**.
- `bun test test/integration/{lane-registry-projection,tasks-json-startup-smoke}.test.ts`
  → **22 pass / 0 fail** (already updated).
- `bun test test/tree-view/` → **443 pass / 10 fail** — the 10 fails are the
  remaining mechanical vocabulary updates in §5.

---

## 1. What Agent Status V2 is (doctrine implemented)

One unified, **project-first** lifecycle tree. Root → project groups
(Command Central, Ghostty Launcher, Symphony Daemon, Config, …); inside each
project, sections **Live · Needs Review · Action Required · History · Sources**.
A single count denominator `Live N · Review N · Action N · History N` replaces the
old `working/⏹/✓` vocabulary and the competing "Symphony Status Surface" row.
Liveness is evaluated first (detached-but-alive is Live, never failed); nothing is
hidden or deleted — only the duplicate denominator and stale auto-expansion are
rationed. Built on the sibling lanes:
`cc-current-running-surface-fix-20260613` (live/detached classification, M0) and
`cc-unified-status-tree-ux-20260613` (the design spec,
`research/RESULT-cc-unified-status-tree-ux-20260613.md`).

---

## 2. UX decisions (locked from Oste's in-flight naming research)

- **Project-first, not section-first.** Root summary → project groups → sections
  inside each project. Project grouping is PRESERVED (it was already the default
  `groupByProject` mode); V2 does not flatten to a global list.
- **Locked section labels** (centralized in `V2_SECTION_HEADERS`):
  `Live` · `Needs Review` · `Action Required` · `History` · `Sources`.
- **Locked count format** (`formatV2Summary`): `Live N · Review N · Action N · History N`,
  used for BOTH the flat root summary and per-project row descriptions. Always
  explicit (`Live 0` when idle); full history retained; never `none active`.
- **Badge** counts `live + action` (helper `unifiedBadgeCount`) — not yet wired
  to the activity bar (still `running` count); see §7 M-step.
- **Sources absorbs Symphony as a provenance feed.** The former
  `Symphony Status Surface: …` row is now `Sources` /
  `Sources · Symphony — workstreams N · run attempts M` — read-only, no competing
  denominator, no `standalone run attempts` wording.
- **Detached = visibility chip only**, never a lifecycle state (inherited from
  the sibling fix).
- **Forbidden wording avoided everywhere:** `Current`, `Live now`, `Issues`,
  `Problems`, `Failed & Stopped`, `Archive`, `Sources / Diagnostics`,
  `none active`, `standalone run attempts`.

### Deliberate deferrals (flagged, NOT done this slice)
- **Project-header chrome** — Oste's latest steer asks to drop uppercase project
  names, the `▼` arrow, and emoji from project headers, and to use lowercase task
  chips (`running · 12m · reviewer · attached/detached`). These were **left
  unchanged** this lane because (a) the project-icon emoji is an existing feature
  (custom per-project icons via `getProjectIcon`/`project_icon`), so "no emoji"
  needs an explicit product decision, not a unilateral feature deletion; (b) the
  naming research emitted four refinements during this session and the chrome was
  the newest/least-settled; (c) it would churn ~6 header-label assertions
  (`"🚀 COMMAND CENTRAL ▼ (N)"`). The header construction is a single inline site
  in `createProjectGroupItem` and the labels are centralized, so this is a
  one-place change once the emoji/icon policy is confirmed. **Recommend the
  recovery lane confirm the project-icon policy with Oste before ripping it out.**
- **5-section render (M3)** — V2 still renders the four legacy status subgroups
  (now relabelled Live / Needs Review / Action Required / History). The richer
  `sectionFromSignals` re-bucketing (pending-review → review, broken-pipeline →
  action) is implemented + unit-tested but **not yet wired to render**, to keep
  root counts and group membership consistent pre-M3. See §7.

---

## 3. Centralization (so wording stays a one-line change)

All user-facing V2 strings flow from `src/utils/agent-status-sections.ts`:
- `V2_SECTION_HEADERS` — section labels (also drives `STATUS_GROUP_LABELS` in the
  provider, so the rendered subgroup headers update from the same map).
- `V2_SECTION_COUNT_WORDS` — the terse count words (`Live/Review/Action/History`).
- `formatV2Summary` — the count line format.
- `V2_SECTION_HEADERS.sources` — the Sources row label.
Rename in that one file → root counts, project rows, and section subgroup headers
all update together.

---

## 4. Files changed

### Already auto-committed under this task id (commit `153f9948`)
> The background auto-commit machinery snapshotted an EARLIER version of the two
> new files mid-session. This was not an intentional lane commit; the working
> tree below carries the current, refactored versions.
- `src/utils/agent-status-sections.ts` — **new** pure V2 model.
- `test/utils/agent-status-sections.test.ts` — **new** model unit tests.

### Uncommitted working-tree diff (PRESERVE — do not commit)
- `src/utils/agent-status-sections.ts` — label/format refactor: locked
  `V2_SECTION_HEADERS`/`V2_SECTION_COUNT_WORDS`, `formatV2Summary` →
  `Live N · Review N · Action N · History N`, removed `formatV2SummaryCompact`,
  added `unifiedCountTotal`, `sectionFromSignals` (§2 engine), `unifiedBadgeCount`.
- `src/providers/agent-status-tree-provider.ts`:
  - import the V2 model; remove dead `formatSummaryCounts` / `formatScopedAgentCount`;
    drop now-unused `formatCountSummary` import.
  - `computeUnifiedSectionCounts(nodes)` + `computeUnifiedSectionCountsForTasks(tasks, discoveredCount)`
    — project-aware V2 counts via `sectionFromStatusGroup(getNodeStatusGroup(node))`
    (cache-only, no new hot-path subprocess).
  - root flat summary label → `formatV2Summary(unifiedCounts)`.
  - `createProjectGroupItem` description → `formatV2Summary` (per-project counts);
    `hasRunning`/`attentionCount` now read `counts.live`/`counts.action`.
  - `STATUS_GROUP_LABELS` now sourced from `V2_SECTION_HEADERS`
    (running→Live, limbo→Needs Review, attention→Action Required, done→History).
  - Symphony row reframed: new `formatSourcesProvenanceDescription` +
    `createSourcesProvenanceSummaryNode` (replaces
    `createSymphonyStatusSurfaceSummaryNode`; 4 call sites updated). The standalone
    `formatSymphonyRootDescription` is untouched (still feeds the legacy Symphony
    view, retired in M7).
- `test/utils/agent-status-sections.test.ts` — updated to the locked format +
  added forbidden-wording guards.
- `test/integration/lane-registry-projection.test.ts` — Sources reframe asserts (done).
- `test/integration/tasks-json-startup-smoke.test.ts` — empty-state summary →
  `"Sources"` (done).
- `test/tree-view/agent-status-tree-provider-discovery.test.ts` — ~6 of 10 summary
  assertions updated to V2; **4 remain** (see §5).

---

## 5. Remaining mechanical test updates (the 10 tree-view fails)

All are old-vocabulary assertions; update to the V2 equivalent. The `Received:`
strings from the run tell you the target.

| File:line | Old assert | New (V2) |
| --- | --- | --- |
| `discovery.test.ts:770` | `"2 agents"` | `toContain("Live 1")` (or robust `toMatch(/Live \d/)`); fixture: 1 running + 1 terminal |
| `discovery.test.ts:1394` | project desc `"1 working"` | `"Live 1"` |
| `discovery.test.ts:1767` | project desc `"1 working"` | `"Live 1"` |
| `discovery.test.ts:1799` | project desc `"1 working"` | `"Live 1"` |
| `agent-status-tree-provider.test.ts:294` | summary `"Symphony Status Surface: no projected runs"` | `"Sources"` |
| `agent-status-tree-provider.test.ts:413-416` | `"4 agents"`/`"1 working"`/`"2 ⏹"`/`"1 ✓"` | `"Live 1"` + `"Action 2"` + (review/history per fixture); drop `"4 agents"` |
| `agent-status-tree-provider-health.test.ts:77-78` | `"1 ✓"` / not `"1 working"` | `toContain("History 1")` (or Review 1) + `not.toContain("Live 1")` |
| `agent-status-dead-process-running.test.ts:363` | `not.toContain("working")` | `not.toContain("Live 1")` (dead → Action, not Live) |
| `agent-status-dead-process-running.test.ts:377` | `toContain("working")` | `toContain("Live 1")` |
| `openclaw-task-nodes.test.ts:363` | `"Symphony Status Surface: 1 standalone run attempt · 1 running"` | `"Sources · Symphony — run attempts 1 · 1 running"` |

Note: `discovery.test.ts:122-123` (`statusBarItem.text` → `"2 done"`) and the
badge tooltip (`"1 working agent"`) are **separate surfaces** (status bar / dock
badge) deliberately NOT changed this slice — those tests still pass. The project
**header** labels (`"🚀 COMMAND CENTRAL ▼ (N)"`, lines ~222/1392/etc.) also still
pass because the header chrome was intentionally not changed (see §2 deferral).

---

## 6. Tests still to write

1. **Multi-project / project-first grouping** (new, e.g.
   `test/tree-view/agent-status-v2-sections.test.ts`) — prove:
   - `groupByProject` true with ≥2 projects → root children are `projectGroup`
     nodes (NOT a flat task list);
   - each project group description uses per-project V2 counts
     (`Live N · Review N · Action N · History N`);
   - a project with a live lane sorts before a history-only project
     (`compareProjectGroups` / `projectGroupHasRunning`);
   - inside a project, the `Live` section sorts first and history is preserved;
   - running+detached lane lands in Live, not Action (AT3);
   - stale Needs Review collapses-but-counts (existing `LIMBO_RECENT_THRESHOLD_MS`);
   - Sources row reframed (no `Symphony Status Surface`);
   - no duplicate registry-fallback warn for unchanged no-task state
     (`warnTaskRegistryFallback` dedup).
   Reuse the harness in `agent-status-running-detached-surface.test.ts`
   (typed `getNodeStatusGroup`/`seedSession` accessors) and
   `_helpers/agent-status-tree-provider-test-base.ts` (`createMockTask`).
2. The §2 `sectionFromSignals` AT4–AT7 logic is already covered by the model
   unit tests; AT3/AT5 also hold at the integration level via the group mapping.

---

## 7. Remaining migration steps (post-RC, with hooks in place)

- **M3 — 5-section render.** Wire `sectionFromSignals` into the render path so the
  rendered subgroups (and counts) use the richer re-bucketing (pending-review →
  review, broken-pipeline → action). Today they use the consistent group→section
  relabel. Touches `buildStatusGroupNodes`, sort priority, collapse thresholds,
  icons, and ~the existing group tests — do it deliberately, not in an RC slice.
- **Badge = live + action.** Swap `updateDockBadge`'s `running` count for
  `unifiedBadgeCount(computeUnifiedSectionCounts(...))` (helper already exists).
- **Project-header chrome + lowercase task chips** (§2 deferral) — pending
  emoji/project-icon policy confirmation from Oste.
- **Per-project Sources section (M6)** + full Symphony fold under each project;
  inline provenance chip only on ambiguity.
- **M7** — retire the standalone `commandCentral.symphony` view; then the legacy
  `formatSymphonyRootDescription` / `standalone run attempts` wording can go.

---

## 8. Is the CC RC blocked?

**Not by this work.** The delivered slice is RC-safe (root + project count
vocabulary, Sources reframe, label centralization) and `tsc` is clean. The RC is
only "blocked" in the sense that the **full test gate is not green yet** — 10
mechanical assertion updates + the multi-project test remain (§5–§6), plus the
operator-directed pause means this lane did not run `just check` / `just test` /
`git diff --check` to completion or commit. Once the recovery lane finishes §5–§6
and the gate is green, the slice is shippable. No cross-repo (Ghostty Launcher)
dependency was touched; no other repo mutated.

---

## 9. Constraints honored

No push/tag/publish/release. No other repo mutated. No history hidden/deleted
(counts always retain full history; stale collapses-but-counts). No terminals
closed/killed. No `--no-verify`. **Per the explicit operator steer, the diff is
left uncommitted for a recovery lane — this lane did not commit.** The
auto-commit `153f9948` was produced by background machinery, not an intentional
lane commit.
