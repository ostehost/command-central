# PAR-84 — [CCSTD-05] Release split-identity & push-target guardrails

- **Date:** 2026-06-23
- **Linear:** PAR-84 (Command Central project); work_item_ref: `linear:PAR-84`
- **Depends on (active):** PAR-80 (CCSTD-04)
- **Repo:** `/Users/ostemini/projects/command-central` @ branch `main`
- **Disposition:** code + doc. Pure split-identity logic + injected-input gate
  runner + bash assertion are fully implemented and tested. The live end-to-end
  push/tag refusal against a real misconfigured remote is **partial** (needs a
  live remote) — see "Live-infra gap".

## What CCSTD-05 asks

Command Central and `ghostty-launcher` are a **split identity**: two separate
repos, two separate GitHub remotes
(`ostehost/command-central` vs `ostehost/ghostty-launcher`). A release/publish
script that tags and pushes must **refuse to push/tag to the wrong remote /
identity** — e.g. when run from the wrong checkout, against a fork, or with a
mis-set `origin`. The guardrail must be **non-destructive** (it must never push
or tag itself).

### Baseline (the hazard)

- `scripts/release.sh` did `git commit` + `git tag` and printed
  `git push origin main --tags` with **no remote-URL assertion, no dry-run, no
  identity check**. A checkout whose `origin` pointed at `ghostty-launcher`
  would tag/push into the wrong repo silently.
- `scripts-v2/prerelease-gate.ts` had repo-parity, daemon-smoke, node-readiness,
  and launcher-contract checks but **no remote-identity / push-target check**.
- `rg` for `git remote get-url | assert.*remote | expected.*remote` across
  `scripts/ scripts-v2/ justfile` returned zero matches — no guardrail existed.

## Source of truth

`package.json` `repository.url` is the canonical identity. The live push target
is `git remote get-url <remote>` (default `origin`). The guardrail compares the
two **after normalization** and refuses on mismatch or unparseable input.

## What this change adds

### 1. Pure split-identity logic — `scripts-v2/prerelease-gate.ts`

- `normalizeGitHubRemote(url)` → lowercase `owner/repo` slug. SSH/HTTPS, a
  trailing `.git`, a trailing slash, and case all compare equal. Returns `""`
  for non-GitHub / unparseable remotes so a clear "could not parse" issue is
  surfaced rather than a silent match. Supported shapes:
  `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`,
  `ssh://git@github.com/o/r(.git)`.
- `evaluatePushTarget({ remote, remoteUrl, packageRepoUrl })` →
  `{ ok, remote, remoteSlug, expectedSlug, issues }`. Pure, injected-input,
  non-destructive (mirrors the existing `evaluateRepoParity` / `evaluateDaemonSmoke`
  pattern). Refuses when the slugs differ or either side cannot be parsed.

### 2. Gate runner — `runPushTargetCheck(config)`

- Reads `package.json` `repository` from `config.commandCentralRepo` and runs
  `git remote get-url <config.pushRemote ?? "origin">`, then delegates to
  `evaluatePushTarget`. Emits a structured `release push-target identity`
  `CheckRecord` (passed/failed) — never pushes or tags.
- Opt-in via `--require-push-target` (+ `--push-remote <name>`); wired into
  `runGate` so a wrong target throws a `GateError` and **hard-blocks the gate
  before any publish path**. The flag is opt-in so CI (`just prerelease-gate`)
  and `just cut-preview` keep passing unchanged.

### 3. Bash assertion + dry-run — `scripts/release.sh`

- `assert_push_target_identity` runs **before any mutation** (before bump,
  commit, tag). It reads `package.json` `repository` via `bun -e`, reads
  `git remote get-url $PUSH_REMOTE`, normalizes both with a bash
  `normalize_github_remote` mirroring the TS logic, and `exit 1`s on
  mismatch/unparseable input.
- New `--dry-run` flag: prints what would happen (bump/commit/tag + the push
  command) and exits **without changing files, committing, or tagging**.
- `PUSH_REMOTE` env override (default `origin`). The script still only
  commits+tags locally and **prints** the push command for an operator — it
  never runs `git push` itself.

## Tests — `test/scripts-v2/prerelease-gate.test.ts`

Reuses the file's existing `createGateFixture` / `writeExecutable` / git-init
helpers.

- `normalizeGitHubRemote`: url-shape + case normalization; empty for non-GitHub.
- `evaluatePushTarget`: pass on match; **refuse when origin points at the
  sibling `ghostty-launcher` repo** (the core regression — no such check existed
  before); refuse a same-name fork; clear failure on unparseable url.
- `runPushTargetCheck`: wrong sibling remote → failed check; matching remote →
  passed; **integrated `runGate` with `requirePushTarget` hard-blocks** (throws
  `GateError`, `release push-target identity` check is `failed`).

The bash `normalize_github_remote` was independently verified against the same
url-shape matrix (PASS on all 10 cases) and `scripts/release.sh` passes
`bash -n` + `shellcheck`.

### Regression proof

On the pre-fix code there was no push-target logic, so a command-central
checkout with `origin → ghostty-launcher` would have tagged/pushed to the wrong
repo with no error. The new tests assert that scenario now **fails** (pure +
gate-runner + integrated), and pass on the fixed code.

## Acceptance-criteria status

| AC | Status | Evidence |
|---|---|---|
| Refuse push/tag to the wrong remote/identity | **code complete** | `evaluatePushTarget`, `runPushTargetCheck`, `assert_push_target_identity` |
| Non-destructive; guardrail itself does not push/tag | **done** | pure logic + injected inputs; bash only reads `git remote get-url`; `--dry-run` exits before mutation |
| Unit test for pure logic | **done** | `normalizeGitHubRemote` + `evaluatePushTarget` + gate-runner tests |
| Short research doc | **done** | this file |
| No push/tag/publish in this lane | **satisfied** | edits only |

## Live-infra gap (why the live part is `partial`)

The pure logic, gate runner, and bash assertion are fully implemented and
tested with injected inputs / a temp-git fixture. Not produced here (needs a
real misconfigured remote, and would mutate git state — out of scope for this
edit-only lane):

1. An end-to-end `scripts/release.sh` run that actually `exit 1`s on a
   deliberately wrong `origin` (the bash logic is verified in isolation; the
   live refusal is the unrun part).
2. A green `just prerelease-gate --require-push-target` run on the real repo
   (`origin → ostehost/command-central` matches `package.json`, so this is
   expected to pass once run live).

## Constraints honored

- Edits confined to the allowed file-set: `scripts-v2/prerelease-gate.ts`,
  `scripts/release.sh`, `research/`, `test/scripts-v2/`.
- New `GateConfig` fields are optional so existing callers/tests still
  type-check; new helpers exported following the file's existing convention.
- ESM, strict TS, zero `as any`; index-signature access via bracket notation
  (`["repository"]`, `["url"]`); indexed `match[n]` access guarded.
- No push, tag, publish, or `--no-verify`.
