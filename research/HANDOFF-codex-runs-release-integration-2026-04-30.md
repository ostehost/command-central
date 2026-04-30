# Handoff: Codex Runs Post-RC13 Alignment Correction

Date: 2026-04-30
Repo: `/Users/ostemini/projects/command-central`
Audience: main OpenClaw agent
Status: ready for final review, commit, hub/node propagation, and next-phase planning

## Context

The Command Central Codex/Symphony visibility MVP was integrated and cut through
`oste.command-central@0.6.0-rc.13`.

Main-agent feedback after review:

- Remove the remaining title-based launcher join.
- Add a regression test proving an owner row whose display title equals an unrelated launcher id does
  not inherit that launcher metadata.
- Keep the next slice on VS Code-native tree ergonomics and provenance.
- Do not move Command Central into JSONL/process acquisition without a separate acquisition spec.

This pass implements that narrow correction only.

## Scope Boundary

This is still visibility-only.

Do not add:

- scheduler behavior
- lifecycle authority
- retry queues
- tracker writes
- SQLite writes
- JSONL/process acquisition
- dashboard surfaces
- Codex launches
- workspace hooks

Command Central remains the operator UI. Lifecycle authority remains with OpenClaw, TaskFlow, or the
launcher/source owner.

## Changed Files

- `src/providers/agent-status-tree-provider.ts`
- `src/services/codex-run-observer-service.ts`
- `test/services/codex-run-observer-service.test.ts`
- `test/tree-view/openclaw-task-nodes.test.ts`
- `research/SPEC-codex-symphony-visibility-layer-2026-04-29.md`
- `research/HANDOFF-codex-run-observer-mvp-2026-04-29.md`
- `research/HANDOFF-codex-runs-release-integration-2026-04-30.md`

No new release artifact was cut in this correction pass.

## What Changed

Projection join hardening:

- Launcher metadata now joins owner rows only by explicit identity:
  - owner `taskId` matching launcher `AgentTask.id`
  - owner `runId` matching launcher `AgentTask.id`
  - normalized session identity
- Display title equality is not a launcher join key.
- The remaining title-equality allowance in launcher title enrichment was removed too, so the code no
  longer has a hidden display-title fallback.
- The MVP spec and handoff now describe launcher joins as `taskId`, `runId`, or session identity
  only.

VS Code-native Agent Status tree:

- Renamed the visible detail row from `Lifecycle owner` to `Lifecycle authority`.
- Added `Lifecycle Authority: ...` to individual Codex run hover text.
- Added a root `Codex Runs` hover that states:
  - the count is a read-only projection
  - exact normalized status counts
  - lifecycle authority stays with the source owner
- Improved the root `Codex Runs` description so neutral stopped runs are visible instead of hidden
  behind the total count.

Dogfood fixture behavior in a real Extension Development Host:

- `Codex Runs · 101` appears at root.
- The compact description renders as status buckets such as:
  - `15 attention · 26 stopped · 60 done`
- Expanding a run shows:
  - `Status: Failed`
  - `Source status: failed`
  - `Lifecycle authority: launcher:cc-steer-contract-fix (...)`
  - workspace/run-id details

## Verification Completed

Focused verification:

```bash
bun test test/tree-view/openclaw-task-nodes.test.ts test/services/codex-run-observer-service.test.ts
bunx tsc --noEmit --pretty false
git diff --check
```

Result:

- `24 pass`
- `0 fail`
- typecheck passed
- diff check passed

Full gate:

```bash
just ready
```

Result:

- `1461 pass`
- `1 skip`
- `0 fail`

Build and real VS Code dogfood:

```bash
bun run build
just fixture-edh test/fixtures/agent-status/dogfood-live-tasks.json
```

Observed in the Extension Development Host:

- `Codex Runs · 101`
- `15 attention · 26 stopped · 60 done`
- expanded detail row includes `Lifecycle authority: launcher:cc-steer-contract-fix (...)`

## Review Instructions

Review this as a small post-release UX/provenance patch, not a new acquisition or scheduler slice.

Check:

- The tree wording says `Lifecycle authority`, not `Lifecycle owner`.
- The root description accounts for active/attention/stopped/cancelled/unknown/done buckets without
  creating lifecycle state.
- The root tooltip clearly says the group is read-only projected visibility.
- The observer no longer joins or enriches through broad display-title matching.
- Tests cover both the single active run case and the dogfood fixture status buckets.
- No service/projector logic was widened.

## Hub And Node Propagation

If approved, commit this patch on the hub and propagate it to the node through the normal
non-destructive path.

Before updating the node checkout:

```bash
git status --short
git rev-parse HEAD
```

After updating, verify hub and node match the chosen commit:

```bash
git rev-parse HEAD
git diff --stat <hub-sha>
```

Install a new preview VSIX only if the maintainer wants this follow-up in the next rc. Since rc12 is
and rc13 are already cut, the likely release path is a subsequent preview through the existing
release tooling, not manual artifact editing.

## Feedback Requested

Report back with:

- final commit SHA
- whether a new VSIX was cut or this stayed source-only
- hub verification result
- node verification result
- whether the dogfood EDH still shows `Codex Runs · 101`
- whether the root description reads well with stopped runs separated from attention
- any remaining UX concern around legacy Background/OpenClaw coexistence

Capture anything that smells like JSONL/process acquisition, dashboard work, or lifecycle
reconciliation as a separate future spec. Do not fold it into this patch.
