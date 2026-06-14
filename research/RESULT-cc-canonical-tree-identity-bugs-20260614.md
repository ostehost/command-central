# RESULT — cc-canonical-tree-identity-bugs-20260614

Canonical Agent Status tree-identity refactor: bug hunt + fix.

## Verdict

**One real design-smell bug found and fixed**, plus one related integration
point tightened. The rest of the canonical refactor is sound: a single identity
function drives both `TreeItem.id` and refresh coalescing, and every other node
namespace is already content-independent and globally unique.

## The bug

`getStableTreeItemId`'s `olderRuns` case still derived the bucket's identity by
**hashing its hidden-node set**:

```ts
const hiddenIds = element.hiddenNodes
  .map((node) => this.getStableTreeItemId(node))
  .filter(...)
  .sort()
  .join(",");
return `olderRuns:${parentScope}:${hiddenIds}`;
```

This was the last residue of the retired `getOlderRunsStableId` hack. Two
problems:

1. **Not refresh-stable (violates "IDs never depend on mutable content").**
   Hidden-node membership churns every time a completed lane ages in or out of
   the visibility cap. A content-derived id therefore silently re-keys the node
   on each refresh — VS Code sees a brand-new node, the "Show N older
   completed..." bucket loses its expand/collapse state, and a targeted refresh
   keyed on the old id no-ops.

2. **The hash was load-bearing for collision avoidance.** A project with >5
   lanes sub-groups by status; `getStatusGroupChildren` → `applyAgentVisibilityCap`
   passed the project scope but **not** the status, so two sibling buckets under
   one project (e.g. `done` and `limbo`) both resolved to `olderRuns:<project>:`
   and were distinguished *only* by the hidden hash. Dropping the hash naively
   would have produced a duplicate id — a hard VS Code "element already
   registered" tree crash. The cap returns early when `allHidden.length === 0`,
   so this stayed latent in practice, but the identity function itself was one
   refactor away from a crash and was not collision-safe on its own terms
   (checks #4/#5).

## The fix

Scope the `olderRuns` id on **(status, project, group)**, mirroring the
`statusGroup` key exactly, with no reference to the hidden set or the
count-bearing label:

```ts
return `olderRuns:${element.parentStatus ?? ""}:${
  element.parentProjectDir ?? element.parentProjectName ?? ""
}:${element.parentGroupKey ?? ""}`;
```

- Added `parentStatus?: AgentStatusGroup` to `OlderRunsNode`.
- Threaded `parentStatus: node.status` from `getStatusGroupChildren` through the
  `applyAgentVisibilityCap` options onto the constructed node. The flat-root and
  background-tasks lanes leave it undefined (each hosts a single bucket).
- `applyAgentVisibilityCap` emits at most one bucket per (status, project,
  group), so the scope key is provably unique without hashing contents, and the
  identity is now stable across refreshes.

### Why it stays unique

- Per-project per-status buckets differ by `parentStatus`.
- A ≤5-lane project's single bucket has no status; a >5-lane project's buckets
  carry status — mutually exclusive per project, so no overlap.
- Flat-root and background-tasks buckets both reduce to `olderRuns:::`, but the
  two lanes live in opposite modes (`groupByProject` on vs off) and each is a
  singleton, so they never coexist. A real project never reduces to the empty
  triple (it always has a name), so it never collides with the root buckets.

### Related integration point tightened

`findElementParent` located an `olderRuns` parent by matching the **volatile
label** (`node.label === element.label`) plus project fields. The label
re-counts on every refresh and could not distinguish sibling-status buckets.
Switched it to compare the **one canonical id** (`getStableTreeItemId(node) ===
getStableTreeItemId(element)`), removing the label dependency and routing parent
resolution through the same single identity path.

## Checks against the task's 8 criteria

1. **One canonical identity function** — confirmed. `getStableTreeItemId` is the
   sole source; `getRefreshElementKey` delegates to it; there is exactly one
   `item.id = …` assignment in the file (`getTreeItem`).
2. **id / refresh coalescing cannot diverge** — both go through
   `getStableTreeItemId`; unchanged and reinforced.
3. **No dependency on label / count / sort / index / mutable text** — was
   violated by `olderRuns` (hidden-set hash); now fixed. All other cases already
   compliant.
4. **Global uniqueness across grouped + flat** — verified by enumeration above
   and by the full-render walk tests (no duplicate ids).
5. **olderRuns empty / mixed hidden handled safely** — identity no longer
   touches `hiddenNodes` at all, so empty or mixed sets are irrelevant.
6. **Tests lock the design, not examples** — rewrote the olderRuns unit test to
   assert membership- *and* label-independence + status/project qualification;
   added a sibling-status collision test, a cross-project distinctness test, and
   a grouped-render test that produces a real bucket and asserts a content-free,
   collision-free id.
7. **No stale prose** — removed the "uses the canonical hidden-node identities"
   test name/comment; updated the `findElementParent` comment. The header note
   about `state` rows is still accurate (`state` intentionally returns
   `undefined`). The dated `RESULT-cc-history-olderruns-rc63-live-retest-20260614.md`
   references the old `getOlderRunsStableId`; it is a historical retest snapshot
   of rc.63 and was left intact rather than rewritten.
8. **No lint / type / test regressions** — see below.

## Files changed

- `src/providers/agent-status-tree-provider.ts`
  - `OlderRunsNode`: added `parentStatus?: AgentStatusGroup`.
  - `getStableTreeItemId` `olderRuns` case: scope-based id, no hidden-set hash.
  - `applyAgentVisibilityCap`: options gain `parentStatus`, propagated onto node.
  - `getStatusGroupChildren`: passes `parentStatus: node.status`.
  - `findElementParent`: olderRuns parent match now uses the canonical id.
- `test/tree-view/agent-status-tree-item-stable-id.test.ts`
  - Rewrote the olderRuns identity test; added 3 tests (sibling-status,
    cross-project, grouped-render).

## Commands run & results

| Command | Result |
| --- | --- |
| `bun test test/tree-view/agent-status-tree-item-stable-id.test.ts` | 17 pass / 0 fail |
| `bun test` (history-native-rows + diff-notifications + discovery) | 137 pass / 0 fail |
| `bun test test/tree-view/` | 483 pass / 0 fail |
| `bunx biome check` (the 2 changed files) | clean, no issues |
| `bunx tsc --noEmit` | exit 0 |
| `just check` | passed (8 pre-existing warnings, all in untouched files / Knip — informational) |
| `just test-unit` | 129 + 512 pass / 0 fail |
| pre-commit hook (Biome on staged) | passed |

## Remaining risks / blockers

- **None blocking.** The id format for `olderRuns` changed, so existing
  expand/collapse state for that bucket resets **once** on the first render after
  upgrade — expected and benign (the whole point is that it stays stable from
  then on).
- The `getProjectGroupChildren` ≤5 path and the flat-root/background lanes leave
  `parentStatus` undefined by design; documented in the type and verified
  collision-free above.
- `RESULT-cc-history-olderruns-rc63-live-retest-20260614.md` is now historically
  stale (mentions `getOlderRunsStableId`); left as a dated snapshot, not active
  code/tests.
- Not run (out of scope per task): no VSIX cut, no install, no push/tag/publish.

## Git status

- Working tree: clean (`git status --porcelain` empty).
- HEAD: `0c6ca0d0` — `fix(agent-status): scope olderRuns identity to parent, not hidden-node hash`
- Branch `main`, 40 commits ahead of `origin/main` (not pushed).
