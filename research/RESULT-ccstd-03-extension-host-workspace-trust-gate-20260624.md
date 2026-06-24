# RESULT — CCSTD-03 / PAR-82: Extension-host runtime + Workspace Trust gate verification

- **Ticket:** PAR-82 — `[CCSTD-03] Verify Command Central extension-host runtime and Workspace Trust gates`
- **Date:** 2026-06-24
- **Repo:** `command-central` (VS Code extension, Bun toolchain)
- **Verified revision:** `package.json` version `0.6.0-rc.70`, branch `main` (HEAD `40476c3` at start)
- **Status:** Verified + a real gap closed. The verification surfaced one
  defensible security gap (launcher subprocesses had **no** Workspace Trust
  gate, unlike the existing `bun test` gate), which this work fixes with a code
  guard, a manifest gate, and regression tests. Every claim is grounded in a
  real file at the cited path.

---

## 1. What the extension actually does at runtime (extension-host facts)

| Dimension | Value | Evidence |
|---|---|---|
| Activation | `onStartupFinished` (single event) | `package.json` `activationEvents` |
| Host runtime | Node extension host (not Bun); build `target: "node"`, ESM | `scripts-v2/dist-simple.ts`; `package.json` `"type": "module"` |
| Subprocess surface | `TerminalManager` spawns the `ghostty-launcher` binary (`execLauncher` → `node:child_process.execFile`) and `open`/`osascript` for `.app` bundles (`runInBundleTerminal`); `TestCountStatusBar` spawns `bun test` | `src/ghostty/TerminalManager.ts` `execLauncher`/`execCommand`/`runInBundleTerminal`; `src/services/test-count-status-bar.ts:53-61` |
| Code-execution risk | The launcher reads the workspace's `.vscode/settings.json → commandCentral.terminal.*` and runs a multiplexer + AppleScript, i.e. it executes **project-defined** behavior | `src/ghostty/TerminalManager.ts` `parseMultiplexerResult` comment; launcher `--create-bundle` / `--send` contract |

## 2. Workspace Trust posture — before this work

| Setting | Scope | In `restrictedConfigurations`? | Notes |
|---|---|---|---|
| `commandCentral.ghostty.launcherPath` | `machine` | **Yes** | The only subprocess-spawning setting. `machine` scope already blocks per-workspace override; the restricted-list entry is correct belt-and-suspenders. |
| `commandCentral.agentTasksFile(s)`, `laneRegistry.files`, `releaseGeneration.file`, `legacyLauncherTasks.enabled` | `machine` | n/a | `machine`-scoped → not workspace-overridable; not subprocess-spawning. |
| all other `commandCentral.*` | `window`/`resource`/`application` | n/a | Display/behavior settings; no subprocess path. |

The manifest's `capabilities.untrustedWorkspaces.restrictedConfigurations`
(`package.json:51-53`) already covered the one launcher-path setting. The
ledger evidence's reference to `commandCentral.terminal.launcherPath/app`
settings is stale — **those keys do not exist**; the real key is
`commandCentral.ghostty.launcherPath`.

## 3. The gap (real, defensible)

`TerminalManager` spawned the launcher (which runs project-defined shell) with
**no Workspace Trust check**, while the established codebase pattern already
gates a different subprocess path:

```
src/services/test-count-status-bar.ts:35
  if (!vscode.workspace.isTrusted) { ...refuse, warn... }   // before `bun test`
```

So opening a project terminal / sending a command / running a bundle command in
an **untrusted** workspace would execute project-controlled code on open — the
exact threat Workspace Trust exists to mitigate. No `isTrusted` reference
existed in `src/ghostty/`. The manifest also advertised `"supported": true`
with description "Command Central works in all workspaces", which was no longer
accurate once terminal features are gated.

## 4. Fix applied

1. **Code gate (`src/ghostty/TerminalManager.ts`):**
   - New `WorkspaceTrustRequiredError` and a private `assertWorkspaceTrusted(operation)`
     guard. The guard blocks **only** when `vscode.workspace.isTrusted === false`
     (explicit untrusted); `true`/`undefined` (trust-unaware hosts) proceed, so
     trusted workspaces and older hosts are never silently broken.
   - Guard applied at the three code-executing entry points: `createProjectTerminal`,
     `runInProjectTerminal`, `runInBundleTerminal`. (`createProjectTerminal` is
     guarded before icon-persistence side effects; `runInProjectTerminal` is
     guarded **before** the try/catch so the refusal is not converted into a
     fallback-terminal prompt.)
2. **Manifest gate (`scripts-v2/vsix-content-gate.ts`):** new exported
   `SUBPROCESS_SPAWNING_SETTINGS` + `evaluateWorkspaceTrustManifest(manifest)`.
   It fails the build if the `untrustedWorkspaces` capability is missing, if
   `supported` is not `true|false|"limited"`, or if any subprocess-spawning
   setting is dropped from `restrictedConfigurations`. Wired into the gate's
   `import.meta.main` run path so a regression fails packaging alongside the
   size/content budget.
3. **Manifest posture corrected (`package.json:48-54`):** `supported` →
   `"limited"` with an accurate description (read-only features work untrusted;
   Ghostty terminals blocked until trusted).

## 5. Tests (regression — fail on pre-fix code, pass after)

- `test/ghostty/terminal-manager.test.ts` — new describe
  "TerminalManager Workspace Trust gate (CCSTD-03)":
  - untrusted → `runInProjectTerminal` / `createProjectTerminal` /
    `runInBundleTerminal` reject with `WorkspaceTrustRequiredError` and **spawn
    nothing** (`execFile` not called; no icon persistence; no integrated-terminal
    fallback). These FAIL on pre-fix code (which would spawn the launcher).
  - positive control: trusted → `createProjectTerminal` **does** spawn
    `--create-bundle` (proves the refusal is the trust gate, not a mock gap).
  - `isTrusted === undefined` → proceeds (trust-unaware host not broken).
- `test/scripts-v2/vsix-content-gate.test.ts` — new describe
  "evaluateWorkspaceTrustManifest (CCSTD-03 / PAR-82)":
  - the shipped `package.json` passes the gate (live receipt);
  - every `SUBPROCESS_SPAWNING_SETTINGS` key is an actual contributed config;
  - negative cases: missing capability, dropped restricted setting, invalid
    `supported`; and all three valid `supported` variants accepted.

## 6. Out of scope / follow-ups

- The gate validates against the **repo** `package.json` at CLI run time, not
  the manifest inside the built `.vsix`. They are identical at packaging time
  (the VSIX is built from the repo), but a future hardening could parse
  `extension/package.json` from the zip for full hermeticity.
- `getTerminalInfo` (read-only name/icon/session lookup) still spawns the
  launcher and is intentionally **not** trust-gated here, to keep tree display
  working untrusted. If launcher `--parse-*` is ever shown to execute
  project shell, it should also be gated.
- `prerelease-gate.ts` was left unchanged; the manifest gate lives in
  `vsix-content-gate.ts`, which is the existing package-validation chokepoint.
