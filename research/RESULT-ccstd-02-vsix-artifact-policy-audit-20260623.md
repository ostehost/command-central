# RESULT — CCSTD-02 / PAR-81: Command Central VSIX & generated-artifact policy audit

- **Ticket:** PAR-81 [CCSTD-02] — Audit Command Central VSIX and generated artifact policy
- **Date:** 2026-06-23
- **Scope:** Audit-doc. Classify VSIX/dist/out/.vscode-test/resources as source vs
  artifact; verify `.gitignore` / `.vscodeignore` / `package.json` packaging semantics;
  confirm no generated artifact is treated as source and no only-copy source is hidden;
  ensure a repeatable audit check exists. Tighten the gate only if a real AC-named gap
  is found.
- **Dependency:** CCSTD-01 / PAR-80 closeout
  (`research/RESULT-ccstd-01-preserve-baseline-audit-20260623.md`) is present, so the
  preserve-before-destroy baseline prerequisite is satisfied.

## Source-vs-artifact classification (grounded in real files)

| Path | Class | Tracked? | Packaged into VSIX? | Authority |
|------|-------|----------|---------------------|-----------|
| `src/`, `test/`, `scripts/`, `scripts-v2/` | source | yes | no (bundled into `dist/`) | `.vscodeignore` `src/**`…`scripts-v2/**`; gate `FORBIDDEN_DIR_PREFIXES` |
| `dist/` | generated artifact | no (`.gitignore` "output") | **yes** — runtime payload | `.gitignore` `dist`; gate `REQUIRED_ENTRIES` `extension/dist/extension.js` |
| `out/` | generated artifact (tsc output) | no (`.gitignore` "output") | no (not produced for shipping) | `.gitignore` `out` |
| `*.vsix` | generated artifact | no (`.gitignore`, `!releases/.gitkeep`) | n/a (the package itself) | gate `FORBIDDEN_SUFFIXES` `.vsix` |
| `.vscode-test/` | generated artifact | no (`.gitignore`) | no | `.vscodeignore` `.vscode-test/**`; gate `FORBIDDEN_DIR_PREFIXES` |
| `coverage/`, `coverage-ci/` | generated artifact | no | no | `.vscodeignore` + gate |
| `releases/` | published artifact store | only `.gitkeep` + digests tracked | no (excluded) | `.gitignore` `*.vsix !releases/.gitkeep`; `.vscodeignore` `releases/**`; gate |
| `resources/bin/`, `resources/icons/icon.png` | **source committed as runtime payload** | yes | **yes** | gate `REQUIRED_ENTRIES`; deliberately NOT a blanket forbid |
| `resources/app/` | synced ~50MB terminal artifact | no (`.gitignore` keeps only `.terminal-version`) | yes (bundled at build) | `.gitignore` `resources/app/ !resources/app/.terminal-version` |
| `resources/icons/v3-*`, `v4-*`, `v5-*`, `git-status-v2/`, legacy `*.svg` | unused source explorations | yes | no (explicitly excluded) | `.vscodeignore` per-path excludes |
| `logo-concepts/` | dev/proof artifact (icon explorations, ~1.3MB, 110 files) | no (`.gitignore`) | **excluded** | `.vscodeignore` `logo-concepts/**` |

### "Only-copy source hidden" verification

No only-copy (single-source-of-truth) source is silently excluded:

- `resources/bin/ghostty-launcher`, `resources/bin/scripts/lib/window-probe.applescript`,
  and `resources/icons/icon.png` are committed source that must ship — and the gate's
  `REQUIRED_ENTRIES` (scripts-v2/vsix-content-gate.ts) asserts their presence, so a
  `.vscodeignore` over-exclusion that drops them is a hard build failure, not a silent
  loss. (rc51 shipped without `window-probe.applescript`; that exact regression is now
  guarded.)
- `src/**` etc. are excluded from the VSIX *because* they are bundled into
  `extension/dist/extension.js` (the build entry, `main: ./dist/extension.js`), so the
  source still ships in compiled form — not hidden, transformed.
- The per-path icon excludes in `.vscodeignore` (`v3-*`, `v4-*`, …, `logo-concepts/**`)
  are deliberate "unused exploration" captures, not the only copy of a shipped asset
  (the shipped asset is `resources/icons/icon.png`, which is a required entry).

### "Generated artifact treated as source" verification

`dist/` is the only generated dir that ships, and it ships intentionally as the runtime
payload (required entry), not because it is mistaken for source. All other generated
categories (`out/`, `coverage*`, `.vscode-test/`, `*.vsix`, `*.tsbuildinfo`, `*.map`,
`releases/`) are excluded by `.vscodeignore` and independently detected by the gate's
`FORBIDDEN_DIR_PREFIXES` / `FORBIDDEN_SUFFIXES`.

## Repeatable audit check

`scripts-v2/vsix-content-gate.ts` (recipe `just vsix-gate`, also run inside `just dist`
via `scripts-v2/dist-simple.ts`) is the repeatable, deterministic audit: it inspects the
built VSIX, fails on forbidden-dir / forbidden-suffix / non-allowlisted-markdown leaks,
asserts the required runtime payload is present, and enforces the size/file-count budget
(`DEFAULT_BUDGET`: 600KB compressed / 2MB uncompressed / 120 files). This satisfies the
"repeatable audit check" acceptance criterion.

## Policy gap found and fixed (one unchecked artifact category)

The gate docstring states `FORBIDDEN_DIR_PREFIXES` "Mirrors `.vscodeignore`". Diffing the
two lists found one real discrepancy that is a genuine unchecked artifact category:

- `.vscodeignore` excludes `logo-concepts/**` (line 54) — an untracked, gitignored
  ~1.3MB / 110-file directory of icon explorations that exists on disk today.
- The gate's `FORBIDDEN_DIR_PREFIXES` did **not** list `logo-concepts/`.

Impact: this is precisely the rc50 failure class the gate was built to catch — a single
`.vscodeignore` line is the only thing preventing the leak, and if that line were dropped
the gate would NOT flag the directory. Content rules would pass it, and the uncompressed
budget has enough headroom for it to creep in unnoticed.

(The other two list discrepancies are not gaps: `resources/` is in `.vscodeignore` but is
deliberately NOT a blanket forbid because it carries required runtime payload via per-path
allow/deny; `extension/` appears only in the gate as the VSIX path prefix consumed by
`toRepoRelativePath`, not a directory to forbid.)

### Change

- `scripts-v2/vsix-content-gate.ts`: added `"logo-concepts/"` to
  `FORBIDDEN_DIR_PREFIXES` (alphabetically ordered between `logs/` and `memory/`),
  re-aligning the gate with its stated `.vscodeignore` mirror.
- `test/scripts-v2/vsix-content-gate.test.ts`: added regression test
  "flags the logo-concepts dev-artifact directory excluded by .vscodeignore" — it adds an
  `extension/logo-concepts/activity-bar-v27-1.svg` entry and asserts the
  `forbidden directory logo-concepts/` violation. This test FAILS on the pre-fix gate
  (no `logo-concepts/` prefix) and PASSES after.

## Out of scope / not changed (deliberate)

- `out/` and `prompts/` are gitignored but absent from `.vscodeignore`; the gate's stated
  contract is to mirror `.vscodeignore`, so they are noted in `future_items` rather than
  silently expanded into the gate (avoids scope creep beyond the AC and the gate's own
  documented mirror semantics).
- `package.json` has no `files` field (it is a VS Code extension packaged by `vsce`, which
  uses `.vscodeignore`, not the npm `files` allowlist); `main: ./dist/extension.js` is the
  packaged entry. No change needed.

## Verification note

Per task constraints (concurrent sibling agents, orchestrator gates after the batch) the
test/typecheck recipes were not run here. The regression test is written against the
existing `bun:test` helpers (`cleanEntries`, `evaluateVsixEntries`) already proven by the
surrounding suite.
