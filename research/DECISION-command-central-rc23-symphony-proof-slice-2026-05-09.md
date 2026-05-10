# Command Central rc23 Symphony Proof Slice Decision - 2026-05-09

## Recommendation

Cut rc23 only after the identity-field cleanup passes node proof and `just ci`.

Do not treat this as a pure harness release. The batch includes user-visible/product behavior that should be intentionally accepted:

- Source-owner metadata preservation
- Explicit missing tracker source wording
- Review queue continuation gap UI
- Installed-VSIX Symphony proof harness

## Why rc23 Is Reasonable

The product changes make the Symphony Status Surface more truthful:

- Source-owner metadata preservation keeps launcher/source authority visible instead of dropping owner fields during task normalization.
- Missing tracker source wording avoids silently hiding absent tracker context and makes the owner boundary explicit.
- Review queue continuation gap UI exposes a real autonomous-process failure mode: a run can advertise pending review/fixup artifacts that do not exist yet.
- The installed-VSIX harness gives a repeatable node proof path that tests the installed extension, not the source checkout.

This aligns with the Symphony boundary: Command Central observes and routes read-only operator intent. It does not dispatch, retry, reconcile, poll Linear, transition issues, claim work, clean workspaces, or mutate lifecycle state.

## Why Not Promote Blindly

Accepted rc22 is immutable and does not contain the new inspection API. Post-rc22 proof artifacts are temporary local proof packages unless a new prerelease is cut.

The next prerelease must clearly identify the artifact by version and SHA. The proof manifest must distinguish:

- `vsix_matches_expected_sha`: whether the loaded VSIX matches the SHA provided to the harness.
- `expected_vsix_identity_kind`: `published-prerelease` or `temporary-proof-artifact`.
- `published_release_match`: true only for a SHA match against an accepted prerelease artifact.

The review queue continuation gap UI is useful, but it changes operator semantics by surfacing completed-looking work as blocked/limbo when expected review evidence is missing. That is product behavior and should ride rc23 only with explicit release note language.

## Release Scope

Include:

- Installed-VSIX proof runner and manifests.
- Expected-SHA/identity-kind manifest fields.
- Passive/live proof modes.
- Source-authority and lifecycle-owner projection.
- Explicit missing tracker source text.
- Review queue continuation gap visibility.

Exclude:

- Scheduler controls.
- Tracker mutation.
- Linear polling.
- Retry/reconcile/dispatch controls.
- Issue transitions or claims.
- Workspace cleanup.
- Multi-node manifest aggregation inside Command Central.

## Release Gate

Before cutting rc23:

1. `bunx tsc --noEmit --pretty false`
2. `git diff --check`
3. Targeted harness/tree/service tests
4. `just ci`
5. Node passive installed proof with `--expected-sha` and `--identity-kind temporary-proof-artifact` for the pre-release candidate artifact
6. Node live installed proof with a currently running marker task
7. Build rc23 artifact
8. Rerun node passive proof with `--identity-kind published-prerelease` and the rc23 SHA

No public push, tag, GitHub release, Marketplace publish, or announcement belongs to this decision without explicit approval.

## Current Decision

Status: ready to continue dogfood, not yet a release request.

The identity-field cleanup is validated against a temporary installed-VSIX proof artifact built from `fe9089a`. That proof keeps `published_release_match: false` for the temporary artifact while still proving `vsix_matches_expected_sha: true`.

Next decision point: cut rc23 as a minimal internal prerelease candidate only if the product behavior slices above are intentionally accepted into the prerelease notes. Otherwise keep the harness and product changes unshipped for more dogfood.
