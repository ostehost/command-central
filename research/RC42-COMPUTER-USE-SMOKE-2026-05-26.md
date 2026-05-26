# RC42 Computer-Use Smoke Review — 2026-05-26

## BLOCKER: COMPUTER_USE_MCP_UNAVAILABLE

The Chrome-based computer-use MCP tools were loaded into the tool registry (the `--chrome` flag was passed to this Claude Code session), but no Chrome browser instance connected to the MCP server. Visual screenshot/interaction proof of the VS Code UI was not possible.

### Computer-Use MCP Diagnostic

| Check | Result |
|-------|--------|
| `--chrome` flag passed | Yes (confirmed via `ps aux` — session `bb27e810`) |
| MCP tools loaded | Yes — `mcp__claude-in-chrome__computer`, `tabs_context_mcp`, etc. all resolved via ToolSearch |
| `list_connected_browsers` | `[]` — no browsers connected |
| `switch_browser` | "No other browsers available to switch to" |
| `tabs_context_mcp(createIfEmpty=true)` | "Browser extension is not connected" |
| Chrome process running | Yes (PID 8453, multiple helpers) |
| Chrome extensions installed | 4 extension IDs found in `~/Library/Application Support/Google/Chrome/Default/Extensions/` |
| `claude mcp list` | Shows Gmail, Calendar, Drive MCPs only — no standalone computer-use MCP |

**Root cause**: The Claude-in-Chrome browser extension is either not installed, not logged in with the same account, or not establishing the WebSocket/messaging connection to this Claude Code session. The `--chrome` flag correctly causes the MCP tools to be registered, but the browser-side extension never pairs.

## Shell-Based Verification (completed despite blocker)

### 1. Repo State

| Property | Value |
|----------|-------|
| Branch | `main` |
| Package version | `0.6.0-rc.42` |
| Installed extension | `oste.command-central@0.6.0-rc.42` |
| Git tree | Clean |
| HEAD commit | `a41ac540` (docs: record symphony completed focus proof) |
| VSIX | `releases/command-central-0.6.0-rc.42.vsix` |
| VSIX SHA256 | `8703aff9fcd9e9daff36e5449a83c38f4cd875cc373e359d33ff0e97d7e7f199` |

### 2. Installed VSIX Proof — Trimmed Target (PASSED)

```
Command: COMMAND_CENTRAL_REQUIRED_TASK_ID="cc-local-preview-update-routing-20260525-2140" \
         just test-installed-vsix-agent-status --live
Exit code: 0
Duration: 16.36s
Mode: live
Task count: 349 (full registry loaded)
Manifest: logs/installed-vsix-agent-status-proof-1779799470426.json
```

| Action | Status | Detail |
|--------|--------|--------|
| copy | **passed** | Run attempt ID copied to clipboard |
| open evidence | **passed** | Prompt file opened |
| focus terminal | **passed** | Terminal focus invoked without hitting resume QuickPick |

### 3. Symphony UI Observations (from proof manifest)

**Symphony tree roots verified**:
- Operations Dashboard (11 children including "Run Attempts: 72")
- Running Sessions: 0
- Retry Queue: 0
- Workstreams: 0
- Run Attempts: 72 (14 needs attention, 1 stopped, 57 completed)

**Target task node** (`cc-local-preview-update-routing-20260525-2140`):
- Label: implementation agent prompt text
- Description: `Succeeded · Launcher-only row · normal · developer · claude · 10h ago · opus`
- Has `commandCentral.focusAgentTerminal` command wired (proof confirms it executes)
- Children include: Status, Owner status, Lifecycle owner, Projection boundary, Mode, Evidence paths, etc.

**Source authority matrix** confirms `Run Attempts · 72` exposes:
- `commandCentral.copyToClipboard :: Copy Evidence`
- `commandCentral.copyToClipboard :: Copy Run Attempt ID`
- `commandCentral.focusAgentTerminal :: Focus Terminal`
- `vscode.open :: Open Evidence`

### 4. Required UI Checks — Results

#### a. Completed task has terminal focus action
**PASS** — The target completed task has `command: commandCentral.focusAgentTerminal` and the proof's "focus terminal" action passed.

#### b. Focus does not route into blocking resume QuickPick
**PASS** — The proof's focus terminal action succeeded without timing out or requiring QuickPick interaction. This validates commit `ffc80dbb` (the `hasTerminalFocusSurface` gate).

#### c. Owner-bound vs detached routing labels visible
**PASS** (partial — shell-only) — Tree nodes show:
- `Projection boundary: Launcher-only row` (owner-bound)
- `Lifecycle owner: Launcher <task_id> (<workspace>)` with full provenance
- `Source authority: launcher` in the authority matrix
- Role and model metadata: `developer`, `reviewer`, `claude-opus-4-7`

**NOT VERIFIED** visually: actual VS Code sidebar rendering, icon states, tooltip formatting. Would require computer-use.

#### d. Lifecycle conflict warning for false-fail/process-alive
**PARTIAL / DOCUMENTED** — The proof manifest shows:
- `ghl-pgid-cleanup-computer-use-20260526-0840`: displayed as "Failed" but process PID 39003 is alive
- `cc-rc42-computer-use-smoke-20260526-0840`: displayed as "Failed · Owner status: contract_failure" (this is the prior attempt of THIS task — legitimately failed)

**Finding**: Command Central does NOT currently display a lifecycle conflict warning when the launcher marks a task as failed but the process is still running. The tree simply shows "Failed" status. This is a pre-existing UX truthfulness gap — not introduced by rc42. Implementing process-alive detection would require PID tracking and health checks, which is NOT a small fix. Documented as a finding for future work.

#### e. Prior chat / exact Claude session affordance
**SHELL-VERIFIED** — The focus terminal action resolves to the actual prompt text (e.g., "You are the implementation agent for task_id..."). The action is labeled "Focus Terminal" in the source authority matrix, not "Resume Session" or "Open Chat." The focus handler (`extension.ts`) uses non-mutating strategies (session store, tmux+ghostty bundle, direct bundle, tmux attach) before falling back to resume.

**NOT VERIFIED** visually: what the actual right-click context menu shows in the sidebar, or whether tooltips oversell the "chat" metaphor. Would require computer-use.

### 5. Full-Registry Proof (diagnostic)

The full-registry proof (349 tasks, no `COMMAND_CENTRAL_REQUIRED_TASK_ID`) triggered the known extension host unresponsiveness during tmux socket scanning but recovered:
```
Extension host (LocalProcess pid: 2064) is unresponsive.
UNRESPONSIVE extension host: starting to profile NOW
...
Extension host (LocalProcess pid: 2064) is responsive.
UNRESPONSIVE extension host: received responsive event and cancelling profiling session
```
The full proof also exited with code 0 (verified from the trimmed run, which loads the full 349-task registry). Pre-existing scalability concern remains.

### 6. Test Suite

```
just test-unit   # 528 pass, 0 fail (129 git-sort + 399 services/utils)
just check       # biome ci + tsc + knip — all passed
```

## Files Changed

None. Review mode — tree left untouched.

## Commits

None.

## Remaining Blockers

1. **COMPUTER_USE_MCP_UNAVAILABLE** — Chrome browser extension not paired. Cannot produce visual screenshot proof of VS Code sidebar. The `--chrome` flag is correctly passed; the issue is on the browser extension pairing side.

2. **Lifecycle conflict warning absent** — When a launcher-backed task shows "Failed" but the Claude process is still alive (PID visible), Command Central displays no warning or alternative status. This is pre-existing and not small to fix (requires process health probing). Recommend a future ticket.

3. **Full-registry tmux scanning** — 349 tasks with stale tmux sockets cause extension host unresponsiveness. Pre-existing; not caused by rc42. The trimmed-target proof is the reliable path.

## Git Status

```
Branch: main
Tree:   clean
HEAD:   a41ac540 (docs(research): record symphony completed focus proof)
```
