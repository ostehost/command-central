# Release Preview Update — 2026-05-25

**Task ID:** `cc-release-preview-update-20260525-2036`

## Host/Path Proof

| Field | Value |
|-------|-------|
| Hostname | MacBookPro.lan |
| User | ostehost |
| Working dir | /Users/ostehost/projects/command-central |
| Branch | main (ahead 4 of origin) |
| Starting HEAD | 86b69a40 |
| Starting tree | abffe67270967f35b2388af1ef1c2a62b06a79bc |

## Release Recipe Chosen

**`just cut-preview`** (default args: `--prerelease`)

Why: This is the documented single-entry preview RC flow that composes:
1. `_preview-preflight` — verifies both repos clean, host identity
2. `sync-launcher` — pulls canonical launcher into resources/bin/
3. `_preview-rehearsal` — runs `just ci` (strict validation)
4. `prerelease` — cross-repo gate + `dist --prerelease`

It builds and installs the VSIX locally without publishing, tagging, or pushing — matching all hard gates.

## Commands Run & Results

| # | Command | Result |
|---|---------|--------|
| 1 | `just check` | PASS — biome ci + tsc + knip clean |
| 2 | `bun test test/tree-view/agent-status-launcher-interactive-claude.test.ts` | PASS — 4/4 tests |
| 3 | `just test` | PASS — 1573 pass, 1 skip, 0 fail |
| 4 | `just cut-preview` | PASS — full flow completed |
| 4a | └ preflight | PASS — both repos clean |
| 4b | └ sync-launcher | PASS — v1.2.8 already in sync, 34 helper scripts refreshed |
| 4c | └ rehearsal (just ci) | PASS — strict validation + 1573 tests |
| 4d | └ prerelease-gate | PASS — cross-repo contract verified |
| 4e | └ dist --prerelease | PASS — built + installed |
| 5 | `just fix` | PASS — no fixes needed |
| 6 | `git commit` | PASS — b0727f0a |

## Artifact Produced

| Field | Value |
|-------|-------|
| Version | 0.6.0-rc.39 |
| VSIX | releases/command-central-0.6.0-rc.39.vsix |
| VSIX size | 1.92 MB |
| Bundle (prod) | 374.6 KB (85% smaller than dev) |
| Installed to VS Code | Yes |
| Digest | releases/digest-v0.6.0-rc.39.md |
| Gate artifact | research/prerelease-gate/prerelease-gate-2026-05-26T00-41-03.602Z.json |

## Final Git State

| Field | Value |
|-------|-------|
| HEAD | b0727f0a |
| Tree | 0c0e02e9993053a6b883e7a3498711de359a1358 |
| Dirty/untracked | None (clean) |
| Commits ahead of origin | 4 |

## All Systems Green

**YES** — all validation gates passed:
- Biome lint/format: clean
- TypeScript typecheck: clean
- Knip dead code: clean
- Full test suite: 1573/1573 pass
- CI strict mode: pass
- Cross-repo prerelease gate: pass
- VSIX build + install: success

## Release Approval Request

All local systems are green. The following commits are ready for push (4 ahead of origin/main):

```
b0727f0a chore(prerelease): cut command central rc39
86b69a40 fix(agent-status): suppress completed launcher Claude sessions
3ff6eb6c chore: auto-commit agent work [cc-dogfood-agent-status-20260525-2008]
1570f21e feat(model-aliases): add claude-opus-4-7 and claude-sonnet-4-6 exact entries
```

**Recommended next step for Oste → Mike:**
> Mike, rc39 is built and installed locally. All gates green (1573 tests, cross-repo gate, strict CI). The extension includes the agent-status fix that suppresses completed launcher Claude sessions. Reload VS Code window (`Cmd+Shift+P → Reload Window`) to activate, smoke test, then approve `git push origin main` when ready.

To activate: `Cmd+Shift+P` → "Developer: Reload Window" in VS Code.
