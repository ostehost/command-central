# RESULT — Command Central Bloat/Refinement Map

- **Task:** cc-bloat-map-rerun-20260610 (planner, read-only)
- **Date:** 2026-06-10, post-rc50 (HEAD `59e6e299`, clean tree)
- **Baseline:** `just test-unit` green — 432 pass / 0 fail in 245ms; `bunx knip` exits 0 (clean in current scope)
- **Scale:** src = 33,842 lines TS; test = 51,978 lines; VSIX rc50 = 2.5MB compressed / **21.2MB, 488 files uncompressed**

---

## Top 5 bloat targets (evidence-backed, ranked by payoff ÷ risk)

### 1. VSIX packaging — dev artifacts shipped in the release (highest payoff, lowest risk)
The project commandment says VSIX < 100KB; rc50 is **2.5MB** (25×). Actual extension payload is only ~391KB (`dist/extension.js`). The rest is working-directory sweep-up:

| Content in VSIX | Files | Evidence |
|---|---|---|
| `extension/logs/installed-vsix-agent-status-proof-*.json` | 12 (~10MB) | largest single entries: 1.5MB, 1.40MB, 1.37MB… (`unzip -l releases/command-central-0.6.0-rc.50.vsix`) |
| `extension/research/**` (incl. `prerelease-gate/*.json` receipts, 322KB each) | 219 | research/ is git-tracked (224 files) |
| `extension/.clawpatch/reports/*.md` | 91 | 74KB each |
| `extension/releases/**` (release metadata/receipts) | 74 | recursive release-dir inclusion |
| `extension/dist/extension.js.map` | 1 (1.4MB) | production build uses `sourcemap: "external"` (`scripts-v2/dist-simple.ts:336`) |
| `extension/.claude/`, `specs/`, `.preview-status/`, `drafts/`, `coverage-ci/` | ~30 | all unlisted in `.vscodeignore` |

**Root cause:** `.vscodeignore` has no entries for `logs/`, `research/`, `.clawpatch/`, `releases/`, `.claude/`, `specs/`, `.preview-status/`, `drafts/`, `coverage-ci/`, or `dist/*.map`. Its `*.md` glob matches only root-level markdown (vsce minimatch semantics), so nested `.md`/`.json` receipts ship.
**Fix shape:** add those globs + `dist/*.map`; consider a VSIX size/file-count assertion in `scripts-v2/prerelease-gate.ts`. Expected result: VSIX ≈ 0.5–0.7MB (code + icons + `resources/bin` 428KB), 10× smaller.

### 2. `src/providers/agent-status-tree-provider.ts` — 8,971 lines, 26% of all src
One exported class, **15 distinct responsibility clusters**, ~143 leaf methods. Zero orphaned methods (all reachable), so this is structure debt, not dead code. Clean low-coupling extraction candidates (verified `this.`-state usage):
- **Registry normalization** (`normalizeTask:786`, `normalizeRegistryTasks:908`) — module-level pure JSON→AgentTask transforms, ~160 lines → `utils/task-registry-normalization.ts`
- **Prompt display helpers** (`truncatePromptSummary:6144`–`isPromptBoilerplateLine:6159`, `cleanPromptForDisplay:4724`) — pure string processing → `utils/prompt-display.ts`
- **Git diff parsing** (`buildGitDiffArgs:6442`, `parsePerFileDiffsFromNumstat:6417`, `parsePerFileStatusesFromNameStatus:6393`, `extractCommitHash:6554`…) — ~170 lines, only `execFile` + strings → `services/git-diff-service.ts`
- **OpenClaw audit/ledger** (`getOpenClawTaskLedgerLines:7021`, `getOpenClawTaskAuditData:7098`) — self-contained → service
- **Port detection** (`_detectPortsAsync:6076`) — isolated, 54 lines

Tangled clusters to defer (shared cache fields, ~30-method fan-out): tree rendering/children generation (~1,400 lines, 3073–4500), grouping/sorting (~657 lines), health-check caches (6 cache maps, 1430–1790), Symphony/Codex formatting (~1,500 lines, heavily coupled to `CodexRunObserverService`).
Service boundaries are otherwise clean: **no logic duplication** found vs `codex-run-observer-service.ts`, `agent-registry.ts`, `process-scanner.ts`, `agent-task-classification.ts` — the provider only adds caching layers over `utils/tmux-pane-health`, `persist-health`, `handoff-file-health`, `review-queue-health`.

### 3. `src/extension.ts` — 3,819 lines, monolithic `activate()`
66 inline `registerCommand` closures (of 126 contributed commands; the other 60 gitSort slot commands register dynamically in `project-view-manager.ts:536–593` — verified alive). `activate()` is a single try-block from line 198 onward; command bodies inline `await import("node:fs")` / `execFileSync` blocks (e.g. lines 1079, 1216, 2221, 2306, 2847). ~30 static imports at module top include the 8,971-line provider. `src/commands/` already exists as the natural home — move command groups (cron, gitSort, agent-status quick actions, ghostty) into per-feature registration modules with a `registerXCommands(context, deps)` signature.

### 4. Test suite duplication — ~1,500–2,000 lines removable conservatively (52k total)
- `test/ghostty/terminal-manager.test.ts` (1,574 lines): 12 describe blocks each re-mocking vscode/child_process/fs inline (blocks at 41–55, 204–207, 295–298, 419–422, 582–585…) — ~320 lines extractable to one helper; bypasses canonical `test/helpers/vscode-mock.ts` (344 lines, `setupVSCodeMock()` used correctly by 54 tests, bypassed by ~12 files).
- `test/services/active-file-tracking.test.ts:50–180`: 131-line inline vscode mock despite importing typed-mocks at lines 22–24.
- `createMockLogger` re-implemented locally in ~5 files (canonical: `test/helpers/typed-mocks.ts:34–52`).
- `test/helpers/vscode-test-helpers.ts` (316 lines): `getOutputChannelContent()` (194–201), `mockWindowMethods()` (206–263), `measureCommandTime()` have **0 callers**; ~23 lines of commented-out assertions (268–290). ~200 lines deletable.
- `test/git-sort/sorted-changes-provider-*.test.ts` (9 files, 2,972 lines): each re-implements Git API mock factories (`createMockGitExtension()` etc., e.g. core.test.ts:29–56); no shared harness, unlike the tree-view suite's `_helpers/agent-status-tree-provider-test-base.ts` (463 lines) which is the working pattern to copy.
- Overlap: `getChildren`/`getTreeItem`/`reload`/`readRegistry` exercised in 3–4 of the 8 agent-status split files — acceptable as integration-style coverage, but summary-node scenarios repeat verbatim across discovery/rendering/health files.

### 5. knip blind spots + dependency hygiene
`bunx knip` is clean, but `knip.json` `project` covers only `src/**` and `scripts-v2/**` — the legacy `scripts/` dir (20K) is invisible, and it contains `scripts/svg-to-png.ts`, the **sole consumer of the `playwright` devDependency**, which is also hard-ignored via `ignoreDependencies`. So the heaviest devDep (~50MB installed + browser downloads) is held by one icon-generation script outside analysis scope. Candidates: widen knip `project` to include `scripts/**`, drop the playwright ignore, and decide whether svg-to-png is one-off tooling that can be retired (icons are committed). Runtime `dependencies` is empty — zero supply-chain runtime risk. ✅

---

## Suggested future lanes (non-overlapping, 3–5 safe iterations)

| Lane | Scope (files touched) | Est. effect | Risk |
|---|---|---|---|
| **A. vsix-diet** | `.vscodeignore`, optional size gate in `scripts-v2/prerelease-gate.ts` | VSIX 2.5MB → ~0.6MB, 488 → ~120 files | Very low — packaging only, verify by `unzip -l` diff |
| **B. provider-pure-extractions** | `src/providers/agent-status-tree-provider.ts` + new `utils/`/`services/` files; matching test moves | −600–900 lines from the 9k file, no behavior change | Low — pure functions, existing 8-file test suite locks behavior |
| **C. activation-modularization** | `src/extension.ts` + new `src/commands/register-*.ts` modules | extension.ts 3,819 → ~1,500 lines | Medium — run AFTER lane B settles imports; integration tests + installed-VSIX proof required |
| **D. test-consolidation** | `test/**` only (terminal-manager helper, vscode-mock adoption, dead helper deletion, git-sort shared harness) | −1,500–2,000 test lines, faster suite | Low — test-only; gate is the suite itself staying green with same test counts |
| **E. analysis-scope-hardening** | `knip.json`, `justfile`/CI gate additions (size budget, command-contribution audit) | prevents regression of A + surfaces `scripts/` dead code | Very low — config only |

Ordering: A and D are independent and can run in parallel lanes. B before C (both touch provider exports/imports). E last, codifying A's win as a gate.

## Dead-code / dependency candidates (evidence)

1. `test/helpers/vscode-test-helpers.ts:194–290` — `getOutputChannelContent`, `mockWindowMethods`, `measureCommandTime`, commented-out assertion block: 0 callers (~200 lines).
2. `playwright` devDep — only referenced by `scripts/svg-to-png.ts`; outside knip scope and force-ignored in `knip.json` `ignoreDependencies`.
3. `logs/` on disk (10MB, 12 files, untracked) — janitorial deletion candidate; currently leaks into every VSIX.
4. Icon explorations already excluded in `.vscodeignore` (`resources/icons/v3-*`, `v4-*`, `v5-*`…) remain in the repo — repo-weight only, optional cleanup.
5. **Verified NOT dead:** the 60 contributed `gitSort.*.slotN[Panel]` commands (dynamic registration, `project-view-manager.ts:536–593`); zero orphaned methods inside the 9k-line provider.

## Gates required before release (any lane)

1. `just ready` (fix + check + test) and `just ci` (warnings = errors, strict knip) — both must be green.
2. `just test-integration` for lanes B/C (provider + activation behavior).
3. Installed-VSIX proof for lanes A/C: `just test-installed-vsix-agent-status` — activation, tree render, and command availability against the real package.
4. Lane A specifically: `unzip -l` before/after diff committed in the lane receipt; confirm `dist/extension.js`, `resources/bin/**`, icons, README/CHANGELOG/LICENSE all still present; confirm map file absent.
5. Lane C: every contributed command in `package.json` must resolve at runtime (no "command not found") — the dynamic slot registrations make a static check insufficient; the installed-VSIX proof covers it.
6. `just prerelease-gate` before any rc cut, per the cross-repo dependency on ghostty-launcher.
7. Unit baseline to preserve: 432 pass / 0 fail (subset), full suite ~6s — any consolidation lane must keep counts explainable (deleted dead helpers may reduce file count, never pass→fail).
