# RESULT — Flat-mode duplicate summary TreeItem.id fixup

- **task_id:** `cc-history-stable-id-flat-fixup-20260614`
- **date:** 2026-06-14
- **fix commit:** `4690bc95` — `fix(agent-status): distinct stable id for flat-mode Sources summary`
- **regressed by:** `98732e82` — `fix(agent-status): stable TreeItem.id anchors History tree-resolve storm`
- **found by:** adversarial review `cc-history-stable-id-adversarial-review-20260614`
- **verdict:** ✅ Fixed. Smallest viable patch landed with a regression test that fails without the discriminator. Full suite green, `just check` clean on touched files.

## The regression

`98732e82` anchored structural nodes to stable `TreeItem.id` values at the
`getStableTreeItemId` chokepoint. For `type:"summary"` it returned the constant
string `"summary"`.

That is unique in the **default grouped mode** (`groupByProject=true`): the only
root-level summary node there is the Sources provenance feed.

But **supported flat mode** (`commandCentral.agentStatus.groupByProject=false`)
renders **two** summary siblings at the root, built in
`getChildren(undefined)` (`src/providers/agent-status-tree-provider.ts`):

1. **V2 count summary** — `summaryNodes`, only emitted when `!groupedByProject`
   (≈ line 3921), label like `formatV2Summary(...) · N background tasks · N stuck`.
2. **Sources provenance summary** — `createSourcesProvenanceSummaryNode(...)`,
   emitted unconditionally (≈ line 3934), label `Sources · …`.

Both resolved to `id === "summary"`. Runtime proof of the duplicate root id:

```
["summary","summary","task:t-run","task:t-done"]
```

VS Code rejects a duplicate `TreeItem.id` with a hard render failure —
`Element with id summary is already registered` — which is strictly worse than
the soft "Failed to resolve tree node" error the original commit was fixing.

## The fix (minimal)

Three-line behavioral change in `src/providers/agent-status-tree-provider.ts`:

1. **Discriminator** on the node type:
   ```ts
   export interface SummaryNode {
     type: "summary";
     label: string;
     tooltip?: string;
     kind?: "sources"; // only the Sources provenance node sets this
   }
   ```
2. **Tag** the Sources node at its single factory
   (`createSourcesProvenanceSummaryNode`), so all four call sites inherit it:
   ```ts
   return { type: "summary", kind: "sources", label: ..., tooltip: ... };
   ```
3. **Distinguish** in `getStableTreeItemId`:
   ```ts
   case "summary":
     return element.kind === "sources" ? "summary:sources" : "summary";
   ```

Result: Sources summary → `summary:sources`; ordinary count summary → `summary`.
Grouped-mode ids are entirely unchanged (the only grouped root summary is the
Sources node, now `summary:sources` — still globally unique).

### Deliberately NOT changed

`getRefreshElementKey` (a separate method, ≈ line 1625) also maps both summary
nodes to `"summary"`. That key drives per-element **refresh coalescing**, not the
VS Code-registered `TreeItem.id`, so a collision there cannot cause the
"already registered" crash — at worst a fine-grained refresh of one root summary
also nudges the other, and the provider refreshes globally on reload anyway.
Left untouched to keep the patch scoped to the registered-id regression the
review identified.

## Tests

`test/tree-view/agent-status-tree-item-stable-id.test.ts` (+2 tests):

- **"the two flat-root summary nodes get distinct ids (count vs Sources
  provenance)"** — node-level: count summary → `summary`, sources summary →
  `summary:sources`, and they differ.
- **"a full FLAT render assigns globally-unique ids (root summaries do not
  collide)"** — drives a real `groupByProject=false` render (one running + one
  done lane), walks the whole tree asserting every `TreeItem.id` is unique, and
  asserts both `summary` and `summary:sources` are present.

**Proven to catch the regression:** with the `getStableTreeItemId` change
reverted, exactly these two tests fail (duplicate-id collision + missing
`summary:sources`) while all 11 pre-existing stable-id tests still pass —
confirming grouped-mode coverage is unaffected.

Two existing exact-shape (`toEqual`) assertions on the Sources summary node were
updated for the new `kind` field (no behavior change, just shape):

- `test/tree-view/agent-status-tree-provider.test.ts`
- `test/integration/tasks-json-startup-smoke.test.ts`

## Verification

| Command | Result |
| --- | --- |
| `bun test test/tree-view/agent-status-tree-item-stable-id.test.ts` | 13 pass / 0 fail |
| `bun test test/tree-view/` | 478 pass / 0 fail |
| `bun test test/tree-view/ + tasks-json-startup-smoke` | 489 pass / 0 fail |
| `just test` (full suite) | 2120 pass / 1 skip / 0 fail |
| `just check` | ✅ complete; 8 pre-existing warnings only in `agent-status-perf-caches.test.ts` (untouched) — no new findings on changed files |

## Files changed

- `src/providers/agent-status-tree-provider.ts`
- `test/tree-view/agent-status-tree-item-stable-id.test.ts`
- `test/tree-view/agent-status-tree-provider.test.ts`
- `test/integration/tasks-json-startup-smoke.test.ts`

## Scope notes

- No push / tag / publish performed.
- Staged only this lane's four paths (sibling lanes share the working copy; an
  untracked `research/RESULT-cc-history-dead-row-action-audit-20260614.md` from
  another lane was left untouched).
- No `--no-verify`; pre-commit Biome hook passed on the staged files.

## Next steps

None required. If a future change adds a third distinct root-level summary
variant, give it its own `kind` value and a matching `summary:<kind>` branch in
`getStableTreeItemId` — the same pattern this fix established.
