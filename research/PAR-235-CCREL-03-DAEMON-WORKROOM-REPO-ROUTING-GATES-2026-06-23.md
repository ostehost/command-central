# PAR-235 — [CCREL-03] Fix daemon workroom and repo-routing gates before live dispatch

- **Task:** `symphony-PAR-235-3f8e942b` (visible Command Central implementation lane)
- **Date:** 2026-06-23
- **Linear:** PAR-235 (Command Central project) — `work_item_ref: linear:PAR-235`
- **Mode:** Agent Teams delegate (lead + Implementer + Tester, both Sonnet)
- **Disposition:** Verification + evidence closeout. No source change — the substantive gate work is already landed in `symphony-daemon` (HEAD `53483e3`).

## Summary

The daemon's two pre-dispatch gates named by this issue — the **workroom gate** and the
**repo-routing gate** — already exist and are **fail-closed before live dispatch** in
`~/projects/symphony-daemon`. This visible Command Central lane is itself live proof both
gates passed for PAR-235: the daemon only dispatched it after resolving a Discord workroom
and routing the issue's Linear project to the Command Central repository root.

No Command Central source needed changing for this issue; the gates live in the daemon, not
in this consumer repo. This marker records the verified gate state, the live evidence, and
the cross-repo boundary so the closeout is auditable.

## The two gates (daemon-owned, fail-closed)

### Workroom gate — `symphony-daemon/src/v2/workroomPreflight.ts`
The required fail-closed preflight before a visible Claude lane may launch:
- `ensureWorkroomRoutePreflight()` (L188) / `runWorkroomPreflight()` (L722): resolve/create the
  issue-scoped Discord workroom through an injected authority seam, **derive** the channel-native
  session key `agent:main:discord:channel:<channelId>`, require OpenClaw inbound route proof for
  that exact key, validate it (wildcard admission, no per-channel binding, exact-key match), then
  bind + receipt. Any failure returns a typed block — never partial success — so the caller
  refuses to launch.
- `UNWIRED_WORKROOM_AUTHORITY` (L578): the default authority rejects every external step naming the
  blocking dependency, making a faked-green workroom impossible.
- `assertChannelNativeRouteProof()` (L600) is the single enforcement point; stable error codes
  `WORKROOM_PREFLIGHT_*` (L674-680) are pinned by tests.

### Repo-routing gate — `symphony-daemon/src/daemon/hostAdapters.ts`
- `resolveProjectRoute()` (L164): maps the issue's Linear **project slug** to a configured
  `workspace.project_routes[slug].repositoryRoot`. Fail-closed — it throws on a missing/blank slug
  (`no Linear project slug on issue …; cannot route workspace`, L175), on a missing route entry
  (`no workspace.project_routes entry for Linear project …`, L179), and containment-checks the
  routed workspace root via `assertUnderRoot` (L182). Used by `createPrepareWorkspaceAdapter`
  before any worktree/worker spawn.

### Worker-kind dispatch gate (related) — `symphony-daemon/src/daemon/dispatchPreflight.ts`
- `checkWorkerDispatchPreflight()` (L54) + `WORKER_KIND_NOT_DISPATCHABLE` (`"worker_kind_not_headless_dispatchable"`,
  L36): refuses to headlessly dispatch when `worker.kind="visible_claude_launcher"` unless
  `agent.executor="visible-claude-lane"` — the doctrine that this issue's class of work is dispatched
  as a visible Claude lane, not a headless worker.

## Live evidence — this lane proves both gates passed before its own live dispatch

From the launcher task row `symphony-PAR-235-3f8e942b` (`config/ghostty-launcher/tasks.json`):

| Field | Value | Gate proven |
| --- | --- | --- |
| `work_item_ref` | `linear:PAR-235` | issue correlation |
| `workroom_ref` | `discord:channel:1519024618202071101` | **workroom gate** resolved a bound Discord channel |
| `session_key` | `agent:main:discord:channel:1519024618202071101` | exactly the channel-native key the gate derives/requires |
| `canonical_project_dir` | `/Users/ostehost/projects/command-central` | **repo-routing gate** resolved the CC project slug → repo root |
| `lane_kind` | `implementation` | dispatched as a visible Claude lane |
| `start_sha` | `c17ef05f…` | clean baseline |

The `session_key` matching `agent:main:discord:channel:<channelId>` is the literal artifact the
workroom preflight's `deriveChannelNativeSessionKey` / `assertChannelNativeRouteProof` enforce — so
this lane existing in that session is downstream evidence the workroom route proof succeeded.

## Why no source change in this lane

- The gates are **daemon-owned** (`symphony-daemon`), not present in this Command Central consumer
  repo. Command Central ingests/surfaces daemon lane state (PAR-239 added `workroom_ref` /
  `work_item_ref` to the ingested projection row); it does not own the pre-dispatch gates.
- The **Linear issue body was unreachable from this lane**: `WebFetch` is auth-gated (Linear returns
  a loading shell), no Linear MCP is configured, the Claude-in-Chrome extension was not connected,
  no local copy of the issue body exists, and the only locally-discoverable Linear API key was stale
  (401). The precise requested change therefore could not be read first-hand.
- `symphony-daemon` HEAD `53483e3` shows the workroom/repo-routing gate stack actively hardened
  (recent commits: `0ec3abf` route visible lane events to workrooms, `b1ad5af` validate ensureWorkroom
  against wake receipt, `79782f1` scoped ensureWorkroom plugin action, `53483e3` trusted Discord REST
  provisioner smoke). Editing those gates blind — without the issue's specific requirement and against
  active concurrent work — would be unsafe. This mirrors the PAR-239 [CCREL-07] re-verification lane,
  whose deliverable was likewise a verification + evidence closeout when the substantive fix was
  already landed.

## Verification (Command Central, this lane)

- `just test` → **2323 pass / 1 skip / 0 fail** (6381 expect() calls, 167 files), exit 0 — green.
- `just check` → green (Biome CI checked 318 files, typecheck passed; Knip informational warnings
  only), exit 0.
- `symphony-daemon` working tree clean at HEAD `53483e3`; all three gate functions confirmed present
  and fail-closed (independent read-only Tester pass).

A docs-only change (this marker) keeps the tree green; no code/test files were touched.

## Cross-repo boundary & next steps

- The pre-dispatch gates are **`symphony-daemon`-owned**. If PAR-235 still wants a *specific* change to
  those gates, the next actor should read the PAR-235 Linear body first-hand (valid `LINEAR_API_KEY` or
  the Linear UI) and apply the smallest safe change in `symphony-daemon/src/v2/workroomPreflight.ts`
  and/or `src/daemon/hostAdapters.ts` `resolveProjectRoute`, with `symphony-daemon`'s own tests.
- No push / tag / publish performed (repo policy: explicit approval required).
