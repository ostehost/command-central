# RESULT — cc-rc52-preview-cut-fable-20260610

Cut the 0.6.0-rc.52 preview locally via the standard `just cut-preview` path so
the approved `ebdb7382` sync-launcher applescript fix (window-probe bundled +
required by the VSIX gate) is packaged and proven in the real prerelease flow.
Local-only: no push, no tags, no Marketplace publish, no external comms.

## Preconditions verified

- command-central tree clean at start; HEAD `ebdb7382`
  (`fix(sync-launcher): bundle applescript lib helpers (window-probe)`),
  approved clean by `review-cc-sync-launcher-applescript-fable-20260610`.
- ghostty-launcher tree clean on committed HEAD `3cab35c4`.
- Hub machine (`ostehost@MacBookPro`), Bun 1.3.13.
- Starting version `0.6.0-rc.51` → expected cut rc.52. ✅
- rc51 retroactively fails the updated gate as expected: `unzip -l` on the
  rc51 VSIX shows **0** `window-probe.applescript` entries; rc52 shows **1**.

## Commands run

```bash
just cut-preview                 # preflight → sync-launcher → just ci rehearsal
                                 # → prerelease-gate → dist --prerelease (53.2s)
just vsix-gate                   # explicit re-run of the content gate
just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.52.vsix \
  --expected-version 0.6.0-rc.52 \
  --manifest-out research/vscode-consumption-rc52-20260610.json
just preview-status              # exit code 0, SUCCEEDED
```

## Gates

| Gate | Result |
| --- | --- |
| Preflight (both repos clean, hub host) | ✅ |
| `sync-launcher` (binary 1.2.8 in sync; 36 helper files refreshed) | ✅ |
| `just ci` rehearsal — Biome 249 files, tsc, knip, quality checks | ✅ |
| Test suite | ✅ 1739 pass / 1 skip / 0 fail (124 files, 10.51s) |
| `prerelease-gate` (CC `just ci` + launcher `just check` + contract checks) | ✅ `research/prerelease-gate/prerelease-gate-2026-06-10T13-20-21.909Z.json` |
| VSIX content gate (in-path during dist) | ✅ budgets respected, no forbidden artifacts |
| `just vsix-gate` (explicit re-run) | ✅ identical numbers |
| Independent forbidden-pattern scan (`unzip -l` grep for `.map`, tests, coverage, `node_modules`, `.ts`, `src/`, `scripts-v2`, tsconfig) | ✅ no hits |
| `window-probe.applescript` present in package | ✅ `extension/resources/bin/scripts/lib/window-probe.applescript` (2,058 bytes) |

## Artifact identity

- **VSIX:** `releases/command-central-0.6.0-rc.52.vsix`
- **Version:** `0.6.0-rc.52` (publisher `oste`, name `command-central`)
- **Compressed:** 265,983 bytes (259.7 KB) — budget 600,000
- **Uncompressed:** 884,312 bytes — budget 2,000,000
- **Files:** 52 — budget 120 (51 in rc51; +1 is the window-probe applescript)
- **sha256:** `43c337b9ee94e4e33a8f93384162b22c47b3da5e82f6eaf8808bb00ddbeeeac2`
- **Digest:** `releases/digest-v0.6.0-rc.52.md` (tracked record; VSIX itself is gitignored)
- `preview-status`: SUCCEEDED, pid 74731, 2026-06-10T13:19:34Z → 13:20:27Z,
  artifact sha matches the independently computed sha256 above.

## Install status

`code --install-extension` ran inside dist against VS Code 1.122.1 (arm64);
`verify-vscode-consumption` confirms `oste.command-central@0.6.0-rc.52`
installed with package sha256 matching the release artifact
(`research/vscode-consumption-rc52-20260610.json`, `success: true`).
Interactive smoke test (Reload Window, Agent Status tree, Focus Terminal) is
left to the user per the cut-preview handoff checklist.

## Sync churn provenance

`sync-launcher` refreshed 36 helper files in `resources/bin/scripts/`; all were
byte-identical to launcher HEAD `3cab35c4` (no working-tree diff) because
`ebdb7382` already committed the bundled helpers, including the new
`lib/window-probe.applescript`.

## Commits

- `chore(release): cut rc52 preview` — version bump, digest, gate artifacts,
  consumption manifest. Hooks passed; no `--no-verify`.
- `docs(research): add rc52 preview cut receipt` — this file.

## Hard-stop compliance

No push, no tags, no Marketplace publish, no external GitHub release changes.
The full flow is local; dist's only outward-looking step is the local
`code --install-extension`.
