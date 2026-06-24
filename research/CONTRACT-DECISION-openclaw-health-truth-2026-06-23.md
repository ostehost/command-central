# Contract Decision: OpenClaw Health Truth Contract for Command Central

- **Linear:** PAR-152 / CC-002 — "Define OpenClaw health truth contract for Command Central"
- **Parent:** PAR-149
- **Depends on (done):** PAR-38 / CC-001 (evidence-weighted five-state model)
- **Date:** 2026-06-23
- **Classification:** contract decision required

Classification: contract decision (ratified same-day, code baseline already on
`main`).

## Why this document exists

CC-001 / PAR-38 shipped an evidence-weighted health state machine in
`src/services/infrastructure-health-status-bar.ts`
(`ok | warn | degraded | stale | down`) and documented it as a *bug-fix
receipt* in `research/RESULT-cc-001-openclaw-down-health-20260611.md`. That
receipt explains how a single transient probe failure stopped collapsing into
a false `DOWN`. It does **not** define the cross-dimension *contract*: what
the distinct dimensions of "OpenClaw is healthy" are, how each maps to a
displayed state, and how they take precedence over one another. PAR-152 is
that contract. It also requires one dimension the bug-fix did not model: an
**auth-failed** signal distinct from an outage.

This document is the canonical health-truth contract. The implemented baseline
it ratifies is `infrastructure-health-status-bar.ts` plus the gateway-scope
resolver `src/utils/openclaw-gateway-health.ts`.

## Decision surface

"OpenClaw health" is not one boolean. Command Central renders a single
glanceable status-bar item, but that item summarizes several independent truth
sources that can disagree. Without a contract, any failure tends to collapse
into the most alarming state (the CC-001 false-`DOWN` bug), and a genuinely
distinct failure mode (credentials rejected) is indistinguishable from an
outage even though the operator fix is completely different (re-auth, not
restart).

## The health dimensions (truth sources)

Each dimension is an independent signal with its own evidence source. The
contract names them, fixes their source, and states whether the implemented
baseline models them today.

| # | Dimension | Truth source | Evidence read | Modeled today |
|---|-----------|--------------|---------------|---------------|
| 1 | **Gateway process status** | Is the gateway process answering at all? | `GET /readyz` reachability (network-level success/failure), one retry on a network-level failure | Yes — `GatewayReadiness.reachable`, retried in `readGatewayReadiness` |
| 2 | **API reachability + readiness** | Does the gateway report itself ready? | `/readyz` body `ready` + `failing[]`, or HTTP 200 fallback | Yes — `GatewayReadiness.ready` / `failing` |
| 3 | **Authorization** | Are *our* credentials accepted? | `/readyz` HTTP **401/403** → reachable but rejected | Yes (new in PAR-152) — `GatewayReadiness.authFailed` |
| 4 | **Channel health** | Are the messaging channels healthy? | dashboard `health-summary.json` `overall.severity` + per-channel `discord` / `bluebubbles` | Yes — `HealthSummaryInfo`, gated by freshness |
| 5 | **Snapshot freshness** | Is the canonical summary recent enough to trust? | `health-summary.json` `generatedAt` vs. `summaryFreshnessMs` (10m default) | Yes — `summaryStale`, drives `STALE` |
| 6 | **TaskFlow / task-service availability** | Is the task layer alive (agents actually working)? | `taskActivityProbe()` → working count + summary, wired in `extension.ts` to the same `countAgentStatuses` data the AgentStatusBar renders | Yes — `TaskServiceActivity` |
| 7 | **Node connectivity** | Is this machine probing the right gateway (hub vs. local)? | `resolveGatewayHealthSource` reads `gateway.mode` / `gateway.remote.url` from `~/.openclaw/openclaw.json`; remote scope labels state `(hub)` | Partial — scope/label modeled; node↔hub link liveness as a *separate* dimension deferred (see below) |
| 8 | **Launcher execution** | Can the bundled launcher actually start sessions? | Ghostty Launcher runtime | **Not modeled in this item.** Deferred (see scope decision) |

## Display-state contract (precedence)

The status-bar item collapses the dimensions above into one of **six** display
states. Precedence runs top to bottom; the first matching rule wins. This is
the ratified ordering implemented in `resolveDisplayState`.

1. **`AUTH-FAILED`** (`$(key) OpenClaw AUTH`, error background) — dimension 3
   fired (401/403). Outranks everything else: a healthy task layer or fresh
   summary cannot mask the fact that our *view* of gateway health is locked
   out, and the fix is an operator re-auth, not a restart. **Not transient** —
   bypasses the reachability retry.
2. **Gateway up (reachable + ready):**
   - fresh `critical` summary → `DEGRADED` (the gateway is demonstrably up, so
     a channel outage is partial, never `DOWN`)
   - stale `critical` summary → `STALE`
   - fresh `warn` summary → `WARN`; stale `warn` → `STALE`
   - otherwise → `OK`
3. **Gateway not up, but task layer alive** (dimension 6, `workingCount > 0`) →
   `DEGRADED`. Running agents prove partial life; a failed probe is at most a
   partial outage.
4. **Gateway not up, no working tasks, but a *fresh* `ok`/`warn` summary** →
   `DEGRADED`. Fresh corroborating life from the channel dimension.
5. **Otherwise** → `DOWN`. Reserved for: gateway unreachable/not-ready AND no
   fresh evidence of life from any other dimension.

### Why AUTH-FAILED is a top-level state, not a flavour of DOWN

`DOWN` says "restart / investigate the gateway". `AUTH-FAILED` says "the
gateway is fine; *you* are locked out — re-authenticate." Collapsing the two
would send operators to the wrong runbook. A 401/403 also proves the process
is up and the HTTP API answered, so it is categorically *not* an outage. It is
also not transient, so unlike a network blip it must not trigger the retry that
absorbs reachability flaps.

## Scope decisions

### Decision 1 — auth-failed is in scope and now implemented

Add an explicit `auth-failed` `DisplayState`, detect HTTP 401/403 in
`probeReadyzOnce`, surface it as `reachable: true, authFailed: true`, and give
it top precedence in `resolveDisplayState`. Render `$(key) OpenClaw AUTH` on
the error background with tooltip `Gateway: reachable, auth rejected (HTTP
40x)` and `Status bar state: AUTH-FAILED`. **Ratified and implemented** in this
change.

### Decision 2 — node connectivity is partially modeled; deep link-liveness deferred

The *scope* half of node connectivity (am I a node probing the hub? is the
state about the hub or a local gateway?) is modeled and shipped:
`resolveGatewayHealthSource` resolves the probe target from
`~/.openclaw/openclaw.json` and remote scope labels the state `(hub)` so an
`OK`/`DOWN`/`AUTH` reading is never read as a claim about a non-existent local
gateway. A *deeper* node↔hub link-liveness dimension (e.g. websocket session
up/down independent of `/readyz`) is **deferred**: it has no local evidence
source today and asserting it needs a live two-machine hub+node topology that
this environment cannot stage. The `/readyz` reachability dimension already
covers "can this node reach the hub gateway" for the status bar's purpose.

### Decision 3 — launcher execution stays out of this item

Launcher execution health (can Ghostty Launcher actually start a session) is a
real dimension of "OpenClaw works end to end", but it belongs to the launcher
surface and the Agent Status tree, not the gateway-health status-bar item.
Modeling it here would couple two surfaces and require live launcher
invocation. It is enumerated above for completeness and **deferred** to its
owning surface; this contract does not claim to render it.

## Implemented baseline (what this contract ratifies)

- `src/services/infrastructure-health-status-bar.ts`
  - `DisplayState` now includes `"auth-failed"`.
  - `GatewayReadiness.authFailed` carries dimension 3.
  - `probeReadyzOnce` maps 401/403 → `reachable: true, authFailed: true`.
  - `resolveDisplayState` gives `auth-failed` top precedence.
  - `applyState` renders `$(key) OpenClaw AUTH` (+ `(hub)` suffix on remote
    scope) on the error background.
  - `formatGatewayLine` surfaces `reachable, auth rejected (HTTP 40x)`.
- `src/utils/openclaw-gateway-health.ts` — dimension 7 (scope) resolver,
  unchanged by this change.
- `src/extension.ts` — `taskActivityProbe` wiring for dimension 6, unchanged.
- `test/services/infrastructure-health-status-bar.test.ts` — adds the
  auth-failed precedence/label/no-retry regression tests alongside the existing
  CC-001 state-matrix tests.
- Baseline narrative: `research/RESULT-cc-001-openclaw-down-health-20260611.md`
  (the five-state evidence model this contract extends to six).

## Not produced here (needs live infrastructure)

- A **live auth-failure smoke** against a real gateway returning 401/403. The
  mapping is pinned by the unit state matrix (exact text/background/tooltip via
  the vscode mock); a live host returning 401 cannot be staged without breaking
  real hub auth, the same honest limit recorded for forced-`DOWN` in CC-001.
- A **two-machine hub+node link-liveness** smoke for the deferred deep node
  connectivity dimension (Decision 2).

## Ratified

- Date: 2026-06-23
- Surface: Command Central OpenClaw infrastructure health status bar
- States: `ok | warn | degraded | stale | down | auth-failed`
- Precedence: as enumerated under "Display-state contract" above
