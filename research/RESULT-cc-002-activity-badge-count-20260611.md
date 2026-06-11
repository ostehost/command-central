# RESULT — CC-002: Activity bar badge count + canonical worktree grouping

- **Task ID:** `cc-002-activity-badge-count-20260611`
- **Date:** 2026-06-11
- **Worktree:** `/Users/ostehost/projects/command-central-cc-002-activity-badge-20260611` (detached, isolated from the CC-001 main worktree as instructed)
- **Start HEAD:** `ed3b2f442a354b6ca913ec315875040acc12b0e9` (clean tree at start)
- **Fix commit:** `b6254933a182459ece04090d47093720fbda4ab1` — provider changes. Note: this commit was created by the launcher's auto-commit hook (`chore: auto-commit agent work [cc-002…]`, author `Oste Agent`) while the implementation session was running; per the no-reset/no-rewrite hard stop it was left as-is rather than amended into a conventional message. The descriptive history lives in the follow-up test commit and this receipt.
- **Test commit:** `test(agent-status): cover single-owner activity badge and canonical worktree grouping`, on top of `b6254933`
- **Final HEAD:** the `docs(research)` commit adding this receipt, directly on top of the test commit

## Live-state explanation of badge = 4 (and the earlier badge = 2)

The Command Central activity bar number is **VS Code's sum of every
`TreeView.badge` inside the `commandCentral` view container** — it is not a
value the extension sets directly. The container holds two tree views built
from the *same* provider class over the *same* data
(`src/extension.ts:442-464`):

- `commandCentral.agentStatus` → `AgentStatusTreeProvider` (default mode)
- `commandCentral.symphony` → `AgentStatusTreeProvider` (`viewMode: "symphony"`)

Both instances ran `updateDockBadge()` / the grouped-mode badge write and
each set `badge = { value: runningCount }` on its own view. The workbench
then summed them:

| Live registry state (`~/.config/ghostty-launcher/tasks.json`, read-only) | Per-view truth | Activity bar badge |
| --- | --- | --- |
| Screenshot 1: `cc-001-health-followup` running, `cc-001-openclaw-down-health` completed → 1 running | Both views showed 1 running | **2** = 1 × 2 views |
| Screenshot 2 (dogfood feedback): cc-001 follow-up + cc-002 (this lane) running → 2 running | Symphony "2 running", Agent Status "2 working" | **4** = 2 × 2 views |

So the badge was **cross-surface double-counting (Symphony + Agent Status)**,
not "total run attempts": an attempts-based bug would have shown 2 and 3,
not 2 and 4. OpenClaw mirroring and discovery duplication were ruled out:
OpenClaw tasks that mirror launcher lanes are already deduped
(`getNonLauncherOpenClawTasks`), discovered agents are deduped against
launcher tasks by `AgentRegistry.getDiscoveredAgents(launcherTasks)`, and in
both screenshots each view's own counts matched the true running count.
The original CC-002 hypothesis ("badge counts completed attempts") is
disconfirmed — completed tasks never entered any badge count; the
multiplier was the second view.

## Fix 1 — single badge owner, one count source (`src/providers/agent-status-tree-provider.ts`)

- New `ownsActivityBadge` guard: only the `viewMode === "agentStatus"`
  provider may write badges; the Symphony provider never touches
  `TreeView.badge`, the best-effort macOS dock badge, or the dispose-time
  clear. Container badge = working count, counted once.
- Removed the second, independent badge writer (the grouped-mode inline
  write in `getChildren()` used `agentCounts.working`, a slightly different
  count than `updateDockBadge()`'s `getTasks()` source). Both paths now call
  the single `updateDockBadge()`, whose source is `getTasks()` — the same
  source the `AgentStatusBar` status bar item uses, so badge, status bar,
  and sidebar agree by construction.
- View badge is now updated on every platform; previously
  `updateDockBadge()` returned early off-darwin, so on Linux/Windows the
  view badge only updated in grouped mode (stale/never-set in flat mode).
  The macOS dock badge and dock-attention paths remain darwin-only.

**Badge semantics (design decision):** the badge counts `status === "running"`
work (launcher lanes excluding auto-review lanes, deduped discovered agents,
non-mirrored running OpenClaw background tasks). Failed/attention tasks do
**not** inflate it — attention has its own surfaces (Attention bucket, dock
bounce, status bar tooltip), and the badge tooltip says "N working agents".
If product later wants attention included, change the filter inside
`updateDockBadge()` only; there is now exactly one writer.

## Fix 2 — canonical worktree grouping (`buildProjectNodes`)

**Root cause:** project groups were keyed by `dir:${project_dir}`. A lane in
a detached worktree (`…/command-central-cc-002-activity-badge-20260611`) got
its own group, displayed via the launcher's path-derived
`visible_project_name` → "COMMAND-CENTRAL CC 002 ACTIVITY BADGE 20260611",
even though the registry already records the canonical identity
`project_id: "command-central"` on every lane.

**Fix:**
- Group key is `id:${project_id}` whenever the task has a `project_id`;
  `dir:`/`name:` keys remain the fallback for legacy tasks.
- Identity-keyed groups take the project's own `project_name` (falling back
  to the id), never a per-lane worktree label
  (`getProjectGroupDisplayName`).
- A lane without `visible_project_name` is treated as the canonical checkout
  (`isCanonicalProjectLane`); its display name and `project_dir` win for the
  merged group regardless of registry order, so the group anchors on the
  main repo dir (icons, filters, `commandCentral.project.group` overrides,
  tree-item identity).
- A dir→groupKey map routes legacy no-`project_id` tasks and discovered
  agents whose dir matches any claimed checkout (main or worktree) into the
  same canonical group. Discovery already resolves linked worktrees to
  `mainRepoDir` (`getDiscoveredProjectDir`), so both paths converge.
- Explicit user-visible identity still wins where it always did: the
  `commandCentral.project.group` setting override operates on the merged
  group's canonical dir, unchanged.

Result: the cc-002 lane now appears under **COMMAND CENTRAL** together with
the cc-001 lanes (verified by tests mirroring the live registry's exact
field values).

## Tests (`test/tree-view/agent-status-activity-badge.test.ts`, 12 new)

Badge:
- running + completed → badge 1 ("1 working agent")
- all completed → badge cleared (after previously showing 1)
- 3 running → badge 3 ("3 working agents")
- failed + running → badge 1 (attention doesn't inflate working count)
- **symphony provider never writes a view badge** (flat and grouped paths)
- grouped and flat modes report the same badge for the same registry

Grouping (fixtures mirror the live tasks.json fields):
- worktree lane + canonical lane → one group, name "Command Central", dir =
  main repo; both tasks inside
- canonical identity wins regardless of registry order
- worktree-only group shows `project_name` ("command-central"), never the
  path-derived label
- legacy task without `project_id` joins the id group via shared dir
- discovered agent in the worktree dir joins the canonical group
- distinct `project_id`s keep distinct groups

## Verification

- `bun test test/tree-view/agent-status-activity-badge.test.ts` — 12 pass
- Focused neighbors (`…-discovery`, `…-rendering`, `agent-status-bar-count`,
  `agent-counts`) — 159 pass
- `just test-unit` — 459 pass
- `just test` (full suite + typecheck + quality checks) — 1942 pass, 0 fail,
  1 pre-existing skip
- `just check` — biome + tsc + knip clean

**Why provider-level tests are the proof:** `TreeView.badge` is write-only
through the VS Code API and the container sum is composited inside the
workbench renderer; neither the integration-test API
(`src/services/integration-test-api.ts`) nor any extension-host API can read
the activity bar number back. The tests pin the only things the extension
controls — which provider writes, and what value — and the sum-of-badges
behavior is VS Code's documented container semantics (observed live: 2 = 1×2,
4 = 2×2).

## Remaining risks / follow-ups

- **Worktree-only groups show the slug** (`project_name` =
  "command-central"), not the prettier "Command Central", when no canonical
  lane is present in the registry window. Cosmetic; fixable by
  title-casing the id or having the launcher write the display name on
  worktree lanes too.
- **Badge includes running OpenClaw background tasks** (non-mirrored). This
  matches the status bar and "active work" semantics, but differs from the
  tree's agent-only headline count. If that ever confuses, narrow
  `updateDockBadge()`'s source — single writer makes that a one-line change.
- **Discovered agents without git worktree metadata** in an *unclaimed*
  worktree dir still form their own group (no launcher lane to map the dir,
  discovery couldn't resolve `mainRepoDir`). Same behavior as before the
  fix.
- The launcher auto-commit hook captured the source change before tests
  landed; history is therefore fix → tests → receipt rather than a single
  commit. No content risk, noted for reviewers.
- No push/tag/publish performed; everything is local to this worktree.
