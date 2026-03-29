# DEV NOTES: Agent Status Recency P0

## Scope shipped

Implemented the first recency-focused slice of the Agent Status sorting redesign in `src/providers/agent-status-tree-provider.ts`.

- Added a real recency-first mode that uses `completed_at` when available and falls back to `started_at`.
- Changed the config default for `commandCentral.agentStatus.sortByStatus` to `false` so recency is the default behavior for this slice.
- Unified launcher-managed tasks and discovered agents under the same sort comparator in flat mode and inside grouped project nodes.
- Changed grouped project ordering so project groups and parent folder groups sort by freshest child activity instead of alphabetically.
- Added a lightweight visible sort indicator in the summary row: `Recent` or `Status`.
- Kept project grouping enabled by default. No current-project-only scoping was added.

## Tests updated

Updated `test/tree-view/agent-status-tree-provider.test.ts` to cover:

- Recency sorting with `completed_at` precedence over a later `started_at`
- Interleaving launcher and discovered agents under the same recency sort
- Grouped project ordering by freshest child activity
- Grouped child interleaving for launcher + discovered agents
- Explicit status-priority behavior when `sortByStatus=true`

Updated `test/package-json/agent-menu-contributions.test.ts` to reflect the new default config value.

## Verification

- `bun test test/tree-view/agent-status-tree-provider.test.ts`
- `TMPDIR=/tmp bun test`

Result: full suite passed, `964 pass`, `0 fail`.

## Validation caveat

The repo quality recipes could not run in this sandbox because Bun could not write temp files:

- `TMPDIR=/tmp just fix` -> `bun is unable to write files to tempdir: PermissionDenied`
- `TMPDIR=/tmp just check` -> `bun is unable to write files to tempdir: PermissionDenied`

The code was still validated with the full Bun test suite.
