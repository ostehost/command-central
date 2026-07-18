# PAR-243 — [M1HOOK-01] Authenticated Hook HTTP Workroom Route Smoke Harness

- **Task:** `symphony-PAR-243-201fe811` (visible Command Central implementation lane)
- **Date:** 2026-06-23
- **Linear:** PAR-243 (Command Central project, State: Todo)
- **Machine:** Mike's MacBook Pro (user `ostehost`)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main`
- **Mode:** Agent Teams delegate (lead + Implementer + Tester, both Sonnet)
- **Scope:** local only, test + docs. No bundled bridge / source / config / version touched. No push / tag / publish / marketplace release / external writes / destructive reset.

---

## 1. What this marker documents

PAR-243 asks: "Codify the authenticated hook → HTTP → workroom route smoke harness." The existing two tests in `test/scripts/work-system-bridge-workroom.test.ts` (introduced in PAR-239) exercised the `outbox` transport mode only. The production route that delivers a lane-ref to the workroom is `http` mode — it had **zero test coverage** before this lane. This lane adds the smoke test that proves the HTTP path end-to-end through the SHIPPED bundled artifact.

---

## 2. The authenticated hook → HTTP → workroom route

The route exercised by the new smoke test is:

```
env-less authenticated Stop-hook invocation
  → work_system_emit_lane_ref_for_task(tasks_file, task_id, "completed")
  → row-backs workroom_ref / work_item_ref from the tasks.json row via
    work_system_lane_ref_enrich()          (PAR-239 fix, now also tested here)
  → _work_system_bridge_transport() dispatches by OSTE_WORK_SYSTEM_BRIDGE=http
  → work_system_bridge_post_http()
  → curl -s -m <timeout> -X POST -H 'Content-Type: application/json'
         --data-binary "$update" "$OSTE_WORK_SYSTEM_BRIDGE_ENDPOINT"
```

All of this lives in the bundled artifact at
`resources/bin/scripts/lib/work-system-bridge.sh`. The test drives that exact
file — no shim, no mock, no alternate code path.

### What "authenticated" means in this context

"Authenticated" describes the **operational context** — it does NOT mean the
bundled bridge sends an `Authorization` header:

1. **Authenticated agent session**: the Stop hook fires at the end of a real,
   authenticated Claude Code agent session (authenticated via the
   apiKeyHelper / `claude-token-helper.sh` path). The hook is part of the
   project's DCG hook chain (`hooks/claude/`) and runs inside that
   authenticated context.

2. **Gateway-authenticated ingest endpoint**: the workroom ingest route
   (OpenClaw Work System) requires authentication at the gateway level —
   the caller presents credentials before the POST body reaches the plugin.
   The bridge header documents "gateway auth" on the
   `/work-system/ghostty/reconcile` ingest route.

**The bundled bridge's lane-ref POST itself sends no `Authorization` header.**
We deliberately did not fabricate one:

```bash
curl -s -m "$timeout" -X POST \
  -H "Content-Type: application/json" \
  --data-binary "$update" \
  "$endpoint" >/dev/null 2>&1 || true
```

Adding a header would (a) break the PAR-239 bundled↔canonical byte-match
invariant and (b) require a cross-repo launcher change in
`~/projects/ghostty-launcher` (canonical owner of the bridge). If a real
Bearer / gateway-token on the POST is desired, that is a launcher-owned
next step, not part of this smallest-safe change.

The smoke test therefore asserts the POST body, not any Authorization header.

---

## 3. What the new smoke harness covers

**Test file:** `test/scripts/work-system-bridge-workroom.test.ts`
**New describe block:** "bundled work-system-bridge.sh — authenticated hook HTTP workroom route (PAR-243)"

### Concurrency design (critical for correctness)

`spawnSync` was explicitly **not** used for this case. `spawnSync` blocks the
Node/Bun event loop, preventing `Bun.serve` from accepting the curl connection
while the bash subprocess is running — a deadlock. The test uses async spawn
(`node:child_process` `spawn` wrapped in a Promise that resolves on `close`) so
both the subprocess and the in-process HTTP server can make progress
concurrently.

### Test setup

| Component | Detail |
| --- | --- |
| Capture server | `Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })` — OS assigns port; `127.0.0.1` avoids IPv4/IPv6 flakiness |
| Endpoint | `http://127.0.0.1:${port}/plugins/work-system/lane-ref` (verbatim via `OSTE_WORK_SYSTEM_BRIDGE_ENDPOINT`) |
| Env simulation | Inherits PATH + HOME; deletes `OSTE_WORKROOM_REF` and `OSTE_WORK_ITEM_REF` — exact env-less Stop-hook simulation |
| Bridge mode | `OSTE_WORK_SYSTEM_BRIDGE=http` |
| Timeout guard | `Promise.race([capture, 5 s rejection])` — test fails fast with a clear message instead of hanging in CI |
| Cleanup | `server.stop()` + `rmSync` in `finally` |

### Tasks.json fixture row

Carries `workroom_ref: "discord:room-xyz"` and `work_item_ref: "linear:PAR-243"`
persisted at spawn time — the same shape the actual Stop hook reads from
`tasks.json` in production.

### Assertions on the captured POST body

| Assertion | Value |
| --- | --- |
| `body.kind` | `"lane_ref_update"` |
| `body.workroom_ref` | `"discord:room-xyz"` (row-backed despite env-less) |
| `body.work_item_ref` | `"linear:PAR-243"` |
| `body.lane_ref.status` | `"completed"` |
| `body.lane_ref.task` | task id |

These five assertions collectively prove: the HTTP transport fires, the
enriched envelope is delivered over the wire, and the PAR-239 row-back
mechanism works on the `http` path (not just on `outbox`).

---

## 4. Verification

### New smoke test (Implementer, commit `29b09654`)

Stable across 3 consecutive runs — no flakiness or hangs observed:

```
bun test test/scripts/work-system-bridge-workroom.test.ts

bun test v1.3.13 (bf2e2cec)

 3 pass
 0 fail
 15 expect() calls
Ran 3 tests across 1 file. [352.00ms]
```

(3 tests: 2 original PAR-239 outbox tests + 1 new PAR-243 HTTP smoke test.)

### Full gates (Tester, task #2)

- `just test` (167 files) — **2324 pass / 1 skip / 0 fail**, 6387 expect(), rc=0. The lone skip is the Bun-level `todo()` quality-gate registration line; the `just test` quality script independently confirms "Zero skipped tests."
- `just check` (Biome CI + tsc + Knip, 318 files) — **0 errors**, rc=0. (Informational Knip + `noNonNullAssertion` style warnings are not failures.)
- Bundled vs canonical `resources/bin/scripts/lib/work-system-bridge.sh` ↔ `~/projects/ghostty-launcher/scripts/lib/work-system-bridge.sh` — **empty diff (rc=0)**, byte-for-byte identical; bundled bridge untouched by this lane.

---

## 5. Change made

- **Modified:** `test/scripts/work-system-bridge-workroom.test.ts` — one new `describe` block + `runBridgeEmitHttp` async helper (153 insertions). Commit `29b09654`.
- **Added:** `research/PAR-243-M1HOOK-01-AUTH-HOOK-WORKROOM-ROUTE-SMOKE-2026-06-23.md` (this file).
- **Nothing else touched.** No bundled bridge, no other source, no config, no packaging/version bump. The bundled bridge stays byte-for-byte canonical (PAR-239 invariant honored).

Commits on `main` (ahead of `origin/main`):
- `29b09654` — `test(work-system-bridge): smoke authenticated hook HTTP workroom route (PAR-243)`
- this commit — `docs(research): record PAR-243 authenticated hook HTTP workroom-route smoke marker (symphony-PAR-243-201fe811)`

---

## 6. Constraints honored

- Bundled bridge (`resources/bin/scripts/lib/work-system-bridge.sh`) untouched — byte-for-byte canonical.
- No publish, push, tag, marketplace release, external writes, or destructive reset.
- `git add` staged only the marker path; `git add -A` not used (sibling lanes share this working copy).
- Conventional commit; hooks honored (no `--no-verify`).
- `just check` green before commit.
