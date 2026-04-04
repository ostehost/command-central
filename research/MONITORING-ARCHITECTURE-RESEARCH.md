# OpenClaw-Native Monitoring Architecture Research

Date: 2026-04-04
Scope: Command Central VS Code extension, `dashboard.partnerai.dev`, and OpenClaw-native monitoring primitives

## Executive Summary

The best architecture is a thin aggregation layer over existing OpenClaw health primitives, not a new monitoring system.

Use OpenClaw itself for:
- Channel self-healing where restart is safe
- Gateway health/readiness probes
- Diagnostics and auth checks via `openclaw doctor`
- Scheduled alert delivery via OpenClaw cron
- Existing watchdog/canary coverage for autonomy-specific failures

Build only one new thing:
- A small deterministic health snapshot exporter that aggregates existing signals into one canonical JSON file

Then consume that same JSON in both places:
- Command Central: status bar + new "Infrastructure Health" tree view
- `dashboard.partnerai.dev`: static JSON polling, matching the current dashboard architecture

This avoids duplicated polling logic, avoids LLM-driven data transformation for routine telemetry, and keeps OpenClaw as the source of truth.

## Research Inputs

Primary sources read:
- `~/.openclaw/openclaw.json`
- `~/.openclaw/cron/jobs.json`
- `~/.openclaw/workspace/scripts/openclaw-health-gate.sh`
- `~/.openclaw/workspace/scripts/openclaw-autonomy-canary.sh`
- `~/.openclaw/workspace/dashboard/ARCHITECTURE.md`
- `~/.openclaw/workspace/dashboard/index.html`
- `~/.openclaw/workspace/memory/decisions/hub-spoke-architecture.md`
- `~/.openclaw/workspace/memory/decisions/terminal-architecture-2026-03-31.md`
- `/opt/homebrew/lib/node_modules/openclaw/docs/gateway/configuration.md`
- `/opt/homebrew/lib/node_modules/openclaw/docs/gateway/configuration-reference.md`
- `/opt/homebrew/lib/node_modules/openclaw/docs/gateway/health.md`
- `/opt/homebrew/lib/node_modules/openclaw/docs/gateway/doctor.md`
- `/opt/homebrew/lib/node_modules/openclaw/dist/gateway-cli-CWpalJNJ.js`
- `src/extension.ts`
- `src/services/cron-service.ts`
- `src/services/openclaw-task-service.ts`
- `src/services/taskflow-service.ts`
- `src/services/agent-status-bar.ts`
- `src/providers/cron-tree-provider.ts`
- `src/providers/agent-status-tree-provider.ts`
- `package.json`

Prior research reviewed:
- `~/projects/openclaw-hardening-2026-04-03/05-monitoring-architecture.md`
- `~/projects/openclaw-hardening-2026-04-03/06-cc-integration-analysis.md`

## Findings

### 1. What OpenClaw `healthMonitor` actually does

`channels.<provider>.healthMonitor.enabled` enables OpenClaw's built-in channel health monitor for that provider or account.

What it does:
- Periodically evaluates runtime channel health
- Detects stale/unhealthy channels after a startup grace and connect grace
- Applies cooldowns and a rolling restart cap
- Stops and restarts the unhealthy channel

What it does not do:
- It is not an alerting system
- It does not publish notifications by itself
- It does not write shared dashboard data

Relevant config knobs from docs/source:
- `gateway.channelHealthCheckMinutes`
- `gateway.channelStaleEventThresholdMinutes`
- `gateway.channelMaxRestartsPerHour`
- `channels.<provider>.healthMonitor.enabled`
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`

Channels with documented built-in monitor support:
- Discord
- Google Chat
- iMessage
- Microsoft Teams
- Signal
- Slack
- Telegram
- WhatsApp

Important live config finding:
- `channels.discord.healthMonitor.enabled` is currently `false`
- `channels.bluebubbles.healthMonitor.enabled` is currently `true`
- `gateway.channelHealthCheckMinutes = 5`
- `gateway.channelStaleEventThresholdMinutes = 45`
- `gateway.channelMaxRestartsPerHour = 2`

Conclusion:
- `healthMonitor` is a self-healing primitive, not a monitoring UI or notification pipeline.

### 2. Minimal stack that covers the real failure modes

The real failures are not all the same class, so one primitive will not cover them.

Failure mode to primitive mapping:

| Failure mode | Existing primitive that helps | Gap |
| --- | --- | --- |
| Discord silently stuck / awaiting gateway readiness | Built-in channel monitor, `/readyz`, `openclaw health --json` | Alerting and shared UI surfacing |
| Agent completions not firing wake hooks | `openclaw-autonomy-canary.sh`, completion-review watchdog cron | Shared UI surfacing |
| Claude/OpenAI OAuth token expiry or TLS breakage | `openclaw doctor` | Scheduled surfacing and severity mapping |
| Stale `tasks.json` entries | Command Central reconciliation against launcher/process/OpenClaw state | Shared health presentation |

Practical implication:
- OpenClaw already has the probes.
- The missing piece is consolidation and presentation.

Specific guidance by failure mode:

Discord stuck:
- Source and docs show the built-in monitor can auto-restart unhealthy channels.
- Past incident history also shows Discord is the riskiest channel for restart loops.
- Recommendation: keep Discord on the detect-and-alert path first. Do not rely on aggressive auto-restart alone until a canary proves it is safe for this account.

Wake hooks / autonomy pipeline:
- OpenClaw itself does not natively know whether the orchestration wake chain is healthy.
- The existing `openclaw-autonomy-canary.sh` and completion-review watchdog are already the correct primitives.
- Reuse them; do not rebuild this logic in the extension or dashboard.

OAuth/token expiry:
- `openclaw doctor` already checks model auth health, OAuth expiry, TLS prerequisites, session locks, and state integrity.
- This should be treated as the canonical deep auth diagnostic.

Stale launcher tasks:
- `tasks.json` is operational metadata, not source of truth.
- The hub-and-spoke and terminal decisions both explicitly treat gateway/session truth as authoritative and terminal/task state as supplemental.
- Monitoring should flag stale launcher tasks as a warning, never as the primary truth source.

### 3. How Command Central should surface health

Yes, Command Central can add an "Infrastructure Health" tree view cleanly.

Why this fits the current architecture:
- The extension already registers multiple tree views in `package.json`.
- `src/extension.ts` already shows the pattern with `commandCentral.cronJobs` and `commandCentral.agentStatus`.
- `src/services/agent-status-bar.ts` already provides the status-bar pattern for severity coloring and tooltips.
- `src/services/cron-service.ts` already wraps `openclaw cron list --json` and watches `~/.openclaw/cron/jobs.json`.

Recommended CC surfacing model:

1. Status bar item for immediate health
- Poll `/readyz` every 30 seconds
- This is the fastest, cheapest signal
- Suggested states:
  - Green: gateway ready, no failing channels
  - Yellow: gateway ready, but one or more channels failing
  - Red: endpoint unreachable or `ready: false`

2. New "Infrastructure Health" tree view for detail
- Data source: canonical `health-summary.json`
- Refresh cadence: 30-60 seconds
- Sections:
  - Gateway
  - Channels
  - Autonomy
  - Auth / Doctor
  - Cron freshness
  - Launcher/task drift

3. Reuse existing Cron Jobs view instead of duplicating it
- The health tree should show derived cron health only:
  - scheduler OK
  - expected watchdog jobs present
  - overdue / stale jobs
- Detailed job management should remain in the current Cron Jobs view

4. Channel health should be visible
- Yes, CC should show configured/running/degraded channel state
- Discord deserves explicit visibility because it is an actual failure hotspot

5. Cron job status should be visible
- Yes, but at a summary level in health
- Full job list, enable/disable, run-now, and history belong in the existing cron tree/service

### 4. How the dashboard should integrate

The dashboard should consume the same canonical health JSON as Command Central.

Current dashboard architecture already favors:
- Static HTML
- JSON polling
- No framework
- No WebSocket dependency

That is the right pattern here too.

Recommendation:
- Write `dashboard/data/health-summary.json`
- Fetch it client-side with cache-busting timestamp, the same way the dashboard already loads `metrics-detail.json`
- Poll every 30-60 seconds

Do not start with WebSockets because:
- Current dashboard architecture is polling-based already
- Health data changes relatively slowly
- Polling is simpler, cheaper, and more failure-tolerant for a local LAN dashboard
- WebSockets would create a second real-time transport path without enough benefit

Can OpenClaw cron write the JSON snapshot?
- Technically yes, through an `agentTurn` job that runs commands and writes a file
- Practically, no, that is the wrong primitive for deterministic telemetry export
- Cron is good for scheduled checks and `announce` delivery
- A tiny local exporter script is the correct primitive for generating shared machine-readable state

### 5. Notification and alerting path

OpenClaw cron's `delivery.mode: "announce"` is the native alerting path worth reusing.

But alert routing must not be circular.

Recommendation:

Out-of-band operator alerts:
- Use OpenClaw cron to announce warn/critical conditions to BlueBubbles/iMessage or another non-Discord channel
- Do not send Discord-health alerts to Discord

On-machine operator alerts:
- Command Central should show VS Code notifications on health degradation transitions
- Notify on state change, not every poll

Suggested severity model:

Critical:
- Gateway unreachable
- `/readyz` reports not ready for sustained period
- Discord configured but down beyond threshold
- Autonomy canary fails
- `openclaw doctor` reports expired auth or broken OAuth/TLS prerequisites

Warn:
- Channel degraded but self-healing in progress
- Restart cap reached
- Cron watchdog overdue
- Stale launcher task drift
- Health-gate warnings
- Token expiring soon

Info:
- Recent auto-restart event
- Temporary latency spike
- Fresh pending-review backlog within threshold

## Recommended Architecture

### Data Flow

```text
                         OpenClaw Runtime
                                |
          ------------------------------------------------
          |                      |                       |
          v                      v                       v
  Built-in self-heal      Native probes            Existing guardrails
  - channel monitor       - /healthz               - health gate script
  - restart caps          - /readyz                - autonomy canary
                          - status --json          - completion watchdog
                          - health --json          - doctor --non-interactive
                          - channels list
                                |
                                v
                 Health Snapshot Exporter (new, thin)
                 - deterministic aggregation only
                 - no LLM in the path
                 - writes one canonical JSON file
                                |
                                v
       ~/.openclaw/workspace/dashboard/data/health-summary.json
                      |                               |
                      |                               |
                      v                               v
          Command Central                     dashboard.partnerai.dev
          - status bar via /readyz           - static HTML polling
          - health tree via summary          - health cards + details
          - local notifications
                                |
                                v
                   OpenClaw cron announce alerts
                   - warn/critical only
                   - BlueBubbles/iMessage or other
                   - not Discord for Discord failures
```

### Canonical health snapshot contents

The new exporter should aggregate existing signals into a shape like:

```json
{
  "generatedAt": "2026-04-04T19:00:00Z",
  "overall": { "severity": "warn", "summary": "Discord degraded; gateway healthy" },
  "gateway": {
    "reachable": true,
    "ready": true,
    "latencyMs": 264,
    "failing": ["discord"]
  },
  "channels": [
    { "id": "discord", "configured": true, "running": false, "severity": "critical" },
    { "id": "bluebubbles", "configured": true, "running": true, "severity": "ok" }
  ],
  "autonomy": {
    "hookEligible": true,
    "wakeRecent": true,
    "pendingReviewFresh": true,
    "severity": "ok"
  },
  "doctor": {
    "lastRunAt": "2026-04-04T18:45:00Z",
    "auth": "ok",
    "tls": "ok",
    "sessionLocks": "ok",
    "severity": "ok"
  },
  "cron": {
    "schedulerOk": true,
    "jobs": [
      { "id": "completion-review-watchdog", "fresh": true }
    ],
    "severity": "ok"
  },
  "launcher": {
    "staleTasksDetected": 1,
    "severity": "warn"
  }
}
```

The key point is not the exact schema. The key point is a single shared file with:
- current severity
- raw facts
- freshness timestamps
- enough detail for both CC and the dashboard

## What To Reuse vs What To Build

### Reuse as-is

OpenClaw runtime primitives:
- `openclaw status --json`
- `openclaw health --json`
- `/healthz`
- `/readyz`
- `openclaw doctor`
- built-in channel health monitor
- `openclaw channels list`
- OpenClaw cron with `delivery.mode: "announce"`

Existing workspace guardrails:
- `openclaw-health-gate.sh`
- `openclaw-autonomy-canary.sh`
- completion-review watchdog cron job

Existing Command Central architecture:
- tree-view registration pattern
- status-bar pattern
- `CronService`
- `OpenClawTaskService`
- `TaskFlowService`

Existing dashboard architecture:
- static HTML + JS
- JSON polling
- `dashboard/data/*.json` convention

### Build new

Only the pieces OpenClaw does not already provide:

1. Health snapshot exporter
- Purpose: aggregate native signals into one machine-readable summary
- Constraint: deterministic; no AI reasoning required

2. Command Central "Infrastructure Health" view
- Purpose: operational visibility inside VS Code

3. Dashboard health page/card
- Purpose: LAN visibility from the existing dashboard

4. Alert policy layer
- Purpose: severity thresholds and destination routing on top of existing cron announce

### Explicitly do not build

- A second monitoring database
- A custom real-time event bus
- Separate CC and dashboard collectors
- A brand new self-healing subsystem outside OpenClaw
- A duplicate cron management UI

## Implementation Phases

### Phase 1: Canonical snapshot + immediate visibility

Build:
- Health snapshot exporter
- `health-summary.json`
- CC status bar polling `/readyz`
- Dashboard health card consuming the same JSON

Why first:
- Highest value per unit effort
- Solves "what is the current state?" for both surfaces
- Does not require changing OpenClaw internals

### Phase 2: Command Central Infrastructure Health tree

Build:
- Tree view alongside Agent Status and Cron Jobs
- Sections for gateway, channels, autonomy, doctor, cron, launcher drift

Reuse:
- Existing tree provider and command registration patterns

Why second:
- Gives the operator the full breakdown in the tool they already use for agents

### Phase 3: Scheduled deep checks and alert routing

Build:
- Alert policy over the snapshot
- OpenClaw cron announce jobs for warn/critical states

Reuse:
- `openclaw doctor --non-interactive`
- `openclaw-autonomy-canary.sh`
- `openclaw-health-gate.sh`
- existing completion-review watchdog

Why third:
- Adds out-of-band awareness without changing the core data model

### Phase 4: Discord-specific hardening decisions

Evaluate:
- Whether Discord health monitor should remain disabled
- Whether any targeted auto-remediation is safe after more incident data

Why later:
- Discord is the highest-risk auto-restart target
- Detection and visibility should come before new automation

### Phase 5: Optional advanced observability

Consider only if Phase 1-4 prove insufficient:
- OpenTelemetry plugin / external observability
- historical trend retention beyond JSON snapshots
- richer incident history UI

Why last:
- Current problem is operational visibility, not lack of metrics infrastructure

## Anti-Patterns To Avoid

1. Using Discord to alert that Discord is broken
- This is the clearest circular dependency in the system.

2. Treating `tasks.json`, tmux, or a spoke terminal as authoritative
- Gateway/session truth is authoritative.
- Launcher/task state is supplemental and can be stale.

3. Building two collectors
- CC and the dashboard should not each independently probe the system and derive different answers.

4. Using OpenClaw cron as a file-export engine
- Cron is a scheduling and delivery primitive.
- Deterministic JSON export should be a small script, not an LLM job.

5. Polling deep diagnostics too frequently
- Do not run `openclaw doctor` or the full health gate every 30 seconds.
- Separate fast liveness from slower deep diagnostics.

6. Duplicating the cron UI inside health
- Show derived health summary in the health view.
- Keep job management in the existing Cron Jobs view.

7. Turning Discord auto-restart back on without guardrails
- The live config already reflects a deliberate choice to disable it after failures.
- Re-enable only behind explicit thresholds and incident review.

8. Starting with WebSockets
- The current dashboard is already built around static JSON polling.
- Health does not justify a new transport layer yet.

## Recommended Final Answer

The minimal native stack is:
- OpenClaw built-in self-heal for restart-safe channels
- OpenClaw probes and doctor as the raw monitoring primitives
- Existing canary/watchdog scripts for autonomy-specific failure modes
- One new shared `health-summary.json` exporter
- Command Central status bar + health tree on top of that summary
- Dashboard polling the same JSON
- OpenClaw cron announce for out-of-band alerts to a non-Discord channel

That reuses what already exists, covers the real failure modes, and avoids building a second monitoring system beside OpenClaw.
