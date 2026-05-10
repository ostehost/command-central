# Handoff: Symphony Elixir Runtime Snapshot Alignment

Date: 2026-05-10
Owner: Oste
Repo: `/Users/ostemini/projects/command-central`
Status: next implementation steer after dogfood proof

## Current Verified State

The dogfood round landed and verified:

- `9d1ef96 feat(agent-status): tighten Symphony dashboard to spec runtime-snapshot vocabulary`
- `a58fb73 docs(research): record symphony dogfood proof/review`

Hub validation rerun by Oste:

- `bun test test/tree-view/openclaw-task-nodes.test.ts`: 32 pass / 0 fail
- `bunx tsc --noEmit --pretty false`: pass
- `git diff --check`: pass
- `just check`: pass
- `just ci`: 1529 pass / 8 skip / 0 fail

MacBook node installed-extension proof used a temporary worktree at commit
`a58fb736251972fd9470f1dbe74b2160da31f995` and a throwaway VSIX:

- VSIX: `/Users/ostehost/.openclaw/tmp/command-central-symphony-current-a58fb73-node.vsix`
- SHA256: `cb21b8d595dc5b31fd6f59938d116f617427acd977877be6050ce4d3b17dd5ed`
- Proof manifest:
  `/Users/ostehost/.openclaw/tmp/cc-symphony-proof-a58/logs/installed-vsix-agent-status-proof-1778424030954.json`
- Result: installed extension loaded from VSIX, SHA matched, errors `[]`.
- Agent Status snapshot showed:
  - `Symphony`
  - `Operations Dashboard`
  - `Running Sessions · 0`
  - `Retry Queue · 0`
  - `Workstreams · 0`
  - `Run Attempts · 34`
  - `Orchestrator Runtime State: Not provided by lifecycle owner`
  - `codex_totals.*: Not provided by lifecycle owner`
  - `rate_limits: Not provided by lifecycle owner`

The UI behavior is correct for a read-only Status Surface. The remaining gap is
owner-layer data, not a Command Central lifecycle gap.

## Elixir Demo Shape To Align With

The upstream Elixir presenter exposes a state payload shaped like:

- `generated_at`
- `counts.running`
- `counts.retrying`
- `running[]`
- `retrying[]`
- `codex_totals`
- `rate_limits`
- error envelope for `snapshot_timeout`
- error envelope for `snapshot_unavailable`

The upstream dashboard presents this as:

- Operations Dashboard
- Running metric
- Retrying metric
- Total tokens
- running sessions table
- retry queue table with issue, attempt, due time, and error

Command Central should mirror this payload shape when a lifecycle owner provides
it, but must not become the lifecycle owner.

## Next Slice

Implement a read-only Symphony runtime snapshot contract and projection path.

This is not a scheduler feature. It is an observability adapter.

Command Central may consume a source-owned snapshot if one is already present in
an owner record or registry. It must not poll Linear, create timers, infer
freshness from wall clock alone, dispatch retries, or write owner state.

## Minimal Contract

Add a typed read model for an owner-provided snapshot:

```ts
interface SymphonyRuntimeSnapshotView {
  generatedAt?: string;
  status: "fresh" | "timeout" | "unavailable" | "not_provided";
  error?: {
    code: "snapshot_timeout" | "snapshot_unavailable" | string;
    message: string;
  };
  counts?: {
    running?: number;
    retrying?: number;
  };
  running?: SymphonyRunningEntryView[];
  retrying?: SymphonyRetryEntryView[];
  codexTotals?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    secondsRunning?: number;
  };
  rateLimits?: unknown;
  source: "launcher" | "taskflow" | "openclaw" | "fixture";
  sourcePath?: string;
}
```

Entry views should use official spec names in UI labels:

- `Issue`
- `Run Attempt`
- `Live Session`
- `Retry Entry`
- `attempt`
- `due_at`
- `error`
- `last_codex_event`
- `turn_count`
- `codex_total_tokens`

## Implementation Rules

- Prefer consuming a snapshot already present in the loaded launcher/OpenClaw/
  TaskFlow records.
- If a file path is introduced, it must be explicitly configured or
  source-provided. No filesystem crawling.
- Keep `Not provided by lifecycle owner` for absent fields.
- Show `snapshot_timeout` and `snapshot_unavailable` exactly as source-owned
  error states.
- Keep `Running Sessions` and `Retry Queue` read-only. Counts and rows only.
- Do not add retry/cancel controls in this slice.
- Do not add a separate Activity Bar container or web dashboard.

## Tests Required

Add fixture-backed tests for:

- fresh snapshot: counts, running entries, retry entries, codex totals, and rate limits render.
- timeout snapshot: `Orchestrator Runtime State` reports `snapshot_timeout` with source message.
- unavailable snapshot: `Orchestrator Runtime State` reports `snapshot_unavailable`.
- absent snapshot: current `Not provided by lifecycle owner` behavior remains unchanged.
- boundary scan: no new retry/cancel/dispatch/tracker-write commands.

Keep the existing explicit-identity workstream grouping tests.

## Proof Required

Use the installed-VSIX proof harness on the MacBook node against a temporary
worktree or isolated profile. Do not install into Mike's normal VS Code profile
unless explicitly requested.

Required proof fields:

- VSIX path and SHA256
- commit SHA
- `command_central_loaded_from_vsix: true`
- `vsix_matches_expected_sha: true`
- `Symphony` root present
- `Operations Dashboard` includes the snapshot status
- `Running Sessions` and `Retry Queue` reflect the source-owned snapshot
- no boundary violations

## Process Blockers To Fix Or Avoid

- `oste-remote-spawn.sh` currently hits a node scope-upgrade preflight blocker
  for this dogfood path. Use a temporary node worktree plus installed proof
  until the launcher preflight is repaired.
- Same-project launcher lanes still share `session_id=agent-command-central`.
  Do not rely on `session_id` alone for grouping.
- `.claude/scheduled_tasks.lock` can make a completed lane look dirty. Treat it
  as launcher/harness debt unless the implementation touches that file
  intentionally.

## Acceptance Criteria

Accept only when Command Central can render an Elixir-shaped owner snapshot
without changing lifecycle ownership.

The correct final state is:

- CC displays the same categories the Elixir dashboard exposes.
- CC continues to say `Not provided by lifecycle owner` when owner data is
  missing.
- The authoritative `Orchestrator Runtime State` remains outside CC.
- Installed-extension proof passes on the MacBook node.
