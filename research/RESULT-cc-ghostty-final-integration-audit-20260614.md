# RESULT — CC + Ghostty Final Cross-Repo Integration Audit

- **Task id:** `cc-ghostty-final-integration-audit-20260614`
- **Role:** Reviewer / manager-delegate (read-only audit — working tree left untouched, no commits, no push/tag/publish)
- **Date:** 2026-06-14
- **Host:** Mike MacBook Pro (canonical node)
- **Repos:** `/Users/ostehost/projects/command-central` (CC) · `/Users/ostehost/projects/ghostty-launcher` (Ghostty)
- **Verdict:** 🟢 **GO for a local, same-node, human-driven RC cut at current HEAD.** 🔴 **NO_GO for an off-node / CI / cross-machine cut** (registry + 3 review handoffs are node-local — known, documented, accepted limitation, not a defect).
- **One time-sensitive action before GO is "clean":** preserve 3 ephemeral `/tmp` review verdicts (see §4). They gate review *provenance durability*, not the immediate same-node cut.

---

## 0. TL;DR

Both repos are clean, green, and ahead of origin with self-consistent, native, non-hacky work:

- **CC** (`7346655f`, ahead 17): Agent Status V2 project-first section model, idle/empty-state honesty, perf/log-spam polish. Installed `0.6.0-rc.60` VSIX live proof 3/3, unit suite 641/0 re-confirmed at current HEAD, tree-view 461/0.
- **Ghostty** (`fb5a26bf`, ahead 18): durable-vs-live release-proof split + portability/honesty fixup; spawn robustness (PATH-init inline, unique self-deleting runner, stdin/TTY decouple). Durable `release-proof` `verdict=pass`; live `release-live-proof` GATE_PASS on-node; 122 gate assertions.
- **No active blocker lanes** for the RC (§3). The one `contract_failure` row is a stale label whose handoff was backfilled and whose code defect is fixed by landed commits; the one `completed_dirty` row is a different project (`config`); the two `running` rows are the live RC lanes themselves (the final-gate sibling + this audit).
- **Obsolete-code guard (§6): clean** — no fake/synthetic running rows, no OpenClaw-as-launched-terminal, no ephemeral-tmux-as-durable, no DOM scraping, no gitignored-receipt-as-committed survive into the RC path.
- **Preservation risk (§4):** 3 review verdicts for the RC's headline feature exist **only under `/tmp`** and are **committed nowhere**. Present now; lost on reboot/`/tmp`-clear.

---

## 1. Ahead-stack summary by functional slice (not commit count)

### Command Central — 17 commits ahead of `origin/main`

| Slice | Commits | What it does |
|---|---|---|
| **Agent Status V2 — project-first section model (headline)** | `5f1c9d63` (feat), `153f9948` (impl auto-commit), `c17f3de5` (keep detached/unconfirmable running lanes in Current·Live), `4a64e74b` + `0c02ab5e` (unified status-tree UX impl + spec) | Re-buckets the tree into project-first sections; `formatV2Summary` / `V2_SECTION_HEADERS` / `computeUnifiedSectionCountsForTasks` drive root + per-project descriptions and counts. **Wired into the provider at HEAD** (confirmed by the clean recovery review, §4). |
| **Idle / empty-state honesty** | `add9b0fc` + `aa812b38` ("none active" → history-preserving "0 live now"), `72216ce1` (collapse stale Needs Review backlog; calm idle Symphony summary), `9ace3f74` (honest breakdown for null-status rows) | Read-model never lies about idle/empty/null state. |
| **Perf / log-spam polish** | `807f1158` (current-running surface fix), `05af4109` (suppress duplicate registry-fallback log spam), `91ce7cb2` + `eb23f3da` (rattle/perf + layout polish receipts) | Render-path quieting; no behavioral risk. |
| **Receipts / docs** | `7346655f` (launched-terminal RC closeout), `583a5b8b` + `fab5195a` (cross-repo integration gate), `f7b5c0b0` (rc.61 black-box readiness) | Evidence trail only; no product code. |

### Ghostty Launcher — 18 commits ahead of `origin/main`

| Slice | Commits | What it does |
|---|---|---|
| **Release-proof durable/live split + portability/honesty (headline)** | `a0d28d67` (split durable proof from live attachment), `6d08c273` (durable honest about portability; `--require-receipt`; anchored structured-vs-unhandled boundary), `30012261` (stabilization), `efda7cc7` (refresh evidence scope), `e3f649f6` (SC2034 fix → `just check` green); receipts `fb5a26bf` / `4841b388` / `0e755302` | Durable proof's verdict no longer depends on live tmux attachment or ephemeral/external handoffs; live mode stays strict; committed receipt now enforced. |
| **Spawn robustness — review survival** | `03788085` (decouple visible lanes from interactive stdin so review survives), `ca60d5a9` (unique self-deleting agent runner per staged launch), `2a1699de` (inline runtime PATH-init into staged launch script), `aeb7a409` (review-routing-fix auto-commit); receipts `ac9de264` / `6eee9fd6` | Closes the path-init delete-race that caused the `contract_failure` (§3); makes staged launch self-contained. |
| **Worktree hygiene / dogfood** | `11012c47` (preserve-first stale-worktree hygiene plan), `1853208c` (dogfood readiness receipt) | Plan + receipt; preserve-first respected. |
| **Truthful degraded receipts / model default** | `a1df9c25` (truthful degraded receipt under AX assistive-access denial), `8bd13386` (default claude lanes to opus 4.8) | Honest degraded-mode receipts; opus 4.8 default. |

---

## 2. Verification run this audit (read-only, this node)

| # | Command / check | Exit | Result |
|---|---|---|---|
| 1 | `git status` both repos | 0 | CC clean (`7346655f`, ahead 17); Ghostty clean (`fb5a26bf`, ahead 18) |
| 2 | CC `just test-unit` @ current HEAD `7346655f` | 0 | **641 pass / 0 fail** (129 git-sort + 512 utils/services) |
| 3 | CC installed-VSIX proof log sanity (`logs/…-1781441424565-legacy.json`) | — | `mode=live`, `loaded_from_vsix=true`, `devpath_used=false`, `installed_version=0.6.0-rc.60`, **errors=0 / skips=0 / forbidden=0**, both expected ids present, 3/3 action probes passed |
| 4 | CC VSIX present | — | `releases/command-central-0.6.0-rc.60.vsix` (~273KB, within budget) |
| 5 | Ghostty `just release-proof --json` (durable) | 0 | `proof_mode=durable verdict=pass`; 6/6 rows pass; the 6 `handoff_present` are advisory WARN `handoff_external_not_durable`; `gate_receipt_linked=pass` |
| 6 | Ghostty committed receipt tracked + `test/.timings` gitignored | — | `release/receipts/20260614T132421Z.jsonl` tracked; `test/.timings/` confirmed gitignored (no gitignored-as-committed deception) |

> Note: I did **not** re-run `just release-live-proof` (it mutates nothing but exercises live attachment); the team-checks and portability receipts already record it GATE_PASS on-node today, and item 3 above is the live CC-side proof. Re-running it is the recommended **pre-cut** step (§9), owned by the human/cut lane.

---

## 3. No active blocker lanes for the RC (registry confirmation)

Registry: `~/.config/ghostty-launcher/tasks.json` — 152 rows. Status breakdown: **134 completed**, 11 null-status (legacy/no-status rows), 2 failed, 2 running, 1 completed_dirty, 1 completed_stale, 1 contract_failure. Every non-`completed` row, classified:

| Row | Status | Project | Blocker for RC? | Why |
|---|---|---|---|---|
| `cc-ghostty-final-integration-audit-20260614` | running | command-central | No | **This audit lane.** |
| `cc-next-rc-final-gate-20260614` | running | command-central | No | Sibling **live RC closeout lane** running concurrently. Not stuck; not a blocker — it *is* the closeout. No RESULT artifact yet (still running). |
| `ghostty-review-routing-fix-20260613` | contract_failure | ghostty-launcher | **No — stale label** | Row carries `exit_code:0`, `end_commit aeb7a409`, `failure_reason:missing_handoff`. The handoff was **backfilled** (`research/RESULT-ghostty-review-routing-fix-20260613.md`, 6218B, present) and the **code defect is fixed** by landed commits `2a1699de`/`ca60d5a9`/`03788085`. The `aeb7a409` patch itself was reviewed and **accepted**. The registry status was simply never advanced. |
| `review-ghostty-review-routing-fixup-20260613` | completed_stale | ghostty-launcher | No | Auto-review affinity lane for the above; superseded by the landed fixup. Historical. |
| `config-parity-blocker-20260613` | completed_dirty | **config** | No — different project | Project `config`, not CC/Ghostty. `dirty_reason:baseline_preserved`, dirty path `claude/settings.json` (intentional baseline preservation), `review_state:pending`. Out of this RC's scope; the word "blocker" is in the lane *name*, not its effect. |
| 2× `failed`, 11× null-status | — | various | No | Pre-RC historical rows; none in the RC manifest or the CC/Ghostty RC slices. |

**Conclusion: zero active blocker lanes gate the RC.**

---

## 4. Lane / pane audit + `/tmp` preservation check (manager requirement)

### 4a. The RC release-proof manifest (`ghostty-launcher/release/RELEASE-EVIDENCE.txt`) — 6 rows

| # | Manifest row | Handoff resolves to | Class | On disk now | Authoritative? |
|---|---|---|---|---|---|
| 1 | `cc-current-running-surface-fix-20260613` | `CC/research/RESULT-cc-current-running-surface-fix-20260613.md` | in CC repo (durable in CC, external to Ghostty) | ✅ 8862B (committed in CC) | Authoritative (intermediate fix, superseded-by-build but committed) |
| 2 | `review-cc-current-running-surface-fix-20260613` | `/tmp/command-central-…-review/research/REVIEW-…md` | **ephemeral `/tmp`** | ⚠️ 2385B (uncommitted, /tmp-only) | Authoritative review (WARNING+NIT) — **at risk** |
| 3 | `cc-agent-status-v2-implementation-20260613` | `CC/research/RESULT-cc-agent-status-v2-implementation-20260613.md` | in CC repo | ✅ 13698B (committed in CC) | Intermediate — **superseded** by recovery (see below) |
| 4 | `review-cc-agent-status-v2-implementation-20260613` | `/tmp/…/REVIEW-…md` | **ephemeral `/tmp`** | ⚠️ 4042B (uncommitted, /tmp-only) | Authoritative review (**BLOCKER**: note misattribution; **WARNING**: V2 not yet wired into render path) — **at risk** |
| 5 | `cc-agent-status-v2-recovery-20260613` | `CC/research/RESULT-cc-agent-status-v2-recovery-20260613.md` | in CC repo | ✅ 9492B (committed in CC) | **Authoritative V2 commit** (= current CC HEAD parent `5f1c9d63`) |
| 6 | `review-cc-agent-status-v2-recovery-20260613` | `/tmp/…/REVIEW-…md` | **ephemeral `/tmp`** | ⚠️ 3310B (uncommitted, /tmp-only) | Authoritative review (**CLEAN — no BLOCKER/WARNING/NIT**) — **at risk** |

The 3 in-repo `RESULT-*.md` are committed in CC (durable from CC's git). The 3 `REVIEW-*.md` are **committed nowhere** (verified `git ls-files` in both repos: no hits) and live only under `/tmp/command-central-*-review/research/`. The durable proof correctly demotes all 6 to advisory WARN `handoff_external_not_durable`, so the gate verdict survives their loss — but the **review verdict content** does not.

### 4b. The supersession story these reviews preserve (why they matter)

The V2 headline feature evolved across two lanes, and the `/tmp` reviews are the only record of *why* the final state is correct:

- **`cc-agent-status-v2-implementation-20260613` (`153f9948`)** — its review raised a **BLOCKER** (completion notes misattributed the file list) and a **WARNING**: the commit added the V2 section *utility* (`src/utils/agent-status-sections.ts`) + its unit test but did **not wire it into the tree render path** ("RC-safe classification layer only … re-bucketing wired into render path separately post-RC M3"). → **This commit alone is NOT a user-visible V2 tree.**
- **`cc-agent-status-v2-recovery-20260613` (`5f1c9d63`, current HEAD parent)** — its review is **fully CLEAN** and verifies the provider now *uses* the V2 model: `formatV2Summary` for root/per-project descriptions, `computeUnifiedSectionCountsForTasks` for counts, `V2_SECTION_HEADERS` for subgroup labels, the Sources provenance reframe — with `bun test … agent-status-v2-sections.test.ts` 8/0.

**The recovery lane is the authoritative V2 commit; the implementation lane is a superseded intermediate.** The CC closeout's GO and this audit both bind to HEAD `5f1c9d63`, which is the clean-reviewed recovery state. Lose the `/tmp` reviews and you lose the evidence that the implementation-lane BLOCKER was resolved rather than shipped.

### 4c. PRESERVATION RECOMMENDATION (do before next reboot / `/tmp` clear)

These 3 files are RC review provenance, exist only in `/tmp`, and are committed nowhere. Recommend a tiny dedicated preservation lane (working tree untouched by *this* audit per review mode):

```
# copy the 3 ephemeral REVIEW verdicts into committed CC research/ (or ghostty release/handoffs/)
cp /tmp/command-central-cc-current-running-surface-fix-20260613-review/research/REVIEW-cc-current-running-surface-fix-20260613.md \
   /Users/ostehost/projects/command-central/research/REVIEW-cc-current-running-surface-fix-20260613.md
cp /tmp/command-central-cc-agent-status-v2-implementation-20260613-review/research/REVIEW-cc-agent-status-v2-implementation-20260613.md \
   /Users/ostehost/projects/command-central/research/REVIEW-cc-agent-status-v2-implementation-20260613.md
cp /tmp/command-central-cc-agent-status-v2-recovery-20260613-review/research/REVIEW-cc-agent-status-v2-recovery-20260613.md \
   /Users/ostehost/projects/command-central/research/REVIEW-cc-agent-status-v2-recovery-20260613.md
# then commit in CC as docs(research): preserve RC review verdicts; optionally repoint the
# ghostty manifest's 3 review rows at the in-repo copies to make them durable from git.
```

This is **not a blocker for an immediate same-node cut** (the files are present now and the durable verdict does not depend on them), but it **is** required to keep the RC's review trail durable. The Ghostty team-checks receipt already flagged the same item as P0/P1 (§5); preserving the content also lets the manifest's 3 review rows become genuinely in-repo durable.

> Scope note on the broader `/tmp` review trees: there are ~24 `/tmp/command-central-*-review/` worktree checkouts from earlier RC rounds (cc-001…cc-004, lane-registry, project-ref, worksystem-projection, blackbox, etc.) and many `canonical-project-test-…-worktree-*` test dirs. Those earlier rounds' **RESULT** receipts are already committed in CC `research/`; their lanes are **historical/superseded** by the V2 work. Only the **3 manifest-referenced REVIEW files above** are both RC-relevant and uncommitted. I did not find other RC-critical `/tmp`-only artifacts.

---

## 5. What is RC-ready vs same-node-only vs live-time-bound

| Class | Items | Reproducible where |
|---|---|---|
| **Ready — machine-portable / durable from git** | CC product code + tests (641 unit, 461 tree-view), CC committed `RESULT-*` receipts, Ghostty gate code + 122 assertions, Ghostty committed receipt, durable `release-proof` **verdict** | any fresh clone (code/tests) / across worktrees on this node (durable verdict) |
| **Same-node-only** | `row_exists` / `standard_fields` (read node-local `~/.config/ghostty-launcher/tasks.json`, not committed); installed-VSIX live proof (needs installed `0.6.0-rc.60` + live launcher rows); the 3 EXTERNAL `/tmp` review handoffs | this node, while CC checked out + `/tmp` persists |
| **Live / time-bound** | `capture_resolves` / `focus_resolves` (real tmux attachment); the operator-attested verified-visibility receipt | the live node at cut time (advisory in durable, required in live) |

The durable verdict is reproducible **across worktrees on this node**; it is **not** fresh-machine reproducible because the registry is node-local. That is now stated honestly in `RELEASE-EVIDENCE.txt` and the GO doc banner — not implied.

---

## 6. Obsolete-code guard (manager requirement) — each forbidden pattern checked

| Forbidden pattern | Verdict | Evidence |
|---|---|---|
| **Fake launcher rows / synthetic running state** | ✅ clean | The CC proof's `installed-proof-legacy-alpha/beta` are clearly-labeled **passive sentinel fixtures** for backend-render coverage; the action probes bind to a **real** row via `COMMAND_CENTRAL_REQUIRED_TASK_ID`. No synthetic *running* state is presented as authoritative. Do **not** promote the sentinels beyond test fixtures. |
| **OpenClaw subagents disguised as launched-terminal rows** | ✅ clean | Manifest is 6 launcher `cc-*` / `review-cc-*` tasks; zero OpenClaw IDs (team-checks §3.3). OpenClaw stays a **deferred follow-up source/provenance** integration (CC closeout §8), not forced through launcher row semantics. |
| **Release-proof treating ephemeral tmux attachment as durable evidence** | ✅ clean (this was the fix) | Durable mode demotes `capture_resolves`/`focus_resolves` to advisory WARN; only live mode hard-FAILs on missing attachment. Locked by hermetic Test 5d. Do **not** revert to the pre-split behavior. |
| **DOM scraping / non-native VS Code UI inspection** | ✅ clean | CC proof log shows `command_central_loaded_from_vsix=true`, `is_extension_development_path_used_for_cc=false`, and records `agent_status_tree_snapshot` / `source_authority_matrix` / `action_probe_results` — i.e. native **TreeDataProvider + command** surface against the **installed VSIX**, not DOM. |
| **Gitignored/hidden timing receipts presented as committed proof** | ✅ clean | `release/receipts/20260614T132421Z.jsonl` is **tracked**; `test/.timings/` is **gitignored**. README honestly states the committed receipt is a **gate-self-test** run (P2 caveat), not the six lanes' suite receipt — so it is not over-read. |

**Do NOT integrate any earlier approach superseded by these rounds**, specifically: the pre-split release-gate that hard-FAILed on tmux attachment; the external `/tmp/oste-path-init-<task>.sh` source pattern (replaced by inline PATH-init); or the V2 implementation-lane's "utility only / not wired" intermediate state (superseded by the recovery lane that wired it in).

---

## 7. Native integration rule — confirmed on all three seams

- **CC = native VS Code extension APIs + proof harness.** Installed-VSIX TreeDataProvider/commands/context-menu surface; proof binds to the real installed `0.6.0-rc.60`, `devpath=false`. ✅
- **Ghostty = native launcher registry / LaneRef / tmux / receipt contracts.** Real `tasks.json` rows; `project_ref` + `project_id` + `lane_kind` (LaneRef); tmux session + Ghostty `app_bundle`/`guard_id` metadata; handoff + receipt contracts; explicit durable-vs-live modes; no faked attachment. ✅
- **OpenClaw = follow-up source/provenance only, NOT this RC.** The Work-System bridge already carries `origin_host`/`writer_host` provenance, so the seam is ready for a future first-class OpenClaw source without disguising subagents as launcher rows. Keep deferred. ✅

---

## 8. Tier-2 / NOT-authorized actions that remain (require explicit approval)

None performed this lane. Still outstanding and **not authorized**:

1. `git push` — **CC** (`main` ahead 17) and **Ghostty** (`main` ahead 18). Both unpushed.
2. `git tag` / version bump beyond the current `0.6.0-rc.60`.
3. VSIX **publish** / marketplace push.
4. Any external write (no remote, no API, no cross-machine sync).
5. `--no-verify` on any commit/push.

No push/tag/publish/external write may proceed without Mike's explicit go-ahead.

---

## 9. Final recommendation

**Safe to keep for the RC (authoritative):**
- CC: the full 17-commit stack to HEAD `7346655f`; the **authoritative V2 commit is the recovery `5f1c9d63`** (clean review), with `153f9948` retained only as the build-up intermediate. Installed `0.6.0-rc.60` VSIX + its live proof log. Committed `RESULT-cc-{current-running-surface-fix,agent-status-v2-implementation,agent-status-v2-recovery}-20260613.md`.
- Ghostty: the full 18-commit stack to HEAD `fb5a26bf`; durable `release-proof` + live `release-live-proof`; the **post-split + post-honesty-fixup** gate (`a0d28d67` → `6d08c273`) and the spawn-robustness cluster (`2a1699de`/`ca60d5a9`/`03788085`). Committed receipt `release/receipts/20260614T132421Z.jsonl` (as a gate-self-test receipt, per its README).

**Historical only (do not re-integrate as current best practice):**
- The `ghostty-review-routing-fix-20260613` `contract_failure` registry row (stale; resolved by landed fixups).
- The V2 implementation lane's "classification-layer-only / not-wired" intermediate state (superseded by recovery).
- The pre-split release-gate behavior (tmux-attachment-as-durable) and the external `/tmp` PATH-init source pattern.
- Earlier RC rounds' `/tmp` review worktrees (cc-001…cc-004, lane-registry, project-ref, worksystem-projection, blackbox) — their committed RESULT receipts stand; the lanes are superseded.

**Recommended next command lanes, in order:**
1. **Preservation lane (time-sensitive, do before reboot):** copy the 3 `/tmp` REVIEW verdicts into committed `research/` (§4c) and commit as `docs(research)`; optionally repoint the Ghostty manifest's 3 review rows at the in-repo copies to make them durable from git. *Not a same-node-cut blocker, but the only way to keep the RC review trail.*
2. **Pre-cut live confirmation:** run `just release-live-proof` on this node immediately before any cut (live visibility + on-node handoff presence).
3. **Cut/ship:** let the already-running sibling lane `cc-next-rc-final-gate-20260614` finish; on its GO, the human-authorized push/tag/publish (§8) is the only remaining step.
4. **Quality follow-ups (not blockers):** wire `just release-proof` (durable, CI-safe) into a release-tag CI job; tighten `focus_resolves` vacuity for future non-tmux rows; promote a real lane/full-suite receipt; the deferred **OpenClaw subagent surfacing** follow-up.

**Bottom line: 🟢 GO for a local, same-node, human-driven RC cut at current HEAD.** The integration is native and lasting on all three seams, no active blockers remain, and the obsolete-code guard is clean. The single time-sensitive caveat is preserving the 3 `/tmp` review verdicts before they are lost; off-node/CI reproducibility is a documented, accepted limitation, not a defect.

---

## 10. Repo state at handoff (review mode — unchanged)

| | CC | Ghostty |
|---|---|---|
| HEAD | `7346655f` | `fb5a26bf` |
| Ahead of origin | 17 (unpushed) | 18 (unpushed) |
| Working tree | clean | clean |
| This audit's edits | **none** (review mode; only this handoff written) | **none** |

Handoff: `research/RESULT-cc-ghostty-final-integration-audit-20260614.md`. No push/tag/publish/external write performed. No launcher rows synthesized, no tmux attachment faked, no task/lane history deleted.
