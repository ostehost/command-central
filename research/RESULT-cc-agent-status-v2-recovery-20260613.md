# RESULT — Agent Status V2 recovery (cc-agent-status-v2-recovery-20260613)

- **Task id:** `cc-agent-status-v2-recovery-20260613`
- **Date:** 2026-06-13 · **Host:** Mike MacBook Pro (node lane)
- **Repo:** `~/projects/command-central` (branch `main`)
- **Status:** ✅ **COMPLETE — V2 implementation finished, all gates green, committed.**
- **Predecessor:** `cc-agent-status-v2-implementation-20260613` (orphaned /
  contract-failed; its continuation contract is committed alongside this work at
  `research/RESULT-cc-agent-status-v2-implementation-20260613.md`).

---

## 0. TL;DR

Recovered the paused V2 work from its preserved dirty tree (no blind overwrite),
finished the **mechanical + completeness gaps** the orphaned lane flagged, and
added the missing **project-first grouping test suite**. The V2 model, count
wiring, Sources reframe, and label centralization were already done and
compiling; this lane:

1. Verified the preserved diff, then found & fixed **13 stale test assertions**
   across **7** files (the orphaned lane's §5 listed ~10; the full suite surfaced
   3 more in `agent-status-tree-provider-health` / `agent-status-dead-process-running`).
2. Aligned the **section subgroup header** render to the locked spec
   (`Live · N`, not `Live · N agents`) — one line in `createStatusGroupItem`.
3. Wrote `test/tree-view/agent-status-v2-sections.test.ts` (8 tests) covering
   project-first grouping, the count denominator, locked section labels,
   running+detached→Live, history preservation, Sources reframe, and a
   forbidden-wording guard.
4. Ran the full gate green and committed.

---

## 1. Root cause (why CC showed "no running agents" for a live pane)

The orphaned lane was **paused mid-flight by operator steer** with a dirty,
uncommitted V2 diff. Its launcher record went `contract_failure` /
missing-artifact (the handoff was written to disk but never committed/registered),
so the launcher correctly had **no running task** for that pane — yet its tmux
pane (`%9`) kept editing. Command Central therefore showed **no running agent**
even while a terminal was demonstrably live.

That is exactly the V2 lifecycle class this work hardens: **a contract-failed
task with active terminal residue**, plus registry-running lanes, live/revisitable
tmux panes, and completed records with open terminals. V2's doctrine — *liveness
first, detached is a visibility chip not death, nothing hidden, one denominator* —
is the structural answer. The provider's `toDisplayTask` truth hierarchy
(receipt → stale cache → stream terminal → launcher completion → liveness
overlay, with "detached ≠ dead" gating) already keeps unconfirmable-but-alive
lanes in **Live**; this lane completed the V2 *surfacing* of that model.

No data was lost: the recovery continued **from** the preserved diff (inspected
first via `git diff`), never overwrote it.

---

## 2. What changed (final committed tree)

### Source (V2 implementation — completion of the preserved diff)
- `src/utils/agent-status-sections.ts` — locked `V2_SECTION_HEADERS`
  (`Live` / `Needs Review` / `Action Required` / `History` / `Sources`) +
  `V2_SECTION_COUNT_WORDS`; `formatV2Summary` →
  `Live N · Review N · Action N · History N`; removed `formatV2SummaryCompact`
  (folded into the single denominator). *(preserved diff)*
- `src/providers/agent-status-tree-provider.ts`:
  - imports the V2 model; drops dead `formatSummaryCounts` /
    `formatScopedAgentCount`. *(preserved diff)*
  - `computeUnifiedSectionCounts` / `computeUnifiedSectionCountsForTasks` —
    project-aware V2 counts via `sectionFromStatusGroup(getNodeStatusGroup())`
    (cache-only, no new hot-path subprocess). *(preserved diff)*
  - root summary + per-project row description → `formatV2Summary`. *(preserved diff)*
  - `STATUS_GROUP_LABELS` sourced from `V2_SECTION_HEADERS`
    (running→Live, limbo→Needs Review, attention→Action Required, done→History).
    *(preserved diff)*
  - Symphony row reframed: `formatSourcesProvenanceDescription` +
    `createSourcesProvenanceSummaryNode` (read-only Sources provenance feed;
    no rival "Symphony Status Surface" denominator). *(preserved diff)*
  - **`createStatusGroupItem` section header → `Label · N`** (was `Label · N agents`)
    to satisfy the locked "Section labels: `Live · N` …" requirement; the
    `agent/agents` count word stays in the tooltip. *(this lane)*

### Tests (assertion updates to V2 vocabulary — this lane)
- `test/utils/agent-status-sections.test.ts` *(preserved diff)*
- `test/integration/lane-registry-projection.test.ts` *(preserved diff)*
- `test/integration/tasks-json-startup-smoke.test.ts` *(preserved diff)*
- `test/tree-view/agent-status-tree-provider-discovery.test.ts` — 4 remaining
  summary/project-row asserts → V2 (incl. the session-reconciliation case:
  duplicate-session running lanes → Live 1 / Action 1).
- `test/tree-view/agent-status-tree-provider.test.ts` — empty-state Sources node;
  `summary node has correct format` → `Live 1 · Review 0 · Action 2 · History 1`.
- `test/tree-view/openclaw-task-nodes.test.ts` — lightweight Symphony summary →
  `Sources · Symphony — run attempts N · M running` (selected by label, since the
  root now also carries the denominator summary node).
- `test/tree-view/agent-status-tree-provider-health.test.ts` — stuck-dead running
  → `completed_stale` → **Review 1** + **Live 0** (the orphaned §5 guess of
  "History 1" was wrong: completed_stale → limbo → Needs Review, verified against
  real output).
- `test/tree-view/agent-status-dead-process-running.test.ts` — dead → Live 0 /
  Action 1; live → Live 1.

### Tests (new — this lane)
- `test/tree-view/agent-status-v2-sections.test.ts` — 8 tests, project-first model
  end-to-end (see §0.3).

### Docs
- `research/RESULT-cc-agent-status-v2-implementation-20260613.md` — the orphaned
  lane's continuation contract, committed as provenance (research/ is a tracked
  convention here; this records the design decisions + M3/M6/M7 roadmap).
- `research/RESULT-cc-agent-status-v2-recovery-20260613.md` — this file.

---

## 3. Gates (all green)

| Gate | Result |
| --- | --- |
| `bun test` (full) | **2102 pass / 1 skip / 0 fail** (150 files) |
| Typecheck (`tsc --noEmit`, via `just test`) | clean |
| `just check` (biome ci + tsc + knip) | **PASS** (8 informational knip warnings, pre-existing) |
| `bunx knip` (strict) | clean, exit 0 |
| `git diff --check` | clean (no whitespace / conflict markers) |
| New `agent-status-v2-sections.test.ts` | **8 pass / 0 fail** |

---

## 4. Verification of product requirements

- **Project-first, not flat** — root → project groups → sections. ✅ (test:
  `project-first: ≥2 projects render as project groups, never a flat task list`)
- **Locked labels** `Live / Needs Review / Action Required / History / Sources`. ✅
- **Section labels** `Live · N` etc. ✅ (`createStatusGroupItem` + test)
- **Project row** `Live N · Review N · Action N · History N`. ✅
- **History preserved / nothing hidden** ✅ (test asserts completed lanes stay
  rendered + counted)
- **Detached = visibility chip, not death** — running+detached → Live. ✅ (test)
- **Sources absorbs Symphony**; no competing top-level Symphony Status Surface. ✅
- **No forbidden wording** (`Current`, `Live now`, `Issues`, `Problems`,
  `Failed & Stopped`, `Archive`, `Diagnostics`, `none active`,
  `standalone run attempts`). ✅ (guard test + sections unit test)
- **V2 accounts for** registry-running, live/revisitable panes, completed-with-open-
  terminals, and contract-failed-with-residue — via the existing `toDisplayTask`
  truth hierarchy now surfaced through the V2 section model. ✅

---

## 5. RC / dogfood blockers

**None introduced by this lane.** The delivered slice is RC-safe (root + project
count vocabulary, locked section labels, Sources reframe, label centralization)
and the full gate is green. Outstanding V2 work is **post-RC**, inherited from the
orphaned lane's roadmap (not blockers):

- **M3 — richer 5-section render.** Wire `sectionFromSignals` into the render path
  (pending-review→review, broken-pipeline→action) so subgroup membership uses the
  §2 engine, not just the consistent group→section relabel. Touches
  `buildStatusGroupNodes`, sort priority, collapse thresholds, icons.
- **Badge = live + action.** Swap `updateDockBadge`'s `running` count for
  `unifiedBadgeCount(...)` (helper exists, unit-tested).
- **Project-header chrome + lowercase task chips** — pending an explicit
  emoji/project-icon policy decision (custom per-project icons are an existing
  feature; do not unilaterally delete). Header construction is one centralized
  site in `createProjectGroupItem`.
- **Per-project Sources section (M6)** + full Symphony fold per project.
- **M7** — retire the standalone `commandCentral.symphony` view; then the legacy
  `formatSymphonyRootDescription` / `standalone run attempts` wording can go.

No cross-repo (Ghostty Launcher) dependency touched; no other repo mutated.

---

## 6. Constraints honored

No push / tag / publish / release / deploy. No other repo mutated. No terminals
closed or killed. No `--no-verify`. No history hidden or deleted (counts retain
full history). The preserved dirty diff was inspected and continued from, never
blindly overwritten. Tracked changes were staged by explicit path (no `git add -A`
sweep of sibling lanes).
