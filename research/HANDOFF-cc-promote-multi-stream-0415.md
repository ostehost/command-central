# HANDOFF: Promote Multi-Stream UX into Canonical Lane

> **Date:** 2026-04-15
> **Task:** `cc-promote-multi-stream-0415`
> **Source:** `/private/tmp/cc-multi-stream-ux-0415` commit `809d95e`

---

> **Archival note (2026-08-14).** "Promoted" here means promoted onto the
> `temp/cc-promote-multi-stream-0415` side branch, **not** onto `main`. The
> present-tense claims below ("the project group header ... now shows") describe
> that branch, never shipped code. The feature is absent from `main`: see
> `research/SPEC-multi-stream-canonical-project-ux-0415.md` for why porting it
> to the current V2 section model would be a rewrite.

---

## What Was Promoted

Cherry-picked the multi-stream visibility feature (`809d95e`) from the
`cc-multi-stream-ux-0415` side lane into this clean canonical-attached worktree.

### Product Change

When a project has ≥2 concurrently running agent streams, the project group
header in the Agent Status tree view now shows:

- **Description suffix:** `"N streams"` appended after the existing status
  summary (e.g. `2 working · 1 done · 2 streams`)
- **Rich tooltip:** Lists each active stream by task ID, role, and model under
  an `**Active streams (N)**` heading, plus a count of discovered processes

### Files Changed

| File | Change |
|------|--------|
| `src/utils/agent-counts.ts` | Added `RunningStreamInfo` interface, `getRunningStreams()`, `formatMultiStreamLabel()`, `formatMultiStreamTooltip()` |
| `src/providers/agent-status-tree-provider.ts` | Integrated multi-stream label/tooltip into `createProjectGroupItem()` |
| `test/utils/agent-counts.test.ts` | 15 new tests for the three utility functions |
| `test/tree-view/agent-status-tree-provider.test.ts` | 2 integration tests for project group multi-stream rendering |
| `research/SPEC-multi-stream-canonical-project-ux-0415.md` | Spec document with phase plan |

### What Was NOT Promoted

- `.oste-report.yaml` update from `e7370fe` (task-local artifact, not product code)

---

## Tests Passed

- **agent-counts unit tests:** 32/32 pass (0 fail)
- **tree-provider integration tests:** 216/216 pass (0 fail)
- All 15 new multi-stream tests pass
- Both new tree-provider integration tests pass

---

## What Still Depends on Launcher-Side Follow-Up

Per the promoted spec (`SPEC-multi-stream-canonical-project-ux-0415.md`), the
following phases require launcher-side work:

1. **Phase 2 — Lane Identity:** The launcher needs to emit a `lane` or `stream_id`
   field in the task contract so Command Central can distinguish streams by
   identity rather than just counting concurrent `running` statuses.

2. **Phase 3 — Path Canonicalization:** Symlinks and trailing slashes can cause
   the same project to appear as separate `ProjectGroupNode` entries. Needs
   `fs.realpath()` normalization on the launcher side before emitting
   `project_dir`.

3. **Phase 4 — Per-Task Health Isolation:** Health checks (tmux pane liveness,
   persist-backend) currently operate at the project level. When multiple streams
   target the same project, a dead stream can mask a live one. Requires
   task-ID-scoped health namespacing in the launcher's session management.

---

## Canonical Posture

This change is aligned with the hub=node dogfood posture:
- Works with existing launcher task contract (no new fields required for Phase 1)
- Gracefully degrades: single-stream projects show no indicator (no visual noise)
- Discovered processes (non-launcher agents) are counted in the stream total
