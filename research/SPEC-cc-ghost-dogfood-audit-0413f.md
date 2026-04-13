# SPEC: CC Ghost Dogfood Audit 0413f

## Scope

Audit `command-central` `main` against the live stale/ghost Agent Status behavior: stale `0413b` rows and old discovered sessions such as `ghl-spawn-timeout-diagnosis` still appearing as running.

## Verdict

**Primary blocker before the next dogfood pass is (a): the live build does not contain the new runtime-identity fix yet.**

**Do not patch source first. Cut a fresh dogfood build from current `main`, install it, and validate again.**

If noise remains after that rebuild, the next smallest follow-up should be **(c) cleanup/UX for unmanaged discovered agents**, not another trust-layer rewrite.

## Evidence

### BLOCKER: shipped bundle is still the old session-id dedupe logic

1. Current source `main` has the new runtime-identity dedupe:
   - [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1472)
   - It keys running tasks by backend + project + bundle + persist socket / tmux socket + window, not just `session_id`.
   - The new reconciliation path is at [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1579).

2. The checked-out compiled bundle is still the old weak dedupe:
   - [dist/extension.js](/Users/ostemini/projects/command-central/dist/extension.js:6824)
   - It still groups duplicates by `session_id` or `session_id::tmux_window_id` only and marks older tasks stale with the generic “same session” reason.

3. The installed extension is also still `0.5.1-76` and points at that compiled bundle:
   - [package.json](/Users/ostemini/projects/command-central/package.json:5)
   - Installed package: [package.json](</Users/ostemini/.vscode/extensions/oste.command-central-0.5.1-76/package.json:5>)
   - The installed extension still loads `./dist/extension.js` at [package.json](</Users/ostemini/.vscode/extensions/oste.command-central-0.5.1-76/package.json:9>).

4. Git history confirms the fix landed after the currently installed dogfood build:
   - `da3ecbe fix: harden agent runtime identity`
   - `2cad0b9 chore: auto-commit agent work [cc-runtime-identity-fix-0413d]`
   - Installed/release artifact timestamps are April 4-5, 2026, while the fix landed on April 13, 2026.

### WARNING: current `main` discovery path is already materially hardened

1. Process discovery already rejects shell-wrapper false positives:
   - [src/discovery/process-scanner.ts](/Users/ostemini/projects/command-central/src/discovery/process-scanner.ts:508)
   - Regression test: [test/discovery/process-scanner.test.ts](/Users/ostemini/projects/command-central/test/discovery/process-scanner.test.ts:210)

2. Registry suppression already hides discovered agents when launcher evidence says the task is terminal or the matching stream is idle:
   - [src/discovery/agent-registry.ts](/Users/ostemini/projects/command-central/src/discovery/agent-registry.ts:345)
   - Regression tests: [test/discovery/agent-registry.test.ts](/Users/ostemini/projects/command-central/test/discovery/agent-registry.test.ts:163) and [test/discovery/agent-registry.test.ts](/Users/ostemini/projects/command-central/test/discovery/agent-registry.test.ts:338)

3. The new provider tests explicitly cover the runtime-identity edge that old builds miss:
   - [test/tree-view/agent-status-tree-provider.test.ts](/Users/ostemini/projects/command-central/test/tree-view/agent-status-tree-provider.test.ts:1035)

### WARNING: the live launcher registry does not currently contain the reported stale `0413b` rows

The current Ghostty Launcher registry is small and clean:
- [tasks.json](/Users/ostemini/projects/ghostty-launcher/scripts/tasks.json:1)
- It contains six `ghl-*` rows and no `0413b` or `ghl-spawn-timeout-diagnosis` entries.

That means the observed stale rows are not explained by the current launcher file on disk. They are consistent with an older loaded bundle/UI state, not with `main` source reading the current registry.

## Interpretation

### Why this points to (a), not (b)

- The exact stale-row class reported for `0413b` is the problem `da3ecbe` fixes: older builds collapse running rows by weak session identity.
- Both the installed extension and local compiled bundle still use the pre-fix logic.
- The discovery code on source `main` already has the shell/session/idle-stream hardening and passes focused regression coverage.

### Why (c) is the likely next patch if noise remains after rebuild

Current UI still treats discovered agents as always-running synthetic tasks:
- [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:4772)

So if an unmanaged agent process is genuinely still alive, it will still appear as “running” even when it is not a current launcher task. That is not weak evidence; it is a product decision. If that remains noisy after shipping the rebuilt bundle, the next smallest patch should be:

1. Separate discovered-only agents into an “Unmanaged / Discovered” bucket.
2. Exclude unmatched discovered agents from the primary “working” headline count unless they also match launcher/OpenClaw state.
3. Add age labeling or collapse for old discovered-only processes.

That is a cleanup/UX patch, not a trust-layer patch.

## Recommended Next Step

### Ship now

Cut a new dogfood build from current `main` and install it before writing more code.

Reason:
- The highest-signal fix is already in source.
- The currently observed dogfood environment is still running `0.5.1-76`.
- Another source patch before packaging would blur whether `da3ecbe` actually solved the stale-row symptom.

### Validate immediately after rebuild

1. Confirm the installed extension is newer than `0.5.1-76`.
2. Re-open Agent Status against the same launcher state.
3. Check whether stale `0413b` rows disappear.
4. If only unmanaged discovered processes remain, queue the cleanup/UX patch above as the next pre-release follow-up.

## Files

- Source fix: [src/providers/agent-status-tree-provider.ts](/Users/ostemini/projects/command-central/src/providers/agent-status-tree-provider.ts:1472)
- Old compiled bundle behavior: [dist/extension.js](/Users/ostemini/projects/command-central/dist/extension.js:6824)
- Discovery hardening: [src/discovery/process-scanner.ts](/Users/ostemini/projects/command-central/src/discovery/process-scanner.ts:508), [src/discovery/agent-registry.ts](/Users/ostemini/projects/command-central/src/discovery/agent-registry.ts:345)
- Key tests: [test/tree-view/agent-status-tree-provider.test.ts](/Users/ostemini/projects/command-central/test/tree-view/agent-status-tree-provider.test.ts:1035), [test/discovery/process-scanner.test.ts](/Users/ostemini/projects/command-central/test/discovery/process-scanner.test.ts:210), [test/discovery/agent-registry.test.ts](/Users/ostemini/projects/command-central/test/discovery/agent-registry.test.ts:338)
- Live installed package: [package.json](</Users/ostemini/.vscode/extensions/oste.command-central-0.5.1-76/package.json:5>)
- Live launcher registry: [tasks.json](/Users/ostemini/projects/ghostty-launcher/scripts/tasks.json:1)

## Tests Run

- `bun test test/tree-view/agent-status-tree-provider.test.ts test/discovery/*.test.ts` ✅
- `bun run typecheck` ⚠️ not defined in this repo’s `package.json`

SPEC COMPLETE
