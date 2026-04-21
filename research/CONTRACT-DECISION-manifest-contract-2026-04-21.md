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
- it behaves like an alias, not a distinct implementation
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

### Option 3 — hybrid

Treat the two commands differently.

Required follow-up:
- add `commandCentral.openInfrastructureDashboard` to
  `package.json:contributes.commands`
- remove or internalize `commandCentral.clearTerminalTasks`, keeping
  `commandCentral.clearCompletedAgents` as the single public clear command

Impact:
- user-facing infrastructure navigation becomes explicit and contractable
- the alias command does not become accidental public API
- manifest contract test needs one ratified exception resolved before landing

Risk:
- this is a product decision, not a purely mechanical reconciliation

## User-visible implications

Today, a user can trigger these commands only through code-owned paths after
activation; they are not represented as normal manifest commands. That creates
two mismatched truths:

- code/runtime truth: the commands exist
- manifest/tooling truth: the commands do not exist

For `openInfrastructureDashboard`, that mismatch matters more because a visible
status bar feature depends on the command. For `clearTerminalTasks`, the
mismatch looks more like an internal alias leaking into the command registry.

## Recommendation

Recommend **Option 3 — hybrid**:

- make `commandCentral.openInfrastructureDashboard` explicit public surface by
  contributing it in `package.json`
- internalize or remove `commandCentral.clearTerminalTasks` so
  `commandCentral.clearCompletedAgents` remains the only public clear command

Why this recommendation:
- it preserves the user-facing infrastructure dashboard entrypoint already
  implied by `InfrastructureHealthStatusBar`
- it avoids blessing a redundant alias as permanent public API
- it keeps the eventual manifest contract test strict without requiring awkward
  exceptions for known internal-only commands

## Stop condition

Do not land `test/package-json/manifest-contract.test.ts` until this decision is
ratified. The test would otherwise silently choose whether code or manifest is
authoritative.
