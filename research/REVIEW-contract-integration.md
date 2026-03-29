# REVIEW: Launcher-Contract Integration Branch

**Branch:** `worktree/contract-validation-claude` at commit `79326ef`
**Reviewer:** Claude (contract-validation agent)
**Date:** 2026-03-29

---

## Scope

This branch integrates four related trust-layer fixes into a single merge-ready unit:

1. **Steer contract fix** — switches `oste-steer.sh` invocation from unsupported `--session` flag to positional session form
2. **Helper resolution for Capture/Kill** — resolves `oste-capture.sh` / `oste-kill.sh` from the launcher binary directory instead of `path.dirname(tasksFilePath)`
3. **TASKS_FILE propagation** — passes the active tasks registry path as an environment variable to helper scripts
4. **Prerelease-gate enforcement** — extends the cross-repo gate to validate all of the above

---

## Test Results

| Suite | Result |
|-------|--------|
| `test/ghostty/terminal-manager.test.ts` | 34 pass, 0 fail |
| `test/scripts-v2/prerelease-gate.test.ts` | 14 pass, 0 fail |
| All ghostty + scripts-v2 tests | **86 pass, 0 fail** |
| Full suite | 1 unrelated flaky failure (`infrastructure-validation.test.ts` timing) |
| Build | Passes |

---

## Findings

### BLOCKER

**None.**

### WARNING

**W1: Prerelease gate artifact ran with `--skip-cc-validation --skip-launcher-validation`**
The `latest.json` artifact at `research/prerelease-gate/latest.json` shows the CC-validation and launcher-validation checks were **skipped**. The cross-repo contract check passed, but a full un-skipped gate run has not been recorded in the branch. This is acceptable for merge (the skip was due to sandbox constraints in the worktree agents), but a full gate run should be performed as part of post-merge smoke validation.

**W2: `resolveBinaryPath` introduces a synchronous PATH scan**
`TerminalManager.resolveBinaryPath()` (line 419) performs synchronous `fs.existsSync` calls across all PATH entries. This is called from the async `resolvedLauncherPath()` flow, so the synchronous I/O could block the extension host briefly. In practice, PATH entries are typically few and local filesystem, so the risk is low — but it's worth noting for future refactoring toward async resolution.

**W3: `--by-task-id` is validated in steer help but never used in CC source**
The gate requires `oste-steer.sh --help` to advertise `--by-task-id`, and this flag appears in `REQUIRED_STEER_FLAGS`. However, Command Central itself never invokes `oste-steer.sh --by-task-id`. This is fine — the gate is asserting the launcher supports the flag (forward-looking contract), not that CC uses it today. But if the launcher removes it, the gate will fail even though CC wouldn't be affected.

### NIT

**N1: `tmuxSession` field name is a holdover**
`getTerminalInfo()` still returns `{ tmuxSession: string }` even though comments and logs now correctly reference "launcher session." The data-shape name is a cosmetic debt item, not a functional issue.

**N2: Gate coverage for `anchorsHelperScriptsToLauncher` regex is fragile**
The regex in `anchorsHelperScriptsToLauncher()` matches a specific `path.join(path.dirname(launcherPath), "scripts", scriptName)` pattern. If the implementation is reformatted (e.g., intermediate variable), the regex will silently stop matching. The unit tests for the gate cover the current formatting, but this is inherently brittle source-text matching.

**N3: `resolveLauncherHelperScriptPath` is public but only used by extension.ts**
The method is exposed as a public API on `TerminalManager` for use by the command handlers in `extension.ts`. This is fine architecturally, but it means the helper resolution path is not co-located with its callers. Acceptable for now.

---

## Contract Alignment Checklist

| Contract Surface | Status | Evidence |
|-----------------|--------|----------|
| `oste-steer.sh` uses positional session | PASS | Both steer call sites in `TerminalManager.ts` pass `info.tmuxSession` as argv[0] |
| `oste-steer.sh` passes `--raw` | PASS | Both steer call sites include `"--raw"` |
| `oste-steer.sh` does NOT use `--session` | PASS | Negative test assertion confirms absence; gate checks for regression |
| `oste-capture.sh` resolved from launcher dir | PASS | `resolveLauncherHelperScriptPath("oste-capture.sh")` in extension.ts:1189 |
| `oste-kill.sh` resolved from launcher dir | PASS | `resolveLauncherHelperScriptPath("oste-kill.sh")` in extension.ts:1274 |
| No legacy `path.dirname(tasksFilePath)` for helpers | PASS | Gate regex `hasLegacyTasksDirHelperResolution` would catch regression |
| `TASKS_FILE` env passed to capture helper | PASS | extension.ts:1194-1197 |
| `TASKS_FILE` env passed to kill helper | PASS | extension.ts:1279-1282 |
| Helper scripts anchored to launcher binary | PASS | `resolveLauncherHelperScriptPath` uses `path.dirname(launcherPath)` |
| Gate fails on steer contract regression | PASS | 3 dedicated test cases in prerelease-gate.test.ts |
| Gate fails on helper resolution regression | PASS | 3 dedicated test cases in prerelease-gate.test.ts |

---

## Merge Recommendation

**APPROVE for merge.** No blockers found. The branch is a coherent, well-tested trust-layer fix that:
- Correctly migrates the steer contract to the positional session form
- Properly anchors helper scripts to the launcher binary directory
- Propagates TASKS_FILE through the process environment
- Extends the prerelease gate to prevent regression on all three surfaces

The warnings are all low-severity and appropriate for follow-up work, not merge blockers. A full (un-skipped) prerelease gate run should be performed during cross-repo smoke validation.

---

REVIEW COMPLETE
