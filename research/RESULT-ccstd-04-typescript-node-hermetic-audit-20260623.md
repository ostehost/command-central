# RESULT — CCSTD-04 / PAR-83: Command Central TypeScript/Node Hermetic Build & Env Audit

- **Ticket:** PAR-83 — `[CCSTD-04] Audit Command Central TypeScript/Node hermetic build and env handling`
- **Date:** 2026-06-23
- **Repo:** `command-central` (VS Code extension, Bun toolchain)
- **Audited revision:** `package.json` version `0.6.0-rc.70` (HEAD on `main`)
- **Status:** Audit complete. This is the repo-local standards receipt the ticket
  requires. Every claim below is grounded in a real file at the cited path; no
  source-kit code was applied (none was required — the build is already hermetic
  and reads no `.env*`).

> Scope note: this audit is read-only over the build/env surface. The live build
> entry is `scripts-v2/dist-simple.ts` (Bun.build). There is **no**
> `scripts/build.ts` in this repo — that path is a stale artifact name from the
> standards-kit template; the actual `scripts/` dir contains only
> `install-hooks.sh`, `release.sh`, `site-check.sh`, `svg-to-png.ts`. Where the
> CCSTD-04 template refers to `scripts/build.ts`, read `scripts-v2/dist-simple.ts`.

---

## 1. Toolchain identity (package manager, lockfile, Node policy, formatter, quality gates)

| Dimension | Value | Evidence |
|---|---|---|
| Package manager | **Bun** (exclusive; no npm/yarn/pnpm/webpack) | `bunfig.toml` present; `bun.lock` present; `justfile:92` `bun install`; every script in `package.json` `scripts` runs `bun run …`; CLAUDE.md "Five Commandments" #2 ("ALWAYS use Bun exclusively") |
| `packageManager` field | **Absent** from `package.json` (Bun is asserted via `bunfig.toml` + `bun.lock`, not the corepack field) | `package.json` has no `packageManager` key |
| Lockfile | **`bun.lock`** (Bun text lockfile, 89,281 bytes, committed). No `bun.lockb` (binary) and no `package-lock.json`/`yarn.lock` | root listing shows `bun.lock` only |
| Lockfile policy | `frozen-lockfile = false`; `prefer-offline = true`; `auto = "auto"` (auto-install peer deps) | `bunfig.toml [install]` |
| Node runtime policy | `engines.node >=18.0.0`; build `target: "node"`; `@types/node` **pinned** `20.19.20` (exact, no caret) | `package.json:10-13` engines; `scripts-v2/dist-simple.ts` `Bun.build({ target: "node" })`; `package.json` devDeps `"@types/node": "20.19.20"` |
| VS Code engine policy | `engines.vscode ^1.100.0`; `@types/vscode ^1.100.0` (kept in lockstep) | `package.json:11` + devDeps |
| Module system | ESM only — `"type": "module"`, tsconfig `module: ES2022`, `moduleResolution: bundler`, `verbatimModuleSyntax: true` | `package.json:8`; `tsconfig.json:5,7,14` |
| Strictness | `strict: true`; `types: ["bun","vscode"]`; target `ES2022` | `tsconfig.json:31,58,4` |
| Formatter / linter | **Biome** `^2.3.1` (lint + format) | `package.json` devDeps; `biome.json`; `justfile:200,216,240` |
| Type checker | **TypeScript** `^5.9.3` via `tsc --noEmit` | `justfile:201,241` |
| Dead-code gate | **Knip** `^5.66.3` (`knip.json`) — informational in `check`, hard-fail in `ci` | `justfile:202` (`|| true`) vs `justfile:242` (no `|| true`) |
| Runtime dependencies | **Zero** (`"dependencies": {}`) — extension bundles only its own src; `vscode` + `@vscode/sqlite3` stay external | `package.json` empty `dependencies` |

### Quality-gate commands (the stable interface)

Per `STANDARDS.md` cross-project five-recipe standard, callers use `just <recipe>`,
never bun/biome/tsc directly:

- `just check` (`justfile:194`) — Biome **ci** + `tsc --noEmit` + `knip --no-exit-code || true`
- `just fix` (`justfile:212`) — Biome `check --write` (mutates source files)
- `just test` (`justfile:272`) — `bun run test` + `test-quality`
- `just ready` (`justfile:225`) — fix → check → test
- `just ci` (`justfile:237`) — Biome ci + `tsc --noEmit` + `knip` (hard-fail) + coverage + test-quality

---

## 2. Command classification: read-only vs artifact-producing vs install/publish-adjacent

The AC requires every check/build/dist/install command be classified. Anchored to
real `justfile` recipe definitions (line numbers re-located at audit time).

### A. Read-only (no working-tree mutation, no installs, no network publish)

| Command | Definition | Why read-only |
|---|---|---|
| `just check` | `justfile:194` | `biome ci` (CI/verify mode — never `--write`), `tsc --noEmit`, `knip --no-exit-code` — pure analysis |
| `just ci` | `justfile:237` | Same analyzers in strict mode + coverage/test runs; emits coverage into gitignored `coverage-ci/` but does not touch tracked source |
| `just test` / `test-*` | `justfile:272`, `293`, `362`, `372`, `407` | `bun test`; `test-quality` is grep-only assertions. No source mutation |
| `just knip` / `knip-*` | `justfile:739`+ | Dead-code analysis only (`knip-fix` at `justfile:761` is the lone mutating exception) |
| `just preview-status` | `justfile:659` | Reads `.preview-status/` lifecycle record; reporting only |
| `just vsix-gate` | `justfile:598` | Inspects an existing VSIX via `unzip -l`; pure assertion (`scripts-v2/vsix-content-gate.ts`) |
| `just prerelease-gate` | `justfile:564` | Cross-repo validation + provenance read; gate, not builder |

> Caveat: `just fix` (`justfile:212`) and `just knip-fix` (`justfile:761`) **mutate
> tracked source** (Biome `--write`, Knip auto-fix). They are quality auto-fixers,
> not read-only — call them deliberately, review the diff.

### B. Artifact-producing (writes build output / VSIX / digests; may bump version)

| Command | Definition | Artifacts |
|---|---|---|
| `just dist [args]` | `justfile:541` → `scripts-v2/dist-simple.ts` | `dist/extension.js` (+sourcemap), dev+prod `.vsix`, `releases/<name>.vsix`, `releases/digest-v<ver>.md`. **Default `--patch` bumps `package.json` version** via `npm version --no-git-tag-version` (`dist-simple.ts:116`). Use `--current` to build without bumping. Prunes old releases beyond `distConfig.maxReleases` (default 3, `dist-simple.ts:142,408`) |
| `just build` (`package.json` script) | `package.json scripts.build` → `scripts-v2/dist-simple.ts` | Same script as `dist` (alias) |
| `just prerelease` | `justfile:592` | Runs `prerelease-gate` then `dist --prerelease` — produces a prerelease VSIX |
| `just cut-preview` | `justfile:619` | Composes preflight + sync-launcher + ci + prerelease; produces a preview RC VSIX + `.preview-status/` logs |
| `just sync-launcher` / `sync-terminal` / `sync-all` | `justfile:497,504,511` | Copies bundled binaries into `resources/bin/` & `resources/app/` (mutates tracked resources) |

> The VSIX content gate (`scripts-v2/vsix-content-gate.ts`, wired at
> `dist-simple.ts:200`) hard-fails the build if the candidate exceeds budget
> (≤600KB compressed / ≤2MB uncompressed / ≤120 files) — so artifact production is
> bounded.

### C. Install / publish-adjacent (mutates installed env, registry, or remote)

| Command | Definition | Effect |
|---|---|---|
| `just install` | `justfile:90` | `bun install` from `bun.lock` — mutates `node_modules/`. Depends on `ghostty` recipe (creates a dock launcher) |
| `just add <pkg>` | `justfile:96` | `bun add` — mutates `bun.lock` + `node_modules` |
| `just update` | `justfile:107` | `bun update -i` — interactive dep upgrade (lockfile churn) |
| `bun dist` VS Code install step | `dist-simple.ts:217-221` (`code --install-extension`) | Installs prod VSIX into the local VS Code unless `--no-install`. **Local install only — not a marketplace publish.** |
| `just info <pkg>` | `justfile:116` | `bun info` — read-only network query (registry metadata) |

> Note on the publish boundary: **no recipe publishes to the VS Code Marketplace.**
> `dist-simple.ts` `createVSIX()` (line ~358) runs `bunx @vscode/vsce package`
> (package only, never `vsce publish`). Distribution to the marketplace/registry is
> out of band — the closest to "publish" in-repo is the **local** VS Code install
> in step B/C above. This matches CLAUDE.md's "Do not push, tag, publish … without
> explicit approval."

---

## 3. Hermetic-build / env-handling audit (the core CCSTD-04 deliverable)

### 3.1 No ambient `.env*` file is a build input — CONFIRMED

- **No `.env*` file exists** at the repo root (root listing: no `.env`, `.env.local`,
  etc.). The only mention is in `.gitignore:23-28` (standard dotenv ignore block:
  `.env`, `.env.local`, `.env.development.local`, `.env.test.local`,
  `.env.production.local`) — i.e. an ignore guard, not a build input.
- **No dotenv loading anywhere.** Repo-wide grep over `scripts-v2/`, `scripts/`,
  `justfile`, `package.json`, `bunfig.toml` for `dotenv | loadEnv | .env` returns
  **zero** code that reads a `.env*` file. The hits are only `process.env.<VAR>`
  reads of already-exported variables (see 3.2), never file loads.
- **`bunfig.toml` does not configure any env file** — `[install]`/`[test]`/`[run]`/
  `[debug]` sections only; no `[env]` / dotenv directive.
- **`Bun.build()` reads no env** — `dist-simple.ts buildExtension()` passes a fixed
  config (`entrypoints`, `outdir`, `format: esm`, `target: node`,
  `external: ["vscode","@vscode/sqlite3"]`, `minify`, `sourcemap`); no `define`,
  no `process.env` inlining, no `.env` import. Output is a pure function of source +
  these flags.

**Conclusion:** the build is hermetic with respect to dotenv. Build output does not
depend on any ambient `.env*` file; CI and local builds see the same inputs.

### 3.2 Build-time / pipeline env vars — inventory & safety

All `process.env` reads in the build & release pipeline (grep over `scripts-v2/`,
`scripts/`). None are secrets; none gate correctness of the compiled `extension.js`.

| Env var | Read at | Role | Safety classification |
|---|---|---|---|
| `CI` | `scripts-v2/lib/config.ts:191` | `isCI()` toggle (behavioral) | Safe — non-secret CI flag |
| `GITHUB_ACTIONS` | `scripts-v2/lib/config.ts:191` | `isCI()` toggle | Safe — non-secret CI flag |
| `NODE_ENV` | `scripts-v2/lib/config.ts:198` | `getMode()` → development/production | Safe — standard, non-secret. **Note:** the actual prod/dev split in `dist-simple.ts` is driven by CLI flags (`buildExtension(production)`), not `NODE_ENV`; `getMode()` is helper-level |
| `HOME` | `prerelease-gate.ts:90,732`, `sync-launcher.ts:16`, `node-execution-guard.ts:20`, `preview-status.ts:257` | Locate user paths / cross-repo siblings | Safe — non-secret; falls back to `os.homedir()` where used in the guard |
| `USER` | `node-execution-guard.ts:19`, `preview-status.ts:257` | Identity for the node-execution guard | Safe — non-secret; falls back to `os.userInfo().username` |
| `LAUNCHER_SOURCE` | `sync-launcher.ts:15` | Override path to ghostty-launcher source for `sync-launcher` | Safe — non-secret dev/release override; defaults to `~/projects/ghostty-launcher` |
| `TERMINAL_SOURCE` | `sync-terminal.ts:20` | Override path to terminal app source for `sync-terminal` | Safe — non-secret dev/release override; defaults to `~/ghostty-fork` |

**No secrets in the build path.** No API keys, tokens, or credentials are read by any
build/dist/gate script. (Telemetry's PostHog key is a *runtime extension* setting,
`commandCentral.telemetry.posthogKey`, not a build input.)

### 3.3 Runtime env overrides that are NOT build inputs (disambiguation)

These appear in `package.json contributes.configuration` markdown but are
**extension-runtime** overrides, never consumed at build/package time:

- `TASKS_FILE` — hermetic test/dev fixture override for the lane registry
  (`package.json:197` config description). Test-time only.
- `OSTE_RELEASE_GENERATION_FILE` — overrides the release-generation baseline path
  at runtime (`package.json:233`). Runtime only.

They are listed here so future readers do not mistake them for build env inputs.

### 3.4 Documented safe build-time env vars (the "what may I export" list)

For a reproducible build, **no env var is required** — `just dist --current` (or
`bun run scripts-v2/dist-simple.ts --current`) builds deterministically from
source + lockfile alone. Optional, safe, non-secret overrides:

- `CI=true` / `GITHUB_ACTIONS=true` — opt into CI behavior.
- `NODE_ENV=production` — helper-level mode hint (build minification is actually
  governed by the dist CLI flags, not this var).
- `LAUNCHER_SOURCE` / `TERMINAL_SOURCE` — point the sync recipes at non-default
  sibling repos (release-prep only; not needed for a plain build).

Do **not** introduce a `.env*` file as a build input — it would break the hermetic
property documented in 3.1.

---

## 4. Findings & recommendations

1. **Hermetic w.r.t. dotenv: PASS.** No `.env*` is read; `Bun.build` is config-pure.
   No remediation required.
2. **Lockfile committed & text format: PASS.** `bun.lock` is tracked.
   - *Optional hardening:* `bunfig.toml` sets `frozen-lockfile = false`. CI could set
     `frozen-lockfile = true` (or `bun install --frozen-lockfile`) to guarantee CI
     never silently mutates the lockfile. (Out of scope for this audit's file-set —
     `bunfig.toml` is not in PAR-83's allowed set; logged as a future item.)
3. **`packageManager` field absent.** Bun is asserted by convention + `bunfig.toml`,
   not the corepack `packageManager` field. Adding `"packageManager": "bun@<ver>"`
   to `package.json` would make the toolchain machine-pinned. Logged as future item
   (low priority; `package.json` is in-set, but adding it without a confirmed exact
   Bun version pin risks drift, so deferred to a deliberate change).
4. **Template/path drift:** the CCSTD-04 kit references `scripts/build.ts`, which does
   not exist here. Live build = `scripts-v2/dist-simple.ts`. This receipt records the
   mapping so downstream CCSTD work does not chase a phantom file.
5. **Publish boundary is clean:** no `vsce publish` / marketplace push in any recipe;
   `dist` only packages + (optionally) installs locally. Matches the repo's
   "no publish without approval" policy.

---

## 5. Acceptance-criteria coverage

- [x] Repo-local standards receipt produced (this file) identifying package manager
  (Bun), lockfile (`bun.lock`), Node policy (`engines.node >=18`, `@types/node`
  pinned, `target: node`), formatter (Biome), and quality-gate commands.
- [x] check/build/dist/install commands classified read-only vs artifact-producing
  vs install/publish-adjacent (Section 2, grounded in real `justfile` recipes).
- [x] Confirmed **no ambient `.env*` file is a build input** (Section 3.1).
- [x] Documented safe build-time env vars and the no-secrets property (Sections
  3.2–3.4).
- [x] Every claim cited to a real file/line in this repo; no fabrication.

## 6. Concerns / future items (out of this ticket's file-set)

- `bunfig.toml` `frozen-lockfile = false` — consider CI-side frozen lockfile
  (file not in PAR-83's allowed set; do not edit here).
- `package.json` `packageManager` pin — consider adding once an exact Bun version is
  agreed.
- The stale `scripts/build.ts` reference in the standards kit should be corrected in
  the kit, not in this repo (the repo correctly has no such file).
