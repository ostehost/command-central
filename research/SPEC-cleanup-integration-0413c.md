# SPEC: Cleanup / Integration Slice 0413c

## Task

Audit `command-central` main after the dead-session resume merge and the native Ghostty tmux-attach argv fix, then identify the next smallest shippable slice that reduces stale runtime identity, sibling timestamp confusion, and operator cleanup friction without widening scope.

## Recommendation

Ship a **tree-provider-only runtime identity hardening patch** next.

This slice should stay inside [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:100) plus its existing tree-view tests. The patch should:

1. Stop treating `session_id` by itself as authoritative runtime identity for duplicate-running reconciliation.
2. Make any superseded sibling self-describing by naming the winning task and the runtime tuple that won.
3. Surface exact runtime/timestamp breadcrumbs in the task tooltip so operators can tell similar siblings apart before cleaning anything up.

Do **not** widen the first patch into command/menu/notification renames. Transcript access already exists; the immediate truth gap is still in runtime identity and sibling disambiguation.

## Findings

### WARNING: duplicate-running reconciliation still collapses by a weak key

- `AgentTask` already carries the fields needed for a richer runtime tuple: `session_id`, `terminal_backend`, `persist_socket`, `tmux_socket`, `tmux_window_id`, `bundle_path`, `stream_file`, and `claude_session_id` in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:100).
- `reconcileDuplicateRunningSessions()` currently groups running tasks by `session_id`, or `session_id::tmux_window_id` for tmux, then marks all older siblings as stopped in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1466).
- The stale reason is generic: `"Superseded by a newer task on the same session. Showing as stopped."` in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1513).
- Existing regression coverage currently blesses this weak behavior by asserting “newest wins” for two persist tasks that only share `session_id` in [test/tree-view/agent-status-tree-provider.test.ts](/Users/ostemini/projects/command-central/test/tree-view/agent-status-tree-provider.test.ts:1035).

### WARNING: current tree item UI hides the fields operators need to distinguish siblings

- The main task row label is only `project icon + role icon + task.id`, and the description falls back to project/model/relative time in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:5793).
- The tooltip currently includes status, model, duration, and directory, but not exact `started_at`, `completed_at`, terminal backend, session/window/socket identity, or transcript/session hints in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:5853).
- Existing tooltip coverage explicitly asserts the tooltip stays concise and omits terminal identity in [test/tree-view/agent-status-tree-provider.test.ts](/Users/ostemini/projects/command-central/test/tree-view/agent-status-tree-provider.test.ts:3150).
- This is directly at odds with the current runtime-truth lesson in workspace memory: runtime identity must be composed from task, terminal backend, session/socket, process, and transcript, not from a single session name in [2026-04-13.md](/Users/ostemini/.openclaw/workspace/memory/2026-04-13.md:226).

### WARNING: cleanup friction is still driven by generic stale-state language

- When a raw running task is overlaid to stopped, the first detail row only says “Agent process ended” in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:3545).
- The OpenClaw audit summary only reports counts such as `stale running task(s) — may need manual cleanup` and `inconsistent timestamps (OpenClaw-side, cosmetic)` in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:4831).
- The current audit JSON reader only consumes summary counts, not per-task findings, so trying to solve operator cleanup by enriching the OpenClaw audit text first would require new CLI payload work in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:4908).

### DOC: transcript/session accessibility already exists, so it should not be the first patch

- The current product direction is already “each session should be directly accessible” with a `View Session Transcript` affordance backed by the real `~/.claude/projects/.../*.jsonl` path in workspace memory at [2026-04-13.md](/Users/ostemini/.openclaw/workspace/memory/2026-04-13.md:162).
- `resolveClaudeTranscriptPathForTask()` already resolves transcript files by explicit `claude_session_id` first, then timestamp heuristics in [src/discovery/session-resolver.ts](/Users/ostemini/projects/command-central/src/discovery/session-resolver.ts:149).
- `resolveTaskTranscriptPath()` already prefers the Claude transcript path and falls back to `stream_file` in [src/commands/resume-session.ts](/Users/ostemini/projects/command-central/src/commands/resume-session.ts:73).
- The dead-session QuickPick already exposes `View Session Transcript` in [src/extension.ts](/Users/ostemini/projects/command-central/src/extension.ts:2142), and `commandCentral.showAgentOutput` already opens a transcript file for non-running tasks in [src/extension.ts](/Users/ostemini/projects/command-central/src/extension.ts:2242).
- Renaming the generic `Show Output` action now would widen the patch into quick actions and notification UX. The label still lives in [src/commands/agent-quick-actions.ts](/Users/ostemini/projects/command-central/src/commands/agent-quick-actions.ts:22), and changing it would fan out into multiple command and notification tests such as [test/commands/agent-quick-actions-options.test.ts](/Users/ostemini/projects/command-central/test/commands/agent-quick-actions-options.test.ts:5).

## Exact Scope

### In scope for the next patch

- Add a backend-aware runtime identity helper in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1466).
- Use that helper inside duplicate-running reconciliation instead of plain `session_id`.
- Update the stale overlay reason so it includes the winning task id and a short runtime identity summary.
- Expand the task tooltip to include exact timestamps and a concise runtime line.
- Add focused tree-view regressions for the new tuple behavior and tooltip output.

### Out of scope for the next patch

- Any task schema change.
- Any launcher/OpenClaw CLI change.
- Any transcript-resolution change in `session-resolver` or `resume-session`.
- Any notification text or quick-action label rename.
- Any new cleanup command.

## Proposed Implementation

### 1. Build a real runtime identity key

Add a helper near duplicate reconciliation, for example:

```ts
private getRunningRuntimeIdentityKey(task: AgentTask): string | null
```

Recommended tuple:

- `terminal_backend ?? "tmux"`
- `project_dir`
- `bundle_path` when present and not empty
- For `persist`: `persist_socket ?? getPersistSocketPath(task) ?? session_id`
- For `tmux`: `tmux_socket ?? "__default__"`, `session_id`, `tmux_window_id ?? "__session__"`
- For other backends: `session_id`

Rationale:

- Same `session_id` can legitimately appear across different projects or launcher surfaces.
- For tmux, the code already knows window-level truth is more accurate than session-level truth in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1270).
- For persist, socket identity is the real attach target, and the provider already knows how to derive it in [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1222).

### 2. Make superseded siblings explain themselves

When two running tasks truly collide on the same runtime identity key:

- Keep the newest task as the winner using the existing `started_at` then `id` ordering.
- Overlay older siblings to `stopped`.
- Replace the generic stale reason with something like:

```text
Superseded by newer running task fresh-running on persist:/Users/test/projects/my-app:/Users/.../agent-shared.sock.
```

This directly reduces cleanup friction because the stopped sibling tells the operator which task won and why it was hidden.

### 3. Put exact breadcrumbs in the tooltip

Keep the row description compact, but enrich the tooltip with:

- `Started: <ISO timestamp>`
- `Completed: <ISO timestamp>` when present
- `Runtime: <backend + session/window/socket summary>`
- `Transcript: <basename or claude_session_id>` only when available and short

Do not move this into the row description. The row should stay scan-friendly; the tooltip is the right place for exact sibling disambiguation.

## Exact Files

### Modify

- [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1466)
- [test/tree-view/agent-status-tree-provider.test.ts](/Users/ostemini/projects/command-central/test/tree-view/agent-status-tree-provider.test.ts:1035)

### Do not modify in the first patch

- [src/commands/agent-quick-actions.ts](/Users/ostemini/projects/command-central/src/commands/agent-quick-actions.ts:22)
- [src/extension.ts](/Users/ostemini/projects/command-central/src/extension.ts:2142)
- [src/discovery/session-resolver.ts](/Users/ostemini/projects/command-central/src/discovery/session-resolver.ts:149)
- [src/commands/resume-session.ts](/Users/ostemini/projects/command-central/src/commands/resume-session.ts:73)

## Exact Tests

Update or add focused cases in [test/tree-view/agent-status-tree-provider.test.ts](/Users/ostemini/projects/command-central/test/tree-view/agent-status-tree-provider.test.ts:1035):

1. `does not collapse running tasks that only share session_id but have different runtime identity tuples`
2. `marks only the older sibling stopped when runtime identity tuple matches exactly`
3. `superseded sibling reason names the winning task id`
4. `task tooltip includes exact started timestamp and runtime identity summary`

Keep the existing OpenClaw audit-count assertions unchanged for this slice. The current audit path does not have per-task payload detail, so changing that area first would widen scope without fixing the main truth problem.

## Recommended First Patch

Implement only this:

1. Add `getRunningRuntimeIdentityKey()`.
2. Update `reconcileDuplicateRunningSessions()` to key by that tuple.
3. Replace the generic superseded reason with a winner-aware reason.
4. Expand the task tooltip with exact timestamp/runtime lines.
5. Update the tree-view tests listed above.

If that patch lands cleanly, the next follow-up should be a separate UX-only change that renames transcript-facing actions from `Show Output` to transcript-specific language where appropriate.

SPEC COMPLETE
