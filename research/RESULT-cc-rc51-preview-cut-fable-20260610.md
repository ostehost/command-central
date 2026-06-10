# RESULT — cc-rc51-preview-cut-fable-20260610

Cut the 0.6.0-rc.51 preview locally via the standard `just cut-preview` path to
prove the new VSIX content gate (`303a26fb`) in the real prerelease flow.
Local-only: no push, no tags, no Marketplace publish, no external comms.

## Preconditions verified

- command-central tree clean at start; HEAD `ae9cd3a6` (CLAUDE.md budget doc fix)
  with `303a26fb` (VSIX diet + content gate) directly beneath — both reviewed
  (`review-cc-vsix-diet-fable-20260610` approved the gate).
- ghostty-launcher tree clean on committed HEAD `3cab35c4`.
- Hub machine (`ostehost@MacBookPro`), Bun 1.3.13.
- Starting version `0.6.0-rc.50` → expected cut rc.51. ✅

## Commands run

```bash
just cut-preview                 # preflight → sync-launcher → just ci rehearsal
                                 # → prerelease-gate → dist --prerelease (~50s)
just vsix-gate                   # explicit re-run of the content gate
just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.51.vsix \
  --expected-version 0.6.0-rc.51 \
  --manifest-out research/vscode-consumption-rc51-20260610.json
just preview-status              # exit code 0, SUCCEEDED
```

## Gates

| Gate | Result |
| --- | --- |
| Preflight (both repos clean, hub host) | ✅ |
| `sync-launcher` (binary 1.2.8 in sync; 35 helper files refreshed) | ✅ |
| `just ci` rehearsal — Biome 248 files, tsc, knip, quality checks | ✅ |
| Test suite | ✅ 1736 pass / 1 skip / 0 fail (123 files, 10.35s) |
| `prerelease-gate` (CC `just ci` + launcher `just check` + contract checks) | ✅ `research/prerelease-gate/prerelease-gate-2026-06-10T12-26-33.316Z.json` |
| VSIX content gate (in-path during dist) | ✅ budgets respected, no forbidden artifacts |
| `just vsix-gate` (explicit re-run) | ✅ identical numbers |
| Independent forbidden-pattern scan (`unzip -l` grep for `.map`, tests, coverage, `node_modules`, `.ts`, `scripts-v2`, tsconfig) | ✅ no hits |

## Artifact identity

- **VSIX:** `releases/command-central-0.6.0-rc.51.vsix`
- **Version:** `0.6.0-rc.51` (publisher `oste`, name `command-central`)
- **Compressed:** 265,004 bytes (258.8 KB) — budget 600,000
- **Uncompressed:** 882,180 bytes — budget 2,000,000
- **Files:** 51 — budget 120
- **sha256:** `a0b880c06e2b505eb9f7a1fcb88c4cd0341c77985dd20d7a6b33bdb3e71c6659`
- **Digest:** `releases/digest-v0.6.0-rc.51.md` (tracked record; VSIX itself is gitignored)
- Prior rc.50 production VSIX was 2.54 MB — the diet cuts the shipped package ~90%.

## Install status

`code --install-extension` ran inside dist; `verify-vscode-consumption` confirms
`oste.command-central@0.6.0-rc.51` installed with package sha256 matching the
release artifact (`research/vscode-consumption-rc51-20260610.json`,
`success: true`). Interactive smoke test (Reload Window, Agent Status tree,
Focus Terminal) is left to the user per the cut-preview handoff checklist.

## Sync churn provenance

`sync-launcher` updated `resources/bin/scripts/lib/{bundle-runtime,project-bundle-open,reaper}.sh`;
each verified byte-identical to `~/projects/ghostty-launcher/scripts/lib/` at
launcher HEAD `3cab35c4` (visible-lane receipt fix) before committing.

## Commits

- `0d33511a` `chore(release): cut rc51 preview` — version bump, digest, gate
  artifacts, consumption manifest, synced helper scripts. Hooks passed; no
  `--no-verify`.

## Hard-stop compliance

No push, no tags, no Marketplace publish, no external GitHub release changes.
The full flow is local; dist's only outward-looking step is the local
`code --install-extension`.
