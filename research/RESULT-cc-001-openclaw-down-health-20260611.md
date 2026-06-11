# RESULT — CC-001 / PAR-38: Fix false or stale "OpenClaw DOWN" indicator

- **Task ID:** `cc-001-openclaw-down-health-20260611`
- **Linear:** PAR-38 / CC-001
- **Date:** 2026-06-11
- **Host:** Mike MacBook Pro node
- **Start HEAD:** `8a51be56ffb0a8dd88107b65f570f79d470f1013` (clean tree; newer than the issue's `257aadc4` because rc54 dogfood work continued — implemented on current `main` as instructed, no reset/rewind)
- **Fix commit:** `e83386caeaf780facc25e5c81922acdf8d4b75b2` — `fix(health): stop collapsing partial OpenClaw health into a false DOWN`
- **Final HEAD:** the `docs(research)` commit adding this receipt, directly on top of `e83386ca`

## Reproduction / explanation

The red `OpenClaw DOWN` text comes from `InfrastructureHealthStatusBar`
(`src/services/infrastructure-health-status-bar.ts`), which is driven by two
inputs only: a single HTTP GET to the gateway `/readyz` endpoint (2.5s
timeout, 30s poll) and the dashboard `health-summary.json` snapshot. The
`1 working · 3 done` text comes from a *different* status bar item
(`AgentStatusBar`, `src/services/agent-status-bar.ts`) fed by the Agent
Status tree (launcher tasks.json + OpenClaw task service + discovery). The
two items shared no evidence, so they could contradict each other by
construction.

On this node the probe targets the hub over the network
(`gateway.mode: "remote"` in `~/.openclaw/openclaw.json` →
`https://gateway.partnerai.dev/readyz`). Verified live during this task: the
hub answers `{"ready":true}` and `health-summary.json` does not exist on
nodes (it lives on the hub), so the node's health state hinged entirely on
one unretried 2.5s network probe from a frequently saturated machine. One
timed-out probe → red `OpenClaw DOWN (hub)` for ≥30s while agents kept
working — exactly the reported contradiction. The DOWN wasn't reproducible
live at fix time (hub currently healthy); the failure mode is fully
explained by the source composition above and is now covered by tests.

## Root cause

`resolveDisplayState` collapsed three distinct conditions into `down`:

1. **Single unretried probe failure** — any `!reachable || !ready` reading,
   including a transient timeout/DNS blip, immediately rendered full-outage
   red with no retry and no corroboration.
2. **Stale snapshot trusted forever** — `overallSeverity: "critical"` forced
   DOWN regardless of `generatedAt` age; a stale critical could pin the bar
   red while everything was healthy (the "stale cache" half of the bug).
3. **Task-service blindness** — the health model never consulted the task
   layer, so live working agents could not contradict a failed probe.

## Fix

Evidence-weighted five-state model: `ok | warn | degraded | stale | down`.

- **Probe retry:** one immediate retry on network-level failure before the
  reading is believed (a reachable answer is authoritative either way).
- **Task-service evidence:** new `taskActivityProbe` option, wired in
  `extension.ts` to the same `countAgentStatuses`/`formatCountSummary` data
  the AgentStatusBar renders. Working tasks hold a failed gateway probe at
  `DEGRADED` (yellow, `$(warning) OpenClaw DEGRADED (hub)`) with tooltip
  line `Task service: alive — 1 working · 3 done`. The two status bar items
  can no longer contradict each other.
- **Snapshot freshness:** summaries older than 10 minutes (configurable
  `summaryFreshnessMs`) stop driving state. Gateway-ready + stale negative
  snapshot renders `STALE` (`$(history)`, yellow) with snapshot age in the
  tooltip ("stale — 2h old, not trusted for state").
- **Partial ≠ down:** gateway-ready + *fresh* critical summary is now
  `DEGRADED` (the gateway is demonstrably up), and gateway-failing + fresh
  ok/warn summary is `DEGRADED`. `DOWN` is reserved for: gateway
  unreachable/not-ready AND no fresh evidence of life from any channel.
- **Tooltip:** adds the task-service liveness line and snapshot staleness
  annotation; keeps gateway provenance (hub/local scope labels unchanged).

## Files changed

- `src/services/infrastructure-health-status-bar.ts` — five-state model,
  probe retry, summary freshness, task-activity channel, tooltip additions,
  `getStatusText()` accessor for the test API
- `src/extension.ts` — wires `taskActivityProbe` from the agent status
  provider; hoists the bar to module scope for the integration-test API
- `src/services/integration-test-api.ts` — exposes
  `infrastructureHealthStatusText` in the snapshot
- `test/services/infrastructure-health-status-bar.test.ts` — 9 new tests
  (17 total) covering the state matrix
- `test/integration/suite/infrastructure-health.test.ts` — new real-VS-Code
  scenario asserting the rendered status bar text
- `test/integration/suite/helpers.ts`, `test/integration/suite/index.ts` —
  scenario registration and snapshot interface mirror

## Tests run

| Command | Result |
| --- | --- |
| `bun test test/services/infrastructure-health-status-bar.test.ts` | 17 pass / 0 fail (covers down, degraded-while-tasks-working, degraded-fresh-summary-vs-failed-probe, stale-critical, degraded-not-down-on-fresh-critical, stale-ok-stays-OK, stale+unreachable+idle→DOWN, probe retry, throwing probe) |
| `just test-unit` | 459 pass / 0 fail |
| `just test` (full, incl. typecheck + quality gates) | 1929 pass / 0 fail (1930 ran; tmux sock messages are pre-existing environmental noise) |
| `just check` (biome + tsc + knip) | clean |
| `just test-electron` (real VS Code extension host) | 6/6 scenarios pass, exit 0 |

## UI / extension-host proof

`just test-electron` launches real VS Code (1.124.0, darwin-arm64) with the
built extension and runs the new `infrastructure health status bar`
scenario, which polls the integration-test API until the item settles and
asserts the rendered text matches the five-state machine. On this node it
rendered:

```
  rendered: $(pulse) OpenClaw OK (hub)
✓ infrastructure health status bar (503ms)
```

That exercises the full corrected pipeline in a live extension host: config
resolution from `~/.openclaw/openclaw.json` → remote (hub) scope → real
readyz probe with retry → evidence-weighted state → rendered status bar
text. A DOWN/DEGRADED render can't be forced in the live host without
breaking the real hub, so those renderings are proven at the unit layer,
which asserts the exact `statusBarItem.text`/background/tooltip through the
vscode mock. No GUI screenshot blocker beyond that; the integration proof
is the honest closest equivalent.

## Remaining risks

- **State propagation latency:** the bar reads task activity at its own
  refresh (30s poll); a DOWN→DEGRADED flip after tasks start can lag up to
  30s. Acceptable for a glanceable indicator; could subscribe to tree
  changes later if it matters.
- **Freshness TTL is a heuristic:** 10 minutes for `health-summary.json`
  was chosen conservatively; if the hub generator runs much less often,
  fresh-but-slow summaries would render STALE. Configurable via
  `summaryFreshnessMs` if dogfood shows the wrong cadence.
- **DEGRADED is deliberately yellow even for fresh-critical summaries** —
  severity detail lives in the tooltip. If dogfood wants red for
  channel-critical-while-gateway-up, that's a one-line render change.
- **Working launcher tasks (non-OpenClaw agents) also count as task
  activity.** That matches the reported contradiction (the agent bar counts
  the same tasks), but it means purely-local agent work holds the bar at
  DEGRADED during a genuine hub outage — arguably correct ("partial: your
  agents are fine, hub unreachable"), noted for awareness.
- Pre-existing, out of scope: `GatewayExplicitAuthRequiredError` noise from
  the OpenClaw CLI during activation in the test host, and the tmux sock
  messages in the unit suite.

## Hard-stop compliance

No push, no tags, no Marketplace/GitHub release actions, no `--no-verify`.
Ghostty Launcher untouched (bug was entirely in Command Central health
composition). Tracked tree clean after commits.

---

# Follow-up — CC-001 iteration (`cc-001-health-followup-20260611`)

- **Date:** 2026-06-11 (same day, second iteration)
- **Start HEAD:** `ed3b2f44` (clean tree)
- **Fix commit:** `ceca1a97` — `fix(health): re-read task activity on tree
  changes to close the 30s contradiction window`

## Manager feedback addressed

1. **30s contradiction window** — the initial fix read task activity only on
   the health item's own 30s poll, while AgentStatusBar updates on every
   `onDidChangeTreeData`. The false-looking pairing could still render
   transiently (working counts change now, health bar catches up a poll
   later). **Fixed this iteration.**
2. **Extension-host proof too weak** — the live scenario only proved the item
   settles into *some* five-state label, not the corrected behavior under
   task-service-alive evidence. **Strengthened this iteration.**
3. **`.oste-report.yaml` absence at review time** — the file is listed in
   `.gitignore` (line 88) and the harness contract marks it "ephemeral; not a
   lifecycle signal or committed deliverable", consumed by the launcher
   finalizer after process exit. Its absence from the repo at review time is
   the expected end state once the finalizer has ingested it; the pending-
   review receipt carrying the report metadata is the durable copy. Not a
   defect; nothing chased.

## Additional fix

`InfrastructureHealthStatusBar.refreshTaskActivity()`
(`src/services/infrastructure-health-status-bar.ts`): caches the gateway-side
evidence (readiness + summary) of the last completed refresh, and on call
re-reads the `taskActivityProbe` and re-resolves the display state from that
cached evidence. `src/extension.ts` invokes it from the same
`onDidChangeTreeData` handler that updates AgentStatusBar (plus once after
the initial update), so both items re-render from the same provider data in
the same event tick. DOWN→DEGRADED when work appears, and DEGRADED→DOWN when
work drains, are now immediate.

Design choice vs. the suggested "trigger a full refresh, deduped by
refreshPromise": a full refresh re-probes the gateway, and tree-data events
fire every few seconds during active work — on a node that probes the hub
over the network, that turns tree chatter into network chatter (and on a
failing gateway each refresh burns up to ~5s of probe timeouts). Only the
task-activity input changed, so re-resolving from cached gateway evidence is
both immediate and free. The dedupe still matters for the in-flight case:
`refreshTaskActivity()` defers to a refresh in progress, which reads the
latest activity itself when it applies state (covered by test). The
gateway-evidence cadence itself is unchanged (30s poll + retry).

## Files changed (follow-up)

- `src/services/infrastructure-health-status-bar.ts` — evidence cache +
  `refreshTaskActivity()`
- `src/extension.ts` — tree-change wiring; AgentStatusBar hoisted to module
  scope for the test API; deactivate cleanup
- `src/services/agent-status-bar.ts` — `getStatusText()` (undefined while
  hidden) for the integration-test API
- `src/services/integration-test-api.ts`, `test/integration/suite/helpers.ts`
  — `agentStatusBarText` in the snapshot
- `test/integration/runTest.ts` — deterministic `TASKS_FILE` fixture: one
  fresh `running` task (`session_id` required by the registry normalizer;
  `terminal_backend: "applescript"` routes liveness through the
  non-tmux/non-persist branch where a launch-time `started_at` keeps the
  truth hierarchy trusting `running` for the whole run)
- `test/integration/suite/infrastructure-health.test.ts` — pairing proof
  (below)
- `test/services/infrastructure-health-status-bar.test.ts` — 4 new tests
- `test/services/agent-status-bar.test.ts` — 1 new test

## Tests run (follow-up)

| Command | Result |
| --- | --- |
| `bun test test/services/infrastructure-health-status-bar.test.ts test/services/agent-status-bar.test.ts` | 38 pass / 0 fail (new: DOWN→DEGRADED immediate without re-probing; DEGRADED→DOWN immediate on drain; in-flight refresh dedupe reads latest activity; activity change does not disturb gateway-OK; getStatusText visibility) |
| `just test-unit` | 464 pass / 0 fail |
| `just test` (full) | 1935 ran / 0 fail |
| `just check` | clean |
| `just test-electron` | 6/6 scenarios pass, exit 0 |

## Extension-host proof (follow-up)

The electron suite now launches the real VS Code host with a fixture task
registry via `TASKS_FILE`, so the agent count item deterministically renders
a working count from real provider data. The scenario then asserts the
corrected pairing directly: while the agent bar shows ≥1 working, the health
item must not render DOWN — under the corrected state machine a failing
gateway probe is at most DEGRADED, a healthy one OK/WARN/STALE. Rendered
live on this node:

```
  rendered pairing: "$(pulse) OpenClaw OK (hub)" beside "$(pulse) 1 working"
✓ infrastructure health status bar (252ms)
```

Honest limit, unchanged from the first iteration: a *forced* gateway outage
is not staged in the live host — that would require taking the real hub
gateway down. The failed-gateway → DEGRADED-while-working mapping is pinned
by the unit state matrix (exact text/background/tooltip through the vscode
mock); the live host pins that the working-tasks evidence reaches the health
item and forbids DOWN. Together they cover the corrected behavior without
brittle test-only hooks in production code.

## Residual risk (follow-up)

- The first render after activation still waits for the initial gateway
  probe (spinner until then); tree changes during that window are absorbed
  by the in-flight refresh, which reads activity at completion — no
  contradictory render, just initial-probe latency (bounded by the 2.5s
  timeout × retry).
- Gateway-side state changes (probe recovers/fails) still propagate on the
  30s poll; only the task-activity channel is event-driven. That is the
  health item's own domain and not a cross-item contradiction.
- `releases/digest-v0.6.0-rc.54.md` is regenerated by every `bun run build`
  (dist-simple writes it), so it drifts whenever commits land after a cut;
  this run restored it to the cut-time snapshot per repo convention rather
  than committing the drift. Pre-existing behavior, noted for awareness.
