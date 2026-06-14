# REVIEW - cc-history-stable-id-flat-fixup-20260614

Review target: `869e7a214760c0ec09f91a9b69b25357d9a871e6`
Requested range: `4690bc95a142b2833c969111321f95a4ebfc135a..869e7a214760c0ec09f91a9b69b25357d9a871e6`
Working repo confirmed by `pwd`: `/tmp/command-central-cc-history-stable-id-flat-fixup-20260614-review`

Initial `git status --short`: clean.
Final `git status --short` before handoff: clean except for this review artifact.

## Verdict

No BLOCKER findings.

The central implementation claim is accurate: the code adds a `SummaryNode.kind` discriminator, tags the Sources provenance summary with `kind: "sources"`, and returns `summary:sources` for those nodes while keeping ordinary count summaries at `summary`. The regression tests described in the notes are present, and the focused changed tests pass locally.

Not everything in the completion notes/artifacts is perfectly aligned. There is one warning about grouped-mode id wording and one metadata nit about the selected range boundary.

## Evidence Checked

- `git show --stat --name-only HEAD`
  - HEAD is `869e7a214760c0ec09f91a9b69b25357d9a871e6`.
  - HEAD itself changes only `research/RESULT-cc-history-dead-row-action-audit-20260614.md`.
- `git diff 4690bc95a142b2833c969111321f95a4ebfc135a..869e7a214760c0ec09f91a9b69b25357d9a871e6`
  - Contains only:
    - `research/RESULT-cc-history-dead-row-action-audit-20260614.md`
    - `research/RESULT-cc-history-stable-id-flat-fixup-20260614.md`
- Tighter diff suggested by the notes: `git diff 4690bc95a142b2833c969111321f95a4ebfc135a^..869e7a214760c0ec09f91a9b69b25357d9a871e6`
  - Matches the six reported files:
    - `research/RESULT-cc-history-dead-row-action-audit-20260614.md`
    - `research/RESULT-cc-history-stable-id-flat-fixup-20260614.md`
    - `src/providers/agent-status-tree-provider.ts`
    - `test/integration/tasks-json-startup-smoke.test.ts`
    - `test/tree-view/agent-status-tree-item-stable-id.test.ts`
    - `test/tree-view/agent-status-tree-provider.test.ts`

Focused tests run:

```bash
bun test test/tree-view/agent-status-tree-item-stable-id.test.ts test/tree-view/agent-status-tree-provider.test.ts test/integration/tasks-json-startup-smoke.test.ts
```

Result: 37 pass, 0 fail.

I did not independently rerun the full `just test` or `just check` commands. Their pass claims are recorded in `research/RESULT-cc-history-stable-id-flat-fixup-20260614.md`, and the changed focused tests pass in this review worktree.

## Findings

WARNING: Grouped-mode stable-id wording is inaccurate.

The committed result artifact says grouped-mode ids are "entirely unchanged" at `research/RESULT-cc-history-stable-id-flat-fixup-20260614.md:63`. Actual code tags every Sources provenance summary in `createSourcesProvenanceSummaryNode` (`src/providers/agent-status-tree-provider.ts:6493-6496`) and `getStableTreeItemId` returns `summary:sources` for any `kind === "sources"` summary (`src/providers/agent-status-tree-provider.ts:3698-3702`). Therefore the grouped-mode Sources summary id changes from the previous constant `summary` to `summary:sources` too.

This does not invalidate the flat-mode duplicate-id fix, and it may be an acceptable tradeoff, but the notes should not describe grouped-mode ids as unchanged. The more precise claim is: ordinary count summary ids stay `summary`; Sources provenance summary ids are now `summary:sources` in all modes.

NIT: The reported file list matches the combined task span, not the requested range as written.

The completion report lists six changed files. That is accurate for `4690bc95^..869e7a2`, but not for the requested `4690bc95..869e7a2` range, which contains only the two research artifacts. Since the notes also identify `4690bc95` as the fix commit, the code claims are still verifiable in the current repo state. This is a range-boundary/metadata ambiguity, not a code mismatch.

## Aligned Claims

- Fixed root cause: `getStableTreeItemId` no longer returns the same `summary` id for both flat root summary siblings.
- Code change exists as described:
  - `SummaryNode.kind?: "sources"` at `src/providers/agent-status-tree-provider.ts:427`
  - Sources factory sets `kind: "sources"` at `src/providers/agent-status-tree-provider.ts:6495`
  - stable id returns `summary:sources` for Sources summaries at `src/providers/agent-status-tree-provider.ts:3702`
- Regression tests exist:
  - node-level count-vs-Sources id test at `test/tree-view/agent-status-tree-item-stable-id.test.ts:365`
  - full flat-render unique-id walk at `test/tree-view/agent-status-tree-item-stable-id.test.ts:381`
- Existing exact-shape assertions were updated for the new `kind` field in:
  - `test/tree-view/agent-status-tree-provider.test.ts`
  - `test/integration/tasks-json-startup-smoke.test.ts`
- Focused changed tests pass locally.

REVIEW COMPLETE
