# DEV-NOTES: Agent Status Slice 4 — Handoff-File Detection

**Date:** 2026-04-10
**Task:** cc-agent-status-slice4-v1
**Scope:** Display-layer only — no schema migration, no new data sources
**Builds on:** Slice 1 (limbo tier + review_status routing), Slice 2 (dead-process-running detection)

## Summary

Shipped the next truthfulness pass for the Agent Status tree view. The problem:
clean `completed` lanes landed in the "Completed" group regardless of whether
they actually produced the deliverable they had declared. A lane that crashed
in its final minute — after marking itself `completed` but before writing the
expected handoff / report — was indistinguishable from a lane that finished
with full deliverables. Slice 4 uses the existing `handoff_file` field already
carried in the registry JSON to distinguish the two.

## Design Principle: Proven Beats Guessed

Slice 4 follows the same fail-open philosophy as slice 2. The only state that
triggers a demotion out of `done` is a **confirmed** `ENOENT` on the declared
path. Every other outcome — absolute path outside the workspace, permission
error, non-ENOENT stat throw, invalid input, path traversal, or no declaration
at all — is treated as "cannot verify" and leaves the task in `done`. A live
lane that simply happened to run without a handoff declaration must never be
demoted on the strength of this signal alone.

The full decision matrix:

| `handoff_file` declaration | Disk state                  | State     | Effect on `completed` |
|---------------------------|-----------------------------|-----------|-----------------------|
| `null` / empty / whitespace | (not checked)             | `absent`  | stays in `done`       |
| relative / absolute path  | file exists                  | `present` | stays in `done`       |
| relative / absolute path  | **confirmed ENOENT**         | `missing` | → routed to `limbo`   |
| relative / absolute path  | path is a directory          | `missing` | → routed to `limbo`   |
| relative path escaping project_dir | (not checked)       | `unknown` | stays in `done`       |
| relative / absolute path  | non-ENOENT error             | `unknown` | stays in `done`       |

The distinction between `absent` and `unknown` matters: `absent` means "the
task never promised a handoff, so we have nothing to verify," while `unknown`
means "the task promised one, but we could not prove whether it shipped." Both
are safe states; neither demotes the task.

## Implementation

### New helper: `src/utils/handoff-file-health.ts`

Exports `checkDeclaredHandoff(task)` returning `DeclaredHandoffState`:
`"absent" | "present" | "missing" | "unknown"`. Takes a narrow
`HandoffTaskShape` (`{ project_dir, handoff_file? }`) so tests can mock easily.

Algorithm:

1. Trim `handoff_file`. If nullish or empty → `"absent"`.
2. Resolve the declared path:
   - Absolute → use as-is (`path.resolve`).
   - Relative → resolve against `project_dir`, then verify the canonical path
     is still inside `project_dir` via `path.relative`. A relative result
     starting with `".."` or one that becomes absolute is rejected as
     traversal → `"unknown"`.
   - Any thrown error during resolution → `"unknown"`.
3. `fs.statSync(resolvedPath)` in a try/catch:
   - Directory → `"missing"` (we expected a file).
   - Regular stat success → `"present"`.
   - `err.code === "ENOENT"` → `"missing"`.
   - Any other error → `"unknown"`.

No caching inside the helper — callers layer a TTL cache.

### Wiring: `src/providers/agent-status-tree-provider.ts`

- **Interface:** `AgentTask` gained `handoff_file?: string | null`.
- **Normalizer:** `normalizeTask()` reads it via the standard
  `asString(raw["handoff_file"]) ?? null` pattern.
- **New field:** `_handoffFileCache: Map<string, { state: DeclaredHandoffState; checkedAt: number }>`,
  mirroring `_tmuxPaneAgentCache`.
- **New method:** `getDeclaredHandoffState(task)` with a 5_000 ms TTL, keyed on
  `${project_dir}::${handoff_file ?? ""}`. Delegates to `checkDeclaredHandoff`
  on cache miss.
- **`getNodeStatusGroup`:** In the `status === "completed"` branch, AFTER the
  existing `review_status` attention routing and BEFORE `return "done"`, a
  `"missing"` state now returns `"limbo"`. Branches for `running`, `attention`,
  `completed_dirty`, and `completed_stale` are untouched.
- **Tree item description:** `createTaskItem` appends
  `"missing handoff: <relpath>"` to the task's description — but only when
  **all** of the following hold, to avoid leaking the hint onto rows where it
  would be misleading:
  - `task.status === "completed"` (not dirty, not stale — those have their own
    badges),
  - `review_status` is neither `"pending"` nor `"changes_requested"` (those
    rows live in `attention`),
  - `handoff_file` is declared,
  - `getDeclaredHandoffState(task) === "missing"`.

## Routing precedence (for clean `completed` tasks)

The priority chain established across slices 1–4:

1. `review_status ∈ {pending, changes_requested}` → **attention**
2. declared handoff file is **confirmed missing** → **limbo**
3. otherwise → **done**

Review status wins. A reviewer explicitly flagging a task for follow-up is a
stronger human signal than the file-presence check, and the flow for
addressing it is different (review vs. re-run). A regression test
(`completed + review_status=pending + missing handoff → attention`) guards
this ordering.

## What is proven vs. inferred

Slice 4 carefully separates the two:

- **Proven:** `"missing"` only comes from a confirmed ENOENT or a directory at
  the expected path. When the UI shows `"missing handoff: <relpath>"`, that
  file is genuinely absent right now.
- **Inferred / tolerated as unknown:** everything else. Non-ENOENT stat errors,
  permission failures, traversal rejects, and empty declarations all fall back
  to `"done"`. The UI deliberately does not flag these cases, because a false
  alarm would erode trust faster than a missed one would — and the whole
  truthfulness wave is about earning that trust back.

## What was NOT changed

- **No schema migration.** The `handoff_file` field already existed in
  `tasks.json`; slice 4 just reads it.
- **No badge count changes.** `countAgentStatuses` (and therefore the status
  bar badges) are untouched. Per slice 1 precedent, badge counts reflect
  orchestration state, while tree grouping reflects actionability. A task with
  a missing handoff still counts as "done" in the badge but surfaces in
  "Needs Review" in the tree.
- **No changes to `completed_dirty` / `completed_stale`.** They already route
  to limbo from slice 1 and continue to do so regardless of handoff state.
- **No changes to slice 2's tmux pane health path.** Running lanes with
  missing handoff declarations are unaffected.
- **No stream file checks.** The slice 1/2 principle — stream file presence
  is not a reliable signal — still holds.
- **No host grouping, no historical tiering.**

## Testing

**12 unit tests** for `checkDeclaredHandoff` in
`test/utils/handoff-file-health.test.ts` — 100% of branches covered:
- `handoff_file` nullish / empty / whitespace / missing property → `absent`
- Relative + present / missing / nested subdir → `present` / `missing` /
  `present`
- Absolute + present → `present`
- Directory at path → `missing`
- Path traversal (`../outside.md`) → `unknown`
- Non-ENOENT stat error (mocked) → `unknown`
- File removed between calls → fresh stat returns `missing`

**8 tree-provider integration tests** in
`test/tree-view/agent-status-handoff-file.test.ts`, following the slice 2
provider-test shape (`mock.module("vscode", ...)`, real tmp dir per test).
Five regression guards are called out explicitly in the file:
- Clean `completed` + handoff present → `done`
- Clean `completed` + handoff **missing** → `limbo`
- Clean `completed` + `handoff_file=null` → `done` (unaffected)
- **`completed_dirty` stays in `limbo` regardless of handoff state** — slice
  1/2 no-regression guard
- `completed` + `review_status=pending` + missing handoff → `attention`
  (review_status wins)
- Cache behavior: repeated calls within 5 s collapse to a single `fs.statSync`

**Full-suite report (tester):** 318 pass / 0 fail in `test/utils` +
`test/services`. `test/tree-view` is 256 pass / 6 fail, **all six failures are
pre-existing** — verified by checking out the slice-2 tip (`8c7d4d7`) and
re-running; the same six fail there. Slice 4 adds 20/20 green and introduces
zero new failures.

The six pre-existing tree-view failures (unrelated to this wave):

1. runtime health overlay: stuck dead running tmux task → completed_stale
2. visibility contract: stale running task excluded from working count
3. visibility contract: reload re-merges discovery against latest launcher state
4. `readRegistry` preserves `completed_dirty` and maps unknown statuses to `stopped`
5. `readRegistry` preserves `model` from tasks.json
6. `readRegistry` preserves `actual_model` from tasks.json

## Files Changed

| File | Change |
|------|--------|
| `src/utils/handoff-file-health.ts` | **New** — `checkDeclaredHandoff` + `DeclaredHandoffState` |
| `src/providers/agent-status-tree-provider.ts` | Import, `handoff_file` on `AgentTask`, `normalizeTask` read, `_handoffFileCache` field, `getDeclaredHandoffState` method, `getNodeStatusGroup` routing, `createTaskItem` description hint |
| `test/utils/handoff-file-health.test.ts` | **New** — 12 unit tests |
| `test/tree-view/agent-status-handoff-file.test.ts` | **New** — 8 integration tests |

## Known Limitations

1. **Absolute `handoff_file` paths bypass the project_dir containment check.**
   Intentional and documented in the b4be359 commit — there are legitimate
   cases (e.g., handoff files in an orchestrator-owned directory outside the
   project tree). An absolute path is treated as a statement of intent and
   resolved as-is. Tests cover this branch.

2. **No debouncing across reloads.** Registry reloads clear other caches
   (`_tmuxSessionHealthCache`, `_tmuxPaneAgentCache`) in
   `reconcileDuplicateRunningSessions`, but `_handoffFileCache` is not. This
   is acceptable: the 5 s TTL already bounds staleness, and filesystem state
   for handoff files changes on the order of seconds-to-minutes, not
   milliseconds. Worth a follow-up only if the cache becomes a visible source
   of stale routing during dogfood.

3. **The description hint only fires on clean `completed`.** A `completed_dirty`
   or `completed_stale` task with a missing handoff also has a missing
   deliverable, but we deliberately don't double-label those rows — their
   limbo membership is already explained by their status badge, and the slice
   1/2 tests assert their existing descriptions remain intact.

4. **No CLI housekeeping scripts wired.** Reviewer noted `CLAUDE.md`
   references `bun run typecheck` / `bun run check`, but those scripts are
   not defined in `package.json`. `bunx tsc --noEmit` and
   `bunx @biomejs/biome check` were used directly during this slice. Worth
   a separate cleanup task.

## Commits

| Commit | Description |
|--------|-------------|
| `b4be359` | `feat: add handoff-file-health helper (slice 4)` |
| `4842a9c` | `feat: route completed tasks with missing handoff to limbo (slice 4)` |
| `e22c579` | `test: add handoff-file-health unit tests (slice 4)` |
| `78219ce` | `test: add handoff-file routing suite (slice 4)` |

## Recommended next slices

- **Reconcile handoff cache on registry reload** — minor housekeeping.
- **Host grouping** — still outstanding from slice 1's recommendations.
- **Stream liveness as a secondary signal** — still outstanding.
- **Review-status follow-through** — when a reviewer approves a task, the
  `attention` row should clear without requiring a reload (today it only
  updates on registry change).
