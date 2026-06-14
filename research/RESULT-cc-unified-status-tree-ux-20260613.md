# RESULT — Agent Status V2: Unified Status Tree Spec (cc-unified-status-tree-ux-20260613)

**Date:** 2026-06-13 · **Host:** Mike MacBook Pro (node lane) · **Version in flight:** `0.6.0-rc.60`
**Steer (Mike/Oste):** *"Produce an implementable V2 Agent Status spec, not commentary. ONE unified VS Code-native tree absorbs Symphony Status as a provenance/source feed. Required sections: Live/Current, Needs Review, Action Required, History/Revisit, Sources/Diagnostics. Preserve all history & revisitability; collapse/count stale history, never hide it. Exact acceptance tests + migration steps. No 'none active' — use live/history counts."*
**Mode:** Build-ready spec; **no code committed by this lane** — every touch-point is inside `agent-status-tree-provider.ts`, the file the sibling lane `cc-current-running-surface-fix-20260613` is editing in this shared working copy (§9). The implementer applies this after that lane lands.

---

## 0. The five V2 sections (canonical, display order)

```
type V2Section =
  | "live"        // Live / Current   — anything alive right now (attached OR detached)
  | "review"      // Needs Review     — finished work awaiting a human review verdict
  | "action"      // Action Required  — something is broken and needs an operator to act
  | "history"     // History / Revisit— terminal, succeeded, or aged; full revisitable ledger
  | "sources";    // Sources / Diagnostics — provenance feed + orchestrator snapshot (read-only)
```

`live | review | action | history` are **lane buckets** (each lane lands in exactly one). `sources` is **not a lane bucket** — it is a fixed, read-only section that absorbs the entire Symphony surface as a provenance/diagnostics feed (§4). The activity-bar badge counts **`live + action`** only (work that is live or broken), never review/history.

Root summary label (no "none active", ever):
```
Agent Status        live: 2 · review: 1 · action: 1 · history: 47
```
When nothing is live: `live: 0 · review: … · action: … · history: …` (explicit zero, history retained).

---

## 1. Why one tree (decision)

Command Central ships **two sidebar trees that are the same class** (`AgentStatusTreeProvider`) in two `viewMode`s — `agentStatus` and `symphony` (`package.json:1113-1120`, `extension.ts:447-465`). They read the **same lane projection** but count **two different denominators**: the status groups count launcher+discovered+OpenClaw nodes (`agent-counts.ts`), while the pinned `Symphony Status Surface: N run attempts · 0 live now` row (`createSymphonyStatusSurfaceSummaryNode`, `agent-status-tree-provider.ts:6351-6363` → `formatSymphonyRootDescription` `:6469-6500`) counts the CodexRun projection. Two denominators on one screen = "overlap but disagree" = the distrust Mike observed.

**Decision:** collapse to **one lifecycle-led tree**. Symphony's ~80% duplicate framing is dropped; its ~20% unique value (runtime snapshot: Codex token totals, rate limits, cron tick, reconciliation, retry queue, workstreams) is **absorbed into the `sources` section** as a read-only provenance/diagnostics feed. The standalone `commandCentral.symphony` view is retired in migration step M7. Nothing is hidden; only the duplicate denominator and stale auto-expansion are removed.

---

## 2. Section semantics & classification (implementable predicate)

Each lane is classified by `sectionForNode(node): "live"|"review"|"action"|"history"` evaluated **top-down, first match wins**. Liveness is evaluated **first** so a detached-but-alive lane is Live, never Action.

```ts
// Pseudocode — wire into getNodeStatusGroup()'s call site; reuse warmed liveness cache.
function sectionForNode(node): V2LaneSection {
  const status = getNodeStatus(node);                       // existing
  const live = getCachedTerminalTaskLivenessEvidence(task); // existing, 5s TTL, no hot-path subprocess

  // 1. LIVE — alive process wins over any recorded terminal status (the detached≠failed fix).
  if (status === "running") return "live";
  if (live === "alive") return "live";   // terminal-status-but-alive => lifecycle conflict, still LIVE

  // 2. ACTION REQUIRED — broken and needs an operator to act.
  if (isDeadFailure(status)) return "action";          // failed | stopped | killed | contract_failure, and not alive
  if (isReviewPipelineBroken(node)) return "action";   // declared handoff missing OR review-queue receipt missing

  // 3. NEEDS REVIEW — finished, pipeline intact, awaiting a human verdict.
  if (isAwaitingReviewVerdict(node)) return "review";  // completed + (pending|changes_requested) & !reviewed
  if (status === "completed_dirty" || status === "completed_stale") return "review";

  // 4. HISTORY — terminal, succeeded/approved, or aged. Always revisitable.
  return "history";
}
```

| Section | Header (exact) | Members | Detached handling |
| --- | --- | --- | --- |
| **Live / Current** | `Live · N` | `running`; **any terminal-status lane whose liveness == alive** | Detached + alive ⇒ **here**, with a `detached` chip and (on conflict) a quiet `launcher says <status>` chip. The live/detached verdict is owned by the sibling lane; this tree reads it. |
| **Needs Review** | `Needs Review · N` (fresh) `· (+M to revisit)` | completed-pending-review (not yet reviewed) + `completed_dirty` / `completed_stale` with intact pipeline | Detached + finished ⇒ History, not here. |
| **Action Required** | `Action Required · N` | dead `failed`/`stopped`/`killed`/`contract_failure`; declared-handoff-missing; review-queue-receipt-missing | Detached + dead + failed ⇒ **here**. |
| **History / Revisit** | `History · N` | `completed` (approved/clean), released runs, aged terminals | Detached + finished ⇒ here. |
| **Sources / Diagnostics** | `Sources & Diagnostics` | Symphony runtime snapshot, retry queue, workstreams, provenance feed, health/cron/rate diagnostics | n/a — read-only fixed section (§4). |

Predicate helpers (all already exist or are thin wrappers over existing code):
- `isDeadFailure(status)` = `status ∈ {failed, stopped, killed, contract_failure}` (reached only after liveness ≠ alive).
- `isReviewPipelineBroken(node)` = `getDeclaredHandoffState(task) === "missing"` **or** `isReviewQueueReceiptMissing(task)` (existing, `:1943-1949`). These are **pipeline integrity failures** (the artifact a reviewer needs never arrived) — operator action, not a reading task.
- `isAwaitingReviewVerdict(node)` = `status === "completed"` and `review_status ∈ {pending, changes_requested}` and `!reviewTracker.isReviewed(id)` (existing logic at `:4383-4390`).

**Mapping from today's four buckets** (so `getNodeStatusGroup` stays the engine): `running` → live; `attention`'s dead-failures → action; `attention`'s completed-pending-review → review; `limbo`'s broken-pipeline → action, rest → review; `done` → history; live-process-conflict (today routed to `attention`) → **live**.

---

## 3. Stale-history collapse rule (preserve everything, surface nothing alarmist)

Applies to **Needs Review** and **History** (and any aged child of Action Required):

- **Fresh window** `REVIEW_RECENT_MS = 8h` (existing `LIMBO_RECENT_THRESHOLD_MS`, `:829`); **Action fresh window** = `2 * DAY_MS` (existing, unchanged — never hide a real failure fast).
- Items inside the window render expanded. Items outside collapse under a single counted child: `▸ M older · revisit` (a `revisitGroup` node), **expandable on demand**.
- Section header always shows the **total** (`fresh + older`); the collapsed child shows the older count. **Count is truth; only auto-expansion is rationed. Zero deletions, zero hiding.**
- Decision source: `statusGroupHasRecentItems()` (`:4561-4570`) + `getNodeActivityTimeMs()`; extend to emit the `revisitGroup` child instead of just collapsing the whole section.

---

## 4. Sources / Diagnostics — absorbing Symphony as a provenance feed

A single read-only section (rendered last; only when it has content). It replaces the standalone Symphony view and the pinned `Symphony Status Surface:` summary row.

```
⚙ Sources & Diagnostics                          [collapsed; read-only]
├─ Provenance
│   ├─ Launcher registry        47 lanes · ~/.config/openclaw/lanes.json (+compat)
│   ├─ Pending-review receipts   3 · ${CC_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}
│   ├─ Symphony daemon snapshot  fresh · generated 2m ago
│   └─ OpenClaw sessions         2 · runs.sqlite
├─ Orchestrator runtime (read-only)
│   ├─ Codex totals              in 1.2M · out 380K · 14m running
│   ├─ Rate limits               …
│   ├─ Last cron tick            ok · 30s ago
│   ├─ Reconciliation            240ms
│   └─ Retry queue               N  (expand for entries)
└─ Workstreams                   K active
```

- Built by folding the existing `getSymphonyChildren()` (`:6303-6330`) + `getSymphonyDashboardDetailChildren` content under one node. **Preserve the read-only guard** (`workflow-run-actions.ts:34-37,96-106` — `focusTerminal`/`showDetail` only).
- **Provenance is also surfaced inline on a lane** *only when ambiguous* — i.e. a lane appears in ≥2 sources with conflicting status, or is projection-only (no primary `project_ref` record). Chip values: `launcher` · `receipt` · `symphony` · `openclaw`. Fields already on `AgentTask`: `source_authority`, `provenance.source_ref`, `lane_kind_source`. Unambiguous lanes show **no** provenance chip (no noise).

---

## 5. Tree sketch (target)

```
AGENT STATUS                              live: 2 · review: 1 · action: 1 · history: 47
│
├─ ● Live · 2                                              [always expanded]
│    🎯 🔨 cc-unified-status-tree-ux-20260613   node · visible · 4m
│    🔍 ghostty-review-stdin-tty-fix-20260613   tmux · detached · alive 12m   ⟵ detached ≠ failed
│
├─ ◇ Needs Review · 1  (+12 to revisit)                   [fresh expanded; older collapsed-counted]
│    🔍 fresh-review-lane          awaiting review · 30m ago
│    └─ ▸ 12 older · revisit                               [collapsed, counted, NOT hidden]
│
├─ ⚠ Action Required · 1                                   [expanded if recent <2d]
│    🔨 some-build-lane            failed · exit 1 · 8m ago
│
├─ ✓ History · 47                                          [collapsed; full revisitable ledger]
│    (completed + released + finished-detached — every terminal attachable & diffable)
│
└─ ⚙ Sources & Diagnostics                                [collapsed; read-only; only if content]
     Provenance · Orchestrator runtime · Retry queue · Workstreams
```

Project grouping unchanged (canonical `project_id` key; worktree-phantom fix already shipped). The cross-project root uses the same `live · review · action · history` vocabulary — no alarmist language.

---

## 6. Data-model changes (exact)

1. **`UnifiedCounts`** in `src/utils/agent-counts.ts`:
   ```ts
   interface UnifiedCounts { live: number; review: number; action: number; history: number; }
   function countV2Sections(nodes): UnifiedCounts   // single pass over the SAME node set the tree renders
   function formatV2Summary(c): string              // `live: 2 · review: 1 · action: 1 · history: 47`
   ```
   Root label uses `formatV2Summary`. The CodexRun-projection denominator (`formatSymphonyRootDescription`) is **removed from the primary tree** and survives only inside §4 Sources.
2. **Section enum + `sectionForNode`** (§2) replaces the four-way `getNodeStatusGroup` mapping at its render call site; `getNodeStatusGroup` itself may stay as the inner status classifier.
3. **`revisitGroup` node type** (collapsed counted child for stale Needs Review / History).
4. **Provenance chip** reads existing `AgentTask` fields; render gated by an `isProvenanceAmbiguous(node)` predicate.
5. **Badge** = `live + action` (single owner already enforced; Symphony view retirement makes double-count structurally impossible).
6. **No new hot-path subprocess** — `sectionForNode` reads only the warmed `getCachedTerminalTaskLivenessEvidence` cache (rattle-perf invariant).

---

## 7. Acceptance tests (exact — name · arrange · assert)

Add to `test/tree-view/` (extend `agent-status-completed-tmux-regression.test.ts` and a new `agent-status-v2-sections.test.ts`). All run under `just test-unit` / `bun test test/tree-view/`.

| # | Test name | Arrange | Assert |
| --- | --- | --- | --- |
| AT1 | `root summary uses live/review/action/history counts` | fixture: 2 running, 1 completed-pending-review, 1 failed-dead, 47 completed-approved | root label === `live: 2 · review: 1 · action: 1 · history: 47`; string `none active` absent |
| AT2 | `zero live renders explicit live:0, never none active` | fixture: 0 running, all completed | label starts `live: 0`; `none active` absent; history count == fixture count |
| AT3 | `detached-but-alive lane is Live not Action` | task `status:"failed"`, tmux liveness `alive`, `tmux_pane_id` set, pane detached | lands in `live`; renders `detached` chip + `launcher says failed` chip; **not** in `action` |
| AT4 | `dead failed lane is Action Required` | task `status:"failed"`, liveness `dead` | lands in `action`; **not** live/history |
| AT5 | `finished detached lane is History` | task `status:"completed"` approved, liveness `dead`, detached | lands in `history`; attach + diff actions present |
| AT6 | `completed-pending-review is Needs Review` | `status:"completed"`, `review_status:"pending"`, not reviewed | lands in `review` |
| AT7 | `missing handoff / receipt is Action Required` | `status:"completed"`, `getDeclaredHandoffState==="missing"` (and separately `isReviewQueueReceiptMissing`) | lands in `action` (pipeline broken), **not** review |
| AT8 | `stale review collapses but counts` | 1 review item 30m old + 12 items 2d old | section header total == 13; 12 under `▸ 12 older · revisit`; child expandable; no node dropped |
| AT9 | `history is fully revisitable` | mixed fixture | sum of leaf task nodes across live+review+action+history == total lanes from `countAgentStatuses`; every history leaf exposes attach + diff commands |
| AT10 | `Sources section is read-only` | fixture with runtime snapshot + retry entries | Sources node renders; any mutate action via `workflow-run-actions` throws; `focusTerminal`/`showDetail` allowed |
| AT11 | `provenance chip only on ambiguity` | lane A in launcher only (clean); lane B in launcher+receipt with conflicting status | A has no provenance chip; B has chip drawn from `launcher`/`receipt` |
| AT12 | `badge counts live+action only` | 2 live, 1 action, 5 review, 40 history | activity-bar badge value === 3 |
| AT13 | `completion evidence still wins liveness (regression)` | existing `agent-status-completed-tmux-regression` cases | unchanged green — completed never shows Live/fresh-attach |
| AT14 | `no Symphony references after retirement (M7)` | post-migration | `knip` / grep finds no `commandCentral.symphony` in `package.json` views, menus, settings |

**Gate before commit (never `--no-verify`):** `just test-unit` → focused `bun test test/tree-view/` → `git diff --check` → `just check` (biome+tsc+knip) → `just ready` before any push. Perf invariant: no synchronous tmux/git probe added to `getChildren`/`sectionForNode`.

---

## 8. Migration steps (ordered, each independently shippable)

| Step | Change | File(s) | Gate | RC? |
| --- | --- | --- | --- | --- |
| **M0** | *(prereq)* land sibling live/detached fix | sibling lane | its own | — |
| **M1** | Replace pinned `Symphony Status Surface:` row → demote to `⚙ Sources & Diagnostics — read-only` at tree bottom (label/order only; no count) | `createSymphonyStatusSurfaceSummaryNode` `:6351-6363` | AT1-ish snapshot | **RC-safe** |
| **M2** | Add `UnifiedCounts` + `formatV2Summary`; switch root label | `agent-counts.ts`, root builder | AT1, AT2 | RC-safe |
| **M3** | Add `sectionForNode` + 5-section render; map old buckets | provider render site | AT3–AT7 | post-RC |
| **M4** | Live absorbs live-process-conflict w/ chips (coordinate w/ sibling verdict) | provider + `agent-task-classification` | AT3 | post-RC |
| **M5** | `revisitGroup` collapse-but-count for Needs Review + History | provider, `statusGroupHasRecentItems` `:4561` | AT8, AT9 | post-RC |
| **M6** | Fold Symphony builders into `sources`; add provenance feed + ambiguity chip | `getSymphonyChildren` `:6303`, `AgentTask` provenance fields | AT10, AT11 | post-RC |
| **M7** | Retire `commandCentral.symphony` view; keep `viewMode:"symphony"` 1 release as hidden fallback, then delete `createSymphony*` | `package.json:1113-1116`, `extension.ts:447-465`, menus/settings | AT14, `knip` clean | post-RC |
| **M8** | Update docs: `CLAUDE.md`, skill `command-central-vscode-extension`, `references/agent-status-sources.md` | docs | — | post-RC |

---

## 9. Coordination & why no code this lane

`cc-current-running-surface-fix-20260613` owns the live/detached classification and is editing `agent-status-tree-provider.ts` / `agent-task-classification.ts` in **this shared working copy** (no commits yet; tree clean). Every M-step above touches those exact files. Editing now risks clobbering the sibling lane (the documented "concurrent lane commit sweep" hazard) and violates the constraint "do not conflict with the active current-running-surface lane." So this lane ships the spec; M1 starts **after** M0 lands. The only tracked change committed here is this receipt.

---

## 10. Invariants (override everything)

1. **No deletion, no hiding** — stale history collapses under a counted `revisit` child; counts always show the truth.
2. **No "none active"** — always `live: N` (explicit zero allowed); history counts retained.
3. **Detached ≠ failed** — liveness evaluated first; alive ⇒ Live regardless of attach state.
4. **Completion evidence wins liveness** (Tier 2c) — completed never shows Live.
5. **One denominator** — a single `live·review·action·history` count vocabulary; Sources keeps its own internal counts but never competes at the root.
6. **Sources is read-only** — `focusTerminal`/`showDetail` only.
7. **No silent integrated-terminal fallback**; **single badge owner** (`live+action`); **no new hot-path subprocess**.

---

## 11. File / symbol index

| Area | Location |
| --- | --- |
| Two view registrations | `package.json:1113-1116` (symphony), `:1119-1120` (agentStatus) |
| Symphony provider/view creation | `src/extension.ts:447-465` (var `:89`) |
| Status classification engine | `getNodeStatusGroup()` `agent-status-tree-provider.ts:4353-4406` |
| Group labels/order/header | `STATUS_GROUP_LABELS`; build `:4424`; `createStatusGroupItem` `:8818-8832` |
| 8h collapse | `LIMBO_RECENT_THRESHOLD_MS :829`; `statusGroupHasRecentItems :4561-4570` |
| Tier ladder / cached liveness | `toDisplayTask() :2146-2262`; `getCachedTerminalTaskLivenessEvidence() :2123-2143` |
| Lifecycle conflict | `agent-task-classification.ts classifyLifecycleConflict() :384-407` |
| Review pipeline predicates | `isReviewQueueReceiptMissing() :1943-1949`; handoff `getDeclaredHandoffState`; review `:4383-4390` |
| **Symphony summary row (overlap)** | `createSymphonyStatusSurfaceSummaryNode() :6351-6363`; `formatSymphonyRootDescription() :6469-6500`; `0 live now :6496-6497` |
| Symphony builders | `getSymphonyChildren() :6303-6330`; `createSymphony* :8287-8402` |
| Read-only guard | `src/commands/workflow-run-actions.ts:34-37,96-106` |
| Counts | `src/utils/agent-counts.ts` (`countAgentStatuses`, `formatCountSummary`) |
| Runtime snapshot type | `src/types/codex-run-types.ts SymphonyRuntimeSnapshotView :123-140` |
| Pending-review receipts | `${CC_PENDING_REVIEW_DIR:-/tmp/oste-pending-review}/<id>.json` |

*`:NNN` line anchors are reference points (some via code survey); function/symbol names are the stable handles.*

---

## 12. One-paragraph handoff

V2 Agent Status is **one VS Code-native tree** with five sections — **Live/Current** (anything alive, attached or detached), **Needs Review** (finished, awaiting a human verdict; stale items collapse under a counted `revisit` child), **Action Required** (dead failures or broken review-pipeline needing operator action), **History/Revisit** (full, always-attachable ledger), and **Sources/Diagnostics** (a read-only section that absorbs the entire Symphony surface as a provenance + orchestrator-runtime feed). The root shows one count vocabulary `live · review · action · history` (never "none active"); liveness is evaluated first so detached-but-alive is Live, never failed; nothing is ever hidden or deleted — only duplicate denominators and stale auto-expansion are rationed. Ship M1–M2 RC-safe after the sibling live/detached lane lands; M3–M8 post-RC, retiring the standalone Symphony view. Fourteen named acceptance tests (AT1–AT14) and an eight-step migration (M0–M8) make it directly implementable.
