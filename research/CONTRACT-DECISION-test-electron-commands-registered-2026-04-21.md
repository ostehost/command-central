# Contract Decision — Real VS Code Command Registration

## Classification

contract decision required

## Decision surface

PR 6 ("Install `@vscode/test-electron` and wire real-VS-Code tests") flipped out
of safe hardening during the real host run.

Observed runtime result on 2026-04-21:

- activation passed in the real VS Code host
- the next scenario (`commands registered`) failed with:
  `Expected contributed command commandCentral.gitSort.changeFileFilter.slot10 to be registered.`

This is not a harness-only failure. It is a contract question about which of
these truths is authoritative:

1. every command listed in `package.json:contributes.commands` must be
   registered after activation, even if the corresponding view slot is inactive
2. generated per-view slot commands are only required to register for active
   slots, even though the manifest statically contributes slot1-slot10 and
   panel variants

## Conflicting sources

### Position A — manifest/startup contract says slot10 is public now

- `package.json:724` contributes
  `commandCentral.gitSort.changeFileFilter.slot10`
- `package.json:739` contributes
  `commandCentral.gitSort.changeFileFilter.slot10Panel`
- `package.json:1738-1754` wires those commands into slot10 view/title menu
  contributions

Current implication:

- manifest-driven tooling treats slot10 and slot10Panel commands as part of the
  public command surface
- a strict real-host interpretation expects them to appear in
  `vscode.commands.getCommands(true)` after activation

### Position B — runtime registers per-view commands only for active slots

- `src/services/project-view-manager.ts:531` derives `slotId` from the active
  `ProjectViewConfig`
- `src/services/project-view-manager.ts:535-617` registers per-view commands
  only for that active `slotId` and its `Panel` variant

Current implication:

- if the clean real-VS-Code workspace only instantiates `slot1`, then
  `slot10`/`slot10Panel` commands are not registered at startup
- the real host can legitimately activate and still fail a scenario that
  assumes eager registration for all ten slots

### Position C — the existing manifest contract test already treats generated slot commands specially

- `test/package-json/manifest-contract.test.ts:97-113` explicitly recognizes
  generated slot commands by template rather than requiring literal
  registrations to exist in source

Current implication:

- the repo already encodes a softer contract for generated slot commands at the
  source/manifest layer
- PR 6's real-host scenario is currently stricter than the existing manifest
  contract test

## Resolution options

### Option 1 — eager registration wins

Treat every contributed slot command as required runtime surface immediately
after activation.

Required follow-up:

- register slot1-slot10 and slot1Panel-slot10Panel commands eagerly at startup,
  regardless of whether the corresponding views are active
- keep PR 6's `commands registered` scenario strict

Impact:

- manifest truth and runtime truth match exactly after activation
- command palette / automation callers can invoke any contributed slot command
  without depending on workspace shape

Risk:

- registers many inert commands for views that do not exist in the current
  workspace
- may cement a wider public API than the product actually wants

### Option 2 — contextual registration wins

Treat generated per-view slot commands as valid only for active slots/views.

Required follow-up:

- keep runtime registration contextual in `ProjectViewManager`
- narrow PR 6's `commands registered` scenario so it asserts:
  - all non-generated contributed commands are registered after activation
  - generated slot commands are registered only for active slots discovered in
    the host

Impact:

- matches current architecture and the special-casing already present in
  `manifest-contract.test.ts`
- avoids treating inactive slots as real runtime surface

Risk:

- manifest contributes commands that may not be immediately invocable from a
  clean host
- the command palette contract remains looser than the manifest suggests

### Option 3 — redesign the slot command surface

Stop contributing static slot1-slot10 command IDs and replace them with a
smaller generic command surface plus arguments/context.

Required follow-up:

- redesign package.json menu contributions and the slot-command architecture
- adjust both manifest contract and PR 6 real-host scenarios to the new model

Impact:

- removes the mismatch entirely
- shrinks the public command surface

Risk:

- larger product/design change outside PR 6 scope

## User-visible implications

Today, real activation succeeds on a clean VS Code host, but at least one
contributed slot command (`commandCentral.gitSort.changeFileFilter.slot10`) is
absent from the registered command set in that same host.

That means there are currently two different command contracts:

- manifest truth: slot1-slot10 are all contributed
- runtime truth: only active slots are registered

PR 6 surfaced that mismatch with a real host instead of a source-only test.

## Recommendation

Recommend **Option 2 — contextual registration wins**.

Why:

- it matches the current architecture in `ProjectViewManager`
- it aligns with the existing special-case already codified in
  `manifest-contract.test.ts`
- it avoids forcing ten inert slot command registrations into every activation
  just to satisfy a stricter-than-current test assumption

If product intent is "every contributed command must be globally invocable from
Command Palette immediately after activation," then choose Option 1 instead.
But that would be a product-surface expansion, not a test-only fix.

## Ratified

- Date: 2026-04-21
- Ratifier: @ostehost (delegate reviewer)
- Resolution:
  - keep `ProjectViewManager`'s per-view slot command registration contextual
  - require all non-generated contributed commands after activation
  - require generated slot commands only for active slots discovered in the
    real host

## Stop condition

Ratification is complete. The remaining work is mechanical alignment:

- if Option 1 had won: change product code, then keep the strict scenario
- for the ratified Option 2: narrow the PR 6 `commands registered` scenario to
  active-slot registration for generated slot commands
- if Option 3 is ever chosen later: design a fresh follow-up handoff for the
  slot-command redesign
