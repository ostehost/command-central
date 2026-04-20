# Command Central — Manual Terminal Pickup

**Task:** `cc-manual-terminal-pickup-20260420-1710`
**Date:** 2026-04-20
**Author:** implementation agent (autonomous research)
**Outcome:** Research + convention proposal. No code change landed.

> **⚠️ Superseded — 2026-04-20.** The "adoption sidecar" recommendation in this
> document was reviewed against a stricter native-OpenClaw / Claude-Code bar
> in `research/COMMAND-CENTRAL-NATIVE-MANUAL-ADOPTION-CONTRACT-2026-04-20.md`
> and **rejected**. Do not implement `AdoptSidecarWatcher`, do not add
> `commandCentral.discovery.adoptDir`, do not document the `cc-adopt` fish
> helper. The native contract is `oste-launch` (already wrapped by CC's
> `Launch Agent` command); the near-term roadmap item is `oste adopt-pid` in
> `oste-cli`, not a new discovery source in Command Central. Read the verdict
> document first before acting on any recommendation below.

---

## Problem statement

A human partner sometimes launches a "side-quest" Claude (or Codex / Gemini)
manually — not through the Ghostty launcher, not through the VS Code extension's
`Launch Agent` command. Examples:

- `claude` in a native macOS Terminal.app tab
- `claude` in a VS Code integrated terminal
- `codex` in an ssh session nested inside a tmux pane the launcher doesn't own

They want Command Central's Agent Status tree to **discover, label, and monitor
that lane** with the same confidence the launcher enjoys. Today, that lane is
invisible or filtered out in almost every flavour of "manual."

This doc characterises the gap, proposes a narrow opt-in convention, and
recommends the next step.

---

## Current discovery path (as of `e9ba5ea`, v0.6.0-rc.4)

Four sources feed `AgentRegistry` (`src/discovery/agent-registry.ts:1-27`):

| Source | Mechanism | Picks up manual terminals? |
| --- | --- | --- |
| **ACP sessions** | `openclaw tasks --runtime acp` — background managed agents | No — ACP-managed only |
| **Launcher `tasks.json`** | `~/.config/ghostty-launcher/tasks.json` (or `$TASKS_FILE`) | No — only launcher-spawned lanes |
| **SessionWatcher** (`~/.claude/sessions/<PID>.json`) | fs watcher + `ps -p <pid> -o command=` re-check | **Partial.** File exists for every Claude REPL, but `AGENT_MODE_RE` (`-p\|--print\|exec\|--prompt\|--resume`) filters bare interactive `claude` out (`session-watcher.ts:19-20,170-183`). |
| **ProcessScanner** (`ps -eo … / lsof`) | Regex-matches agent binaries | **Partial.** Interactive lanes are rejected as `interactive-process` noise unless a launcher task already claims the PID (`process-scanner.ts:399-421, 552-562`). |

### The concrete gap

For an ad-hoc `claude` (no `-p`), Command Central sees the session file and the
process, then **filters both** because nothing claims the PID. The prior
truth-hierarchy work explicitly names this:

> "Process scanner only consults launcher tasks.json. Interactive Claude lanes
> started outside the launcher are still filtered as noise. That's the correct
> behaviour for now (we shouldn't claim every random Claude is a task), but it
> means external launches won't appear in the discovered list."
> — `research/COMMAND-CENTRAL-INTERACTIVE-CLAUDE-VISIBILITY-2026-04-20.md:150-153`

So the gap isn't a bug — it's a deliberately narrow filter, erring on the side
of "don't hijack every REPL the user has open." The missing piece is a
**user-driven opt-in** that crosses the filter cleanly.

### What *does* work today

- **Agent-mode CLIs** (`claude -p …`, `codex exec …`, `gemini --prompt …`)
  discovered via both session file and process scan, regardless of launcher.
- **Launcher-claimed interactive lanes** (via `task.pid` in `tasks.json`) —
  survive the interactive-process filter thanks to `isLauncherClaimedPid()`
  (`process-scanner.ts:552-562`).

Everything else in a manually-opened terminal is invisible to CC.

---

## Conventions considered

All five candidate conventions were evaluated against three criteria:
(1) humans can realistically adopt it, (2) zero risk of false-positives flooding
the tree, (3) low implementation cost that slots into the existing truth
hierarchy.

### 1. Adoption sidecar directory — **recommended**

User (or a one-line shell alias) drops a JSON file at
`$HOME/.claude/cc-adopt/<PID>.json`:

```json
{
  "pid": 12345,
  "cwd": "/Users/ostehost/projects/foo",
  "backend": "claude",
  "label": "review PR #42",
  "startedAt": 1745164800000,
  "sessionId": "optional-claude-session-id"
}
```

A new `AdoptSidecarWatcher` (modelled on `SessionWatcher`) watches the
directory with `fs.watch`, validates each file, confirms the PID is alive, and
emits a `DiscoveredAgent` with `source: "adopt-sidecar"`. The adoption sidecar
**bypasses** the `AGENT_MODE_RE` / `isAgentModeProcess` filters because it is
an explicit, user-authored declaration: "yes, track this."

**Why it's the best fit:**
- **Zero ambiguity.** The user wrote the file. We don't have to guess whether
  every bare `claude` is a side-quest.
- **Mirrors the existing pattern.** `SessionWatcher` is already the template —
  watcher + PID alive check + emit — so the new code slots into
  `AgentRegistry.mergeDiscoverySources()` with no shape changes.
- **Launcher-compatible.** If the user later starts launcher-managed work in
  the same project, `matchesLauncherTask()` suppression
  (`agent-registry.ts:398-441`) still deduplicates.
- **Trivial to write from any shell:**
  ```fish
  # one-shot helper
  function cc-adopt
    set -l pid (pgrep -n claude)
    set -l cwd (lsof -p $pid -d cwd -Fn | grep '^n' | sed 's/^n//')
    mkdir -p ~/.claude/cc-adopt
    printf '{"pid":%d,"cwd":"%s","backend":"claude","startedAt":%d}\n' \
      $pid "$cwd" (date +%s)000 > ~/.claude/cc-adopt/$pid.json
  end
  ```
- **Cleans itself up.** The watcher prunes entries whose PID is dead on its
  next tick, same as `SessionWatcher`.

**Sharp edges / tradeoffs:**
- Requires a helper or docs — it is not zero-touch. The user has to remember
  to run it. Not a deal-breaker: the same kind of user burden as naming a
  launcher lane.
- Sidecars for stale PIDs could theoretically match a *recycled* PID. Mitigate
  by also storing and validating `startedAt`: reject the sidecar unless
  `ps -p <pid> -o lstart=` returns a start time within ±5 s of the claim.
- Cross-platform path: keep the watcher under `os.homedir()` so it works on
  Linux/macOS/WSL without surprises.

### 2. Environment-variable marker — **possible, platform-bumpy**

User launches `CC_ADOPT=1 claude`. Process scanner reads env via
`ps -E -p <pid>` (macOS) or `/proc/<pid>/environ` (Linux) and keeps any
PID whose environ contains `CC_ADOPT=1`.

**Pros:** Zero filesystem footprint. Survives for the lifetime of the process
exactly; no cleanup logic needed. Extensible to richer markers
(`CC_ADOPT_LABEL=…`).

**Cons:**
- `ps -E` on macOS only exposes env for the current user's processes and
  parses awkwardly (env tokens get interleaved with the command column).
  Parser would need a careful rewrite of `parsePsOutput`.
- Linux uses `/proc/<pid>/environ`, a NUL-separated read; macOS has no
  equivalent. Forking the code path by platform grows the surface area.
- Adds a `ps -E -p <pid>` call per candidate (or rewires the single scan),
  which compounds the 5 s poll into more work.

This is a viable long-term option but the code lift is 3× the sidecar and the
payoff (not having to write a file) is modest.

### 3. Loosen the SessionWatcher filter globally — **rejected**

Simplest possible change: remove `AGENT_MODE_RE` from
`session-watcher.ts:170-183`. Every session file is trusted.

**Why rejected:** Claude Code writes a session file for every REPL. On a
dev machine with multiple casual `claude` windows open (docs lookups, quick
questions, an idling terminal), CC would light up with phantom "tasks." The
existing filter is load-bearing — the prior truth-hierarchy work
explicitly chose this filter to avoid over-claiming. Removing it undoes
that decision.

### 4. Named-terminal / cwd marker — **rejected**

Convention: terminal title contains a magic string, or cwd matches a tagged
pattern. Both require either VS Code terminal APIs (we don't currently
subscribe to `onDidOpenTerminal` — see `grep` audit) or deep filesystem
heuristics, and neither is robust in tmux/ssh.

### 5. Launcher-compatible `tasks.json` injection — **rejected for this scope**

User writes a full `AgentTask` into `~/.config/ghostty-launcher/tasks.json`
so every truth-hierarchy path (receipts, tmux health, stream file, etc.)
applies. The required shape is documented in
`COMMAND-CENTRAL-LAUNCHER-TRUTH-HIERARCHY-2026-04-20.md`.

Would work but is heavy:
- User has to mint a task_id, backend, timestamps, and optionally a
  stream_file path that nothing is writing.
- Without `oste-complete.sh` writing a receipt, the "completion" tier never
  fires — the record sits in `running` until CC's Tier-4 fallback kicks in.
- Collisions with launcher-owned state are a real risk: if the launcher
  rewrites tasks.json, a manual record could be nuked.

Better as a follow-up *once the sidecar lands and we know what metadata users
actually fill in.*

---

## Recommended implementation (sketch, for the next task)

Files to touch (estimated ~200 lines + tests):

1. **`src/discovery/types.ts`** — extend `DiscoverySource` with
   `"adopt-sidecar"`.
2. **`src/discovery/adopt-sidecar-watcher.ts`** (new) — mirror of
   `session-watcher.ts`:
   - Watches `$HOME/.claude/cc-adopt/` (configurable via
     `commandCentral.discovery.adoptDir`).
   - Parses JSON, requires `{pid, cwd, startedAt}`, tolerates missing
     `backend`/`label`/`sessionId`.
   - Validates `pid` is alive; optionally cross-checks `ps -p <pid>
     -o lstart=` against `startedAt` (±5 s) to defend against PID recycling.
   - Emits `DiscoveredAgent` with `source: "adopt-sidecar"`.
3. **`src/discovery/agent-registry.ts`**:
   - Construct the watcher alongside `SessionWatcher`.
   - Wire it into `mergeDiscoverySources()` so adoption agents merge with
     session and process sources. Give it the highest *discovery-source*
     priority below launcher (insert between `session-file` and `launcher`
     in `sourcePriority()`).
   - `matchesLauncherTask()` is unchanged — if the launcher later adopts the
     PID, the existing suppression kicks in.
4. **`package.json`** — add `commandCentral.discovery.adoptDir` config
   (scope: machine), default `""` meaning "auto-detect at
   `~/.claude/cc-adopt`".
5. **`src/providers/agent-status-tree-provider.ts`** — already renders
   `DiscoveredAgent`s; no change required for basic visibility. Optional
   polish: surface `label` in the tree-item description when present so the
   human can tell side-quests apart at a glance.
6. **Tests**:
   - `test/discovery/adopt-sidecar-watcher.test.ts` — read/parse, PID-alive
     prune, PID-recycle guard via `startedAt`, malformed JSON is ignored.
   - `test/discovery/agent-registry.test.ts` — adoption agent survives the
     existing interactive-process filter and is visible in
     `getDiscoveredAgents()`.
   - `test/tree-view/agent-status-adopt-sidecar.test.ts` — optional, for
     the label-in-description polish.
7. **Docs** — a short section in `CLAUDE.md` or a new
   `docs/MANUAL-ADOPTION.md` describing the `cc-adopt` convention and the
   one-line helper.

Keep it strictly additive: no change to existing filters, no change to
launcher truth-hierarchy code. The adoption agent stands on its own as a
discovery source, and the tree view picks it up with no new routing.

---

## Was a safe implementation made this pass?

**No.** This task is scoped as research + proposal. Landing the watcher
cleanly needs:

- A dedicated unit-test pass that covers the PID-recycle edge case.
- Config schema work in `package.json` that should get the same review
  treatment as other `commandCentral.discovery.*` settings.
- A short docs update users can copy-paste from.

Those are cheap but they deserve their own commit with a proper changelog
entry and a dogfood pass — the kind of shape `cut-preview` catches. Ship it
as the next task, not as a side-effect of research.

The handoff doc itself is the committed artifact for this task.

---

## Exact tests run

- `just check` — executed after authoring this doc. Confirms the tree is
  clean (biome + tsc + knip) with no drift caused by the research pass.

No test suite change, no new unit tests; no code paths were modified.

---

## Next recommended step

1. **Implement the adoption sidecar watcher** per the sketch above.
   Estimated effort: half a day including tests and docs. Task id suggestion:
   `cc-adopt-sidecar-watcher-20260421-0900`.
2. **Ship a one-line `cc-adopt` shell helper** in the `oste-cli` (or as a
   documented snippet) so the user experience is a single command.
3. **Revisit the `CC_ADOPT=1` env-var path** once the sidecar is in the
   field for ~two weeks of dogfooding. If users consistently forget to run
   the helper, the env-var path's zero-touch appeal may outweigh its
   platform complexity — at which point it becomes a cross-platform polish
   task, not a foundational one.
4. **Parallel follow-up:** file an upstream ask with Claude Code / Codex /
   Gemini teams to write a `sessionId` and `cwd` marker that includes an
   explicit `adopted_by` hint. If the CLI itself emits that, the sidecar
   becomes a compatibility shim rather than the only source of truth.
