# SPEC — Stale Process Lifecycle Governance + Visibility Contract

## Goal
Implement end-to-end stale-process lifecycle governance (detect → classify → recover/close) across Ghostty Launcher + Command Central so UI counts never inflate running agents, multi-agent concurrency is stable (3–4 agents), and running agents are deterministically visible. Provide CI-grade integration tests proving spawn → terminal → tracked running → completion accounting.

## Non‑Goals
- No new UI polish beyond what’s required to show correct states/counts.
- No refactor unrelated to session lifecycle, socket isolation, or running visibility.
- Defer non-critical multi-tab enhancements unless they directly fix stale or visibility.

## Scope (Must‑Have)
1) **Stale lifecycle governance**
   - Detect stale: no live terminal session, stale stream, or missing receipt.
   - Classify: mark tasks as `completed_stale` (or `failed` when receipt indicates non‑zero).
   - Recover: if receipt exists, recover completion status; otherwise mark stale.
   - UI counts must **exclude stale** from running.

2) **Concurrent agent mode (3–4 agents)**
   - Enforce socket/session isolation (unique session IDs per agent, no collisions).
   - Explicit rules for pod sessions: base vs role suffix behavior.
   - Health checks confirm each running agent is both alive **and** visible in CC.

3) **Multi‑tab persistence stabilization**
   - Prioritize socket isolation + stale prevention.
   - Defer extra UX tweaks until lifecycle is solid.

4) **Visibility contract**
   - If agent is running, UI + launcher **must** show it deterministically.
   - Add reproducible test using the provided screenshot scenario (commit in test folder) and ensure it survives restart/reconnect.

5) **Integration test**
   - Executable test (CI‑friendly) proving: spawn → terminal created → running tracked → completion accounting.
   - Must output a pass/fail artifact suitable for CI gating.

## Primary Files
### Ghostty Launcher
- `scripts/lib/reaper.sh` (stale detection + recovery)
- `scripts/oste-watchdog.sh` (periodic stale + idle checks)
- `scripts/oste-spawn.sh` (session/pod handling + socket cleanup)
- `scripts/lib/terminal*.sh` (session creation + socket mapping)
- tests under `test/` (see existing lifecycle/reaper/e2e tests)

### Command Central
- `src/providers/agent-status-tree-provider.ts` (running health + visibility)
- `src/utils/agent-counts.ts` (status counting)
- tests under `test/providers`, `test/tree-view`, `test/integration`

## Required Behaviors
- **Stale tasks never appear as running in counts or summary badges.**
- **Duplicate session IDs**: only newest running task remains running; older ones marked stopped/stale with clear reason.
- **Running task must be visible** if session exists OR discovered process/session confirms it.
- **Restart/reconnect** must rehydrate running tasks correctly from tasks.json + discovery sources.

## Test Requirements
1) **Stale count test (CC)** — a stale launcher task must not increment running count.
2) **Concurrency test (Launcher)** — spawn 3–4 agents; ensure session IDs unique and sockets isolated.
3) **Multi‑tab persistence** — ensure pod tabs don’t leak stale session sockets.
4) **Visibility contract test (CC)** — running agent appears in UI and stays after reload/restart.
5) **Integration test (Launcher)** — spawn → running → completion accounting with CI artifact.

## Implementation Notes
- Prefer changing lifecycle logic in launcher first, then align CC display logic.
- Use `completed_stale` consistently for stale cleanup.
- Keep scopes tight; avoid unrelated refactors.

## Deliverables
- Code changes in both repos (if needed) + tests.
- Evidence: test output proving each step.
- Short retro summary + list of scripts used for spawn context.

SPEC COMPLETE
