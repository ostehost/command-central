# Command Central — Native Manual-Adoption Contract (Verdict)

**Task:** `cc-native-manual-adoption-contract-20260420-1720`
**Date:** 2026-04-20
**Author:** implementation agent (autonomous review)
**Reviews:** `research/COMMAND-CENTRAL-MANUAL-TERMINAL-PICKUP-2026-04-20.md`
**Outcome:** **Verdict B — reject the sidecar proposal; revise the recommendation.** No code change landed. Prior research doc updated with a superseded banner.

---

## TL;DR

The just-landed proposal to ship a `~/.claude/cc-adopt/<PID>.json` sidecar is a non-native invention dressed up as a convention. It squats in another tool's namespace, adds a third truth source where two already exist, and hands the user a hand-rolled fish helper as the "user experience." Against the stricter product bar — native to OpenClaw and Claude Code, no hidden sidecars, no fake launcher identity, no demo-only conventions — it does not survive review.

The native contract for manual adoption already exists: **`oste-launch` (the launcher CLI)**, wrapped by Command Central's `Launch Agent` command. For users who want a side-quest tracked, the durable answer is "launch through the launcher," not "drop a JSON file in Claude Code's home directory."

For users who already have a manual REPL they want to retroactively promote, the right place to add a primitive is **in `oste-cli` (a future `oste adopt-pid` subcommand)**, not in Command Central via a new discovery source. Once oste-cli supports adoption, Command Central needs zero changes — the existing launcher truth-hierarchy machinery picks it up automatically.

---

## Why the sidecar proposal fails the stricter bar

### 1. Namespace squatting in `~/.claude/`

`~/.claude/` is owned by the Claude Code CLI. Putting a Command Central convention at `~/.claude/cc-adopt/` is the same anti-pattern as third-party tools dropping files into `~/.gitconfig.d/cc-extras/`. Claude Code is free to clean, restructure, or fail loudly on unknown subdirectories under its own namespace at any time. We do not own that path.

The right home for a CC-only convention would be `~/.config/command-central/` or `~/.openclaw/` — but adding a *third* well-known directory to the discovery surface is itself the smell. We already have two (`~/.claude/sessions/` for native session truth, `~/.config/ghostty-launcher/tasks.json` for launcher truth). A third invented for one feature is the wrong shape.

### 2. Adds a third truth source for one user gesture

Today's truth hierarchy
(`research/COMMAND-CENTRAL-LAUNCHER-TRUTH-HIERARCHY-2026-04-20.md`) is deliberately layered: the launcher is primary, the session-file watcher and process scanner are secondary corroboration. The sidecar proposal would slot a *new* source between launcher and session-file — outranking Claude Code's own session file but with weaker provenance (a JSON file the user authored vs. one the CLI wrote).

Every additional truth source is a future bug. The launcher-truth-hierarchy work just unwound the consequences of overlapping signals (stale-stream silence, dead-pane evidence, discovered sessions, receipts). Adding another opt-in source that says "trust me, I'm an agent" inverts the direction we just pushed in.

### 3. Demo-only convention dressed as a contract

The proposal's own implementation guide includes a fish function the user is expected to copy-paste. That is not a contract; it is a demo. Real contracts ship as commands the user runs (`oste-launch`, `code --install-extension`), not as snippets to paste into rc files. If we cannot put the gesture behind a binary, we should not be encouraging users to paste shell into their dotfiles.

### 4. PID-recycle defenses are brittle

The proposal hedges with a `lstart` ±5s check to defend against PID recycling. This is the canonical "we know it's a hack so we added a guard" pattern. The guard works in steady state but rots fast: process start times drift, the launcher already wrestles with `lstart` parsing differences across macOS / Linux / WSL. Every guard is a future test, every test is a future flake.

### 5. Fake launcher identity

The sidecar bypasses both load-bearing filters (`AGENT_MODE_RE` in `session-watcher.ts:170-183`, `interactive-process` in `process-scanner.ts:399-421`) by introducing a parallel "I'm explicitly opted in" lane. That is exactly the kind of fake-identity workaround the stricter bar rules out. The filters exist because the prior interactive-Claude-visibility work concluded that pretending every REPL is a task over-claims. The sidecar proposal smuggles "this REPL is a task" past those filters via a JSON file.

---

## Native options considered

### A. Use the existing launcher (recommended demo posture)

`commandCentral.launchAgent` (`src/extension.ts:2978-3041`) already shells out to `oste-launch` via `buildOsteSpawnCommand()`. That is the native contract. Anything launched through it gets a real `tasks.json` record, a real PID, a real stream file — and benefits from the full Tier 1–4 truth hierarchy without any new code in Command Central.

Cost: zero. Already shipped. The only gap is *user education* — make it obvious that "if you want it tracked, launch it via Command Central or `oste-launch`."

### B. Adoption primitive in `oste-cli` (recommended near-term roadmap)

If a user wants to promote a *running* manual PID into a tracked lane, the durable place to add that capability is in `oste-cli` (the launcher repo), not Command Central. Sketch:

```bash
oste adopt-pid <PID> --label "review PR #42" [--backend claude]
# → mints a task_id, captures cwd via lsof, writes a real tasks.json
#   record with status=running and pid=<PID>.
```

Once that exists, **Command Central needs zero changes**: `process-scanner.ts:552-562` already retains interactive PIDs that a launcher task claims via `task.pid`, and `agent-registry.ts:398-441` already deduplicates discovered agents against launcher tasks by PID / session_id / project_dir.

This is the path option (5) in the prior research dismissed as "heavy." It is heavy *for the user* if they have to mint the record by hand. It is the right weight for a single CLI subcommand. The heaviness was misallocated to the wrong layer.

### C. Loosen the AGENT_MODE_RE filter — rejected (same reason as before)

The filter exists deliberately. Removing it floods the tree with phantom REPLs. This was already evaluated and rejected in the prior research; the stricter bar gives no reason to revisit.

### D. CC_ADOPT=1 environment variable — rejected as anti-pattern

Reading process environments (`ps -E -p <pid>` on macOS, `/proc/<pid>/environ` on Linux) to discover agents is a textbook brittle-heuristic. macOS exposes env only for the current user, parses awkwardly, and bumps the per-poll cost. Linux uses a different mechanism. The cross-platform code surface is exactly the kind of thing the stricter bar rules out as "demo-only convention." Same conclusion as the prior research, formalized.

### E. VS Code terminal hook — rejected (scope mismatch)

Subscribing to `vscode.window.onDidOpenTerminal` would only catch VS Code's integrated terminals. The motivating cases (Terminal.app, ssh+tmux) explicitly live outside VS Code. Solving 30% of the user need via a fragile detection path is worse than admitting the contract.

### F. Upstream ask: have Claude Code emit an `adopted_by` marker — file but don't depend on

The cleanest long-term answer is for Claude Code to write a richer session-file marker (e.g. an `adopted_by: "openclaw"` field set when launched under our wrapper). We should file that ask upstream. We should not ship a CC-side workaround in the meantime that we'd have to deprecate the moment upstream lands the right thing.

---

## Verdict on the sidecar proposal

**Reject.** Do not implement `AdoptSidecarWatcher`. Do not add `commandCentral.discovery.adoptDir`. Do not document the `cc-adopt` fish function. The prior research's recommendation is superseded by this verdict.

The change is purely directional — there is nothing to *un-ship* because no code landed. The prior research doc itself is preserved as an artifact of the exploration, with a superseded banner added at the top pointing at this document.

---

## Was code changed?

**No.** The sidecar was a proposal, not an implementation. There is nothing to revert. The only file modified in this pass is `research/COMMAND-CENTRAL-MANUAL-TERMINAL-PICKUP-2026-04-20.md`, which now carries a one-paragraph banner directing readers to this verdict before they act on the rejected recommendation.

The Command Central source tree is unchanged. The existing filters (`AGENT_MODE_RE`, `interactive-process`, `isLauncherClaimedPid`) continue to do exactly what the truth-hierarchy work asked of them, and they remain the correct posture.

---

## Tests run

- `just check` — clean (biome ci + tsc + knip). No source-level changes; this is a docs-only pass.

No source code changed → no unit tests added or re-run beyond the gate.

---

## Recommended product posture

### For the v0.6.0-rc.4 → 0.6.0 demo

> **Command Central tracks agents launched through OpenClaw — via the `Launch Agent` command, the `oste-launch` CLI, or any tool that writes a `tasks.json` record. Bare interactive REPLs opened outside the launcher are intentionally not adopted into the running list.**

This is already true in code. The action items are user-facing only:

1. **In demo narration, frame manual REPLs as out of scope for tracking.** "If I want this side-quest in my Agent Status tree, I launch it through CC's Launch Agent command — not by typing `claude` in a fresh terminal."
2. **No README change required.** The current README phrasing
   (`README.md:88-98`, `README.md:103-109`) already says "supported Claude Code … sessions" and "tasks.json registry tracking." It does not promise to adopt every REPL. Honest.
3. **No new config surface.** Don't add `discovery.adoptDir`. Don't add `discovery.adoptEnvVar`. Don't widen the contract.

### For the near-term roadmap (post-0.6.0)

1. **File `oste adopt-pid` against `oste-cli`.** Single subcommand, mints a launcher task record from a running PID. Zero changes to Command Central. The existing launcher-claimed-PID path picks it up automatically.
2. **File the upstream ask with the Claude Code team** for an `adopted_by` (or similar) marker in the session file. If/when that lands, the launcher's `oste-launch` can write the marker; CC can use it to *positively label* (not adopt) the lane in the tree without inventing yet another file format.
3. **Hold the line on the discovery filters.** Future patches that propose loosening `AGENT_MODE_RE` or the `interactive-process` filter need to clear the same bar this verdict applied: native, durable, no hacks.

---

## Where Command Central should draw the line

Command Central is the **observer** of OpenClaw activity. Its truth comes from sources written by other components:

- The launcher writes `tasks.json` records.
- Claude Code writes `~/.claude/sessions/<PID>.json`.
- The OS exposes processes via `ps`.
- ACP-managed tasks come from the OpenClaw ledger.

Command Central reconciles those signals into the Agent Status tree. It must not become an *originator* of new truth — that path leads to Command Central inventing its own task IDs, its own session files, its own adoption registry, and gradually competing with the launcher for source-of-truth status.

The sidecar proposal would have crossed that line. Rejecting it keeps the architecture clean: the launcher launches, Claude Code sessions, the observer observes.

---

## Files touched in this task

- `research/COMMAND-CENTRAL-NATIVE-MANUAL-ADOPTION-CONTRACT-2026-04-20.md` (new — this doc).
- `research/COMMAND-CENTRAL-MANUAL-TERMINAL-PICKUP-2026-04-20.md` (added a superseded banner pointing here).
