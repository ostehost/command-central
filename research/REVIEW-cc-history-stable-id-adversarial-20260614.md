# Adversarial Review — History rattle stable `TreeItem.id` fix

- **task_id:** `cc-history-stable-id-adversarial-review-20260614`
- **Date:** 2026-06-14
- **Scope:** `/Users/ostehost/projects/command-central`
- **Under review:**
  - Fix: `98732e82 fix(agent-status): stable TreeItem.id anchors History tree-resolve storm`
  - Handoff: `82da1352 docs(research): record History click rattle diagnosis + stable-id fix`
  - UX guardrails: `ad77b307`, `e94f32db`
- **Mode:** read-only. Working tree left untouched (verified clean; all probes run from `/tmp`, deleted after use).

---

## VERDICT: ACCEPT_WITH_FIXUPS — one **required** (blocking-for-flat-mode) fixup

The core fix is sound and a real improvement in the **default** configuration
(`groupByProject=true`, grouped mode). Project / folder / task / discovered /
openclaw / status-group / time-group identities are stable, count-free,
position-independent, and globally unique — verified at runtime, including the
`olderRuns` overflow path.

**However the fix introduces one real, reproducible duplicate-`TreeItem.id`
regression in the supported non-default mode `commandCentral.agentStatus.groupByProject=false`
(flat mode).** This reintroduces the exact failure class the commit message
says it set out to avoid ("a duplicate id is a hard 'already registered' tree
crash — worse than the soft resolve error"). It is **not** caught by any test,
because the new uniqueness test only exercises grouped mode.

Do **not** revert the commit — reverting reintroduces the 204-failure resolve
storm in the default mode, which is far worse. The remedy is a ~3-line fixup
(below). If the team's bar is "no known hard-crash in any supported config on
`main`," treat this as **BLOCKED until the one fixup lands**; the fixup is
trivial enough to ship immediately.

---

## BLOCKER-CLASS FINDING — duplicate `id:"summary"` at root in flat mode

### What
`getStableTreeItemId` maps **every** `type:"summary"` node to the constant id
`"summary"`:

```ts
// src/providers/agent-status-tree-provider.ts:3690 (case in getStableTreeItemId)
case "summary":
    return "summary";
```

But the root render in flat mode emits **two** `type:"summary"` siblings:

1. The V2 section-count summary — `src/providers/agent-status-tree-provider.ts:3921-3929`
   (`summaryNodes` is non-empty only when `!groupedByProject`).
2. The Sources provenance summary — added unconditionally at
   `src/providers/agent-status-tree-provider.ts:3934`, produced by
   `createSourcesProvenanceSummaryNode` which returns `type:"summary"`
   (`src/providers/agent-status-tree-provider.ts:6480-6489`).

Both get `item.id = "summary"` → duplicate id at the root.

In real VS Code an explicit `TreeItem.id` is used as a non-parent-qualified
handle, so two nodes sharing `"summary"` trigger
**"Element with id summary is already registered"** — a hard render failure.
Before this fix neither summary node carried an id, so each used a distinct
position/label-derived handle and there was no collision. **This is a regression
introduced by the fix.**

### Reachability — REAL, not theoretical
- `isProjectGroupingEnabled()` defaults to `true`
  (`src/providers/agent-status-tree-provider.ts:4306-4309`), so the **default**
  config is safe.
- Flat mode is a first-class supported state: it has a config key
  (`commandCentral.agentStatus.groupByProject`), a change listener
  (`:1407`), and dedicated render/`getParent` branches (`:3887-3889`, `:7677+`).
  A user who has set `groupByProject=false` goes from tolerable soft resolve
  errors to a hard "already registered" tree-render failure — a strict
  regression for those users.

### Runtime proof (flat mode)
Probe (run from `/tmp`, importing the test harness by absolute path; deleted after):

```
ROOT TYPES:            summary, summary, task, task
SUMMARY NODE COUNT:    2
ROOT IDS:              ["summary","summary","task:t-run","task:t-done"]
DUPLICATE IDS AT ROOT: ["summary"]
```

The bun `vscode` mock does **not** enforce id uniqueness (TreeItem is a plain
object), so this never surfaces in tests — only in the real VS Code runtime.

### Smallest exact fix (for the fixup lane — NOT applied here)
Add a discriminator to the provenance summary node and branch on it. Three edits:

1. `SummaryNode` interface (`:417-421`) — add an optional field:
   ```ts
   export interface SummaryNode {
       type: "summary";
       label: string;
       tooltip?: string;
       kind?: "sources"; // discriminates the Sources provenance summary
   }
   ```
2. `createSourcesProvenanceSummaryNode` (`:6483`) — tag it:
   ```ts
   return { type: "summary", kind: "sources", label: /* … */, tooltip: /* … */ };
   ```
3. `getStableTreeItemId` summary case (`:3689-3690`):
   ```ts
   case "summary":
       return element.kind === "sources" ? "summary:sources" : "summary";
   ```

Label-deriving the id is **not** an option (the provenance label embeds live
counts — exactly the volatility this fix removes), so a structural discriminator
is required. Both ids stay stable across refreshes.

### Regression test the fixup lane should add (currently missing)
The new test's full-tree uniqueness walk uses `groupByProject: true` only
(`agent-status-tree-item-stable-id.test.ts` → `setAgentStatusConfig(h.vscodeMock, { groupByProject: true })`).
Add a flat-mode case that asserts root id uniqueness — it fails today, passes
after the fixup:

```ts
test("flat mode root assigns unique ids (no duplicate 'summary')", () => {
    setAgentStatusConfig(h.vscodeMock, { groupByProject: false });
    provider.readRegistry = () => createMockRegistry({
        "t-run":  createMockTask({ id: "t-run",  status: "running",   project_dir: "/p/a", project_name: "A" }),
        "t-done": createMockTask({ id: "t-done", status: "completed", project_dir: "/p/a", project_name: "A" }),
    });
    provider.reload();
    const ids = provider.getChildren(undefined)
        .map((n) => provider.getTreeItem(n).id)
        .filter((id): id is string => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length); // FAILS today: two "summary" ids
});
```

---

## Checks that PASSED (no other duplicate / stale-id hazards found)

| Area | id formula | Verdict | Evidence |
|---|---|---|---|
| `task` | `task:<task.id>` | ✅ unique | Registry keyed by id. Visible vs `olderRuns` hidden sets are mutually exclusive (`applyAgentVisibilityCap` `:4741-4795`). Runtime walk of 14 completed (4 in expanded `olderRuns`) + running + failed → 0 dupes. |
| `discovered` | `discovered:<agent.pid>` | ✅ unique | `pid: number` is required (`src/discovery/types.ts:3`), unique per snapshot. No undefined-id risk. |
| `openclawTask` | `openclaw:<task.taskId>` | ✅ unique | Inline openclaw (flat) and `backgroundTasks` children (grouped) are mutually exclusive (`showOpenClawInline` `:3861`, `:3935`). |
| `projectGroup` | `project:<dir ?? name>` / `project:__unregistered__` | ✅ unique | Unregistered sentinel can't collide with a same-named project. A project renders under exactly one folder or top-level (`getParent` flatMap `:7561-7563`). |
| `folderGroup` | `folder:<groupKey>` | ✅ unique | groupKey is the folder's stable key. |
| `statusGroup` | `status-group:<status>:<dir??name>:<groupKey??>` | ✅ unique + count-free | `:8958`. Project-qualified → distinct across projects; single top-level group when ungrouped. |
| `statusTimeGroup` | `status-time-group:<status>:<period>:<dir??name>:<groupKey??>` | ✅ unique | `:8969`. |
| `summary` (provenance, grouped) | `summary` | ✅ unique | Only one summary in grouped/empty states (runtime: grouped walk → single `summary`). |
| `backgroundTasks` | `backgroundTasks` | ✅ unique | At most one per render. |
| Deliberate omissions | `olderRuns`, `state` → `undefined` | ✅ correct | Count-bearing / parent-ambiguous; left to VS Code's derived handle. Never targeted by `reveal()`. |

### Stale-id resistance — sound
IDs derive from project dir, task id, pid, or group key — never index, label,
live count, or sort position. Verified: project id invariant across `(2)→(5)`
count changes and across sort order; status-group id invariant across `· 2`/`· 5`.

### `getParent` / reveal consistency — sound
`getParent` (`:7542+`) reconstructs project/status nodes from the same
`buildGroupedRootNodes` / `getProjectGroupChildren` inputs, so the parent it
returns yields the same stable id that `getChildren` registered. No stale-handle
divergence introduced.

### Symphony view — covered
One provider class renders both `agentStatus` and `symphony`; the new test
asserts identical ids in both. (Symphony's own dashboard/run-group rows return
`undefined` from `getStableTreeItemId` by design — out of the resolve-storm
path.) Note: the flat-mode summary collision is specific to the `agentStatus`
view (symphony has its own root children), so the single fixup fully closes it.

### Test quality — projectGroup coverage is tight (per task check #2)
By inspection of the assertions in `agent-status-tree-item-stable-id.test.ts`:
- **Remove the `projectGroup` case** → id becomes `undefined` →
  `expect(itemTwo.id).toBe("project:<dir>")` fails; full-tree
  `ids.some(id => id.startsWith("project:"))` fails.
- **Label-derive the id** (e.g. `project:<label>`) → label contains `(2)` →
  `not.toContain("(")` and `not.toContain("2")` fail; count-invariance
  `small.id === large.id` fails.

These guards do their job. The **gap** is solely the missing flat-mode root
uniqueness case described above.

---

## Commands run (evidence)

```bash
bun test test/tree-view/agent-status-tree-item-stable-id.test.ts   # 11 pass / 0 fail
bun test test/tree-view/                                           # 477 pass / 0 fail (broad cheap gate)
# /tmp throwaway probes (deleted after run):
#   flat-mode root  -> DUPLICATE IDS AT ROOT: ["summary"]
#   grouped deep walk (folders + olderRuns expanded) -> 23 unique ids, 0 dupes
git status --porcelain                                             # clean (working tree untouched)
```

## Summary for the fixup lane
1. **Required fixup:** discriminate the Sources provenance summary id
   (`summary:sources`) so flat mode has no duplicate `summary` id. ~3 edits at
   `:417`, `:6483`, `:3689-3690`.
2. **Required test:** add the flat-mode root-uniqueness case (snippet above) to
   `agent-status-tree-item-stable-id.test.ts`; it red→green proves the fix.
3. Everything else in `98732e82` is correct and should stay.
