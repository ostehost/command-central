# RESULT — Command Central Agent Status "History click rattle" diagnosis (live rc.61)

- **Task:** `cc-history-rattle-diagnosis-20260614`
- **Repo:** `/Users/ostehost/projects/command-central` (Mike MacBook Pro)
- **Branch:** `main` — HEAD `98732e82` (my fix), parent `e94f32db`
- **Installed VSIX:** `releases/command-central-0.6.0-rc.61.vsix` (live). rc.61 was cut at
  `19ea6c9f`; the V2 project-first section model (`5f1c9d63`) **is** in rc.61, and source
  HEAD is only docs/tests ahead of the cut — so the installed extension matches the code I
  diagnosed.
- **Tree:** clean (`git status --porcelain` empty after commit).

---

## Verdict: **GO**

Root cause found with direct evidence from the live extension-host log, a minimal native
fix landed (`98732e82`), and the full gate is green. The fix is render-only (stable
`TreeItem.id`), touches no task data or history, and cannot drop or hide any lane.

---

## Mike's question, answered plainly

**Is the rattle performance, an invalid interaction, or a VS Code alert from a failing
command?**

> It is a **VS Code tree-view identity / node-resolution storm**, surfaced as audible
> alert feedback — **not raw rendering performance, and not an invalid command on the
> History row.** The History section header carries no command (the sibling commit
> `ad77b307` already locked that), so clicking it only toggles native expand/collapse.
> What actually fires is VS Code repeatedly failing to *resolve* the History node (and the
> project-group headers above it) because those nodes had no stable identity. Each failure
> is logged as an error and the list/tree widget emits the system alert; because the tree
> re-resolves on every refresh while agents are active, the failures arrive in rapid bursts
> — the "rattle."

Performance (synchronous tmux/git probes on the render path) is a *separate, real* P2 the
prior lane flagged; it can add jank but is not the source of the sound. The audible defect
is the resolve storm.

---

## Evidence (the smoking gun)

Live VS Code extension-host log
(`~/Library/Application Support/Code/logs/20260611T150816/window2/exthost/exthost.log`)
contains **204** errors of the form:

```
[error] [TreeView:commandCentral.agentStatus] Failed to resolve tree node for element 1/status-group:done:/Users/ostehost/projects/command-central:
[error] [TreeView:commandCentral.symphony]    Failed to resolve tree node for element 0/0:🎛️ COMMAND CENTRAL ▼ (47)
```

Breakdown: **62 on `commandCentral.agentStatus`, 163 on `commandCentral.symphony`** (one
shared provider class renders both views). They concentrate on exactly two shapes:

1. `status-group:done:<projectDir>:` — the **History** section header.
2. `0/0:🎛️ COMMAND CENTRAL ▼ (N)` — a **project-group** header whose label embeds a live
   count `(N)`.

### Why it happens (mechanism)

- `createProjectGroupItem()` set **no `item.id`**. With no explicit id, VS Code derives a
  node's handle from `parentHandle / position / displayLabel`.
- The root project groups are **activity-sorted** (`compareProjectGroups` →
  running-first, then freshest-activity-desc), so a project's **position changes** as
  agents start/finish.
- The project-group **label embeds a live `(N)` count** (`… ▼ (47)`), so the label
  **changes** on every refresh as counts move.
- Either change invalidates the derived parent handle. The History node *does* have a
  stable own id (`status-group:done:<dir>:`), but its full handle is
  `<parentHandle>/status-group:done:<dir>:` — so when the parent handle goes stale, the
  whole descendant chain can no longer be resolved.
- On the next refresh / reveal / expansion-state restore (and refreshes are frequent while
  agents run), VS Code tries to resolve the stale handle, fails, logs the error, and the
  widget emits alert feedback. Repeated → audible rattle, reproducible on the dense History
  surface.

This is consistent with — and supersedes for *this* symptom — the prior lane's rc.60
finding (`research/RESULT-cc-rattle-perf-critical-bugs-20260613.md`) that an *ambient*
rattle was external terminal-notifier noise. That predates the V2 project-first model; the
**click-on-History** rattle is this new tree-identity bug introduced with the project-first
sections.

---

## Fix (minimal, native) — commit `98732e82`

Anchor every structural node to a **stable, globally-unique `TreeItem.id`** at the single
`getTreeItem` chokepoint, so node handles stop depending on index / label / count / sort.

`src/providers/agent-status-tree-provider.ts`:
- `getTreeItem()` now fills `item.id` from a new `getStableTreeItemId(element)` **only when
  the create method didn't already set one** (status/time groups keep their existing
  project-qualified ids — untouched).
- `getStableTreeItemId()` returns globally-unique ids:
  `task:<id>`, `discovered:<pid>`, `openclaw:<taskId>`,
  `project:<projectDir ?? projectName>` (with a `project:__unregistered__` sentinel),
  `folder:<groupKey>`, `summary`, `backgroundTasks`.
- Deliberately returns `undefined` for `olderRuns` (label embeds a count) and transient
  `state` rows (label can repeat under multiple parents) — leaving VS Code's derived handle
  in place. A volatile or colliding id would be worse: a duplicate id is a hard
  "Element with id … already registered" tree crash.

Scheme mirrors the existing `getRefreshElementKey` identities, so ids and refresh-coalescing
keys agree (the one intentional divergence: `statusGroup`, whose refresh key is
project-agnostic and would collide as an id — the create method already supplies the correct
project-qualified id there).

Covers **both** `commandCentral.agentStatus` and `commandCentral.symphony` (same provider
class, single chokepoint).

### Edge cases audited (per manager guardrails)
- **projectGroup without `projectDir`** → falls back to `projectName`; `buildProjectNodes`
  groups one node per `projectDir||projectName||identity`, so a given dir/name yields exactly
  one group → no collision. Unregistered bucket uses the `__unregistered__` sentinel so it
  cannot collide with a (contrived) project literally named "Unregistered projects".
- **olderRuns / state** → left unanchored (count-bearing / parent-ambiguous labels).
- **`discovered:<pid>`** → used only for live discovered process rows (never persisted
  history identity).

---

## Tests — `test/tree-view/agent-status-tree-item-stable-id.test.ts` (new, 11 tests)

- projectGroup id is `project:<dir>`, **defined**, and free of the `(N)` count.
- projectGroup id **invariant across count/label changes** and **independent of sort
  position**.
- unregistered sentinel does not collide with a same-named project.
- History `status-group:done` id is project-qualified and **count-invariant**; distinct
  across projects (no cross-project collision).
- task leaf `task:<id>`; folder `folder:<groupKey>`.
- olderRuns / state intentionally `undefined`.
- **symphony view yields identical ids** (both failing views covered).
- **full grouped render → every structural node id is globally unique** (guards against the
  "already registered" crash).

**Regression proof:** temporarily neutralizing the projectGroup id makes **5 of 11** tests
fail; restored → 11/11 green.

---

## Commands & exit status

| Command | Result |
|---|---|
| `bun test test/tree-view/agent-status-tree-item-stable-id.test.ts` | 11 pass / 0 fail |
| `bun test test/tree-view/` | 477 pass / 0 fail |
| `bunx tsc --noEmit` | exit 0 |
| `just check` (biome ci + tsc + knip) | pass (8 pre-existing warnings in `agent-status-perf-caches.test.ts`, not introduced here) |
| `just test-unit` | 129 + 512 pass / 0 fail |
| `just test` (full + typecheck + quality) | **2118 pass / 1 skip / 0 fail**, "✅ Quality checks passed", "✅ Zero 'as any'" |
| pre-commit Biome hook | passed (no `--no-verify`) |

---

## Files changed

- `src/providers/agent-status-tree-provider.ts` — `getTreeItem` chokepoint +
  `getStableTreeItemId` helper (+62 / −1).
- `test/tree-view/agent-status-tree-item-stable-id.test.ts` — new (362 lines, 11 tests).

Commit: **`98732e82`** — `fix(agent-status): stable TreeItem.id anchors History tree-resolve storm`.

No push / tag / publish. No other repos mutated. Launcher dependency not touched (no
launcher defect blocked this task).

---

## Follow-ups (not done; out of scope here)

1. **Perf P2 (separate):** `createTaskItem` calls the *live* `getTerminalTaskLivenessEvidence`
   (`execFileSync tmux …`) for every done/History row — synchronous subprocess on the EH main
   thread when History expands. Cached 5 s, but still N spawns on first expand. Async-ify or
   TTL-tune; behavior-sensitive, needs its own tests. (Matches the prior lane's P2.)
2. **`getRefreshElementKey` statusGroup key is project-agnostic** (`status-group:<status>`).
   Harmless today (coalescing only) but a latent footgun; consider project-qualifying it to
   match the TreeItem id.
3. **Validate live:** after the next RC that includes `98732e82`, confirm the
   `Failed to resolve tree node` errors are gone from the exthost log and the History click no
   longer rattles.
