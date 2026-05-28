# Agent Status pane liveness fix — handoff (2026-05-27)

- **Task id:** `cc-agent-status-pane-liveness-fix-20260527-2323`
- **Exec host:** Mike's MacBook Pro node
- **Repo:** `/Users/ostehost/projects/command-central`
- **HEAD before:** `4ac5f032b757` (tree `b9a1f2acb0ce`, clean)
- **HEAD after:** `abbfd6ec` — `fix(agent-status): treat transient pgrep failures as unknown, not dead`
- **`git status --short --branch`:** `## main...origin/main [ahead 43]` (no working-tree changes)

## Confirmed root cause

The hypothesis in the dispatch brief was correct. `walkDescendants` in
`src/utils/tmux-pane-health.ts` caught **every** `pgrep -P <pid>` failure with
a bare `try/catch ... continue`. That made these three cases
indistinguishable:

1. `pgrep` exited cleanly with status `1` — legitimate "no children".
2. `pgrep` was killed by the 500 ms `timeout` option (signal → `err.status === null`).
3. `pgrep` threw a fatal/unknown error.

Only case 1 is proof of absence. Cases 2–3 are transient probe failures.
When every parent pid in a depth tick happened to fail for reason 2 or 3,
`visited` collapsed to just the pane pids, `descendantPids` came back
empty, and the function returned `"dead"`. That cascaded as:

`inspectTmuxPaneById` → `getTmuxPaneAgentEvidence` returns `"dead"` →
`isRunningTaskHealthy` returns `false` (provider line 1995) → display task
is downgraded → UI renders **"Agent process ended: Click to restart or
dismiss"**.

On the next refresh (5 s cache TTL) `pgrep` succeeded, evidence flipped
back to `"alive"`, the task rendered as `"Running for ~2h • Interactive —
no stream activity for 15 minutes"`, and Mike saw the flap. The launcher's
raw task state (`running`, no `exit_code`, no `completed_at`, no pending
review) never changed during any of this — confirming that this was a
client-side classification bug, not a launcher truth change.

The live evidence on the node matched the hypothesis: pane `%35` is a
`bash|35441` login shell whose descendant chain ends at a real
`claude --session-id 1411323e…` process. The pane is genuinely alive; any
`"dead"` evidence here was a false negative.

## Files / functions changed

- `src/utils/tmux-pane-health.ts` — `walkDescendants(...)`
  - Distinguishes `pgrep` exit status `1` (clean "no children") from every
    other failure mode (timeout signal → `status: null`, fatal exit,
    generic throw). Only the clean case still contributes to a `"dead"`
    classification.
  - Introduces a `probeFailure` flag set whenever a non-status-1 error is
    caught. After the walk:
    - If no descendants were collected: `dead` only when `probeFailure ===
      false`; otherwise `unknown`.
    - If descendants were collected and `ps` saw no agent comm: same rule
      — `dead` only when no upstream probe failed; otherwise `unknown`.
  - `ps` failure still fails-open as `unknown` (unchanged).
  - Added a multi-paragraph header comment documenting the invariant
    (`"dead" must mean we proved absence`) and the pgrep exit-code
    semantics, since this is exactly the kind of liveness contract that
    silently rots.

- `test/utils/tmux-pane-health.test.ts`
  - Replaced the test that documented the buggy behavior
    (`"pgrep -P throws → no descendants collected → dead (false)"`) with
    two regression tests:
    1. `pgrep -P throws without status=1 → fail-open (true)`
    2. `pgrep -P killed by signal (status null) → fail-open (true)`
  - Added three new tri-state coverage tests:
    - `inspectTmuxPaneAgent` returns `'dead'` **only** when `pgrep` exits
      cleanly with status 1.
    - `inspectTmuxPaneAgent` returns `'unknown'` on a generic pgrep throw.
    - `inspectTmuxPaneAgent` returns `'unknown'` when a partial probe
      succeeds at depth 1 but a deeper-level probe fails (we can't prove
      the unreadable subtree is agent-free even when `ps` sees only
      non-agent comms at the readable layer).
  - Added a pane-specific repro test on `inspectTmuxPaneById` that
    mirrors the live `%35` / pid `35441` topology and asserts the new
    `'unknown'` outcome instead of the old `'dead'` flap.

Existing positive-evidence tests (pane current command match, descendant
comm match), session-id / pane-id validation, socket forwarding, and
no-pane / no-output edge cases are unchanged and still pass.

## Tests added / changed

- `test/utils/tmux-pane-health.test.ts`: +5 new tests, 1 test rewritten
  (replacing the test that documented the buggy behavior). Net `+96 / -9`
  lines.

## Validation command results

All run from `/Users/ostehost/projects/command-central` on Mike's MacBook
Pro node, against HEAD `abbfd6ec` (post-commit, clean working tree):

| Command | Result |
| --- | --- |
| `bun test test/utils/tmux-pane-health.test.ts` | **41 pass, 0 fail**, 70 expect() calls, 23 ms |
| `bun test test/tree-view/agent-status-tree-provider-health.test.ts` (+ 4 sibling tree-view files: `agent-status-tree-provider.test.ts`, `agent-status-tree-provider-pure-helpers.test.ts`, `agent-status-launcher-interactive-claude.test.ts`, `agent-status-dead-process-running.test.ts`) | **92 pass, 0 fail**, 209 expect() calls, 414 ms |
| `just test-unit` | **431 pass, 0 fail**, 861 expect() calls across 39 files, 267 ms |
| `just check` (Biome CI + tsc + knip) | green, 244 files checked, 213 ms, no warnings |

Pre-commit hook (Biome on staged files) also ran and passed; commit was
created without `--no-verify`.

## Live task notes — `cc-agent-status-fresh-lane-20260527-2111`

No re-check executed against the live launcher task. The brief asked
this only "if you re-check it" and explicitly forbade touching launcher
lifecycle files; the gathered evidence in the dispatch already proved
the pane is alive and the bug is in client-side classification. The fix
is verified entirely by deterministic mocked-execFile unit tests that
reproduce the exact pane → bash-pid → unreadable-pgrep topology
observed on `%35` / `35441`. Re-launching VS Code on Mike's node and
expanding the Agent Status entry for that lane is the expected manual
sanity check once the next preview VSIX is installed.

## Preview / release-cycle recommendation

**Include this fix in the next Command Central preview.** The bug is
release-blocking for the user-visible Agent Status pane and the fix is
small, well-tested, and confined to one helper file. Risk surface:

- Only the `'dead'` outcome of `walkDescendants` is affected; positive
  agent matches are unchanged, so we cannot regress the "ghost lane is
  truly dead" path that exists when `pgrep` cleanly enumerates an empty
  child set.
- Existing tree-provider tests that assert `completed_stale` /
  `completed_dirty` / `stopped` transitions for tmux tasks set the
  liveness cache directly and do not go through `walkDescendants`, so
  the new fail-open behavior cannot accidentally mask their dead-state
  assertions.

**No release action performed in this lane.** No push, no tag, no
`just cut-preview`, no `just dist`, no `just prerelease`.

### Exact next command(s) for Oste

When you are ready to ship, run from this repo on the node:

```sh
just cut-preview
```

(That wraps `just prerelease-gate` + `just dist --prerelease` + the
cross-repo launcher coordination per `.claude/skills/cut-preview/`.)

If you want a dry-run gate first without bumping the version:

```sh
just prerelease         # cross-repo gate, no version bump
just dist --dry-run --prerelease   # show what cut-preview would do
```

Branch is `main`, currently `[ahead 43]` of `origin/main`. No
push is required for `just cut-preview` itself, but the launcher /
release skill will tell you when to push.
