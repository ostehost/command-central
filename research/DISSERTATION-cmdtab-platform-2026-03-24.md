## Uncovered Items
- Per-project dock badge (active agent count) is not implemented.
- Dock bounce on completion/error is not implemented.
- Dock right-click menu and URL-scheme clickthrough flow are not implemented.
- NSWorkspace activation watcher for Cmd+Tab-driven VS Code workspace sync is not implemented.
- Scroll-to-last-output on focus is not implemented.

# Cmd+Tab as Platform: The Per-Project Dock Icon as Product Foundation

**Date:** 2026-03-24
**Author:** Command Central Research Synthesis
**Version:** 1.0
**Classification:** Strategic — Internal

---

## 1. Executive Summary

The central thesis is this: per-project dock identity is not a clever UI trick. It is the foundation of a new product category — the macOS-native AI agent control plane. The Ghostty Launcher's bundle-cloning architecture turns macOS's dock from an application launcher into a project-switching surface. Combined with Command Central's VS Code sidebar and its external-terminal agent auto-discovery, the result is a system with no direct competitor.

The dock icon is the hook that makes people talk. The moat is the full stack: VS Code sidebar plus external-terminal agent auto-discovery plus macOS-native integration. No competitor has all three. The closest alternatives — cmux, Emdash, dmux — each have one or two components. None have the vertical integration that Command Central's architecture enables.

**The strategic window is real and narrow.** Microsoft will add external-process agent discovery to VS Code within 6-9 months. Anthropic may add native multi-session orchestration to Claude Code's extension within 12 months. The imperative is distribution: reach 1,000 Marketplace installs before those gaps close, because distribution compounds through ranking and word of mouth even after technical differentiation narrows.

**Key recommendations:**

1. Ship Phase 1 in two weeks. The "wow demo" — dock badges, rich notifications with actionable buttons, project grouping in the sidebar — is 10-15 days of engineering. Nothing in Phase 1 requires solving hard problems.

2. The abstraction level for dock icons is project, not agent. Agent-level dock icons create dock hell. The sidebar handles sub-navigation.

3. macOS-only is a strength, not a limitation. Build the best possible macOS experience. Add Linux in Phase 3.

4. The top effort-to-wow features: dock badge showing active agent count (`NSDockTile.badgeLabel`), notification with "Review Diff" action (terminal-notifier + URL scheme), and dock bounce on completion (`NSApp.requestUserAttention`). These are days of engineering, not weeks.

5. Skip: dock progress bars (no measurable sub-steps), Cmd+Tab hover previews (public API does not exist), Split View automation (public API does not exist), AX-based tmux pane targeting (terminal emulators are opaque to the AX tree).

The market opportunity: the macOS developer running parallel AI agents is the fastest-growing, highest-paying segment in developer tools. ~8-10 million professional developers work on macOS. Winning 5,000 at $12/month is $720K ARR. The total addressable market is large enough to justify a focused, premium, macOS-native product.

---

## 2. The Cmd+Tab Thesis

### Why the Dock Is the Right Place

The macOS dock is not an application launcher. It is a spatial navigation surface. Users build muscle memory around icon position. They glance at the dock to understand what is active, not to launch things. This is why the dock succeeds as a project-switching surface where alternatives — a menu bar list, a VS Code panel, a separate orchestration app — do not.

When a developer runs five Claude Code agents across three projects, their cognitive problem is not "where are my terminals?" It is "which project needs my attention, and how do I get there instantly?" The dock solves this. The developer sees three distinct icons — each with a different emoji, each at a known position. One has a badge reading "2". That is the answer: project-auth has two agents running. Cmd+Tab brings it forward. The CC sidebar shows the two agents. One click to focus the correct terminal.

This navigation chain — dock icon to sidebar to terminal — mirrors how macOS itself structures attention management. The dock is breadcrumb level 1. The sidebar is breadcrumb level 2. The terminal is the destination.

### Why This Is a Platform Foundation, Not a Feature

A feature solves one problem. A platform enables a category of solutions.

The per-project dock identity architecture is a platform because it establishes a durable binding between a project identity and a set of system primitives: a unique `CFBundleIdentifier`, a registered URL scheme, a dock presence with badge and menu, and a notification target. Once that binding exists, every ambient-awareness feature in macOS becomes available on a per-project basis:

- A badge on the dock icon is the project's agent count.
- A right-click menu is the project's agent list with direct navigation.
- A bounce is the project's attention request when an agent completes.
- A notification action routes back to the project via URL scheme.
- An `NSWorkspace.didActivateApplicationNotification` event is the signal to switch VS Code's workspace context.

None of these features exist in isolation. They form a coherent system where the dock icon is the anchor. Remove the per-project dock identity and these features degrade into generic, project-unaware notifications and menus. That is what every competitor offers. The per-project binding is what makes this architecture categorically different.

### The Abstraction Level That Makes It Work

The correct abstraction level for dock icons is the project, not the agent session.

The math is straightforward: 20 projects times 3 agents each equals 60 dock icons. A dock with 60 items is unusable. macOS docks fail spatially beyond 15-20 items because spatial memory breaks down at that density. Agent-level dock icons recreate exactly the "terminal hell" problem this architecture exists to solve, just translated one level up to dock hell.

More fundamentally, agent sessions are ephemeral. They start, run, complete, and disappear. Dock icon positions shift when counts change. Spatial memory built on ephemeral items is no memory at all. Project-level icons are stable. A developer can build lasting muscle memory around "top-left is project-auth, second from left is project-api." That muscle memory is the UX value. Destroy it by making icons ephemeral and the entire premise collapses.

The sidebar handles agent sub-navigation. The dock handles project navigation. This division is architecturally correct and should be treated as a constraint, not a choice.

---

## 3. Platform Capabilities Deep Dive

### NSDockTile: The Core Interface

`NSDockTile` (AppKit, macOS 10.5+) is the primary interface for per-project dock customization. It exposes four capabilities relevant to Command Central:

**Badge labels.** `NSApp.dockTile.badgeLabel = "3"` renders a red circle with white text on the dock icon. Setting it to an empty string clears the badge. This is the single highest-value dock API for CC: an agent count badge gives developers ambient project awareness without any clicks. Feasibility is Easy — no special permissions, App Store compatible, stable since macOS 10.5.

**Custom content view.** `NSApp.dockTile.contentView = customView` followed by `NSApp.dockTile.display()` enables full custom drawing over the dock icon. This is how a colored ring (green/yellow/red for agent state) would be implemented. Feasibility is Medium: the view renders statically, `display()` must be called explicitly on each update, and smooth animation requires a timer loop. The [DSFDockTile](https://github.com/dagronf/DSFDockTile) library (updated April 2024) wraps this cleanly.

**Bounce animations.** `NSApp.requestUserAttention(.informationalRequest)` produces a single bounce. `.criticalRequest` bounces continuously until the app receives focus. The distinction matters: agent completion warrants informational; agent error warrants critical. Feasibility is Easy — no permissions, immediate implementation.

**Dynamic icon replacement.** `NSApp.applicationIconImage = NSImage(...)` replaces the icon at runtime. For the Ghostty Launcher bundles, the emoji icon is baked into the `.icns` at bundle creation time, which is the correct approach — it avoids runtime complexity and ensures the icon persists in the dock across restarts.

### Dock Menus: applicationDockMenu

`NSApplicationDelegate.applicationDockMenu(_:) -> NSMenu?` (macOS 10.0+) is called when a user right-clicks or holds the dock icon. It returns a dynamically-constructed `NSMenu`. For Command Central, this is the project's agent list: each menu item shows the agent name, status, and duration. Clicking an item triggers a URL scheme deep link that focuses the agent's terminal.

The implementation model: the Ghostty bundle reads a shared state file (e.g., `/tmp/cc-project-auth-status.json`) at menu-request time, constructs the menu, and returns it. The menu is rebuilt fresh on each right-click, so it always reflects current agent state.

Feasibility is Easy. No special permissions required. This is one of the most underrated features in the roadmap: it turns the dock icon into a context menu for the entire project without the user opening VS Code.

### URL Schemes: Per-Project Deep Linking

Each Ghostty bundle can register a unique URL scheme via `CFBundleURLTypes` in `Info.plist`. Example: `cc-project-auth://focus-agent/agent-id-123`. macOS Launch Services routes URL opens to the correct bundle automatically.

This creates a precise addressing mechanism: Command Central (the VS Code extension) can construct a URL that, when opened, activates a specific project's Ghostty instance and focuses a specific agent's terminal — without any ambiguity about which bundle to target.

The notification clickthrough flow depends entirely on this. terminal-notifier's `-open` parameter accepts a URL. The complete chain:

```
Agent completes
  → CC writes completion event to /tmp/cc-project-auth-status.json
  → oste-notify.sh fires notification via terminal-notifier with -open cc-project-auth://focus-agent/agent-id
  → User clicks notification
  → macOS opens cc-project-auth://focus-agent/agent-id
  → Ghostty bundle activates, handles URL in NSApplicationDelegate
  → tmux select-window targets the correct session
  → CC sidebar auto-selects the agent card
```

Feasibility is Easy. Each component of this chain is a documented, stable API.

### NSWorkspace Notifications: Smart Sidebar Sync

`NSWorkspace.shared.notificationCenter` delivers `didActivateApplicationNotification` whenever the frontmost application changes. The payload includes the new application's `bundleIdentifier`. A lightweight Swift helper binary can listen for this notification and write events to stdout, which the VS Code extension reads via a child process pipe.

The feature this enables: when a developer Cmd+Tabs to a specific project's Ghostty bundle, the CC sidebar automatically selects that project's agent group. The sidebar and the dock become synchronized views of the same project state.

Feasibility is Medium — the NSWorkspace observation is easy, but bridging it to the VS Code Node.js environment requires a small native helper. The recommended implementation: a Swift binary that the extension spawns on activation, outputting JSON events like `{"bundleActivated": "dev.partnerai.ghostty.project-auth"}`. Total engineering: ~3 days.

### What Is Genuinely Impossible

Some features that sound plausible are blocked by the absence of public APIs. These are not engineering challenges — they are hard stops.

**Cmd+Tab hover previews.** macOS's Cmd+Tab overlay is owned by the private `com.apple.dock` process. There is no public API to inject content, override preview thumbnails, or hook into hover events. The feature cannot be built. The mitigation: use descriptive tmux window titles so the stock Cmd+Tab is informative. This requires only tmux configuration.

**Split View automation.** The green traffic light's tiling behavior has no public API. `NSSplitViewController` handles within-app splits only. What IS possible: use `AXUIElementSetAttributeValue` with `kAXFrameAttribute` to resize VS Code and the Ghostty bundle to occupy opposing screen halves. This requires Accessibility permission but achieves the visual effect without the macOS animation. Implement this as a CC command ("Side by side: editor + terminal") if users request it.

**AX-based tmux pane targeting.** Terminal emulators render tmux panes as pixels, not as structured AX tree nodes. The AX tree for a Ghostty window is an opaque drawing surface. You cannot enumerate tmux panes via AX, identify pane content, or click on a specific pane by name. The correct tool for pane management is tmux's own IPC: `tmux select-window -t session:window` and `tmux select-pane -t session:window.pane`. CC already uses this. It is the right approach.

**Progress bars in the dock.** `NSDockTile` with `NSProgressIndicator` is technically possible, but useless without a quantifiable progress metric. Claude Code sessions do not have a natural "N of M steps complete" measure. An indeterminate spinner in the dock adds visual noise with no information content. Skip for all phases until agents expose structured step-completion events.

### Feasibility Summary

| Feature | API | Feasibility | Permissions |
|---------|-----|-------------|-------------|
| Dock badge (agent count) | `NSDockTile.badgeLabel` | Easy | None |
| Dock bounce on completion | `NSApp.requestUserAttention` | Easy | None |
| Right-click dock menu | `applicationDockMenu` | Easy | None |
| Static emoji icon | `NSApp.applicationIconImage` | Easy | None |
| URL scheme deep linking | `CFBundleURLTypes` | Easy | None |
| Drag files to dock icon | `LSItemContentTypes` | Easy | None |
| Activate specific app | `open -a` | Easy | None |
| Dynamic icon overlay | `NSDockTile.contentView` | Medium | None |
| Dock ring color | `NSDockTile.contentView` | Medium | None |
| Specific window focus | AppleScript / AXUIElement | Medium | AX permission |
| NSWorkspace activation watcher | `didActivateApplicationNotification` | Medium | None |
| Side-by-side layout | AX frame manipulation | Medium | AX permission |
| Split View tiling | No public API | Impossible | N/A |
| Cmd+Tab hover previews | No public API | Impossible | N/A |
| AX-based tmux pane targeting | Terminal is opaque | Hard/No | AX permission |
| Ghostty window-level IPC | Not stable yet | Hard | None |

---

## 4. User Journey Analysis

### The Scenario

A developer is working across three projects: project-auth, project-api, and project-ui. Five Claude Code agents are running: two in project-auth (one for worktree `feature/oauth`, one for `fix/session-expiry`), two in project-api (a full test rewrite and a schema migration), one in project-ui. The developer is writing code in VS Code. An agent finishes. What happens next?

### Current State: Minute-by-Minute

| Step | Action | Time | Friction |
|------|--------|------|---------|
| 1 | macOS notification "agent-auth completed" appears | 0s | — |
| 2 | Developer finishes current thought | 5-30s | Context interruption, cannot defer cleanly |
| 3 | Look at CC sidebar to identify which agent | 5s | Must switch focus to CC sidebar panel |
| 4 | Click agent card in CC sidebar | 1s | — |
| 5 | `open -a <bundle_id>` brings Ghostty to front | ~100ms | All Ghostty windows come forward, not just the right one |
| 6 | Identify correct window/tab visually | 5-10s | Mental scanning across multiple tmux windows |
| 7 | Navigate to correct tmux window | 3s | Ctrl+B, window number, or `tmux select-window` |
| 8 | Review agent output | 30-120s | Core task |
| 9 | Switch back to VS Code | 2s | Cmd+Tab |
| **Total** | | **~52-172s** | Three avoidable friction points |

### Three Friction Points to Eliminate

**Friction 1: Information deficit at notification time.** The current notification says "agent completed" and nothing else. The developer cannot triage without switching context. They do not know the exit code, how many files changed, or whether the output requires review or can wait. The fix: rich notifications with exit code, file delta, and the last meaningful output line. With terminal-notifier's `-open` parameter, clicking "Review Diff" can trigger the full navigation chain without any additional clicks.

**Friction 2: Application-level focus instead of window-level focus.** `open -a <bundle_id>` activates the Ghostty application, not a specific window. With multiple windows open, the wrong one may come forward. The fix: AppleScript window targeting (`set index of window 1 to 1`) combined with more aggressive tmux window selection. This does not require Accessibility permission for basic cases.

**Friction 3: tmux pane identification.** Even with the correct window active, if the project uses multiple tmux windows, the developer must navigate manually. CC already calls `tmux select-window`, but users do not always perceive the effect. The fix: scroll-to-last-output on focus — `tmux send-keys -t session:window "" Enter` forces a scroll-to-bottom so the developer always lands at current output.

### The North Star Flow

After Phase 1 ships, the same scenario should resolve as:

```
Agent completes
  → Rich notification: "project-auth: feature/oauth done. 14 files, +340/-87. Exit 0."
  → Actions: [Review Diff] [Open Terminal] [Dismiss]
  → Developer clicks [Review Diff] at their convenience
  → cc-project-auth://focus-agent/agent-oauth URL opens
  → project-auth Ghostty bundle activates (correct icon comes forward in dock)
  → CC sidebar auto-selects the agent card
  → VS Code diff view opens showing time-sorted changes
  → Developer is reviewing changes within 3 seconds of clicking
```

Total clicks: 1. Total keystrokes: 0. Total context-switch cost: minimal — the developer chose when to respond.

### Information Gaps at Each Stage

| Moment | Currently Available | Missing |
|--------|--------------------|---------|
| Notification arrives | Agent name, "completed" | Exit code, file delta, last output line |
| CC sidebar glance | Status, name, duration | Diff summary (+/- lines, file count) |
| After click-to-focus | Ghostty window focused | Confirmation of which pane is active |
| In terminal reviewing | Raw output | Structured summary (what succeeded, what failed) |

Closing these gaps is the Phase 1 and Phase 2 work. Each gap closure compounds: better notification means fewer clicks to CC sidebar; better focus behavior means less tmux navigation; better sidebar diff summary means less terminal time.

### Keystroke Analysis

Current best case (everything works, correct window visible): 3 clicks, 0 keystrokes.
Current typical case: 5 clicks, 4 keystrokes.
Current worst case: 8 clicks, 8+ keystrokes.

Target after Phase 1: 1 click (notification action), 0 keystrokes.
Competitor comparison: dmux's `j` to jump to pane is 1 keystroke. That is the target UX for keyboard-native workflows. The notification action path is the mouse-native equivalent.

---

## 5. Competitive Positioning

### The Moat Is Not the Dock Icon

The bundle-cloning approach — copying Ghostty.app, setting a unique `CFBundleIdentifier`, generating an emoji `.icns` via ImageMagick — is approximately 2-3 days of engineering for a motivated competitor who knows what to look for. It is not a durable moat.

The durable moat is the complete stack:

1. **VS Code sidebar integration** — Not a standalone app, not Electron, not a separate window. Native to the IDE where developers already live.
2. **External-terminal agent auto-discovery** — `ps` scanning combined with `~/.claude/` session file watching discovers agents that CC did not launch, running in any terminal. No competitor does this inside VS Code.
3. **Per-project macOS dock identity** — CFBundleIdentifier, URL scheme, badge, dock menu, bounce. The full chain.
4. **Distribution** — Marketplace installs, SEO, community presence, install count compounding via ranking.
5. **Architecture depth** — 800 tests, clean TypeScript, telemetry, URL scheme registration. A competitor starts from zero.

To replicate the full stack from scratch requires: macOS app bundle cloning pipeline, ICNS generation from emoji, URL scheme registration per project, VS Code extension with process scanning, `~/.claude/` session file parsing (requires reverse-engineering), tmux session tracking, git worktree awareness, telemetry integration, and a test suite for stability. That is a 3-4 month project for a two-person team. Command Central has a 6-month head start if Phase 1 ships in the next two weeks.

### Competitor Response Scenarios

**Scenario A: A well-funded competitor copies the dock icon trick.**

They get the dock icon. They do not get the VS Code sidebar or the external-agent auto-discovery. Their users must switch apps to manage agents; CC users stay in VS Code. This is a meaningful UX gap that distribution can widen: every install of CC before this competitor ships is a user who has already built workflows around CC.

**Scenario B: Microsoft ships external-process discovery in VS Code.**

This is the highest-probability threat. VS Code 1.109 shipped Agent Sessions View for agents VS Code spawned. External-terminal discovery is the natural next step. Timeline: 6-9 months, approximately 2-3 release cycles.

When this happens, CC's "can see external terminal agents" differentiator narrows. What remains: macOS-native dock integration (Microsoft will not build this), notification actions, dock badges, project-level identity, and any distribution advantage built in the intervening period. The goal is 1,000+ installs before this gap closes, because distribution advantage persists even after technical gaps narrow.

The mitigation: become the premium layer on top of VS Code's agent primitives, not a replacement. If Microsoft ships basic external discovery, CC responds with richer dock integration, better notification actions, and deeper macOS-native features that Microsoft will never prioritize.

**Scenario C: Anthropic ships native multi-session orchestration for Claude Code.**

Claude Code's VS Code extension already runs an MCP server on `127.0.0.1`. A native "manage multiple sessions" UI is a logical extension. If Anthropic ships this, CC's Claude-specific integration is partially commoditized.

The mitigation is agent-agnostic breadth. CC already discovers any agent CLI via `ps` scanning, not just Claude Code. If Anthropic ships native Claude Code orchestration, CC becomes the cross-agent aggregation layer that shows Claude sessions alongside Codex, Gemini CLI, Amp, and any future agent CLI. Design for multi-agent breadth from the start — do not build Claude-only features that become dead code when Anthropic absorbs them.

**Scenario D: Ghostty adds per-workspace dock icons natively.**

Mitchell Hashimoto has shown willingness to implement complex macOS-specific UX. Per-workspace dock icons are a natural extension of Ghostty's design philosophy. If this ships, the Ghostty Launcher's bundle-cloning approach becomes redundant.

What remains: the VS Code sidebar, agent auto-discovery, notification actions, dock menus, and the data layer. CC's value is the observation and management layer, not the icon generation. Engage with the Ghostty community and contribute to this feature if it gets traction — positioning CC as the orchestration layer that enhances whatever Ghostty ships natively.

### The macOS-Only Question

macOS-only is the correct decision for now.

The data: 31.8% of all developers use macOS (Stack Overflow 2025). Among the target ICP — AI-forward, terminal power users, developers running parallel agent sessions — the proportion is higher, likely 45-55%. Ghostty itself has 45,000 GitHub stars and is macOS-first. Ghostty users are disproportionately the exact users running parallel Claude Code agents.

31.8% of the professional developer market is approximately 8-10 million people. That is not a niche. It is a focused segment where premium tooling thrives.

The precedent is clear. macOS-native developer tools that nail one workflow problem deeply have maintained profitable niches for decades:

| Tool | Positioning | Outcome |
|------|-------------|---------|
| Tower | Git UI, started macOS-only, $69/year | Profitable bootstrapped, acquired 2023 |
| Kaleidoscope | Diff tool, macOS-only, $99/year | Acquired, continued as premium niche |
| Sketch | Design tool, macOS-only, $99/year | Dominated market until Figma went web |
| BBEdit | Text editor, macOS-only, $49.99 perpetual | 30+ years of operation |
| Ghostty | Terminal, macOS-first, 45K stars | Massive community adoption |

The pattern: deep macOS integration creates an experience that cross-platform tools cannot match without platform-specific investment equal to building a native app. That investment is rare. The moat is real.

macOS-only also enables premium pricing. macOS developer tool buyers expect and accept it: $9-15/month for solo developers, $25-50/month per seat for teams. Cross-platform tools with broader addressable markets typically price lower because competitive pressure is higher. The macOS-native premium is 20-40% above cross-platform equivalents.

Linux support is viable via `.desktop` files in `~/.local/share/applications/` with custom `Icon=` paths. GNOME Shell and KDE support this. The engineering is 2-3 weeks. Add it in Phase 3 when the user base justifies the maintenance overhead. Skip Windows indefinitely — Ghostty is macOS-only, the ICP overlap with Windows is minimal, and Windows taskbar grouping by executable makes the CFBundleIdentifier analogy structurally different.

---

## 6. The Iteration Roadmap

### The Guiding Principle

Every feature decision has one test: effort-to-wow ratio. How many engineering hours does it take? How loudly will a user talk about it in a 60-second demo? Features with high wow and low effort ship in Phase 1. Features with high effort that do not serve the "manage multiple agents" core workflow are cut.

The secondary constraint: VS Code will close the external-agent-discovery gap in 6-9 months. Distribution is the answer. Every week of delay narrowing the window.

### Phase 1: The Wow Demo — 2 Weeks

**Goal:** Ship features that make jaws drop in a 60-second demo. Reach Show HN readiness.

The Phase 1 success criterion: run a 60-second unscripted demo in which the dock shows project icons with agent count badges, an agent completes, a rich notification appears with "Review Diff" action, the user clicks it, and VS Code opens the diff — with no manual intervention at any step.

| Feature | Effort | Wow | Priority |
|---------|--------|-----|----------|
| Fix stale session guard bug | 2 hours | Medium | Ship immediately — blocks correctness for completed agents |
| Dock badge: active agent count | 3-4 days | Very High | Core ambient awareness; no competitor has this |
| Notification with "Review Diff" action | 2-3 days | Very High | Closes agent-to-review loop; instantly demo-able |
| Project grouping in CC sidebar | 2 days | High | Prerequisite for dock-as-platform navigation chain |
| Scroll-to-last-output on focus | 4 hours | High | Small fix, meaningful daily improvement |
| Marketplace listing reframe | 4 hours | High (distribution) | Change positioning to "agent control tower" |

**Phase 1 implementation notes:**

The dock badge implementation path: CC writes agent count to `/tmp/cc-{bundle-id}-status.json`. A minimal Swift file-watcher plugin injected into the Ghostty bundle at creation time reads this file and calls `NSApp.dockTile.badgeLabel`. The file-watcher can also trigger `NSApp.requestUserAttention(.informationalRequest)` on completion and `.criticalRequest` on error. This gives badge plus bounce from a single watcher.

The notification action path: modify `oste-notify.sh` to pass `-open cc-{project}://focus-agent/{agent-id}` to terminal-notifier. The Ghostty bundle handles the URL in its `NSApplicationDelegate`, calling `tmux select-window` and triggering CC's existing focus logic. The "Review Diff" action opens VS Code's diff view via the existing `commandcentral://` URL scheme.

The stale session guard bug: documented in `FOCUS-FEATURE-RESEARCH.md:254`. The `tmux has-session` guard runs before all focus strategies, blocking completed agents with valid `ghostty_bundle_id` from being refocused. Move the guard to wrap only Strategy 3 (the tmux-only path). This is a two-line fix with correctness implications for every completed agent in the sidebar.

### Phase 2: The Platform — 2 Months

**Goal:** Establish Command Central as the definitive agent management layer for macOS developers. Ship features that justify a Pro tier.

| Feature | Effort | Wow | Notes |
|---------|--------|-----|-------|
| Status menu bar item | 1 week | Very High | Global agent status when VS Code is minimized; no competitor has this |
| Cmd+Tab → VS Code workspace switch | 1 week | Very High | "The dock IS the project switcher"; NSWorkspace watcher + Swift helper |
| Dock ring color: agent state indicator | 3-5 days | High | Green/yellow/red overlay via NSDockTile.contentView |
| Rich notifications with diff preview | 1 week | High | Mini diff image attachment; novel differentiator |
| Agent output viewer (last N lines) | 1 week | High | Review output without terminal switch |
| Stuck agent detection | 3 days | Medium | Alert after N minutes with no output |
| Lifecycle controls (kill/restart) | 3-4 days | Medium | Read-only dashboard frustrates power users |
| Cost estimation / token counter | 1 week | High | Addresses runaway token spend concern |
| Terminal agnosticism (iTerm2, native) | 2 weeks | Medium | Removes "requires Ghostty" objection, expands TAM |
| Pro tier + licensing infrastructure | 1 week | — | Enable monetization; Stripe or LemonSqueezy |

**Phase 2 success criteria:** 500+ active users, at least one viral community moment (HN front page, notable developer post), Pro tier generating revenue.

The status menu bar item deserves emphasis: agents run asynchronously. Users close VS Code, move to other work, and want to know when agents finish without checking a sidebar. A menu bar icon showing "2 running, 1 waiting" with a popover listing agent cards is the ambient awareness layer that eliminates the need to context-switch to VS Code at all. No competitor has a VS Code extension that surfaces agent status outside of VS Code. This is the "aha moment" feature for users with background workflows.

### Phase 3: Full Platform Vision — 6 Months

**Goal:** Command Central becomes the platform that agent tools integrate with, not just a monitoring layer over them.

| Feature | Effort | Wow | Notes |
|---------|--------|-----|-------|
| Agent marketplace / skill library | 4-6 weeks | Very High | Pre-configured prompts; drag-and-drop via CC sidebar |
| Conflict detection across worktrees | 2 weeks | High | Detects agents editing overlapping files |
| Cross-project orchestration view | 2 weeks | High | Fleet dashboard across all projects |
| Linux support | 3-4 weeks | Medium | .desktop file equivalent; expands TAM ~30% |
| Team mode: shared agent run history | 2 weeks | Medium | Team tier value |
| GitHub/Linear ticket → agent launch | 2 weeks | High | Start agent on a specific ticket from CC |
| Budget caps / kill-on-budget | 1 week | High | Runaway token spend protection |
| MCP server integration | 2 weeks | High | Expose CC data to Claude Code via MCP |

**Phase 3 success criteria:** 5,000+ active users, Team tier revenue covering costs, at least one external integration shipped.

### What Not to Build

These have been researched, found wanting, and should not appear on any roadmap revision without new information:

**Dock progress bars.** No measurable sub-steps exist in typical agent sessions. Indeterminate spinners add noise. Add only when agents expose structured step-completion events.

**Cmd+Tab hover previews.** No public API. Private `com.apple.dock` process. Cannot be built by any extension or third-party app without private API usage that Apple will reject or break.

**Split View automation.** No public API for macOS Split View. The workaround (AX frame manipulation to achieve side-by-side layout) is feasible but niche. Build it only if multiple users specifically request it.

**AX-based tmux pane targeting.** Terminal emulators are opaque drawing surfaces to the AX tree. tmux IPC (`tmux select-window`, `tmux select-pane`) is the correct tool and is already implemented.

**Orchestration breadth competition.** Emdash (YC W26, 60K+ downloads) supports 22 agent CLIs, SSH, teams. dmux, cmux, 1Code — all have orchestration as their core value with full-time teams. Do not compete on orchestration feature count. That is a resource fight that loses.

---

## 7. Risk Analysis

### Risk 1: Agent Management Commoditizes Before Distribution Scales

**Probability: High.** 12+ tools exist today. More are coming from well-funded teams.

**Impact: Medium.** Commoditization compresses margins but does not kill a product with distribution advantage. The user who installed CC 6 months ago and built workflows around it does not switch tools because a new option appeared.

**Mitigation:** Win on distribution before the category commoditizes. Every install compounds Marketplace ranking, which drives more installs. The 1,000-install threshold is the compound interest inflection point. Get there before Microsoft ships external-agent discovery.

**Verdict: The #1 strategic risk. Ship Phase 1 now.**

### Risk 2: VS Code Closes the External-Agent-Discovery Gap

**Probability: High within 6-9 months.** VS Code 1.109 ships Agent Sessions View. External-terminal discovery is the obvious next step. Microsoft has the resources and incentive.

**Impact: High.** The "sees external terminal agents" differentiator in VS Code narrows to zero.

**Mitigation:** (1) Ship now, accumulate distribution. (2) Build features Microsoft will not: deep macOS dock integration, notification actions, dock menus, Ghostty-specific enhancements. (3) Become the premium macOS-native layer on top of VS Code's agent primitives. Microsoft will never prioritize `NSDockTile.badgeLabel` or per-project CFBundleIdentifier.

**Verdict: The #2 strategic risk. 6-9 month window is real.**

### Risk 3: Anthropic Adds Native Multi-Session Orchestration

**Probability: Medium.** Claude Code's VS Code extension already runs an MCP server. A native "manage multiple sessions" sidebar is a natural extension.

**Impact: Very High** if it includes VS Code sidebar integration with external-terminal discovery.

**Mitigation:** Design CC to be agent-agnostic. The `ps` scanning and `~/.claude/` file watching discover any agent CLI — Claude Code, Codex, Gemini CLI, Amp. If Anthropic ships native Claude Code orchestration, CC responds by emphasizing multi-agent breadth across all CLIs. That is a feature Anthropic cannot ship without rebuilding the entire ecosystem.

**Verdict: Medium-term threat. Architecture must support multi-agent breadth from the start.**

### Risk 4: Apple Changes Dock Behavior or Code-Signing Requirements

**Probability: Low for dock behavior.** `CFBundleIdentifier`-based dock identity has been stable since macOS 10.0 (2001). Apple does not break this primitive.

**Probability: Low-Medium for code signing.** Gatekeeper requirements have tightened each release. Bundle modification invalidates code signatures. Ad-hoc signing works for local dev tools, but requirements may tighten further.

**Impact: High if dock identity breaks.** The entire Ghostty Launcher approach fails.

**Mitigation:** Build on maximally stable APIs (CFBundleIdentifier, URL schemes, POSIX). Handle ad-hoc signing in the bundle creation script. Test on each macOS beta. CC's value extends beyond the launcher — VS Code sidebar + agent discovery remains intact even if the dock trick breaks.

**Verdict: Tail risk for dock identity, ongoing maintenance risk for code signing. Manageable.**

### Risk 5: Ghostty Adds Per-Workspace Dock Icons Natively

**Probability: Low-Medium.** Mitchell Hashimoto has implemented complex macOS-specific features. Per-workspace dock identity is a natural extension. A Ghostty discussion already exists on this topic (issue #7104).

**Impact: Medium.** The Ghostty Launcher becomes redundant, but CC's VS Code integration and agent discovery remain valuable.

**Mitigation:** Engage with the Ghostty community. Contribute to native dock icon support if it gains traction. Position CC as the orchestration layer that works with Ghostty's native features, not a workaround for their absence.

**Verdict: Worth monitoring. Maintain relationships with the Ghostty team.**

### Risk 6: Bundle Cloning Breaks with Ghostty Updates

**Probability: Low.** App bundle structure is stable. Ghostty's `.app` internals have been consistent.

**Impact: Medium.** Bundle creation pipeline breaks; developers must update their project bundles.

**Mitigation:** Pin bundle cloning to specific Ghostty versions with a migration path. Test bundle creation against each Ghostty release. The cloned bundles run independently once created — a Ghostty update does not retroactively break existing bundles.

**Verdict: Routine maintenance risk. Automated testing covers it.**

---

## 8. Recommendations

### What to Build, in What Order, and Why

**Week 1-2: Phase 1 — The Wow Demo**

Start with the stale session guard fix. It takes two hours and unblocks correct behavior for every completed agent. Ship it in the next commit, not a future sprint.

Then in parallel: dock badge implementation and rich notifications with URL scheme clickthrough. These are the two highest-effort-to-wow features in the entire roadmap. The dock badge turns the dock into an ambient status display; the notification action closes the agent-to-review loop. Both are days of engineering, not weeks.

Project grouping in the CC sidebar is a prerequisite for the navigation chain (dock icon to sidebar to terminal) to be obvious to new users. Ship it in the same sprint.

Update the Marketplace listing to reframe the product as "agent control tower for macOS" before shipping. Distribution starts with correct positioning.

**Months 1-2: Phase 2 — The Platform**

The status menu bar item is the highest-value Phase 2 feature. It decouples agent status monitoring from VS Code being open. A developer can work in any app and see agent status in the menu bar. No competitor offers this inside a VS Code extension. Ship it early in Phase 2.

The NSWorkspace activation watcher ("Cmd+Tab switches VS Code workspace") is the feature that makes the dock icon a true platform primitive rather than a visual improvement. Once it ships, every dock Cmd+Tab is also a VS Code context switch. This is the moment the architecture becomes coherent as a system rather than a collection of features.

Pro tier infrastructure should ship in Phase 2, not Phase 3. Revenue validates product-market fit and funds Phase 3 investment. The pricing target: $12-15/month solo, $30-50/month per seat for teams.

**Months 3-6: Phase 3 — Full Platform**

Phase 3 features are contingent on Phase 2 success. If Phase 2 reaches 500+ users and Pro tier generates revenue, Phase 3 investment is justified. The highest-value Phase 3 feature is the MCP server integration: exposing CC data to Claude Code via MCP means agents can query their own status, check for conflicts, and read token consumption — turning CC from an observation layer into an active participant in the agent workflow.

### The Positions That Should Not Change

**Dock icons at the project level, not the agent level.** This is a constraint, not a preference. Agent-level icons create dock hell. The math does not work. The sidebar handles agent sub-navigation. Do not revisit this decision.

**macOS-first.** The ICP is disproportionately macOS. The premium pricing is justified. The macOS-native features are the moat. Cross-platform for its own sake dilutes all three. Add Linux in Phase 3 when users ask for it and revenue justifies it. Windows is indefinitely deferred.

**Observation breadth over orchestration depth.** CC is the layer that sees everything. Competing on orchestration feature count against Emdash and cmux is a resource fight that loses. Win on visibility and ambient awareness — the features only a VS Code extension with macOS-native integration can provide.

**Ship now.** The 6-9 month window on the external-agent-discovery moat is real. Phase 1 is 10-15 days of engineering. There is no technical blocker. Every week of delay narrows a window that, once closed, takes 12-18 months to rebuild with an equivalent moat elsewhere in the product.

The market is right, the technology is feasible, the window is open. Ship.

---

## Sources

1. `_temp-research-a-macos-apis.md` — macOS APIs (NSDockTile, NSRunningApplication, AXUIElement, URL schemes, NSWorkspace), technical feasibility ratings for all proposed features, developer workflow minute-by-minute analysis, Ghostty IPC current state, per-project bundle architecture technical validation

2. `_temp-research-b-strategy.md` — Product strategy, dock icon abstraction level analysis, competitive moat analysis (VS Code integration vs. orchestration vs. network effects), macOS-only market sizing, precedent for macOS-only developer tools, platform capability rankings, notification flow design, iteration roadmap with effort and wow ratings, risk analysis across six risk vectors, one-page strategy summary

Additional references cited in source documents:
- Apple Developer Documentation: NSDockTile, applicationDockMenu, requestUserAttention, NSRunningApplication, CFBundleURLTypes, NSWorkspace
- Stack Overflow Developer Survey 2025 (macOS 31.8% developer adoption)
- Ghostty GitHub discussions #2353 (scripting API), #7104 (dock badge)
- cmux, Emdash, dmux competitive analysis
- macOS-only developer tool precedents: Tower, Kaleidoscope, Sketch, BBEdit, Ghostty
