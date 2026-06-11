# RESULT - L6 explicit diffMode release-blocker contract

- Task: `cc-l6-explicit-diffmode-release-blocker-fable-20260611`
- Date: 2026-06-11
- Base: `a8981e41` (on top of `26f8f96f` working-tree diff routing fix and `60cb3330` L5 extraction)
- Problem: the L5 fix routed working-tree diffs by smuggling `taskStatus: "running"` through the `openFileDiff` payload. It worked, but routing intent was implicit in a status field — a leaky contract for a release-grade API.

## Contract change

`src/providers/agent-status-tree-provider.ts`

- New exported type `AgentDiffMode = "workingTree" | "boundedCommit"` documented next to `FileChangeNode`.
- `FileChangeNode.taskStatus` (produced but never consumed inside the provider — it existed only to feed `openFileDiff`) is replaced by `diffMode: AgentDiffMode`.
- `getFileChangeChildren` derives the intent at the producer: running tasks emit `workingTree`, everything else `boundedCommit`. This keeps the `smartOpenFile` deleted-file fallback (FileChangeNode → `openFileDiff`) on the explicit contract.

`src/activation/register-agent-diff-commands.ts`

- `showGitDiffAsFilePicker` takes a required `diffMode: AgentDiffMode` instead of an optional `taskStatus` and forwards it verbatim in both `openFileDiff` payloads (single-file direct route and quick-pick route). The old `taskStatus ?? "completed"` default is gone.
- Discovered/live agents pass `"workingTree"` explicitly.
- Running launcher tasks pass `"workingTree"` with the same logical left ref as before (`start_sha`, else the commit before `started_at`, else `HEAD~5`); completed tasks pass `"boundedCommit"` with start and end refs.
- The pre-picker guard is unchanged: completed launcher tasks without a usable `end_commit` stop at "No bounded diff is available for this task."
- `openFileDiff` routes only on `node.diffMode === "workingTree"`. `taskStatus` is removed from its payload type; payloads without a `diffMode` (including legacy `taskStatus`-bearing ones) are treated as bounded-commit and hit the bounded-diff guard when no end ref is supplied.

## Test changes

`test/commands/agent-diff-commands-registration.test.ts` (22 → 26 tests)

- Updated every `openFileDiff` payload from `taskStatus` to `diffMode` (`running` → `workingTree`, `completed` → `boundedCommit`), including the discovered-agent single-file routing assertion.
- New: running launcher task routes single-file diffs to `openFileDiff` with `diffMode: "workingTree"`, `startCommit` = `start_sha`, `endCommit` undefined (real temp git repo).
- New: completed launcher task with both refs routes as `diffMode: "boundedCommit"` with both SHAs, against a deliberately dirtied working tree to prove the bounded diff ignores it.
- New: completed launcher task without an `end_commit` stops at the "No bounded diff is available for this task." guard with no `openFileDiff` dispatch.
- New regression: a legacy payload carrying `taskStatus: "running"` but no `diffMode` does NOT open a working-tree diff — it hits the bounded guard. This pins "status is never the routing signal."

`test/tree-view/agent-status-tree-provider-discovery.test.ts`

- `getParent` FileChangeNode literal updated from `taskStatus: "completed"` to `diffMode: "boundedCommit"`.

## Gates run

| Gate | Result |
|---|---|
| `bun test test/commands/agent-diff-commands-registration.test.ts` | 26 pass / 0 fail |
| `just test-unit` | 129 + 450 pass / 0 fail |
| `just check` (biome ci + tsc + knip) | passed |
| `just test` | 1920 pass / 0 fail / 1 skip, quality checks passed |
| `just fix` (pre-commit formatter) | clean, no drift |

## Release posture

- No rc was cut in this lane; no push, tag, publish, or VSIX install.
- rc53 predates both `26f8f96f` and this contract change; the next preview must be rc54 or later.
- Installed-VSIX proof (`just verify-vscode-consumption`, `just test-installed-vsix-agent-status`) still pending for the post-`26f8f96f` stack and now also covers this commit.

## Verdict

**Yes** — safe to proceed to the rc54 cut if installed-VSIX proof passes. The change is a contract clarification with behavior pinned by tests on all four routing paths (discovered working-tree, running launcher working-tree, completed bounded, completed unbounded guard), and the full suite is green.
