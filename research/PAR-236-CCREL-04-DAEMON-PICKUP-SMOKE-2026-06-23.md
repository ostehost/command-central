# PAR-236 — [CCREL-04] Daemon Pickup Smoke through the Formal Process

- **Task:** `symphony-PAR-236-984cde87` (visible Command Central implementation lane)
- **Date:** 2026-06-23
- **Linear:** PAR-236 (Command Central project)
- **Machine:** Mike's MacBook Pro (user `ostehost`)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Mode:** Agent Teams delegate (lead + Implementer + Tester, both Sonnet)
- **Scope:** local only, docs-only. No source/tests/config/version touched, no push / tag / publish / marketplace release / external writes / destructive reset.

---

## 1. Why this marker exists

CCREL-04 asks: "Run a daemon pickup smoke through the formal Symphony process before CC RC signoff." This visible Claude Code implementation lane **is** that smoke. The Symphony daemon selected PAR-236, routed it to this lane, the lane ran verification, and it commits this marker on exit — completing the full formal-process path end-to-end.

The daemon-pickup smoke surface (the three integration tests + the `readRegistry()` projection/primary-wins merge at `src/providers/agent-status-tree-provider.ts:3967`) was already present and green before this lane started. Re-implementing it would only churn correct, already-tested code. The honest, smallest-safe deliverable is this verification marker — confirming the surface is present and green, and leaving a tracked provenance artifact. No source change was required.

## 2. Full-circle formal-process path

| Step | What happened |
| --- | --- |
| 1. Selection | Symphony daemon selected **PAR-236** (Command Central project, CCREL-04 scope). |
| 2. Routing | Routed to this visible Claude Code implementation lane `symphony-PAR-236-984cde87`; a `tasks.json` registry row was written for it at spawn time. |
| 3. Agent Status projection | The lane's `tasks.json` row is read by `AgentStatusTreeProvider.readRegistry()` (`agent-status-tree-provider.ts:3967`) and surfaced in the Agent Status tree; the projection/primary-wins merge ensures a projection row never displaces a primary record. |
| 4. Work | This lane read the three projection/startup smoke test files and the provider pickup path; confirmed no source gap; ran verification (via the Tester teammate). |
| 5. Commit | This `docs(research):` commit records the outcome and closes with a tracked artifact — identical pattern to PAR-195 and PAR-239 dogfood lanes. |
| 6. Exit + finalizer/receipt | On lane exit the Symphony launcher finalizer/reaper closes the task and writes the receipt. CC cannot self-certify the launcher-side task close; that happens in the launcher process. |

## 3. Daemon-pickup smoke surface verified

The pickup/projection path lives in `AgentStatusTreeProvider.readRegistry()` at `src/providers/agent-status-tree-provider.ts:3967`. It iterates all configured lane registry files, calls `readRegistryFile()` per path (which auto-detects `work-system-lanes-projection` documents by `kind`), then merges: when a primary record and a projection row share a task id, the primary record wins regardless of file order (`lane_projection` flag). The three integration test files exercise this surface comprehensively.

| Test file | Tests | expect() calls | Notes |
| --- | --- | --- | --- |
| `test/integration/tasks-json-startup-smoke.test.ts` | 10 pass / 0 fail / 0 skip | 24 | Startup without crash (missing/empty/malformed JSON), valid tasks display, TASKS_FILE env override, legacy tasks array handling, launcher quarantine (legacy default off), global/workspace registry quarantine, global preload sanitization, legacy escape hatch |
| `test/integration/worksystem-lanes-projection.test.ts` | 13 pass / 0 fail / 0 skip | 73 | Bridge-shaped projection ingest without warnings, attach/visibility evidence ingested, absence of attach/visibility forward-compatible, projection rows grouped by project_ref.id, zero-config reads from ~/.config/openclaw/lanes.json, null project_ref quarantine, session-less envelope visible with placeholder session, primary records win over projection rows (both file-order cases), unsupported version fallback, missing lanes collection fallback, malformed envelopes skipped without dropping siblings, workroom_ref/work_item_ref surface on ingested row (PAR-239) |
| `test/integration/lane-registry-projection.test.ts` | 12 pass / 0 fail / 0 skip | 54 | Active LaneRef records render (screenshot regression fix), Symphony view projection, stale legacy rows stay empty under defaults, legacy diagnostics opt-in ingests full file, zero-config OpenClaw bridge registry, deprecated launcher compat registry, zero-config never resurrects stale rows, explicit empty opt-out, legacy diagnostics pinned deprecation warning, worktree lanes grouped under project_ref.id, unresolved records under UNREGISTERED PROJECTS, injectable resolver adapter |
| **Subtotal (smoke surface)** | **35 pass / 0 fail / 0 skip** | **151** | |

Full gate results (Tester, all rc=0):

- `just test` (167 files) — **2323 pass / 0 fail / 1 skip**, 6381 expect(), rc 0. The lone "skip" is a Bun-level `todo()` registration; the `just test` quality script independently confirms "Zero skipped tests."
- `just check` (Biome CI + tsc + Knip, 318 files) — **0 errors**, rc 0. (Informational Knip + `noNonNullAssertion` style warnings are not failures.)

## 4. Change made

- **Added:** `research/PAR-236-CCREL-04-DAEMON-PICKUP-SMOKE-2026-06-23.md` (this file).
- **Nothing else touched.** No source, tests, config, packaging, or version bump. Matches the repo's `research/` convention (uppercase-kebab-case, dated, committed with a `docs(research):` message), mirroring the PAR-195 / PAR-239 dogfood-marker practice.

## 5. Constraints honored

- No publish, push, tag, marketplace release, external writes, or destructive reset.
- No Symphony/OpenClaw/launcher config touched; no `tasks.json` write.
- `git status --porcelain` clean after commit.
- Conventional commit; hooks honored (no `--no-verify`).
- Staged only the marker path (`research/PAR-236-CCREL-04-DAEMON-PICKUP-SMOKE-2026-06-23.md`); `git add -A` not used.
