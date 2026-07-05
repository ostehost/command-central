# RESULT — CCSTD-05 / PAR-84: Command Central release split-identity & push-target guardrails

- **Ticket:** PAR-84 — `[CCSTD-05] Add Command Central release split-identity and push-target guardrails`
- **Date:** 2026-07-05
- **Repo:** `command-central` (VS Code extension, Bun toolchain) @ branch `main`
- **Depends on:** PAR-80 (CCSTD-01 preserve-baseline audit)
- **Canonical kit:** `standards-adoption-kits/vscode-extension-preservation-kit.md`
- **Status:** Done. The split-identity/push-target **code** guardrails (release.sh
  + prerelease-gate) were already landed and tested; this closeout adds the
  **release-safety documentation** (local↔public trust boundary, remote-URL
  assertions) and this **standards receipt** identifying the Tier 2 /
  partner-approval actions. All four acceptance criteria are now satisfied.

> Scope note: this lane made only docs + this receipt changes and ran only
> read-only / dry-run verification. It never pushed, tagged, published, or ran a
> Tier 2 action.

---

## 1. The hazard (split identity)

Command Central and `ghostty-launcher` are a **split identity**: two separate
repos, two separate GitHub remotes (`ostehost/command-central` vs
`ostehost/ghostty-launcher`). A release script that tags/pushes from a checkout
with a mis-set `origin` — the sibling repo, a fork, or the wrong checkout — could
silently tag or push a release into the **wrong repository**. The guardrail must
be **non-destructive**: it must never push or tag on its own.

`package.json` `repository.url` is the canonical identity; the live push target is
`git remote get-url <remote>` (default `origin`). The guardrail normalizes both to
an `owner/repo` slug and refuses on mismatch or unparseable input.

## 2. Deliverables

| Deliverable | Path | Status |
|---|---|---|
| Bash push-target assertion + `--dry-run` | `scripts/release.sh` (`assert_push_target_identity`, `normalize_github_remote`) | Landed (pre-existing) |
| Gate push-target check (pure logic + runner + opt-in flag) | `scripts-v2/prerelease-gate.ts` (`normalizeGitHubRemote`, `evaluatePushTarget`, `runPushTargetCheck`, `--require-push-target`) | Landed (pre-existing) |
| Unit tests (12 push-target cases) | `test/scripts-v2/prerelease-gate.test.ts` | Green (see §5) |
| Release trust boundary + guardrail docs | `docs/releasing/PROCESS.md`, `docs/releasing/CHECKLIST.md` | Added this lane |
| Standards receipt (this file) | `research/RESULT-ccstd-05-release-split-identity-push-target-20260705.md` | Added this lane |
| Intake / design note | `research/PAR-84-CCSTD-05-RELEASE-SPLIT-IDENTITY-PUSH-TARGET-GUARDRAIL-2026-06-23.md` | Pre-existing |

## 3. Tier classification — which actions need partner approval

The canonical kit's split-identity lesson maps onto this repo's two release trust
tiers. **Tier 1** is local and reversible; **Tier 2** is public, hard to unwind,
and requires **explicit partner approval**.

| Action | Tier | Approval | Guardrail |
|---|---|---|---|
| `just dist` / `just dist --dry-run` (build + package VSIX, `npm version --no-git-tag-version`) | **Tier 1** | none | never tags/pushes |
| `code --install-extension …` (local install) | **Tier 1** | none | — |
| `just prerelease` / `just prerelease-gate` (cross-repo gate) | **Tier 1** | none | opt-in `--require-push-target` |
| `./scripts/release.sh --dry-run <version>` | **Tier 1** | none | asserts identity, mutates nothing |
| `./scripts/release.sh <version>` (commit + tag **locally**) | **Tier 2** | partner approval | `assert_push_target_identity` before any mutation; prints push cmd, never pushes |
| `git push origin main --tags` / `git push origin v<x>` | **Tier 2** | partner approval | operator-driven; identity asserted upstream |
| `bunx @vscode/vsce publish` (Marketplace) | **Tier 2** | partner approval | operator-driven, public & irreversible |
| GitHub release / tag-triggered publish | **Tier 2** | partner approval | operator-driven |

This mirrors the standing rule in `CLAUDE.md` and the `cut-preview` skill: *"Do
not push, tag, publish, or use `--no-verify` without explicit approval."*

## 4. Acceptance-criteria status

| AC | Status | Evidence |
|---|---|---|
| Release docs separate local build/package/install from public publish/tag/release | **done** | `docs/releasing/PROCESS.md` → "Release Trust Boundary: Local (Tier 1) vs Public (Tier 2)"; `docs/releasing/CHECKLIST.md` Release section |
| Any publish/tag/release script has an obvious approval gate or dry-run mode | **done** | `scripts/release.sh` `--dry-run` + `assert_push_target_identity`; `just prerelease-gate --require-push-target`; `just dist` uses `--no-git-tag-version` (never tags/pushes) |
| Remote-URL assertions documented for preservation/release pushes | **done** | `docs/releasing/PROCESS.md` → "Split-identity & push-target guardrails (CCSTD-05)" |
| Standards receipt identifies which actions are Tier 2 / partner approval | **done** | §3 of this file |

## 5. Verification evidence

Live guardrail (non-mutating), run 2026-07-05 on the real repo:

```
$ ./scripts/release.sh --dry-run 9.9.9-guardrail-check
🚀 Releasing v9.9.9-guardrail-check...
✅ Push-target identity OK: origin → ostehost/command-central matches package.json

🧪 --dry-run: no files changed, no commit, no tag.
   Would bump package.json to 9.9.9-guardrail-check, commit 'chore: release v9.9.9-guardrail-check', and tag v9.9.9-guardrail-check.
   Then an operator would run: git push origin main --tags
$ git status --porcelain    # clean — dry-run mutated nothing
```

Unit tests (`bun test test/scripts-v2/prerelease-gate.test.ts`): **54 pass / 0
fail**, including the 12 push-target cases:

- `normalizeGitHubRemote`: https/ssh/scp-like + trailing `.git`/slash + case; empty for unrecognizable remotes.
- `evaluatePushTarget`: passes on match across url shapes; **refuses when origin points at the sibling `ghostty-launcher` repo**; refuses a same-name fork; fails clearly on an unparseable url.
- `runPushTargetCheck` + integrated gate: sibling remote → failed check; matching remote → passed; wrong target **hard-blocks** the gate (throws `GateError`).

## 6. Non-mutation / Tier discipline

- Docs + receipt edits only; no source/gate logic changed this lane.
- Verification was `--dry-run` + unit tests; no push, tag, publish, or `--no-verify`.
- The guardrails themselves are non-destructive: bash only reads `git remote
  get-url`; the pure gate logic takes injected inputs; `--dry-run` exits before any
  mutation. Tagging/pushing/publishing remain operator-driven Tier 2 steps.
