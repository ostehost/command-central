# RESULT — Command Central Next-RC Final Local Gate + Installed-VSIX Proof

- **Task id:** `cc-next-rc-final-gate-20260614`
- **Role:** Implementation agent (cut + gate + proof; commits made)
- **Date:** 2026-06-14
- **Host:** Mike MacBook Pro (node lane) — canonical for launched-terminal proof
- **Repo:** `/Users/ostehost/projects/command-central` · branch `main`
- **Verdict:** 🟢 **GO — for LOCAL next-RC gate readiness only** (see scope caveat in §7)

---

## 0. TL;DR

Cut, installed, and proved **`v0.6.0-rc.61`** locally. All required local gates are
green, the cross-repo prerelease gate passed, and a fresh **installed-VSIX live
proof** bound to the new RC (`version=0.6.0-rc.61`, real launcher row) reproduced
copy / open-evidence / focus-terminal — 3/3 passed, 0 skipped, 0 forbidden hits,
0 errors. Nothing pushed, tagged, or published. The bundled launcher was
**intentionally held** at the rc.60-validated state pending the in-flight
cross-repo integration audit. Readiness is asserted for the **local gate only**,
not full cross-repo RC readiness, because the audit lane
(`cc-ghostty-final-integration-audit-20260614`) is still running.

---

## 1. Commands run + exit statuses

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `just test-unit` | **0** | 129 pass (git-sort) + 512 pass (utils/services) = **641 / 0 fail** |
| 2 | `bun test test/tree-view/` | **0** | **461 pass / 0 fail** across 24 files |
| 3 | `just check` | **0** | biome ci + tsc + knip; **8 informational biome `noNonNullAssertion` warnings** (FIXABLE, pre-existing, not errors — `just check` exit 0) |
| 4 | `just prerelease` (gate → dist) | **0** | gate passed (`✅ prerelease gate passed`); dist bumped rc.60→rc.61, built+gated+installed |
| 4a | ↳ prerelease gate | **0** | cc `just ci` + ghostty-launcher `just check` + cross-repo launcher contract (parse-name/icon/session-id, `--send`/`--command`) all passed |
| 4b | ↳ VSIX content gate | **0** | rc.61: compressed 280604 B (≤600000), uncompressed 923385 B (≤2000000), **54 files** (≤120) — no forbidden artifacts |
| 5 | `just verify-vscode-consumption --vsix … --expected-version 0.6.0-rc.61` | **0** | `success: true`, installed package == rc.61, sha bound |
| 6 | `COMMAND_CENTRAL_REQUIRED_TASK_ID=review-cc-agent-status-v2-recovery-20260613 just test-installed-vsix-agent-status --live --phase legacy-fixture` | **0** | `installed-vsix-agent-status-proof-ok` — version **0.6.0-rc.61**, mode **live**, **3 actions passed / 0 skipped**, forbidden hits **0**, expected ids **2/2**, 43.28s |

Benign noise in the proof run (did not affect exit 0): `Extension host … unresponsive → responsive` startup-profiling blip and `can't find session: installed-proof-legacy-{alpha,beta}-session` / `fatal: not a git repository` — the harness probing the **passive sentinel fixture rows**, which have no live tmux/git by design. These are not the action-probe target.

---

## 2. Final version / VSIX path / sha

| Field | Value |
| --- | --- |
| Source `package.json` version | `0.6.0-rc.61` |
| VSIX path | `releases/command-central-0.6.0-rc.61.vsix` (274.0 KB on disk) |
| VSIX sha256 | `83d3ed541c6c8fe274aa23da5dd7aa6d72ef7f07a859af4b17dd101f9623fa3c` |
| VSIX identity | `oste` / `command-central` / `0.6.0-rc.61` |
| Installed (`code --list-extensions`) | `oste.command-central@0.6.0-rc.61` |
| Installed package path | `~/.vscode/extensions/oste.command-central-0.6.0-rc.61/package.json` |
| Loaded from VSIX (not `--extensionDevelopmentPath`) | **true** (installed under `~/.vscode/extensions/…`; `verify-vscode-consumption` `success:true`) |
| Proof manifest `vsix_sha256` | `83d3ed54…` == recomputed == verify-consumption == installed |
| Proof manifest `commit` | `7346655f…` (HEAD at cut time; pre-cut) |

The VSIX itself is **gitignored** (`*.vsix`) so it is not a committed artifact; identity is bound via the sha256 above plus the committed digest.

---

## 3. Selected real launcher row (live proof)

`review-cc-agent-status-v2-recovery-20260613`, read live from
`~/.config/ghostty-launcher/tasks.json` (same row the rc.60 closeout used →
direct comparability):

| Field | Value |
| --- | --- |
| `status` | `completed` |
| `source_authority` / `owner_kind` | `launcher` / `launcher` |
| `project_id` | `command-central` |
| `owner_actions` | `focusTerminal`, `showDetail` |

`COMMAND_CENTRAL_REQUIRED_TASK_ID` bound the live probes to **this real row** —
launcher state was neither faked nor synthesized.

### Action probe results (manifest, all non-mutating to lifecycle/tracker/workspace)

| Action | Status | UI effect | Detail |
| --- | --- | --- | --- |
| copy | ✅ passed | clipboard changed | `Run attempt ID: review-cc-agent-status-v2-recovery-20260613` |
| open evidence | ✅ passed | file opened | `/var/folders/…/T/tmp.RPiNi3qrRk` |
| focus terminal | ✅ passed | terminal focus invoked | reviewer banner of the launched terminal |

Proof manifest (gitignored, in `logs/`):
`logs/installed-vsix-agent-status-proof-1781447749567-legacy.json`
(`errors:[]`, `skips:[]`, `forbidden_launcher_task_id_hits:[]`).

---

## 4. Files changed + commit SHA

**RC cut commit:** `19ea6c9f` — `chore(release): cut local prerelease v0.6.0-rc.61 (launched-terminal RC)`

| File | Change |
| --- | --- |
| `package.json` | version `0.6.0-rc.60` → `0.6.0-rc.61` |
| `releases/digest-v0.6.0-rc.61.md` | new release digest |
| `research/prerelease-gate/latest.json` | cross-repo gate provenance (this run) |
| `research/prerelease-gate/prerelease-gate-2026-06-14T14-33-56.010Z.json` | dated gate provenance |

The cut was staged by explicit path (no `git add -A`). `*.vsix` and `logs/` are
gitignored; the rc.58 VSIX pruned by `cleanupOldReleases` is gitignored, so no
git delta.

**Handoff docs commit:** `21892f6f` — `docs(research): record next-RC final local
gate (rc.61) result`.

> **Concurrent-lane note (honest disclosure):** this repo's working copy + git
> index are shared with a sibling Claude Code lane
> (`cc-ghostty-final-integration-audit-20260614`). Despite staging only this
> lane's RESULT by explicit path, the shared index already held 3 REVIEW docs the
> sibling had staged, so the docs commit `21892f6f` also swept
> `research/REVIEW-cc-agent-status-v2-implementation-20260613.md`,
> `research/REVIEW-cc-agent-status-v2-recovery-20260613.md`, and
> `research/REVIEW-cc-current-running-surface-fix-20260613.md`. **No content was
> lost** — all files are committed and the tree is clean. The sibling's own audit
> handoff committed separately as `de2db65c`
> (`docs(research): record final integration audit`). History was left intact (no
> rewrite) because the sibling lane is active and unrequested history rewrites are
> disallowed. The rc.61 cut commit (`19ea6c9f`) is unaffected and correct.

---

## 5. Launcher bundle decision (held — deliberate)

`_check-launcher-sync` warned the bundled launcher differs from source. Investigated:

- **CC bundled launcher is unchanged** in the working tree — rc.61 ships the
  **same** `resources/bin/` launcher bundle that rc.60 was validated GO against.
- Source vs bundle drift: same version `1.2.8`, source `+4` lines. The two deltas
  are (a) a test-only `GHL_PROJECTS_DIR` override and (b) `d3e7c6a1`
  `fix(launcher): resolve --send bundle path at the sanitized name` (2026-06-12).
- The `--send` fix is a **no-op for `command-central`**: the project name has no
  spaces/capitals, so `send_name == send_safe` — the changed code path is not
  exercised for this project.

Given (1) the cross-repo integration audit is still running and owns the launcher
integration decision, and (2) the guardrail forbids folding in unblessed launcher
paths, the bundle was **held**. `just sync-launcher` + re-cut is deferred to a
follow-up, after the audit completes and before any push/publish. The prerelease
gate (which validates the launcher *contract* and runs launcher `just check`)
passed, so this is a non-blocking sync warning, not a contract failure.

---

## 6. Manager guardrail confirmations

- **OpenClaw subagent surfacing remains deferred** and was **not** folded into
  launched-terminal RC behavior. No subagent surfacing was implemented,
  prioritized, or relied upon. No code path superseded by the native-integration
  research was integrated or preserved (no source changes were made at all; this
  lane is cut + gate + proof only).
- **No fake launcher rows / synthetic running state** were required or used. The
  live proof bound to a real `completed` launcher row from the live
  `tasks.json`; the passive sentinel fixture rows are backend-render coverage
  only and are explicitly **not** the action-probe target.
- **No DOM scraping / non-native VS Code UI path.** The installed-VSIX proof runs
  inside the real VS Code extension host via `@vscode/test-electron` and drives
  the installed extension with native `vscode.commands` / TreeDataProvider
  (`getChildren`) APIs, binding to the expected version + VSIX sha256. No
  webview HTML / DOM scraping, no puppeteer/playwright.
- **Ghostty release-proof treats live tmux/capture/focus as live proof only.**
  The focus-terminal / copy / open-evidence probes here are **time/node-sensitive
  live evidence**, not durable evidence — they prove behavior at this moment on
  this node, and are recorded as such (the durable artifact is the version + sha
  + gate provenance, not the live tmux session).
- **Tmp-only provenance artifacts are named for preservation.** The live-proof
  manifest is persisted at the named path
  `logs/installed-vsix-agent-status-proof-1781447749567-legacy.json` (gitignored
  but stable on disk); the gate provenance is committed at
  `research/prerelease-gate/prerelease-gate-2026-06-14T14-33-56.010Z.json`. The
  build log is at `/tmp/cc-prerelease-rc61.log` and the live-proof console at
  `/tmp/cc-rc61-live-proof.log` — copy these out before `/tmp` is cleared if they
  are needed for provenance.

---

## 7. GO / NO_GO verdict + remaining blockers

### Verdict: 🟢 GO — LOCAL next-RC gate readiness

`v0.6.0-rc.61` builds, installs, and passes the full local gate matrix plus a
real-row installed-VSIX live proof, with the launched-terminal path reproducing
cleanly and no hacks. The local RC is good.

> **Scope caveat (per guardrail):** this is **not** a claim of full cross-repo /
> final RC readiness. The cross-repo integration audit
> (`cc-ghostty-final-integration-audit-20260614`) was still **running** at
> closeout, so readiness is asserted for the **local gate only**.

### Remaining blockers before any push / publish

1. **Cross-repo integration audit must complete** and be GO. Until then, do not
   treat this as final RC readiness.
2. **Launcher bundle sync decision.** If the audit blesses the current launcher
   source, run `just sync-launcher` and re-cut (the bundle is currently held at
   the rc.60 state; functional impact for `command-central` is nil, but the
   bundle should be brought current before a real release).
3. **Branch is 18 commits ahead of `origin/main`, unpushed.** No push/tag/publish
   was performed; all require explicit approval.
4. **OpenClaw subagent surfacing** remains an open follow-up (deferred, out of
   scope here). Re-run this gate matrix once subagent rows are introduced.

---

## 8. Final state

| | |
| --- | --- |
| Repo status | clean (`git status --porcelain` empty) |
| HEAD | `21892f6f` (handoff docs commit); rc.61 cut at `19ea6c9f`; sibling audit at `de2db65c` |
| `package.json` | `0.6.0-rc.61` |
| Installed VSIX | `oste.command-central@0.6.0-rc.61`, sha `83d3ed54…`, loaded from VSIX |
| `just test-unit` | **641 pass / 0 fail** (exit 0) |
| `bun test test/tree-view/` | **461 pass / 0 fail** (exit 0) |
| `just check` | exit 0 (8 informational warnings) |
| `just prerelease` gate | passed (exit 0) |
| Installed-VSIX live proof | **OK** — 3/3 probes passed (exit 0), version 0.6.0-rc.61 |
| **Verdict** | 🟢 **GO (local gate)** — cross-repo audit pending |
