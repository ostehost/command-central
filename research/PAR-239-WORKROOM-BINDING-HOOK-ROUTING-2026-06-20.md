# PAR-239 — [CCREL-07] Persist visible-lane workroom binding for Claude hook routing

- **Task:** `symphony-PAR-239-4e31f530` (visible Command Central implementation lane)
- **Date:** 2026-06-20
- **Linear:** PAR-239 (Command Central project)
- **Mode:** Agent Teams delegate (lead + Implementer + Tester, both Sonnet)

## Problem

The Ghostty Launcher work-system bridge emits a `lane_ref_update` envelope whose
`workroom_ref` / `work_item_ref` were sourced **only** from the `OSTE_WORKROOM_REF`
/ `OSTE_WORK_ITEM_REF` environment variables
(`scripts/lib/work-system-bridge.sh` → `work_system_lane_ref_update`).

The bridge's own header already documents that emission fires from heterogeneous
entry points — spawn shell, **Claude Code Stop hook**, and the launchd reaper —
"whose environments do not share exports." The Stop hook
(`scripts/lib/oste-stop-hook.sh`) and the reaper invoke
`work_system_emit_lane_ref_for_task` with those env vars **unset**, so every
completion / terminal emission silently dropped the workroom binding to `null`.
The visible lane could therefore not be routed back to its workroom at hook time.

Every other lane field (`session`, `lane_kind`, `worktree`, …) is already
**row-backed**: derived from the persisted `tasks.json` task row, not from the
live env. `workroom_ref` / `work_item_ref` were the only two refs still
env-only — the bug.

## Fix (smallest safe, row-backed — mirrors the existing pattern)

The implementation is **cross-repo**. The persist/export half is launcher-owned;
Command Central is the consumer + ships the bundled launcher artifact.

### `~/projects/ghostty-launcher` (canonical — the actual hook-routing persist/export)
1. `scripts/oste-spawn.sh` `register_task()` — persist `OSTE_WORKROOM_REF` /
   `OSTE_WORK_ITEM_REF` into the spawn-time `tasks.json` row as
   `workroom_ref` / `work_item_ref` (null when unset).
2. `scripts/lib/work-system-bridge.sh` `work_system_lane_ref_enrich()` — row-backs
   both refs when the envelope value is null
   (`.workroom_ref = (.workroom_ref // ($row.workroom_ref // null))`). Env wins at
   spawn; the row fills the env-less Stop-hook / reaper path. Fail-soft, no
   signature change to `work_system_lane_ref_update`.
3. `scripts/laneref-update-schema.json` — descriptions updated to document the
   spawn-persist + row-backed fallback.
- Commits: `09a5ae7e` (impl), `3e5f6716` (test). `test-work-system-bridge.sh`:
  149 assertions / 34 tests pass, incl. the new env-less row-backfill case and an
  env-wins non-regression case.

### `~/projects/command-central` (this visible lane — consumer + release artifact + evidence)
4. `just sync-launcher` — bundled `resources/bin/scripts/lib/work-system-bridge.sh`
   (+ the rest of the launcher tree) brought up to canonical; bundled copy now
   byte-matches canonical. Commit `9f22e491`.
5. `src/providers/agent-status-tree-provider.ts` — surface `workroom_ref` /
   `work_item_ref` on the ingested projection row. Added to the `AgentTask`
   interface, to `laneRefUpdateToTaskRecord()` (envelope top-level), **and** to
   `normalizeTask()` (the whitelist rebuilder that would otherwise drop them — the
   gap that initially failed the ingest test). Commits `5679e2d2`, `1900ae06`.
6. Tests (commit `1900ae06`):
   - `test/integration/worksystem-lanes-projection.test.ts` — envelope-carried refs
     surface on the ingested row.
   - `test/scripts/work-system-bridge-workroom.test.ts` (new) — drives the **shipped
     bundled artifact** with `OSTE_WORKROOM_REF`/`OSTE_WORK_ITEM_REF` deleted from
     the subprocess env (Claude Stop-hook simulation) and asserts the outbox
     projection carries both refs row-backed from the `tasks.json` fixture; plus an
     env-wins case.

## Verification

- Launcher: `just test work-system-bridge` → 149 assertions / 34 tests, rc=0.
- Command Central: `just test` → **2308 pass / 1 skip / 0 fail**. The two new test
  files independently: 15 pass / 0 fail / 82 expect() calls.
- `just check` green in both repos. Bundled vs canonical bridge diff: empty.

## Cross-repo dependency (recorded, not guessed)

The hook-routing persistence is **launcher-owned**: it lives in
`~/projects/ghostty-launcher` (`oste-spawn.sh` + `work-system-bridge.sh`) and
reaches Command Central only through the bundled `resources/bin/` artifact via
`just sync-launcher`. Command Central cannot fix env-less hook routing on its own —
it consumes the row-backed envelope. Both repo halves are committed locally; **no
push / tag / publish** was performed (awaiting explicit approval per repo policy).

Note: `releases/digest-v0.6.0-rc.66.md` was already modified in the shared working
tree by a concurrent lane during this work; it is unrelated to PAR-239 and was
deliberately left untouched (not staged, not reverted).

## Re-verification — visible lane `symphony-PAR-239-5f403300` (2026-06-20)

A second visible Command Central lane re-spawned on PAR-239 and confirmed the
prior lane's cross-repo implementation is fully committed and still green. No
source change was required — the smallest safe change for this issue was already
landed; this lane is a verification + evidence closeout (Agent Teams delegate:
lead + Tester, Sonnet).

Committed state re-confirmed:
- Launcher `09a5ae7e` (impl) + `3e5f6716` (test) present; `oste-spawn.sh`
  `register_task()` persists `workroom_ref`/`work_item_ref` into the spawn-time
  row; `work-system-bridge.sh` `work_system_lane_ref_enrich()` row-backs both
  refs on the env-less path.
- Command Central `9f22e491`/`5679e2d2`/`1900ae06`/`69d7f57d` present; provider
  surfaces both refs on the ingested projection row; bundled bridge byte-matches
  canonical.

Fresh verification numbers (identical to the original run):
- Command Central `just test` → **2308 pass / 1 skip / 0 fail** (6319 expect()).
- Command Central `just check` → green (only `noNonNullAssertion` style warnings
  + informational Knip; no errors).
- PAR-239 test files (`work-system-bridge-workroom` + `worksystem-lanes-projection`)
  → 15 pass / 0 fail (82 expect()).
- Launcher `just test work-system-bridge` → 149 assertions / 34 tests, rc=0,
  incl. both env-less row-back cases and both env-wins non-regression cases.
- Bundled vs canonical `work-system-bridge.sh` diff → empty (byte-for-byte).

No push / tag / publish performed (repo policy: explicit approval required).
