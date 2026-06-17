# Command Central — Completed Detached Symphony Lanes Should Not Read as Ambiguous Attention

**Task:** `symphony-PAR-195-19fde801`
**Linear item:** [PAR-195](https://linear.app/partnerai/issue/PAR-195/agent-status-should-not-surface-completed-detached-symphony-lanes-as)
**Date:** 2026-06-17
**Machine:** Mike's MacBook Pro (`MacBookPro`)
**Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
**Mode:** Agent Teams DELEGATE — team lead coordinated an Implementer (code) + Tester
(tests) pair via the shared task list.
**Commits:** `515e1321` (code), `3ea8bb31` (tests).
**Scope:** CC repo only. No launcher/OpenClaw/Symphony source touched, no config
mutation, no `tasks.json` write, no publish/push/tag/release, no version bump.

---

## 1. Problem

A Symphony lane (the visible Claude Code implementation lane the daemon launches,
id `symphony-<ticket>-<hash>`) is registered with the launcher but carries **no
`session_key` and no `callback_url`** — its completion is owned by the launcher
wrapper / receipt / `oste-complete.sh` finalizer, not by an orchestrator callback.

Once such a lane reaches a terminal status (`completed` / `completed_dirty` /
`completed_stale` / `failed` / …), Command Central classified it through the
generic detached path:

- `classifyCompletionRouting()` returned **"Detached — manual observation
  required"** with `iconColor: "charts.yellow"` (the attention color).
- `createTaskItem()` pushed a **`⚠ detached`** badge onto the row description.

So a Symphony lane that finished cleanly — and whose completion was already
auto-reported through the launcher finalizer — rendered with a yellow ⚠ "manual
observation required" signal. That is **ambiguous**: the row sits in History/Done
yet wears an attention glyph, implying the operator must go look at it when in
fact nothing is owed. Reviewer lanes already had this softened (see §2); Symphony
lanes did not.

## 2. Mechanism (pre-fix)

`src/providers/agent-task-classification.ts → classifyCompletionRouting()`, terminal branch:

- `session_key` / `callback_url` present → `owner-bound` (routed back to orchestrator).
- `role === "reviewer"` → **"Detached — no action needed"**, `disabledForeground`
  (muted — a standalone reviewer's completion is local, no action owed).
- **otherwise** → **"Detached — manual observation required"**, `charts.yellow`.

A Symphony lane is a developer-role lane with no callback, so it fell into the
last bucket. The row badge in `agent-status-tree-provider.ts` mirrored this: it
pushed `⚠ detached` for any done-status detached lane except reviewers
(`task.role !== "reviewer"`).

## 3. Change

Symphony lanes are orchestrated — their completion *is* auto-handled, just not via
the `session_key`/`callback_url` transport. So they belong with the reviewer case
("no action needed"), not the generic "manual observation required" case.
Display-only; no `tasks.json` mutation.

### a. `isSymphonyLane(task)` — new exported predicate (`agent-task-classification.ts`)

```ts
export function isSymphonyLane(
	task: Pick<AgentTask, "id" | "orchestration_mode">,
): boolean {
	if (typeof task.id === "string" && /^symphony-/.test(task.id)) return true;
	const mode = task.orchestration_mode?.trim().toLowerCase();
	return mode === "symphony";
}
```

- **Canonical signal:** the launcher's `symphony-<ticket>-<hash>` lane id. The
  Symphony daemon is the only producer of that id shape, so the prefix alone is
  authoritative (unlike `review-`, which needed artifact corroboration because an
  implementation task can be *named* `review-…`).
- **Corroborating signal:** `orchestration_mode === "symphony"` (trimmed,
  case-insensitive) — covers a renamed/relabelled lane.

### b. Symphony branch in `classifyCompletionRouting()`

Added in the terminal branch, after the reviewer case and before the generic
fallback:

```ts
if (isSymphonyLane(task)) {
	return {
		kind: "detached",
		label: "Detached — orchestrated (no action needed)",
		detail:
			"Symphony-orchestrated lane — completion is reported by the launcher wrapper/finalizer (oste-complete), not a session_key/callback_url",
		icon: "debug-disconnect",
		iconColor: "disabledForeground",
	};
}
```

`kind` stays `"detached"` (the transport truth is unchanged — it really has no
callback); only the **label/detail/iconColor** soften so it reads as no-action,
muted, instead of yellow attention. The non-terminal (running) detached branch is
**untouched** — a running detached lane is a legitimate live-visibility state and
still surfaces under Live.

### c. `⚠ detached` badge suppression (`agent-status-tree-provider.ts`)

```ts
if (
	taskRouting.kind === "detached" &&
	isDoneStatus &&
	task.role !== "reviewer" &&
	!isSymphonyLane(task)   // ← added
) {
	descriptionParts.push("⚠ detached");
}
```

`isSymphonyLane` is imported (and re-exported for import-site stability) from
`agent-task-classification.js`.

## 4. Files changed

| File | Change |
| --- | --- |
| `src/providers/agent-task-classification.ts` | New `isSymphonyLane()` predicate; Symphony branch in `classifyCompletionRouting()` |
| `src/providers/agent-status-tree-provider.ts` | Import + re-export `isSymphonyLane`; `&& !isSymphonyLane(task)` guard on the `⚠ detached` badge |
| `test/tree-view/agent-status-symphony-detached.test.ts` | New focused suite (18 tests) |

## 5. Tests

`test/tree-view/agent-status-symphony-detached.test.ts` — **18 tests, 3 describe blocks:**

- **`isSymphonyLane` (8):** canonical `symphony-…` id → true; `orchestration_mode`
  `"symphony"` / `"Symphony"` / `"SYMPHONY"` / `"  symphony  "` → true; plain
  developer id → false; `review-…` id → false; undefined mode → false.
- **`classifyCompletionRouting` (6):** completed Symphony lane (by id and by
  `orchestration_mode`) → `detached` / label contains "no action needed" /
  `disabledForeground` (asserted **not** `charts.yellow`); **regression** —
  completed non-Symphony developer lane still → "manual observation required" /
  `charts.yellow`; reviewer lane unchanged; running+detached Symphony lane
  unchanged (fix is terminal-only); failed Symphony lane also muted.
- **Row badge (4):** real `provider.getTreeItem(...)` pipeline — completed Symphony
  lane row description does **not** contain `⚠ detached` (by id and by mode);
  **regression** — completed non-Symphony developer lane row **does** contain
  `⚠ detached`; reviewer lane row does not (existing behavior preserved).

### Validation run (this checkout, deps installed)

```
bun test test/tree-view/agent-status-symphony-detached.test.ts   # 18 pass / 0 fail
just check                                                        # ✅ biome + tsc clean (8 pre-existing knip/perf-cache warnings in unrelated files)
```

The `fatal: cannot change to '/tmp/project'` lines in the render-test output are
benign git stderr from the mocked task's non-existent dir; the assertions pass.

## 6. Acceptance criteria → status

- ✅ A completed detached Symphony lane no longer renders the ambiguous yellow
  `⚠ detached` "manual observation required" attention signal.
- ✅ It is classified as orchestrated, no-action-needed (muted `disabledForeground`),
  matching the established reviewer-lane treatment.
- ✅ Non-Symphony detached lanes are unchanged (still "manual observation required"
  / `charts.yellow` / `⚠ detached`) — regression-guarded.
- ✅ Running detached lanes and reviewer lanes are unchanged.
- ✅ Display-only — no `tasks.json` mutation, no launcher/config/release changes.

## 7. Notes / follow-ups

- Detection keys off the launcher's `symphony-` id convention plus
  `orchestration_mode`. If the daemon ever changes the lane-id shape, extend
  `isSymphonyLane` accordingly (single chokepoint, fully unit-covered).
- The durable long-term home for per-lane completion-ownership semantics remains
  the OpenClaw-native Work System projection (cf. `TODO(work-system)` in
  `agent-task-classification.ts`); this predicate is the consistent interim
  surfacing, in the same spirit as the reviewer-lane and stale-review-lane work
  (`research/CC-STALE-REVIEW-LANE-LIVE-ROW-2026-06-16.md`).
