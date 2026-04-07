# What's New version policy — 2026-04-07

## Question

`src/extension.ts:149` hard-codes:

```ts
const WHATS_NEW_VERSION = "0.6.0";
```

while `package.json` is currently shipping as a prerelease (`0.5.1-77`). On
the surface this looks like a copy/paste bug — should it not match
`package.json`?

## Answer: the `0.6.0` value is intentional

The What's New toast was added in commit `2a7124b` ("feat: add What's New
notification for recency-first default (M3.5-8)"). Two pieces of evidence
make the intent clear:

1. The user-visible toast copy itself names the version:
   > "Command Central **0.6.0**: Agent Status now sorts by recency by
   > default. Your most recent agent runs appear first."
2. The constant and the copy were introduced in the same commit, both
   spelling `0.6.0`. This is not drift — it was authored as a `0.6.0`
   announcement from day one.

The recency-first default is the headline change for the **0.6.0 stable**
release. The toast is gated so that:

- Returning users (`hasActivatedBefore === true`) see it exactly once per
  `WHATS_NEW_VERSION` value (tracked via the `commandCentral.whatsNewShown`
  globalState key).
- First-time users never see it (no announcement needed — they never had
  the old default).
- 0.5.1 prerelease users (`0.5.1-x`) intentionally do **not** see it. The
  prerelease line is being used to bake in the recency-first default and
  surrounding fixes; the toast is reserved for the stable cut so that
  early adopters on the prerelease channel are not double-notified.

## What users will see on upgrade to 0.6.0 stable

- A user on `0.5.1-x` who has activated the extension before upgrades to
  `0.6.0`. On first activation under `0.6.0`, `hasActivatedBefore` is
  `true` and `whatsNewShown` is still `""` (or some older value), so the
  toast fires once. `commandCentral.whatsNewShown` is then set to
  `"0.6.0"` and the toast does not fire again on subsequent activations
  or further `0.6.0.x` patch bumps.
- A brand-new user installing `0.6.0` directly does not see the toast
  (no `hasActivatedBefore`).
- Continuing to bump the prerelease tag (`0.5.1-78`, `0.5.1-79`, …) does
  **not** retrigger the toast, because the gate is on the literal string
  `"0.6.0"`, not on `package.json`'s `version`. This is the desired
  behavior — we can keep iterating on prereleases without burning the
  one-shot announcement.

## Should we add a comment in `src/extension.ts`?

Yes — a one-line comment next to `WHATS_NEW_VERSION` would prevent the
next reviewer from filing this as a bug. Suggested wording (not applied
in this pass to keep the diff empty per the task brief):

```ts
// Intentionally pinned to the upcoming stable (0.6.0), not package.json's
// version. The toast is the 0.6.0 announcement and should fire once when
// returning prerelease/0.5.x users land on 0.6.0 stable. Bumping prerelease
// tags must NOT retrigger it.
const WHATS_NEW_VERSION = "0.6.0";
```

If a follow-up task wants to land that comment, it should be the only
change in the commit.

## Decision

- **No code change.** `WHATS_NEW_VERSION = "0.6.0"` is correct.
- This note is the rationale; future reviewers should consult it before
  "fixing" the version string.
- Optional follow-up: add the explanatory comment above to
  `src/extension.ts:149` so the rationale lives next to the code.
