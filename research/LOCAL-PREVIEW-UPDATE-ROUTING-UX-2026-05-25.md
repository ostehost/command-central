# Local Preview Update — Routing UX (2026-05-25)

## Mission

Build and install a local preview (rc.40) of Command Central so Mike can
dogfood the latest Agent Status UX changes: completed-session suppression,
previous chat/resume surfacing, and owner-bound vs detached completion
routing visibility.

## Host & Path

- **Host:** ostehost@MacBookPro (Mike MacBook Pro)
- **Repo:** `/Users/ostehost/projects/command-central`
- **Branch:** `main` (canonical checkout)

## Commands Run

| Step | Command | Result |
|------|---------|--------|
| 1 | `bun test --filter "agent"` | 537 pass, 1 fail (pre-existing discovery-e2e, see fix below) |
| 2 | `just check` | PASS (Biome + tsc + Knip) |
| 3 | Fix `internal-tool-dir` symlink bug in `process-scanner.ts` | Committed `613b6b78` |
| 4 | Full test suite (`just test`) | 1594 pass, 0 fail, 1 skip |
| 5 | `just cut-preview` | PASS — preflight, sync-launcher, ci rehearsal, gate, dist |
| 6 | `code --list-extensions --show-versions` | `oste.command-central@0.6.0-rc.40` confirmed |

## VSIX Produced

- **Version:** `0.6.0-rc.40`
- **File:** `releases/command-central-0.6.0-rc.40.vsix` (1.93 MB)
- **Installed to VS Code:** Yes

## Commits Since rc.39

```
e95e0429 chore: auto-commit agent work [cc-dogfood-reaper-false-fail-20260525-2138]
0cb14648 feat(agent-status): surface lifecycle conflict when launcher says failed but process is alive
613b6b78 fix(discovery): check internal-tool-dir before symlink canonicalization
3b9c9d2a chore: auto-commit agent work [cc-prev-chats-completion-20260525-2055]
3ad35631 feat(agent-status): surface completion routing and redesign action menu
```

## Bug Fix Included

**`613b6b78` — fix(discovery): internal-tool-dir before symlink canonicalization**

On machines where `~/.config` is a symlink (this MacBook: `~/.config → ~/projects/config`),
`realpathSync` resolved the symlink before the `isInternalToolDir` check, allowing
internal-tool-dir processes to bypass the filter. Fixed by checking the raw lsof CWD
against internal-tool-dir prefixes *before* canonicalization.

## Final State

- **Git HEAD:** `e95e0429`
- **Working tree:** clean
- **Ahead of origin:** 10 commits (not pushed — per instructions)

## Manual Verification Steps for Mike

### 1. Reload VS Code
- `Cmd+Shift+P` → `Developer: Reload Window`
- Verify Command Central shows `v0.6.0-rc.40` in extension details

### 2. Completed Task / Prior Chat Labels
- Open the Agent Status tree view
- Verify completed launcher tasks show suppressed Claude sessions (no duplicate entries)
- Completed tasks should display a "Prior Chats" action when a `claude_session_id` is available
- Label should show the session identifier for exact resume targeting

### 3. Resume Command
- Right-click a completed task with a session ID
- Verify the action menu includes a resume/open-prior-chat option
- The resume command should target the exact `claude_session_id`

### 4. Owner-Bound vs Detached Routing
- **Owner-bound tasks:** Completion notification routes to the launching terminal/context
- **Detached tasks:** Completion visible in the tree view but not routed to a specific owner
- Verify the tree item description or tooltip distinguishes routing mode

### 5. Lifecycle Conflict (new in rc.40)
- If a launcher task reports `failed` but the process is still alive, the tree should surface this conflict visually

## Status

**Ready for Mike's visual review.** Extension is installed, reload window to activate.
