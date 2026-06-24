# RESULT — CCSTD-01 / PAR-80: Command Central baseline preserve-before-destroy audit

- **Ticket:** PAR-80 — `[CCSTD-01] Run Command Central baseline preserve-before-destroy audit`
- **Date:** 2026-06-23
- **Repo:** `command-central` (VS Code extension, Bun toolchain)
- **Status:** Done. A re-runnable, **non-mutating**, host-labeled audit now exists
  as a script + read-only `just` recipe + machine-readable receipt + this
  closeout. Every category the kit requires is enumerated.

> Scope note: this audit only ever reads. It uses read-only git
> plumbing/porcelain (`rev-parse`, `status --porcelain`, `ls-files`,
> `stash list`, `remote -v`). It never stages, commits, stashes, checks out,
> resets, fetches, prunes, or otherwise writes to the repo under audit. The only
> write is the receipt under a separate output dir (`research/preserve-baseline/`).

---

## 1. Deliverables

| Deliverable | Path |
|---|---|
| Audit script (pure parsers + read-only git I/O + CLI) | `scripts-v2/preserve-baseline-audit.ts` |
| Read-only `just` recipe | `justfile` → `preserve-audit *args=""` |
| Unit test (all pure parse/classify logic) | `test/scripts-v2/preserve-baseline-audit.test.ts` |
| Machine-readable receipt | `research/preserve-baseline/preserve-baseline-<host>-<utc>.json` (+ `latest.json`) |
| Closeout doc | this file |

Run it with:

```bash
just preserve-audit            # human summary + receipt
just preserve-audit --json     # full receipt to stdout + receipt file
just preserve-audit --repo /some/repo --output-dir /tmp/out
```

## 2. Categories enumerated (preserve-before-destroy checklist)

Each maps to a read-only git command and a pure classifier, so a destructive
action (reset --hard, clean -fdx, branch -D, force-push, repo delete) can be
weighed against what it would silently throw away.

| Category | Source command (read-only) | Classifier |
|---|---|---|
| staged-only | `git status --porcelain=v1 -z` | `classifyPorcelain` → `stagedOnly` (index dirty, worktree clean) |
| unstaged | `git status --porcelain=v1 -z` | `classifyPorcelain` → `unstaged` (worktree dirty; covers `MM`) |
| untracked | `git status --porcelain=v1 -z` | `classifyPorcelain` → `untracked` (`??`) |
| ignored-only | `git ls-files --others --ignored --exclude-standard -z` | `parseIgnoredFiles` (the `clean -fdx` blast radius) |
| stash-count | `git stash list` | `parseStashCount` |
| divergent-or-gone-upstream | `git status --porcelain=v1 --branch` (first line) | `parseBranchHeader` → ahead/behind or `[gone]` |
| remotes | `git remote -v` | `parseRemotes` (one entry per remote; push recorded if it differs) |
| credential-in-remote | derived from `git remote -v` | `detectCredentialInRemote` + `redactRemoteUrl` (flags + **redacts** embedded userinfo passwords) |

The receipt also records HEAD (`git rev-parse HEAD`), branch
(`git rev-parse --abbrev-ref HEAD`), a `dirtySummary` with per-category counts,
hostname + user (`os.hostname()` / `os.userInfo()`), and a `preserveClean`
verdict that is true only when there is genuinely nothing to preserve.

## 3. Non-mutation guarantee

- Only the commands in §2 run; all are read-only.
- Remote URLs are **redacted** before they touch disk — a live credential is
  never written to the receipt (verified by a unit test that asserts the secret
  is absent from the serialized receipt).
- The receipt is written under `research/preserve-baseline/`, not into the
  repo's tracked working state. The repo under audit (default `cwd`) is never
  written to.

## 4. Test coverage

`test/scripts-v2/preserve-baseline-audit.test.ts` unit-tests every pure
function, including regressions that pin the subtle cases:

- a file both staged **and** further modified (`MM`) is classified as
  *unstaged*, never *staged-only* (a `reset` would surface the worktree delta);
- a configured-but-`[gone]` upstream is detected distinctly from ahead/behind;
- an embedded token is flagged **and** redacted, while plain `https://` and
  `git@host:` SSH-shorthand remotes are not false-flagged;
- a lone stash entry makes the tree non-clean (so a reflog/gc would orphan it);
- `buildReceipt` assembles a complete host-labeled receipt and never serializes
  a live credential.

## 5. Downstream

PAR-80 blocks PAR-81 and PAR-84 (the rest of the CCSTD destructive-cleanup
lane). With a re-runnable receipt now available, those tickets can reference
`just preserve-audit` as the mandatory preserve step before any destructive
operation. Wiring the recipe into the release/cleanup recipes (cut-preview
preflight, etc.) is a follow-up — this ticket delivers the audit itself, which
is the prerequisite.
