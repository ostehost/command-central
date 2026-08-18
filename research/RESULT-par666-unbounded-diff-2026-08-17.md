# PAR-666 live traversal — Command Central shortcomings

Date: 2026-08-17
Lane: `par-666-manual-spoke-1`
Start SHA: `2f26ae54293cdfe359b7c288a97134642b3a7db2`

## What the UI showed

Agent Status listed the spoke as completed, owner-bound to
`agent:main:discord:channel:1539048163577700382`, then attributed:

- `docs/adr/0013-file-write-runner-transport-spike.md` M +15 -3
- `docs/adr/0014-same-host-direct-runner-poc.md` A +128
- `docs/adr/README.md` M +1
- `3 files · +144 / -3`
- `main · 2f26ae5`

That numstat is byte-exact `git show --stat 2f26ae5`, the current hub
`HEAD`, not the isolated worktree the lane reported (`0dc436d5` on
`codex/par666-null-commit-receipts-20260817`).

## Cause

`src/providers/git-diff.ts` treated an empty or failed bounded range as
`git diff HEAD~1..HEAD`. When start_sha == HEAD and end_commit was
blank, `"HEAD"`, or the same SHA, the empty `start..end` range fell
through to the previous commit. That is the GHLBR-02 consumer failure
in production: a missing result commit became “whatever just landed on
main.”

Lifecycle conflict (`Launcher marked completed but process is still
alive in terminal`) was a separate honest signal: Claude remained at
the TUI prompt. `Sources · Symphony — run attempts 3` is a different
read-only feed and must not be folded into this lane.

## Change made

- Blank / whitespace `end_commit` is missing, not a commit.
- Stale refs and empty `start..end` ranges now return no files.
- There is no `HEAD~1..HEAD` substitute for lane work.

## Not claimed

This does not invent an end commit, fetch the node worktree, or prove
the receipt-writer implementation. It only stops Command Central from
projecting the wrong diff.
