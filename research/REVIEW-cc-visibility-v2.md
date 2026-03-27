# REVIEW — cc-visibility-v2

## Findings

- WARNING: Missing positive test for running PID masking (`test/discovery/agent-registry.test.ts`).
  - The new regression test correctly proves that a non-running launcher task with matching `pid` no longer masks a discovered agent (`does not filter discovered agent when launcher PID is non-running`, lines 186-209).
  - There is no explicit companion test asserting that a *running* launcher task with matching `pid` still masks the discovered agent.
  - Current implementation in `src/discovery/agent-registry.ts` lines 94-102 appears correct (PID/session masks are both gated under `task.status === "running"`), but the running-PID behavior is not directly locked in by tests.
  - Suggested minimal follow-up: add one test with `status: "running"` and `pid` matching the discovered agent; expect filtered result length `0`.

- NIT: Scope and code clarity are good.
  - `src/discovery/agent-registry.ts` keeps PID and session gating in one guarded block (`status === "running"`), which matches the intent and avoids the prior stale-PID masking class of bug.
  - The added non-running PID test is minimal and readable.

## Go/No-Go

GO (with warning).

No blocker found in the implementation itself for this fix.
