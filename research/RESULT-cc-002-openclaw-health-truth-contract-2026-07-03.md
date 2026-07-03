# RESULT — CC-002 / PAR-152: Define OpenClaw health truth contract for Command Central

- **Task ID:** `symphony-PAR-152-a6ee5f41`
- **Linear:** [PAR-152](https://linear.app/partnerai/issue/PAR-152/cc-002-define-openclaw-health-truth-contract-for-command-central) / CC-002 — "Define OpenClaw health truth contract for Command Central"
- **Parent:** PAR-149 / CC-000 · **Depends on (done):** PAR-38 / CC-001 (evidence-weighted five-state model)
- **Date:** 2026-07-03
- **Machine:** Mike's MacBook Pro (`ostehost`) — `/Users/ostehost/projects/command-central` @ branch `main`
- **Start HEAD:** `5c997fe8` (clean tree)
- **Kind:** contract-ratification closeout — the deliverable of this item is a
  *contract definition*, which already exists as
  `research/CONTRACT-DECISION-openclaw-health-truth-2026-06-23.md`, and the code
  baseline it ratifies is already on `main`. No `RESULT-*` receipt had been filed
  for PAR-152, so every other CC child carries one but this one did not. This file
  is that missing receipt: it verifies the ratified contract still agrees with the
  current tree and records fresh verification evidence dated to closeout.
- **Verdict:** **met.** The contract is defined and canonical; the code baseline
  implements it 1:1; verification is green on the current tree.
- **Scope / hard-stop:** docs-only. No source, tests, config, `tasks.json`,
  launcher, or Symphony/OpenClaw state touched. No push / tag / publish / release /
  version bump. No Linear mutation — tracker state is recorded as a follow-up.

---

## What the contract defines (canonical doc)

`research/CONTRACT-DECISION-openclaw-health-truth-2026-06-23.md` is the canonical
health-truth contract. It answers the three questions the CC-001 bug-fix receipt
(`RESULT-cc-001-openclaw-down-health-20260611.md`) deliberately did **not**:
what the independent dimensions of "OpenClaw is healthy" are, how each maps to a
displayed state, and how they take precedence when they disagree.

- **8 truth-source dimensions** enumerated (gateway process status, API
  reachability + readiness, authorization, channel health, snapshot freshness,
  TaskFlow/task-service availability, node connectivity scope, launcher execution),
  each with its evidence source and whether the baseline models it today.
- **6 display states** (`ok | warn | degraded | stale | down | auth-failed`) with a
  ratified precedence: auth-failed outranks everything; gateway-up derives from
  fresh summary severity; a live task layer or fresh corroborating summary holds a
  failed probe at DEGRADED; DOWN is reserved for unreachable/not-ready with no fresh
  evidence of life.
- **The one dimension CC-001 did not model — authorization** — is added as an
  explicit `auth-failed` state: a 401/403 proves the process is up but our
  credentials are rejected, so it must route operators to *re-auth*, not *restart*,
  and must bypass the transient-blip retry.
- **Scope decisions** ratified: auth-failed in scope + implemented; node
  connectivity scope modeled, deep node↔hub link-liveness deferred (no local
  evidence source, needs a two-machine topology this environment can't stage);
  launcher-execution health deferred to its owning surface.

## Code baseline ↔ contract cross-check (verified on current tree)

Every claim the contract makes about the implementation was re-verified against
`5c997fe8`, not taken on trust:

| Contract claim | Location verified | Status |
| --- | --- | --- |
| `DisplayState` includes `"auth-failed"` (six states) | `infrastructure-health-status-bar.ts:20-26` | ✓ |
| `GatewayReadiness.authFailed` carries dimension 3 | `infrastructure-health-status-bar.ts:36-48` | ✓ |
| `probeReadyzOnce` maps 401/403 → `reachable:true, authFailed:true` | `infrastructure-health-status-bar.ts:519-527` | ✓ |
| Auth rejection **bypasses** the reachability retry (returns `reachable:true`, so `readGatewayReadiness` does not re-probe) | `infrastructure-health-status-bar.ts:494-501` | ✓ |
| `resolveDisplayState` gives `auth-failed` top precedence | `infrastructure-health-status-bar.ts:461` | ✓ |
| `applyState` renders `$(key) OpenClaw AUTH` (+ `(hub)` scope suffix) on error background | `infrastructure-health-status-bar.ts:412-413` | ✓ |
| `formatGatewayLine` surfaces `reachable, auth rejected (HTTP 40x)` | `infrastructure-health-status-bar.ts:126-140` | ✓ |
| Dimension 7 (scope) resolver from `~/.openclaw/openclaw.json` | `src/utils/openclaw-gateway-health.ts:54` (`resolveGatewayHealthSource`) | ✓ |
| Dimension 6 (task-service) wiring via `countAgentStatuses` | `src/extension.ts:617` (`taskActivityProbe`) | ✓ |
| Auth-failed precedence/label/no-retry regression tests | `test/services/infrastructure-health-status-bar.test.ts:152,181,208` | ✓ |

The `formatGatewayLine` text and `probeReadyzOnce` error string agree with the
tests' exact assertions (`Gateway: reachable, auth rejected (HTTP 401)` and
`Gateway (hub): reachable, auth rejected (HTTP 403)`).

## Verification (fresh, this closeout)

| Command | Result |
| --- | --- |
| `bun test test/services/infrastructure-health-status-bar.test.ts` | **24 pass / 0 fail** (74 expect calls) — includes the 3 auth-failed regression tests: AUTH-not-DOWN on 401, 403 outranks a healthy task layer, and auth rejection does not retry |
| `just test-unit` | **788 pass / 0 fail** (git-sort 138 + utils/services 650) |
| `just check` (biome CI + tsc + knip) | **clean** — 338 files checked, no fixes; only the two pre-existing informational knip config hints (`*.fixture.ts` / `*.legacy.ts`) |

## Not produced here (needs live infrastructure — honest limits)

Unchanged from the contract's own "Not produced here" section, and consistent with
the CC-001 forced-`DOWN` limit:

- A **live auth-failure smoke** against a real gateway returning 401/403. The exact
  text/background/tooltip mapping is pinned by the unit state matrix through the
  vscode mock; a live host returning 401 cannot be staged without breaking real hub
  auth.
- A **two-machine hub+node link-liveness** smoke for the deferred deep node
  connectivity dimension (contract Decision 2). No local evidence source exists and
  the topology cannot be staged in this environment; `/readyz` reachability already
  covers "can this node reach the hub gateway" for the status bar's purpose.
- **Launcher-execution health** (contract Decision 3) is deferred by design to the
  launcher surface / Agent Status tree; this contract does not claim to render it.

## Hard-stop compliance

No push, no tags, no Marketplace/GitHub release, no version bump, no `--no-verify`.
Ghostty Launcher untouched (no launcher dependency in this docs-only closeout). No
Linear or tracker mutation. Tracked tree clean after the commit adding this receipt.

## Follow-ups (out of scope here, owed to human/orchestrator)

- Flip **PAR-152** Todo → Done in Linear, linking this receipt and the canonical
  `CONTRACT-DECISION-openclaw-health-truth-2026-06-23.md` as the contract artifact.
- If/when a two-machine hub+node topology is available, stage the deferred
  node↔hub link-liveness smoke and the live 401/403 auth smoke to convert the two
  honest limits above into live evidence.
