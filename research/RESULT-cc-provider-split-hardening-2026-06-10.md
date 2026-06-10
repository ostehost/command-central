# RESULT — cc-provider-split-hardening (2026-06-10)

Task ID: `cc-provider-split-hardening-20260610`
Commit: `f3f16d3a` — `refactor(providers): extract task classification into agent-task-classification.ts`

## What changed

One extraction, no behavior change: the pure task-classification block was
moved verbatim out of `src/providers/agent-status-tree-provider.ts`
(**8,971 → 8,649 lines**, −348/+26) into a new vscode-free module.

| File | Change |
| --- | --- |
| `src/providers/agent-task-classification.ts` | **New** (~360 lines). Terminal-surface classifier (`classifyTaskSurface`, `TaskSurfaceKind`, `TaskSurfaceSummary`), completion routing (`classifyCompletionRouting`), lifecycle conflict (`classifyLifecycleConflict`), host identity / remote-node detection (`getTaskExecutionHostLabel`, `isRemoteNodeTaskForCurrentHost`, `__setCurrentMachineHostOverrideForTests` test seam), `getTaskDisplayProjectName`. No `vscode` import — pure metadata → summary functions. |
| `src/providers/agent-status-tree-provider.ts` | Block removed; imports the helpers it uses internally and **re-exports every previously-public symbol**, so all existing import sites (`src/extension.ts`, `test/commands/extension-commands.test.ts`, tree-view tests) are untouched. |
| `test/tree-view/agent-status-task-classification.test.ts` | **New** (23 tests). Direct coverage for `classifyTaskSurface` (all 7 surface kinds, bundle-path sentinels, host normalization) and the host/display helpers — none of which had direct tests before. `classifyCompletionRouting`/`classifyLifecycleConflict` keep their existing coverage in `agent-status-tree-provider-pure-helpers.test.ts` via the re-exports. |

Design notes:
- Type-only back-import of `AgentTask`/`AgentTaskStatus` from the provider
  follows the existing convention (`src/utils/agent-counts.ts`,
  `src/utils/auto-review-lane.ts` do the same); erased at compile time, no
  runtime cycle.
- Agent/model-neutral: detection text and classifier logic untouched.
- No command IDs, package.json, dependencies, or release artifacts touched.

## Verification

| Gate | Result |
| --- | --- |
| `bun test test/tree-view/` | 385 pass / 0 fail |
| `just test-unit` | 432 pass / 0 fail |
| `just test` (full suite) | 1,723 pass / 0 fail (1 pre-existing skip), quality checks pass |
| `just check` (biome ci + tsc + knip) | clean; `bunx knip` exit 0 |
| Pre-commit hook (Biome staged) | pass |

## Not committed (concurrent lane)

`test/tree-view/_helpers/agent-status-tree-provider-test-base.ts` and
`test/tree-view/agent-status-tree-provider-discovery.test.ts` carry in-flight
edits from a separate workstream (new `createDiscoveredAgent` /
`setDiscoveredAgents` helpers replacing inline private-state poking). They are
not part of this task and were deliberately left uncommitted; the full gate
above passed with them present in the working tree.

## Remaining bloat hotspots (next candidates)

`agent-status-tree-provider.ts` is still ~8.6k lines. Largest remaining
cohesive chunks, in rough extraction-value order:

1. **`getSymphonyDashboardDetailChildren` (~323 lines) + `getCodexRunDetailChildren` (~114)** — Symphony/Codex-run detail rendering is nearly self-contained; a `symphony-detail-nodes.ts` module could take ~450 lines.
2. **`getDetailChildren` (~291 lines) + `createTaskItem` (~228)** — task detail/row rendering; depends on classification (now separate) and formatting helpers, so it's the natural second split.
3. **Task normalization (v1 → v2)** — `normalizeTask`/`normalizeRegistryTasks` (~190 lines of pure field mapping near the top of the file); trivially extractable with the same re-export pattern.
4. **Node type definitions** (~640 lines of interfaces before the class) — moving to a `agent-status-tree-nodes.ts` types module would cut a third of the pre-class region, type-only and zero-risk.
5. **`getChildrenImpl` (~307 lines)** — the tree dispatcher; better treated by case-by-case delegation after splits 1–2 than by direct extraction.
