# RESULT — cc-installed-vsix-dogfood-proof-20260614 (alias / recovery pointer)

> The original lane `cc-installed-vsix-dogfood-proof-20260614` committed real code
> (`d80c4805`) but ended **`contract_failure`** because this required handoff file was
> never written. A follow-up fixup lane reviewed the change and wrote the durable
> handoff. This file exists so the originally-missing path resolves for future auditors.

**Canonical handoff:** [`RESULT-cc-installed-vsix-dogfood-proof-fixup-20260614.md`](./RESULT-cc-installed-vsix-dogfood-proof-fixup-20260614.md)

## TL;DR

- **Change reviewed:** the original placeholder commit `d80c4805` was finalized during the
  fixup session into `5ef4c4bd`
  (`fix(agent-status): render detached truth for liveness-unobservable running lanes`).
  It adds honest `(detached)` / `debug-disconnect` rendering for `running` lanes whose live
  work Command Central cannot substantiate (launcher-projected `attach.available === false`
  / `visibility.degraded === true`, or a session-less projection row), gated by the runtime
  liveness probe so genuinely-live rows keep their spinner.
- **Verdict:** ✅ **ACCEPTED** — type-sound, biome-clean, regression-free. `tsc`,
  `just check`, `just test-unit`, and the targeted tree-view tests all pass; the finalized
  commit added 26 passing tests across the two feature test files.
- **Why the original failed:** missing handoff artifact only — not a code defect.
- **Remaining blocker:** the live *installed-VSIX* visual dogfood proof was not performed
  (the fixup lane is forbidden from building/installing/publishing a VSIX). The dedicated
  unit/integration tests that `d80c4805` originally lacked now exist in `5ef4c4bd`.

See the canonical handoff for the full review, test matrix, the `d80c4805` → `5ef4c4bd`
finalization, concurrent-lane notes, and final git state.
