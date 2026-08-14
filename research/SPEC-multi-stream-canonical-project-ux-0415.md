# SPEC: Same-Project Multi-Stream UX for Command Central

> **Date:** 2026-04-15
> **Status:** Draft — Phase 1 implemented, follow-up phases pending launcher-side work
> **Branch:** `temp/cc-multi-stream-ux-0415`

---

> **Archival note (2026-08-14).** This spec is preserved as design history. The
> Phase 1 implementation described below was written against the April-2026
> `AgentCounts` / `formatCountSummary` model and was **never landed on `main`**.
> `main` has since moved the project-group tree item onto the V2 section model
> (`UnifiedCounts` with `live`/`review`/`action`/`history`, rendered by
> `formatV2Summary` in `src/utils/agent-status-sections.ts`) and added a
> separate unregistered-project early-return path. The described
> `getRunningStreams` / `formatMultiStreamLabel` / `formatMultiStreamTooltip`
> helpers exist nowhere in `main`. Treat the product intent here as live and the
> implementation sketch as stale: re-deriving it against the V2 model is a
> rewrite, not a port.

---

## Problem Statement

When the launcher spawns multiple agent streams against the same canonical project
(e.g. a developer lane, a reviewer lane, and a test lane all targeting
`~/projects/command-central`), Command Central's Agent Status view must surface
that concurrency truthfully. Today, each task appears as a sibling under the same
`ProjectGroupNode`, but:

1. **No concurrency signal** — the project group header shows `2 working` but
   doesn't distinguish between "2 concurrent streams in the same project" and
   "2 projects each with 1 stream." There's no visual "multi-stream" indicator.

2. **No per-stream detail in context** — the tooltip shows aggregate counts but
   doesn't list which specific streams (by task ID, role, model) are active.

3. **No lane identity** — there is no "lane" or "stream" concept in the data
   model. Each task is flat; concurrency is incidental, not modeled.

4. **Project path canonicalization gap** — symlinks or trailing slashes could
   cause the same project to appear as two separate `ProjectGroupNode` entries.

5. **Stale-stream masking** — a dead process for stream A in the same project as
   a live stream B can confuse the status inference, since health checks
   (tmux/persist) don't namespace by task ID within a project.

---

## Desired UX Behavior

### Phase 1 (Implemented — this branch)

**Multi-stream indicator in project group header:**

When a `ProjectGroupNode` has ≥2 concurrently running tasks (launcher tasks +
discovered agents), the description line appends a "N streams" suffix:

```
🧩 COMMAND-CENTRAL ▼ (5)    2 working · 1 done · 2 streams
```

**Rich multi-stream tooltip:**

The project group tooltip now lists each active stream with its task ID, role,
and model:

```markdown
**command-central**
Dir: `/Users/oste/projects/command-central`
Agents: 2 working · 1 done

**Active streams (2)**
- `cc-dev-0415` · developer · opus
- `cc-review-0415` · reviewer · sonnet

Latest activity: 3m ago
```

This gives the orchestrator (Oste) immediate visibility into what each stream is
doing without expanding the tree.

### Phase 2 — Lane Identity (Future)

Add an explicit `lane` or `stream_group` field to `AgentTask`:

```typescript
export interface AgentTask {
  // ... existing fields ...
  /** Optional lane identifier for multi-stream orchestration */
  lane?: string | null;
  /** Parent task ID if this is a sub-stream */
  parent_task_id?: string | null;
}
```

UX changes:
- Within a `ProjectGroupNode`, group tasks by lane when the field is present
- Show lane headers: `🔨 developer lane (2 runs)` / `🔍 reviewer lane (1 run)`
- Collapse completed lanes by default, expand running lanes

### Phase 3 — Canonical Project Parity (Future)

Add `fs.realpathSync`-based canonicalization to `buildProjectNodes()` so that
symlinked paths and trailing slashes merge into a single group:

```typescript
private canonicalizeProjectDir(projectDir: string): string {
  try {
    return fs.realpathSync(projectDir);
  } catch {
    return path.resolve(projectDir); // fallback: normalize without resolving
  }
}
```

### Phase 4 — Stream Health Isolation (Future)

Namespace health checks by task ID, not just project directory. Today,
`isTmuxPaneAgentAlive` and `checkPersistSessionAlive` check if a session is
alive without distinguishing which task within the project the session belongs
to. When multiple streams share the same project but use separate tmux
panes/persist sockets, health checks should be per-task.

---

## Exact File Targets

### Phase 1 (Done)

| File | Change |
|------|--------|
| `src/utils/agent-counts.ts` | Added `getRunningStreams()`, `formatMultiStreamLabel()`, `formatMultiStreamTooltip()` |
| `src/providers/agent-status-tree-provider.ts` | Updated `createProjectGroupItem()` to use multi-stream utilities |
| `test/utils/agent-counts.test.ts` | Added 13 tests for new utilities |
| `test/tree-view/agent-status-tree-provider.test.ts` | Added 2 integration tests for project group multi-stream indicator |

### Phase 2 (Lane Identity)

| File | Change |
|------|--------|
| `src/providers/agent-status-tree-provider.ts` | Add `LaneGroupNode` type; modify `getProjectGroupChildren()` to sub-group by lane |
| `src/types/` (new or existing) | Extend `AgentTask` interface with `lane` field |
| `test/tree-view/agent-status-tree-provider.test.ts` | Lane grouping tests |

### Phase 3 (Path Canonicalization)

| File | Change |
|------|--------|
| `src/providers/agent-status-tree-provider.ts` | Add `canonicalizeProjectDir()`, use in `buildProjectNodes()` |
| `test/tree-view/agent-status-tree-provider.test.ts` | Symlink dedup tests |

### Phase 4 (Health Isolation)

| File | Change |
|------|--------|
| `src/utils/tmux-pane-health.ts` | Accept task ID parameter, check specific pane |
| `src/utils/persist-health.ts` | Accept socket path from task, not project-level |
| `src/providers/agent-status-tree-provider.ts` | Pass task-specific identifiers to health checks |

---

## State-Model Implications

### Current State Model

```
TaskRegistry (tasks.json)
  └── Record<string, AgentTask>   ← flat map, key = task ID
```

Tasks are grouped by `project_dir` at display time only. The grouping is
ephemeral — it exists in the tree provider's `buildProjectNodes()` output and is
not persisted.

### Multi-Stream Extensions

1. **Concurrency is implicit today:** Two tasks with the same `project_dir` and
   `status: "running"` are concurrent streams. This is sufficient for Phase 1.

2. **Lane identity requires launcher cooperation:** The launcher must emit a
   `lane` field in the task registry. Until then, Command Central can infer
   lanes from `role` (developer/reviewer/test) but this is not guaranteed to be
   unique or present.

3. **Stream ordering:** Within a project group, streams should be sorted by
   role priority (developer → reviewer → test → planner) then by recency. This
   is already close to what `compareSortableAgentNodes` does, but role-aware
   sorting is not yet implemented.

4. **Discovery source merge:** When a discovered process (via `ProcessScanner`)
   corresponds to a running launcher task in the same project, the current dedup
   in `AgentRegistry.getDiscoveredAgents()` filters by project_dir match. This
   is correct for same-project multi-stream: the discovered process is already
   tracked by the launcher, so it's suppressed. But if a new ad-hoc stream is
   started outside the launcher, it should appear as a separate discovered agent
   within the same project group.

---

## Test Plan

### Phase 1 Tests (Implemented)

**Unit tests (`test/utils/agent-counts.test.ts`):**
- `getRunningStreams` extracts only running tasks
- `getRunningStreams` includes role and model fields
- `getRunningStreams` falls back to `actual_model` when `model` is null
- `getRunningStreams` returns empty array for no running tasks
- `formatMultiStreamLabel` returns null for <2 streams
- `formatMultiStreamLabel` returns "N streams" for ≥2 concurrent
- `formatMultiStreamLabel` combines launcher and discovered counts
- `formatMultiStreamTooltip` returns null for single stream
- `formatMultiStreamTooltip` formats stream detail with role and model
- `formatMultiStreamTooltip` includes discovered process count
- `formatMultiStreamTooltip` pluralizes discovered processes
- `formatMultiStreamTooltip` omits null role/model from lines

**Integration tests (`test/tree-view/agent-status-tree-provider.test.ts`):**
- Project group description shows "2 streams" when 2 running tasks exist
- Project group tooltip includes "Active streams" with task IDs
- Project group omits multi-stream indicator for single running task

### Phase 2 Tests (Planned)

- Lane grouping creates `LaneGroupNode` children within project group
- Tasks without lane field appear ungrouped (backward compatible)
- Lane collapse state: running lanes expanded, done lanes collapsed
- Lane sorting follows role priority order

### Phase 3 Tests (Planned)

- Symlinked paths merge into single project group
- Trailing slash normalization deduplicates groups
- `fs.realpathSync` failure gracefully falls back to `path.resolve`

### Phase 4 Tests (Planned)

- Health check for task A does not interfere with task B in same project
- Per-task persist socket resolution works
- Per-task tmux pane health isolation works

---

## Follow-Up Sequence After Launcher-Side Work Lands

1. **Launcher emits `lane` field** — The launcher needs to set a `lane` field on
   each task in `tasks.json` when spawning multi-stream orchestrations. This is
   the prerequisite for Phase 2.

2. **Launcher emits `parent_task_id`** — For orchestrated multi-stream runs
   (e.g. an orchestrator spawns developer + reviewer), the launcher should set
   a parent task ID so Command Central can show task relationships.

3. **Launcher canonicalizes `project_dir`** — The launcher should `realpath` the
   project directory before writing to `tasks.json`, solving the canonicalization
   issue at the source. Command Central should still have its own fallback
   canonicalization (Phase 3) for discovered agents.

4. **Launcher health protocol** — The launcher should write a health heartbeat
   (e.g. mtime bump on a sentinel file) per-task, not per-project. This gives
   Command Central a reliable per-stream liveness signal without needing to
   probe tmux panes or persist sockets.

5. **Dashboard panel sync** — Once the tree view supports lane grouping, the
   agent dashboard webview (`agent-dashboard-panel.ts`) should mirror the
   grouping: show lane cards within project cards.

---

## Hub=Node Canonical Parity: What It Means for Command Central's Dogfood Posture

**Strict hub=node canonical parity** means that the truth Command Central displays
must be derivable from the same state that the launcher (node) maintains. Command
Central (hub) must not invent state, mask state, or cosmetically rearrange state
in ways that diverge from what the launcher knows.

For dogfooding this means:

1. **If the launcher says "running," Command Central shows "running."** Runtime
   health overlays (stale detection, dead-process inference) are acceptable only
   as annotations on top of the launcher truth, never as replacements. The tree
   provider's `toDisplayTask()` correctly overlays but never mutates the
   underlying task registry — this is good.

2. **If the launcher tracks 3 streams, Command Central shows 3 streams.** The
   multi-stream indicator implemented in Phase 1 is a truthful reflection of
   launcher state. It does not fabricate streams or collapse them.

3. **Discovery-only agents are clearly marked.** Discovered processes (from
   `ProcessScanner`) that are not in the launcher registry get a `DiscoveredNode`
   type, visually distinct from `TaskNode`. This distinction must be preserved —
   it tells the orchestrator "this stream exists but the launcher doesn't know
   about it."

4. **No heuristic grouping that papers over launcher gaps.** If two tasks point
   to the same project but with different paths (e.g. symlink vs real path), they
   must appear as separate groups until the canonicalization is resolved at the
   source (launcher) or verified at the hub (Phase 3). Merging them on a
   heuristic guess would violate parity.

5. **Dogfood signal:** When Command Central is itself the target project of a
   multi-stream orchestration, the Agent Status view should display its own
   streams accurately. This is the ultimate parity test — if the tool can't
   truthfully show its own concurrent development, it can't be trusted for other
   projects.

---

## Summary

| Phase | What | Depends On | Status |
|-------|------|------------|--------|
| 1 | Multi-stream indicator + tooltip | Nothing | **Done** |
| 2 | Lane identity grouping | Launcher `lane` field | Planned |
| 3 | Path canonicalization | Nothing (but launcher fix preferred) | Planned |
| 4 | Per-task health isolation | Launcher health protocol | Planned |
| 5 | Dashboard panel sync | Phase 2 | Planned |
