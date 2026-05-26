# CC Computer-Use VS Code Smoke Test

**Task ID:** `cc-computer-use-vscode-smoke-20260526-0853`
**Date:** 2026-05-26
**Type:** Verification / Smoke Test

## Results Summary

| Field | Value |
|---|---|
| `connected_browsers` | **0** — `list_connected_browsers` returned `[]` |
| `chrome_computer_tool_available` | **yes** — full MCP tool suite discovered (22 tools: `computer`, `navigate`, `find`, `read_page`, `browser_batch`, `gif_creator`, etc.) |
| `chrome_computer_tool_usable` | **no** — no browser paired; `tabs_context_mcp` returns "Browser extension is not connected" |
| `vscode_cli_version` | **1.121.0** (commit f6cfa2ea, arm64) |
| `command_central_extension_installed` | **yes** — `oste.command-central@0.6.0-rc.42` via `code --list-extensions --show-versions` |
| `command_central_direct_test_possible` | **no** — Chrome computer-use is the only path to interact with VS Code UI; it is unavailable |
| `exact_blocker` | Claude-in-Chrome browser extension is not connected. Chrome (PID 8453) is running, VS Code (PID 1529) is running, but the MCP bridge has zero paired browsers. |

## Detailed Findings

### 1. Chrome MCP Tool Discovery

ToolSearch returned 22 `mcp__claude-in-chrome__*` tools with full schemas:

- `computer` (mouse/keyboard/screenshot)
- `browser_batch` (sequential multi-action)
- `navigate`, `find`, `read_page`, `get_page_text`
- `javascript_tool`, `read_console_messages`, `read_network_requests`
- `form_input`, `file_upload`, `resize_window`
- `gif_creator`, `shortcuts_list`, `shortcuts_execute`
- `tabs_context_mcp`, `tabs_create_mcp`
- `list_connected_browsers`, `select_browser`, `switch_browser`

All tool schemas loaded successfully. The capability exists in the harness.

### 2. Browser Connectivity

```
mcp__claude-in-chrome__list_connected_browsers → []
mcp__claude-in-chrome__tabs_context_mcp → "Browser extension is not connected"
```

Chrome process is running (`pgrep` confirms PID 8453 + helpers), but the Claude browser extension either:
- Is not installed in this Chrome profile, or
- Is installed but not logged in / not paired with this Claude Code session

### 3. VS Code & Command Central State

```
$ code --version
1.121.0
f6cfa2ea2403534de03f069bdf160d06451ed282
arm64

$ code --list-extensions --show-versions | grep oste
oste.command-central@0.6.0-rc.42
```

Extension directory confirms rc.42 is the active version:
```
~/.vscode/extensions/oste.command-central-0.6.0-rc.42/
```

Historical extension host logs (2026-05-22) confirm successful activation:
```
ExtensionService#_doActivateExtension oste.command-central, startup: false, activationEvent: 'onStartupFinished'
```

No extension host logs exist for today's session (only CLI logs from `code --list-extensions` invocations), so current-session activation cannot be confirmed from logs alone.

### 4. Direct Test Feasibility

Without Chrome computer-use, there is no way to:
- Take screenshots of VS Code
- Click UI elements in the extension
- Inspect webview content rendered by Command Central
- Observe sidebar/tree providers visually

Shell-based evidence confirms the extension is **installed and was historically activating**, but **live UI verification requires a connected browser**.

## Commands & Tools Run

| # | Command / Tool | Purpose |
|---|---|---|
| 1 | `ToolSearch("claude-in-chrome browser computer")` | Discover Chrome MCP tools |
| 2 | `code --version` | VS Code CLI version |
| 3 | `code --list-extensions --show-versions \| grep -Ei 'command\|central\|oste\|partner\|openclaw'` | Extension install check |
| 4 | `mcp__claude-in-chrome__list_connected_browsers` | Browser pairing check |
| 5 | `mcp__claude-in-chrome__tabs_context_mcp` | Tab group / connection check |
| 6 | `ls ~/.vscode/extensions/ \| grep oste` | Extension directory verification |
| 7 | `ls releases/` | VSIX artifact check |
| 8 | `find ... -name 'exthost*.log'` | Extension host log discovery |
| 9 | `grep 'command-central' exthost.log` | Activation evidence in logs |
| 10 | `pgrep -la "Code"` | VS Code process check |
| 11 | `pgrep -la "Chrome"` | Chrome process check |

## Resolution Path

To unblock Chrome computer-use for VS Code extension testing:

1. **Install** the Claude browser extension from `https://claude.ai/chrome` into the running Chrome profile
2. **Log in** to claude.ai with the same account used by this Claude Code session (`mikeosterhout@gmail.com`)
3. **Pair** the browser — either via `switch_browser` (broadcasts to all extensions) or `select_browser` (with a known deviceId)
4. Once paired, `tabs_context_mcp` will return tab IDs, and `computer` can screenshot/interact with VS Code opened in the browser's display

No files were edited. No commits made. No terminals or apps closed.
