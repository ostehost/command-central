# REVIEW — Fable patch closeout + next-RC perspective (2026-06-09)

Task: `cc-fable-rc-perspective-20260609` · Node: Mike MacBook Pro · Repo: `~/projects/command-central`

## HEAD movement

| | Commit | Subject |
|---|---|---|
| Start | `62b0dfc8` | chore(release): cut rc49 preview |
| End | `12b07332` | fix(models): support fable as default launched-terminal model key |

Branch: `main...origin/main [ahead 3]` (was ahead 2 at launch; +1 from the Fable commit). Tree clean (`git status --porcelain` empty). **Not pushed** per task constraints.

## Patch reviewed and committed

Commit `12b07332`, 3 files, +8/−3 — exactly the expected dirty set, nothing unrelated:

- `src/utils/model-aliases.ts` — adds `["fable", "fable"]` to `EXACT_MODEL_ALIASES`. The fallback path (`split("/")` passthrough) would already return `fable` today, so this entry is defensive: it pins the key against future fallback changes. Correct.
- `test/utils/model-aliases.test.ts` — new test `preserves the Fable 5 launcher key`. Passes.
- `resources/bin/scripts/lib/backend-commands.sh` — threads `${model_flag}` through the `acp` / `acp-codex` / `acp-gemini` lanes, matching what the direct `claude`/`codex`/`gemini` lanes already did. Incompatible-model guards (codex strips claude models, gemini strips claude/openai models) sit upstream of `model_flag` construction, so the ACP variants inherit them correctly.

**Cross-repo parity verified:** the bundled `backend-commands.sh` is byte-identical to ghostty-launcher's committed copy (launcher commit `d7834136 fix: default launched claude lanes to fable`). The launcher commit also touched `oste-spawn.sh` (the actual `fable` default), but Command Central does not bundle `oste-spawn.sh` — only `scripts/lib/*`, `oste-steer.sh`, `routing-policy.json` — so no further mirroring is needed for this patch.

## Tests run (all on node, this session)

| Check | Result |
|---|---|
| `bun test test/utils/model-aliases.test.ts` | ✅ 5 pass / 0 fail |
| `shellcheck resources/bin/scripts/lib/backend-commands.sh` | ✅ clean |
| ghostty-launcher `bash test/test-backend-commands.sh` (identical content to bundle; includes new ACP `--model 'fable'` assertion) | ✅ 47 assertions, 23 tests |
| `bun test test/integration/cross-repo-smoke.test.ts` | ✅ 33 pass / 0 fail |
| `just ready` (fix + check + full suite) | ✅ 1697 pass / 1 skip / 0 fail, quality checks clean |
| `bun run scripts-v2/sync-launcher.ts --check` | binary in sync (content-compared, v1.2.8); **3 helpers drifted** (see risks) |
| Pre-commit hooks (Biome staged check) | ✅ passed, no `--no-verify` |

## RC readiness verdict: **GREEN** (cut-ready, with the notes below)

- rc49 (cut today 14:30Z, succeeded, VSIX + digest present, installed as `oste.command-central@0.6.0-rc.49`) contains everything on main **except** the Fable patch — the only product commit since the cut is `12b07332`.
- All local gates are green and the tree is clean. Nothing blocks `just cut-preview` for rc50 when Mike asks for it.

## What rc50 will actually contain

1. The Fable patch (`12b07332`).
2. **Three bundled helpers that will be pulled in by the cut's sync-launcher step** — they drifted because the launcher landed fixes after rc49's sync:
   - `oste-stop-hook.sh` — worktree-aware artifact-dir candidates for completion contracts
   - `reaper.sh` — single-pass `ps` orphan scan (`70e3abc5`)
   - `terminal-persist.sh` — shared `--lines N` capture interface (`432656e1`)

   All three are committed launcher-side with handoffs. I deliberately did **not** run `just sync-launcher` standalone — that would have widened this lane's diff beyond the Fable patch; the cut-preview lane runs it as a built-in step.

## Recommended commands/gates before/at rc50 — all **NOT RUN** in this lane

- `just cut-preview --prerelease` — the rc50 cut itself (includes preflight + sync-launcher + gate + dist). NOT RUN.
- `just prerelease-gate` — only if cutting outside cut-preview. NOT RUN.
- `code --install-extension releases/command-central-0.6.0-rc.50.vsix` + relaunch proof — installed-VSIX evidence that the Fable patch is live in the extension. NOT RUN (rc50 doesn't exist yet).
- ACP runtime smoke: launch one `acp` lane and confirm acpx accepts the trailing `--model 'fable'` after `claude exec "<prompt>"`. NOT RUN — see risk #1.

## Risks / blockers

1. **acpx trailing `--model` flag is composition-tested, not execution-tested.** Both repos' tests assert the string is present in the built command; neither runs acpx (it isn't on the plain-shell PATH on this node). If acpx doesn't pass trailing flags through to the wrapped agent, ACP lanes would error at launch. Low blast radius (ACP lanes only; default claude lanes get `--model fable` from launcher-side `oste-spawn.sh`, which is tested). Mitigation: one manual ACP lane launch post-rc50.
2. **Installed VSIX (rc49) predates the Fable patch.** Alias display and bundled ACP model propagation are not live in the running extension until rc50 is cut and installed. The *default-fable* behavior for spawned lanes is already live regardless — it comes from the launcher repo, not the extension bundle.
3. **Both repos unpushed:** command-central `ahead 3`, ghostty-launcher `ahead 18`. Node-local by design (constraints forbid push), but hub/node sync debt is accumulating — schedule a sync lane after rc50.
4. **Minor:** the `just preview-status` record for rc49 shows `version: (none)` / `artifact: (none)` despite a successful cut (exit 0, VSIX + digest exist). Cosmetic recorder gap in the lifecycle record; worth a small fix sometime.
5. **Follow-up (not a blocker):** consider adding `claude-fable-5` / `anthropic/claude-fable-5` → `fable` exact alias entries, mirroring the existing `claude-opus-4-7 → opus` pattern. If a runtime ever reports the full Fable model ID in `actual_model`, today's tree would render `claude-fable-5 (fallback from fable)`. That false-positive shape is pre-existing for all short keys (e.g. `opus` vs `claude-opus-4-8`), so it was intentionally left out of this narrow patch.

## Bottom line

Fable patch is correct, minimal, byte-identical to the launcher's committed source, fully gated, and committed locally as `12b07332`. rc50 is cut-ready on request; it will carry the Fable patch plus three already-committed launcher helper fixes via the cut's own sync step. No `--no-verify`, no push, no tag, no publish performed.
