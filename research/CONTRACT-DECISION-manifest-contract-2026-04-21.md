# Contract Decision — Manifest Contract

## Classification

contract decision required

## Decision surface

PR 3 ("manifest contract") flipped out of safe hardening because the codebase
currently registers two literal `commandCentral.*` commands that are not
present in `package.json`'s `contributes.commands` list:

1. `commandCentral.openInfrastructureDashboard`
2. `commandCentral.clearTerminalTasks`

Per the PR 3 handoff, that is a contract question, not a safe test addition:
which source is authoritative when code says a command exists but the manifest
does not advertise it?

## Conflicting sources

### Position A — code says `commandCentral.openInfrastructureDashboard` exists

- `src/extension.ts:894` registers
  `commandCentral.openInfrastructureDashboard`.
- `src/services/infrastructure-health-status-bar.ts:15` sets
  `DEFAULT_COMMAND = "commandCentral.openInfrastructureDashboard"`, which means
  live UI surfaces expect the command to exist.

Current behavior:
- the command is callable programmatically after activation
- the command is not discoverable via `package.json` command contributions

### Position B — code says `commandCentral.clearTerminalTasks` exists

- `src/extension.ts:2037` registers `commandCentral.clearTerminalTasks`.
- `src/extension.ts:2039` immediately delegates it to
  `commandCentral.clearCompletedAgents`.

Current behavior:
- the command is callable programmatically after activation
- it behaves like a stub, not a distinct implementation
- the command is not discoverable via `package.json` command contributions

### Position C — manifest advertises adjacent command surfaces, but not these two

- `package.json:60` begins `contributes`, including the public command list.
- `package.json:864` contributes `commandCentral.clearCompletedAgents`.
- `package.json:924` contributes `commandCentral.openAgentDashboard`.
- No entry exists in `package.json` for either
  `commandCentral.openInfrastructureDashboard` or
  `commandCentral.clearTerminalTasks`.

Current behavior:
- manifest-driven tooling and any contract test built only from
  `contributes.commands` would treat both commands as nonexistent
- the command palette cannot advertise these commands via manifest metadata

### Position D — `clearTerminalTasks` is a planned P1 feature, not a finished contract

- `research/RESEARCH-failed-state-ux.md:2` states
  `commandCentral.clearTerminalTasks` is not implemented.
- `research/RESEARCH-failed-state-ux.md:180` names
  `commandCentral.clearTerminalTasks` as the planned command.
- `research/RESEARCH-failed-state-ux.md:246-247` plans both the real
  registration work and a future title-bar contribution.
- `research/AUDIT-SUMMARY-2026-03-25.md:45` lists
  `clearTerminalTasks` as part of an unfinished P1 work item.

Current behavior:
- the research docs describe future intent, not a completed public command
- the current runtime registration is an unfinished placeholder for that intent
- contributing the stub today would turn planned work into contract prematurely

## Resolution options

### Option 1 — code wins

Treat both commands as public surface area.

Required follow-up:
- add both commands to `package.json:contributes.commands`
- choose titles/categories for each command
- keep the code registrations as-is

Impact:
- manifest contract test can enforce parity in favor of code
- `openInfrastructureDashboard` becomes a normal public command
- `clearTerminalTasks` becomes a public alias for `clearCompletedAgents`

Risk:
- exposes an alias that may not deserve long-term public support

### Option 2 — manifest wins

Treat only manifest-contributed commands as public surface area.

Required follow-up:
- remove or internalize both literal registrations
- replace any programmatic call sites with direct function calls or other
  non-command wiring where needed

Impact:
- manifest contract test can enforce parity in favor of the manifest
- command surface becomes smaller and more explicit

Risk:
- `openInfrastructureDashboard` is already wired into a visible status-bar
  path, so removing it may force a non-command refactor for a user-facing UI

### Option 3 — ratified hybrid

Treat the two commands differently.

Required follow-up:
- add `commandCentral.openInfrastructureDashboard` to
  `package.json:contributes.commands`
- remove the current `commandCentral.clearTerminalTasks` stub registration
- keep `research/RESEARCH-failed-state-ux.md` and
  `research/AUDIT-SUMMARY-2026-03-25.md` intact as future intent documents
- leave the real `clearTerminalTasks` feature for a later implementation PR

Impact:
- user-facing infrastructure navigation becomes explicit and contractable
- the unfinished bulk-clear placeholder does not become accidental public API
- the P1 feature remains planned without locking in stub behavior as contract

Risk:
- future `clearTerminalTasks` work will need to reintroduce the command with
  its own real semantics and manifest entry

## User-visible implications

Today, a user can trigger these commands only through code-owned paths after
activation; they are not represented as normal manifest commands. That creates
two mismatched truths:

- code/runtime truth: the commands exist
- manifest/tooling truth: the commands do not exist

For `openInfrastructureDashboard`, that mismatch matters more because a visible
status bar feature depends on the command. For `clearTerminalTasks`, the
mismatch is a planned future feature currently represented by a stub.

## Recommendation

Recommend **Option 3 — ratified hybrid**:

- make `commandCentral.openInfrastructureDashboard` explicit public surface by
  contributing it in `package.json`
- remove the current `commandCentral.clearTerminalTasks` stub registration
- preserve the research docs describing the planned future bulk-clear feature

Why this recommendation:
- it preserves the user-facing infrastructure dashboard entrypoint already
  implied by `InfrastructureHealthStatusBar`
- it avoids blessing unfinished stub behavior as permanent public API
- it keeps the future P1 implementation free to define the real bulk-clear
  behavior, confirmation flow, and title-bar exposure intentionally

## Ratified

- Date: 2026-04-21
- Ratifier: @ostehost
- Resolution:
  - contribute `commandCentral.openInfrastructureDashboard`
  - remove the current `commandCentral.clearTerminalTasks` stub registration
  - preserve the research docs; do not archive or annotate them in this PR

## Stop condition

Ratification is complete. The remaining work is mechanical alignment:
- revise this decision doc in place
- align code and manifest to the ratified resolution
- land `test/package-json/manifest-contract.test.ts` after parity is restored
