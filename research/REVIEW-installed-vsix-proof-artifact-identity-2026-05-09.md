# Installed VSIX Proof Artifact Identity Review - 2026-05-09

## Summary

The installed-VSIX Symphony proof harness is useful, but the first proof summary blurred artifact identity. The accepted `0.6.0-rc.22` VSIX and the later proof VSIX are different artifacts.

`0.6.0-rc.22` remains immutable as the accepted internal dogfood prerelease. The post-rc22 harness package must be described as an unshipped temporary proof artifact built from commit `0706b30`, not as a replacement or redefinition of rc22.

## Artifact Identity

Accepted rc22 artifact:

- Path: `releases/command-central-0.6.0-rc.22.vsix`
- SHA256: `28ca4dcff85a6c8d80d8d8e4db16d8704ab2a5739ec2a6331b691b9e4f57b481`
- Release posture: accepted internal dogfood prerelease
- Status: immutable; do not overwrite, rebuild under the same identity, or reinterpret

Temporary proof artifact:

- Hub source commit: `0706b30 test(agent-status): seed proof clipboard probe`
- Path used on node: `/tmp/command-central-proof-0706b30.vsix`
- SHA256: `c424664bd538696e0e9c84f41bd4958ffe8e770d5cdf8836ffc0131e3a0f1dae`
- Release posture: unshipped local proof artifact
- Package manifest version: `0.6.0-rc.22`, because `package.json` was not bumped
- Correct label: "temporary installed-VSIX proof artifact built from `0706b30`"

The manifest version collision is acceptable only for local proof if the artifact is named and reported by commit SHA. It is not acceptable for prerelease distribution. If this code needs distribution beyond local proof, cut a new prerelease, probably rc23, after the release gate.

## Accepted rc22 Against New Harness

The accepted rc22 artifact was tested on `Mike MacBook Pro` with the current harness:

```text
COMMAND_CENTRAL_VSIX_PATH=/tmp/command-central-accepted-rc22.vsix just test-installed-vsix-agent-status --passive
```

Result: failed as expected.

Failure reason:

```text
COMMAND_CENTRAL_TEST_MODE must expose the inspection API.
```

Interpretation: accepted rc22 predates the new structured inspection API. The failure proves the SHA mismatch was not caused by corrupt rc22 bytes; the successful proof was run against a newer post-rc22 package.

Accepted rc22 SHA on node:

```text
28ca4dcff85a6c8d80d8d8e4db16d8704ab2a5739ec2a6331b691b9e4f57b481  /tmp/command-central-accepted-rc22.vsix
```

## Temporary Proof Artifact Results

The temporary artifact built from `0706b30` passed the new harness on `Mike MacBook Pro`.

Passive proof:

- Manifest: `/Users/ostehost/.openclaw/tmp/cc-proof-command-central-final3/logs/installed-vsix-agent-status-proof-1778373363060.json`
- Installed version reported by VS Code: `0.6.0-rc.22`
- VSIX SHA256: `c424664bd538696e0e9c84f41bd4958ffe8e770d5cdf8836ffc0131e3a0f1dae`
- Task count: `303`
- Symphony roots: `Symphony / Workstreams · 0`, `Symphony / Run Attempts · 26`
- Actions: `0 passed / 3 skipped`
- Errors: none

Live proof:

- Target task: `cc-artifact-identity-review-20260509-2036`
- Manifest: `/Users/ostehost/.openclaw/tmp/cc-proof-command-central-final3/logs/installed-vsix-agent-status-proof-1778373382530.json`
- Installed version reported by VS Code: `0.6.0-rc.22`
- VSIX SHA256: `c424664bd538696e0e9c84f41bd4958ffe8e770d5cdf8836ffc0131e3a0f1dae`
- Task count: `303`
- Symphony roots: `Symphony / Workstreams · 0`, `Symphony / Run Attempts · 26`
- Actions: `3 passed / 0 skipped`
- UI effects recorded: clipboard changed, evidence file opened, terminal focus invoked
- Errors: none

## Change Classification

Harness hardening:

- Installed-VSIX proof runner and `just test-installed-vsix-agent-status`
- Passive/live proof modes
- VSIX resolution by CLI/env/package default
- Manual VSIX install into an isolated extension dir
- Harness-extension-only `--extensionDevelopmentPath`
- Manifest fields for installed path, SHA, source authority matrix, actions, skips, and errors
- Semantic Symphony root and boundary assertions
- Clipboard sentinel fix for copy probes
- Snapshot caps plus explicit selectors

Product behavior:

- Review queue continuation gap UI from `6305387`
- Missing tracker source wording from `c445d0a`
- Preserving source owner metadata from `1724b05`

These product changes may be valid, but they are not pure harness work. They should be reviewed and released as product behavior in the next prerelease decision.

## Spec Boundary

Command Central remains a read-only Symphony Status Surface. It may observe and route read-only operator intent: inspect tree state, copy IDs, open evidence, and focus terminals.

Command Central must not claim orchestration authority. The Symphony surface must not expose scheduler-owned controls such as dispatch, retry, reconcile, Linear polling, tracker writes, issue transitions, claims, or workspace cleanup. The harness currently asserts this by scanning commands under `Symphony /` roots for forbidden scheduler/tracker mutation vocabulary.

`COMMAND_CENTRAL_TEST_MODE` must remain inspection-only. It may expose structured test APIs, but it must not fake provider data, suppress watchers, skip activation, relax timing, or alter production command behavior.

## Release Recommendation

Do not promote the `c424664b...` artifact as rc22. It is an unshipped proof artifact.

Recommended next step: cut rc23 only after deciding that the harness hardening plus the product behavior slices are ready to distribute together. Keep scope minimal: installed proof harness, source-authority preservation, explicit missing tracker source, and review queue continuation gap UI. No scheduler controls, no tracker writes, no public push, no tag, no GitHub release, and no Marketplace publish without explicit approval.

## Next Harness Hardening

Implemented in follow-up commits:

- `2cead4f test(agent-status): record expected proof artifact sha`: the proof runner accepts `--expected-sha` or `COMMAND_CENTRAL_EXPECTED_VSIX_SHA256`.
- `0a28d99 test(agent-status): distinguish proof artifact identity`: the manifest separates expected-SHA matching from published artifact matching.

Before using this proof path as a release gate, pass the accepted prerelease SHA explicitly:

- Accept an expected SHA and an identity kind.
- Emit `expected_vsix_sha256`, `vsix_matches_expected_sha`, `expected_vsix_identity_kind`, and `published_release_match`.
- Set `expected_vsix_identity_kind` to `published-prerelease` only for an accepted prerelease artifact, and to `temporary-proof-artifact` for local proof packages.
- Set `published_release_match` only when the identity kind is `published-prerelease`.
- Fail release-mode proof if the VSIX SHA does not match the expected published prerelease artifact.
- Keep local proof mode available, but label it as a temporary proof artifact by commit SHA.

This prevents `installed_version` or expected-SHA success from being mistaken for published artifact identity. `installed_version` proves the package manifest version loaded by VS Code; `vsix_sha256` plus `expected_vsix_identity_kind` proves whether the artifact was an accepted prerelease or a temporary proof artifact.

For multi-node Symphony proof, each node should emit its own manifest. Command Central should not merge those manifests or own cross-node orchestration; the conductor/orchestrator should aggregate node proof while CC remains the local read-only Status Surface.

Expected-SHA proof for unshipped commit `0a28d99`:

- Temporary artifact: `/tmp/command-central-proof-0a28d99.vsix`
- SHA256: `67c820e5c73611359ac4627c21f8d8a6e6417027240ee6b6e3d2cc50baa17f8e`
- Passive manifest: `/Users/ostehost/.openclaw/tmp/cc-proof-command-central-final3/logs/installed-vsix-agent-status-proof-1778375375340.json`
- Passive result: `vsix_matches_expected_sha: true`, `expected_vsix_identity_kind: temporary-proof-artifact`, `published_release_match: null`, task count `306`, roots `Symphony / Workstreams · 0` and `Symphony / Run Attempts · 29`, errors none
- Live target: `cc-installed-vsix-proof-live8-20260509-2110`
- Live manifest: `/Users/ostehost/.openclaw/tmp/cc-proof-command-central-final3/logs/installed-vsix-agent-status-proof-1778375393477.json`
- Live result: `vsix_matches_expected_sha: true`, `expected_vsix_identity_kind: temporary-proof-artifact`, `published_release_match: null`, task count `306`, roots `Symphony / Workstreams · 0` and `Symphony / Run Attempts · 29`, copy/open/focus passed, errors none

## Process Finding

The live launcher lanes still reuse `session_id=agent-command-central` even when a session suffix is supplied. Command Central should continue to treat task/run IDs as the primary row identity until launcher session uniqueness is fixed. This matters more as Symphony-style work spreads across multiple nodes, because shared session identity weakens focus, steering, and provenance.
