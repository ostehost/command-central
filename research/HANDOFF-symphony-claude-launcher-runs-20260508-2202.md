# Handoff — symphony-claude-launcher-runs-20260508-2202

> **Archival note (2026-08-14).** Recovered from commit `e44dad36`; it was
> removed from the tree the same day by `446c95de` as a stood-down lane
> artifact, so this is the only copy. It is preserved as design provenance, not
> as open work. **The replacement lane shipped this design**: `main` now carries
> `isSourceOwnedLauncherRun` alongside `isCodexLauncherTask` in
> `src/services/codex-run-observer-service.ts`, matching on `source_authority
> === "launcher"`, `owner_kind`, `owner_actions`, `workflow_run`, and
> `provenance.source_ref` exactly as proposed below. See
> `research/HANDOFF-symphony-claude-launcher-runs-small-20260508-2210.md` for
> the lane that implemented it. Read the "Remaining gaps" section below as
> historical, not as a live TODO.

## Status
**stood_down** — user instructed this lane to stand down before any files were edited or commands run beyond read-only exploration. A replacement lane will take the implementation.

## Files changed
None. The working tree is unchanged from the lane start (`git status` was clean, recent commit `77dfbfe3 fix(agent-status): support node mirrored surfaces`).

## Tests run / results
None. No `bun test` or `bunx tsc --noEmit` invocations were executed.

## Exact behavior change
None applied. The intended (but not implemented) change was, in `src/services/codex-run-observer-service.ts`:

- Broaden `isCodexLauncherTask(task)` (or add a sibling predicate) so a standalone launcher row is projected as a Symphony / Codex Run when **either**:
  - the existing Codex backend signal matches (`agent_backend`/`cli_name` contains "codex"), **or**
  - the row carries explicit source-owned launcher workflow metadata, e.g. `source_authority === "launcher"`, `owner_kind` present, `workflow_run` present, `owner_actions` non-empty, or a provenance `source_ref` present.
- Keep arbitrary non-source-owned, non-Codex Claude/process rows excluded (current behavior for plain Claude launcher rows with no source-owned metadata stays).
- Preserve all existing join/merge logic and lifecycle authority — Command Central remains read-only.

Suggested focused tests for the next lane:

- `test/services/codex-run-observer-service.test.ts`
  - **projects a source-owned Claude launcher row** (e.g. `agent_backend: "claude"`, `source_authority: "launcher"`, `owner_kind: "launcher"`, `exec_mode: "spoke"`, handoff/pending-review fields) → run is included with `source.kind === "launcher"`.
  - **excludes a plain non-source-owned Claude launcher row** (no `source_authority`/`owner_kind`/workflow metadata) → no run projected (still only used as join metadata).
  - Existing "uses non-Codex launcher rows only as join metadata" assertion needs to keep passing for the bare Claude case.
- `test/tree-view/openclaw-task-nodes.test.ts`
  - Tree container count renders the new Claude-backed run with no lifecycle mutation (no commands wired beyond the existing read-only artifact open).

## Remaining UI / release gaps
- No code change landed; the projection still ignores source-owned Claude launcher rows in the dogfood loop. The replacement lane should:
  1. Implement the predicate change above.
  2. Add the three focused tests.
  3. Run `bun test test/services/codex-run-observer-service.test.ts` and `bun test test/tree-view/openclaw-task-nodes.test.ts`, then `bunx tsc --noEmit` if practical.
  4. Commit with a conventional message (e.g. `feat(agent-status): project source-owned claude launcher runs`).
  5. No release/RC cut required from this lane; existing prerelease workflow is untouched.
- Display copy/detail-row tweaks in `src/providers/agent-status-tree-provider.ts` were not needed by the narrowed scope and were not modified. Source-owned lifecycle language already exists in current tooltips/details.

## Authority boundary
Command Central authority is unchanged: read-only projection, no dispatch/retry/stop/cancel, no node shell-out, no scheduler behavior. The intended change only adds rows to the read model; it does not introduce mutation.
