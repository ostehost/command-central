# Symphony — Project source-owned Claude launcher rows into Codex Runs

**Task ID:** `cc-symphony-claude-launcher-runs-small-20260508-2210`
**Date:** 2026-05-08
**Repo:** `command-central`

## Summary

`CodexRunObserverService.project()` previously projected standalone launcher
tasks into the Symphony / Codex Runs view only when the agent backend / CLI
name contained "codex". Standalone Ghostty Launcher Claude Code tasks that
carry explicit launcher-owned workflow metadata (Symphony source-owned rows)
were silently dropped, even though the launcher had already declared them as
authoritative runs.

This narrow change makes the projection accept those source-owned launcher
rows as standalone runs while preserving the existing safety net that excludes
arbitrary non-Codex Claude / process rows that lack source-owned metadata.

## Behavior change

A launcher `AgentTask` is now projected as a standalone Codex run when it
matches **either** of the following predicates:

1. `isCodexLauncherTask(task)` — existing behavior; `agent_backend` or
   `cli_name` contains `codex`.
2. `isSourceOwnedLauncherRun(task)` — new helper that returns `true` when the
   task carries explicit launcher-owned workflow metadata. Tolerant of both
   snake_case (registry) and camelCase (already-normalized) variants:
   - `source_authority === "launcher"` or `sourceAuthority === "launcher"`
     (case-insensitive, trimmed)
   - non-empty `owner_kind` or `ownerKind`
   - non-empty array `owner_actions` or `ownerActions`
   - presence of `workflow_run` or `workflowRun`
   - presence of `provenance.source_ref` or `provenance.sourceRef`

The launcher-side join path (when an existing OpenClaw / TaskFlow run already
covers the same task) is unchanged — those still merge launcher metadata into
the source-owned row exactly as before.

## Files changed

- `src/services/codex-run-observer-service.ts` — added
  `isSourceOwnedLauncherRun(task)` helper and `isNonEmptyArray(value)` guard;
  threaded the helper into the existing launcher-only projection branch.
- `test/services/codex-run-observer-service.test.ts` — two focused tests:
  - "projects source-owned Claude launcher rows as standalone runs" (covers
    snake/camel `source_authority`, `owner_kind`, `workflow_run`,
    `owner_actions`, and `provenance.source_ref`).
  - "excludes Claude launcher rows that lack source-owned metadata" (covers
    bare Claude rows and rows with empty `owner_actions` / empty `provenance`).
- `test/tree-view/openclaw-task-nodes.test.ts` — one focused tree-count test:
  "Symphony / Codex Runs container counts source-owned Claude launcher rows"
  asserts the container projects the source-owned Claude row and excludes the
  bare one, with the container label reading `Symphony / Codex Runs · 1`.

## Tests run

| Command | Result |
| --- | --- |
| `bun test test/services/codex-run-observer-service.test.ts` | 20 pass / 0 fail (was 18) |
| `bun test test/tree-view/openclaw-task-nodes.test.ts` | 26 pass / 0 fail (was 25) |
| `bunx tsc --noEmit` | clean |
| `just check` | clean (pre-existing Knip warnings on `WorkflowRunStatus` / `WorkflowRunPhase` unrelated to this change) |
| `just fix` | no fixes applied |

## Remaining gaps / follow-ups

- The existing dogfood fixture `test/fixtures/agent-status/dogfood-live-tasks.json`
  contains no launcher rows with source-owned metadata, so the dogfood-count
  test (`Codex Runs keep dogfood launcher-only rows distinct`) is unaffected.
  When real Symphony source-owned Claude rows start appearing in dogfood
  registries, that fixture should be refreshed and the count assertion
  reviewed.
- The `AgentTask` interface still does not formally type
  `workflow_run` / `owner_actions` / `provenance` / camelCase aliases; the
  helper accepts them via a structural cast inside the helper. If those fields
  become first-class registry fields, consider promoting them to `AgentTask`
  proper and removing the local cast.
- No changes to detail rendering, sorting, or container tooltips; the new run
  inherits the standard launcher projection path (`projectLauncherTask`) and
  thus the same field sources / provenance treatment.

## Pre-existing artifact note

`research/HANDOFF-symphony-claude-launcher-runs-20260508-2202.md` was already
present in the working tree from a stood-down lane and is intentionally NOT
included in this commit.
