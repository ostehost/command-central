# RESULT — cc-rc54-preview-cut-installed-proof-fable-20260611

Cut the 0.6.0-rc.54 preview locally via `just cut-preview --prerelease` and
proved the normal VS Code profile is consuming the installed extension with
both the consumption manifest and the installed-VSIX Agent Status proof.
Local-only: no push, no tags, no Marketplace publish, no external comms.

## Versions

- **Previous version:** `0.6.0-rc.53`
- **New version:** `0.6.0-rc.54`

## Preconditions verified

- command-central tree clean at start; HEAD `fea91b9e`
  (`refactor(agent-diff): route diffs on explicit diffMode, not taskStatus`),
  version `0.6.0-rc.53` as expected.
- ghostty-launcher tree clean on committed HEAD `fa83364d`
  (`fix(persist): support length-prefixed data frames`) — the prior launcher
  blocker is resolved and absorbed by this cut's sync.
- Hub machine (`ostehost@MacBookPro`), Bun 1.3.13.

## Commands run

```bash
just cut-preview --prerelease    # preflight → sync-launcher → just ci rehearsal
                                 # → prerelease-gate → dist --prerelease (63.7s)
just preview-status              # state: succeeded, exit code 0
just verify-vscode-consumption --vsix releases/command-central-0.6.0-rc.54.vsix \
  --expected-version 0.6.0-rc.54 \
  --manifest-out research/vscode-consumption-rc54-20260611.json
just test-installed-vsix-agent-status
```

## Gates

| Gate | Result |
| --- | --- |
| Preflight (both repos clean, hub host) | ✅ |
| `sync-launcher` (binary 1.2.8 in sync; 36 helper files refreshed, byte-identical — no working-tree diff) | ✅ |
| `just ci` rehearsal — Biome 270 files, tsc, knip, quality checks | ✅ |
| Test suite | ✅ 1920 pass / 1 skip / 0 fail (1921 tests, 135 files, 15.55s) |
| `prerelease-gate` (CC `just ci` + launcher `just check` + contract checks) | ✅ `research/prerelease-gate/prerelease-gate-2026-06-11T06-51-55.505Z.json` |
| VSIX content gate (in-path during dist) | ✅ 268,369 B compressed / 888,459 B uncompressed / 52 files — budgets respected, no forbidden artifacts |
| `verify-vscode-consumption` | ✅ `success: true` |
| `test-installed-vsix-agent-status` | ✅ `installed-vsix-agent-status-proof-ok`, exit 0 |

## Artifact identity

- **VSIX:** `releases/command-central-0.6.0-rc.54.vsix`
- **Version:** `0.6.0-rc.54` (publisher `oste`, name `command-central`)
- **Compressed:** 268,369 bytes (262.1 KB) — budget 600,000
- **Uncompressed:** 888,459 bytes — budget 2,000,000
- **Files:** 52 — budget 120 (unchanged from rc53)
- **sha256:** `5ebae2a4f3ea276a4ce8185319b3a1140f303435fd6b1876278414bf351c0276`
- **Digest:** `releases/digest-v0.6.0-rc.54.md` (tracked record; VSIX itself is gitignored)
- `preview-status`: SUCCEEDED, pid 9121, 2026-06-11T06:50:57Z → 06:52:01Z
  (63.7s), artifact sha matches the independently computed sha256 above.
- Digest "Since previous prerelease cut (rc53)" section lists exactly the
  user-visible commits in `6b7a25f4..HEAD` (docs(research) receipts excluded
  by the generator's documented subject filter).

## Installed-VSIX proof (objective of this cut)

**Consumption manifest** (`research/vscode-consumption-rc54-20260611.json`):
`code --list-extensions --show-versions` and the installed
`~/.vscode/extensions/oste.command-central-0.6.0-rc.54/package.json` both
report `0.6.0-rc.54`, and the VSIX sha256 in the manifest matches the release
artifact. `success: true`, zero errors.

**Agent Status proof** (`just test-installed-vsix-agent-status`): launched a
real VS Code test host (1.124.0, arm64) against the packaged extension in an
isolated extensions dir and inspected the live tree:

```
installed-vsix-agent-status-proof-ok
version: 0.6.0-rc.54
task count: 142
symphony view roots: Operations Dashboard | Running Sessions · 0 | Retry Queue · 0 | Workstreams · 0 | Run Attempts · 142
mode: passive
actions: 0 passed / 3 skipped
duration: 65.92s
```

Passive mode means the three action probes are intentionally skipped (live
probes require `--live` + `COMMAND_CENTRAL_REQUIRED_TASK_ID`). Proof manifest
is local-only at `logs/installed-vsix-agent-status-proof-1781160770476.json`
(gitignored). Interactive smoke (Reload Window, Focus Terminal) remains on
the user per the cut-preview handoff checklist.

## Sync churn provenance

`sync-launcher` refreshed 36 helper files in `resources/bin/scripts/`; all
byte-identical to launcher HEAD `fa83364d` (no working-tree diff), so the cut
carries no launcher changes beyond what rc53 already bundled. Release archive
rotation removed the gitignored `command-central-0.6.0-rc.51.vsix`
(keep-last-3 policy).

## Commits

- `chore(release): cut rc54 preview` — version bump, digest, gate artifacts,
  consumption manifest. Hooks passed; no `--no-verify`.
- `docs(research): add rc54 preview cut + installed proof receipt` — this file.

## Hard-stop compliance

No push, no tags, no Marketplace publish, no `git fetch`/`pull`. The full
flow is local; dist's only outward-looking step is the local
`code --install-extension`.

## Verdict

`rc54_ready_for_review: yes` — all gates green, artifact identity verified
end-to-end (package.json → preview-status → VSIX sha → installed package),
and the installed-VSIX Agent Status proof confirms the packaged rc54 renders
the real task registry (142 tasks) in a live VS Code host. Ready for Mike
review and later push/tag/publish approval.
