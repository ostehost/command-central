# REVIEW — symphony-daemon 8204fd2 + CC owner_waiting

Pulled `8204fd292cef44660cfb8ddec3b17fa339001d47` on 2026-08-18.

## Symphony Daemon review (`chore: auto-commit agent work [symphony-receipt-directory-fsync-20260818]`)

### What it does
`writeReceipt` now fsyncs the containing directory after `link`+`unlink`. Content fsync + name publication + directory fsync all precede `{ok:true}`. A directory-fence `EIO` refuses as UNCERTAIN. Mutation `receipt_directory_entry_is_never_persisted` pins the fence.

Focused tests: DIRECTORY-durable, directory fence, unwritable acceptance — 3 pass.

### Critical
None. Fail-closed on fence failure is correct.

### Warnings
- Notes file still says **NOT committed**; the tree was auto-committed. Stale provenance.
- Commit subject is a chore auto-commit, not the defect name.
- If `link` succeeds and `fsyncDirectory` throws, the file exists on disk while the port returns refusal. Callers must treat UNCERTAIN as “do not claim accepted,” even if the path is readable. Existing uncertain path covers this if they do not re-stat the file as success.

### Suggestions
- Align notes Git-state section with the published SHA.
- Keep this in the local-POC transport only; do not treat it as authenticated Runner transport.

### Looks good
- Matches existing `src/v2/receipts.ts` / `snapshot.ts` directory-fence idiom.
- Tests drive `launchSupervisedRunner`, not a private helper.
- Open dir `r` for fsync is the portable pattern.

## Command Central follow-on

`owner_waiting` was missing from review vocabulary. A completed canary with a present receipt went to History (`done`), hiding the next process step.

Fix: completed + `owner_waiting` → Needs Review (`limbo`) with `owner review waiting`. Unsettled launcher states also count as pending projections. `isReviewLifecycleResolved` still treats `owner_waiting` as unresolved.
