## Uncovered Items
- Dock badge (active agent count) is not implemented.
- Dock bounce on completion is not implemented.
- Dock right-click menu is not implemented.
- NSWorkspace-driven Cmd+Tab → workspace sync is not implemented.
- Status menu bar item is not implemented.
- Token/cost estimation is not implemented.
- Click-to-focus still does not target a specific `window_id` from the terminal map.

# Command Central — UI/UX Strategy

**Date:** 2026-03-24
**Author:** Oste (synthesized from all research)
**Purpose:** Unified prioritization for the next engineering phases, grounded in competitive research, technical feasibility, and CC's unique position.

---

## The Core Problem Today

When you click an agent in the sidebar, CC runs `open -a <bundle_id>`, which brings the whole Ghostty app forward — not a specific window. Then it runs `tmux select-window` to switch the tmux state, but if the Ghostty window showing that session isn't the one that came forward, you see the wrong thing. For completed agents, if the tmux session is dead and the Ghostty bundle isn't running, it falls through to showing a diff. **The click doesn't reliably land you on the right terminal.**

This is Friction #2 from the dissertation: **application-level focus instead of window-level focus.**

## What We Know (Research Summary)

### CC's Unique Position
- **Only VS Code extension that auto-discovers external terminal agents** — nobody else does this
- **The moat is the stack:** VS Code sidebar + external discovery + macOS dock integration + distribution
- **The window:** 6-9 months before Microsoft adds external-agent discovery to VS Code natively

### Competitive Gap Analysis (8 tools studied)
- **Universal pattern:** 3-state lifecycle (working / needs attention / done) + progressive disclosure (list → detail → deep)
- **CC is missing:** prompt text display ✅ fixed, diff summary ✅ fixed, lifecycle controls ✅ fixed, BUT still missing: reliable click-to-focus, status colors, per-file change lists, agent type badges, session grouping
- **Zero competitors show token/cost** — first-mover opportunity
- **CC's auto-discovery is unique** — preserve and amplify

### macOS Platform Capabilities (Feasible, Not Built)
| Feature | Effort | Wow | API |
|---------|--------|-----|-----|
| Dock badge (agent count) | 3-4 days | Very High | `NSDockTile.badgeLabel` |
| Dock bounce on completion | Easy | High | `NSApp.requestUserAttention` |
| Right-click dock menu (agent list) | Easy | High | `applicationDockMenu` |
| Rich notifications w/ actions | 2-3 days | Very High | terminal-notifier + URL scheme |
| NSWorkspace sidebar sync (Cmd+Tab → auto-select project) | Medium | Very High | Swift helper |
| Status menu bar item | 1 week | Very High | NSStatusItem |

---

## Prioritized Feature Roadmap

### Tier 1: Fix What's Broken (Days, Not Weeks)

These block the "click an agent → land in the right place" flow. Ship before anything else.

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 1 | **Fix click-to-focus window targeting** | Core UX is broken. `open -a` brings the wrong window. Use `/tmp/ghostty-terminals.json` data (already exists) with AppleScript `tell application id "..." to set index of window N to 1` | 1-2 days |
| 2 | **3-color status indicators** | Running (amber) / needs attention (red) / done (green). Superset proved this is the clearest encoding. Currently everything looks the same. | 1 day |
| 3 | **Agent type badges** | Claude 🟣, Codex 🟢, Gemini 🔵. Currently generic wrench on every item. Instant visual differentiation. | 0.5 day |

### Tier 2: The Wow Demo (2 Weeks — Show HN Ready)

The 60-second demo: dock icons with badges, agent completes, rich notification, click → diff. No manual steps.

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 4 | **Dock badge: active agent count** | The single highest-wow dock feature. Red circle with agent count on each project's dock icon. No competitor has this. | 3-4 days |
| 5 | **Rich notifications with "Review Diff" action** | Closes the agent→review loop. Click notification → URL scheme → VS Code opens diff. Currently notifications say "completed" with no action. | 2-3 days |
| 6 | **Dock bounce on completion** | Single bounce = informational, continuous = error. Free via `requestUserAttention`. | 0.5 day |
| 7 | **Per-file change list** | Expandable list of files touched with per-file +/-. Nimbalyst shows this on the card itself — powerful for triage. | 1-2 days |
| 8 | **Session grouping by project** | Agents grouped under project headers. Prerequisite for dock→sidebar navigation chain being intuitive. | 2 days |
| 9 | **Marketing site update** | cc.partnerai.dev with competitor comparison, demo GIF, refined positioning. | 1 day |
| 10 | **Marketplace listing refresh** | Screenshots showing new UI, keywords for "agent management" | 0.5 day |

### Tier 3: Platform Features (Post-Launch, 2 Months)

Build these based on real user feedback from launch.

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 11 | **Status menu bar item** | Agent status when VS Code is minimized. No competitor does this. | 1 week |
| 12 | **Cmd+Tab → VS Code workspace switch** | NSWorkspace watcher syncs sidebar to active Ghostty bundle. Makes dock a true project switcher. | 1 week |
| 13 | **Right-click dock menu** | Agent list per project in the dock context menu. Days of engineering, huge ambient awareness. | 3 days |
| 14 | **Token/cost estimation** | Zero competitors show this. First-mover. Team leads ask "how much did this cost?" | 1 week |
| 15 | **Stuck agent detection** | Yellow warning after N minutes of no output. | 3 days |
| 16 | **Dock ring color** | Green/amber/red overlay via NSDockTile.contentView. | 3-5 days |
| 17 | **Terminal agnosticism (iTerm2, native Terminal)** | Removes "requires Ghostty" objection. Expands TAM. | 2 weeks |

### Tier 4: Full Platform (6 Months)

Only pursue after 500+ active users and revenue.

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 18 | Multi-agent diff comparison (Cursor-style) | Unique paradigm — compare parallel agent outputs | 2 weeks |
| 19 | Conflict detection across worktrees | Prevent agents from stomping each other | 2 weeks |
| 20 | MCP server integration | CC data exposed to Claude Code via MCP | 2 weeks |
| 21 | GitHub/Linear → agent launch | Start agent from a ticket | 2 weeks |
| 22 | Linux support | .desktop files, GNOME/KDE | 3-4 weeks |
| 23 | Pro tier + licensing | Stripe/LemonSqueezy | 1 week |

---

## What NOT to Build

Researched, rejected. Do not revisit without new information.

| Feature | Why Not |
|---------|---------|
| Dock progress bars | No measurable sub-steps in agent sessions |
| Cmd+Tab hover previews | No public API — private `com.apple.dock` process |
| Split View automation | No public API for macOS Split View |
| AX-based tmux pane targeting | Terminal emulators are opaque to AX tree |
| Agent-level dock icons | Creates dock hell (20 projects × 3 agents = 60 icons). Project-level is the correct abstraction. |
| Orchestration breadth competition | Emdash has 60K downloads and VC backing. Don't compete on feature count. Win on visibility + macOS-native depth. |

---

## The Demo Script (60 Seconds)

> "I have three projects, five Claude Code agents running. Watch my dock."
>
> [Dock shows 3 project icons with emoji. project-auth has badge "2".]
>
> "project-auth has two agents. One just finished—"
>
> [Dock icon bounces. Rich notification: "feature/oauth done. 14 files, +340/-87. Exit 0." Actions: Review Diff | Open Terminal]
>
> [Click "Review Diff"]
>
> [VS Code opens, sidebar auto-selects the agent, diff view shows time-sorted changes]
>
> "One click. Zero terminal juggling. That's Command Central."

---

## Architecture Principles

1. **Dock = project navigation. Sidebar = agent navigation.** The dock handles which project; the sidebar handles which agent within it. This division is a constraint, not a preference.

2. **Observation breadth over orchestration depth.** CC is the layer that *sees everything*. Deep orchestration is a feature race against funded competitors. Deep visibility is a unique wedge.

3. **macOS-first is a strength.** 31.8% of devs, but 45-55% of the ICP. Premium pricing is justified. Don't dilute with cross-platform until users demand it.

4. **Distribution is the moat.** Every install compounds Marketplace ranking. Get to 1,000 before Microsoft closes the external-agent-discovery gap.

5. **The free tier IS the marketing.** Agent status tree, basic discovery, click-to-focus — free forever. Pro tier: cost tracking, stuck detection, advanced controls.

---

## Mapping to Existing Roadmap

| Strategy Item | Roadmap Location | Status |
|---------------|-----------------|--------|
| Fix click-to-focus | NEW — add to M2.5 | TODO |
| Status colors | M2.5-9 | TODO |
| Agent type badges | M2.5-6 | TODO |
| Per-file change list | M2.5-10 | TODO |
| Dock badge/bounce/notifications | NEW — add to M4 or new M3.5 | TODO |
| Session grouping | M3-1 | TODO |
| Marketing site | M2.5-12 | TODO |
| Menu bar item | NEW — Phase 2 | TODO |
| Token/cost | M5-4 | TODO |
| Stuck detection | M3-6 | TODO |

---

## Decision Points for Mike

1. **Tier 1 (broken stuff) — ship this week?** The click-to-focus fix, status colors, and agent badges are 2-3 days total. Small blast radius, high daily-use impact.

2. **Tier 2 (wow demo) — commit to 2-week sprint?** Dock badges + rich notifications + per-file list + session grouping + marketing site. This is the Show HN package.

3. **Tier 2 vs launch now?** The research says "ship now, window is 6-9 months." Do we launch with current M2.5 core (which is already competitive) and add Tier 2 post-launch? Or polish 2 more weeks then launch?

4. **Monetization timing?** Research says Pro tier in Phase 2 (months 1-2 post-launch), not at launch. Free tier as marketing. Agree?

5. **macOS-only positioning?** Research is unanimous: yes. Skip Linux until Phase 3 (500+ users). Skip Windows indefinitely. Agree?
