# REVIEW — cc visibility contract

## Scope
- `src/discovery/agent-registry.ts`
- `src/providers/agent-status-tree-provider.ts`
- `test/discovery/agent-registry.test.ts`
- `test/tree-view/agent-status-tree-provider.test.ts`
- `test/fixtures/agent-status/screenshot-stale-running.json`

## Findings

### WARNING — PID-based dedup still masks non-running launcher entries
- Location: `src/discovery/agent-registry.ts:91-109`
- The session-id mask is now correctly restricted to `task.status === "running"`, but PID masking is unconditional.
- If launcher tasks start carrying `pid` (the code already anticipates it), a non-running stale launcher row with a reused PID can still hide a live discovered agent. That is the same class of visibility bug this change set is addressing.

Suggested fix:
- Apply the same running-state gate to PID masking, e.g. only add to `launcherPids` when `task.status === "running"`.
- Add a test case in `test/discovery/agent-registry.test.ts` where launcher task is `completed_stale` with matching `pid` and discovered agent must remain visible.

## Checklist Validation
- Stale launcher entries never mask live discovery:
  - Partially satisfied. Session-id path is fixed and tested (`non-running` launcher no longer masks by session).
  - PID path remains asymmetric (warning above).
- Reload/reconnect merges deterministic state:
  - Satisfied. `reload()` now recomputes `_allDiscoveredAgents` and `_discoveredAgents` from the latest launcher registry before render, and coverage exists in `reload re-merges discovery against latest launcher state` test.
- Launcher `project_icon` passthrough consistency:
  - Satisfied. `project_icon` is normalized and used in both task labels and project-group labels.
- Visibility contract (status bar + running count) coverage:
  - Satisfied. Screenshot fixture test validates summary, dock badge, and status bar text consistency for stale-running downgrade behavior.

## Proceed Recommendation
- **Proceed with caution**: acceptable to merge, but follow up with the PID gating fix + test to fully close the stale-mask contract.
