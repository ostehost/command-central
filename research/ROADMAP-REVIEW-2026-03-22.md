# Roadmap Review: Command Central & Launcher

## Executive Summary
Command Central has successfully pivoted from a Git time-sorter to a powerful, VS Code-native agent multiplexer, but it risks losing its identity by trying to do both. The market is moving incredibly fast with 8+ competitors (cmux, dmux) already established, meaning our time-to-market window is rapidly closing. The current roadmap focuses too heavily on internal "dogfooding" features (like rendering ROADMAP.yaml in a tree view) instead of the killer features needed to compete, like session grouping and a deterministic workflow engine. To win, CC must double down on being the ultimate visual orchestration layer for file-based agent handoffs and eliminate its hardcoded local environment assumptions.

## Feature Audit
| Feature | Category | User Value | Verdict |
| :--- | :--- | :--- | :--- |
| **Time-sorted Git Changes** | Git / SCM | High | **Keep, but reposition** as "Agent Diff Tracker" rather than a general Git tool. |
| **Agent Status Tree** | Orchestration | Critical | **Core**. The foundation of the multiplexer. |
| **Agent Activity Timeline** | Orchestration | High | **Keep**. Great for auditing multi-agent environments. |
| **Ghostty Terminal Launch** | Integration | Medium | **Refine**. Tying too heavily to Ghostty limits the total addressable VS Code market. |
| **Agent Dashboard Webview** | Orchestration | Medium | **Evaluate**. Might overlap with the native tree views; needs to act as the missing "Fleet Dashboard". |
| **Agent Notifications/Decorations**| UX | High | **Keep**. Essential for background agents. |

*Note on Bloat:* The extension feels like two products (Git Sort vs Agent Mux). The Git Sort features should be explicitly marketed as the way to verify what agents have changed.

## Roadmap Item Assessment

| Item | Why? | Priority | Effort | ROI | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `roadmap-yaml-automation` | Auto-updates state | High | Accurate | High | **Proceed**. Good for automation, but don't over-engineer. |
| `cc-cmux-features` | Session grouping, multi-pane | **Too Low** (currently Medium) | Under-estimated | Critical | **Accelerate**. This is the table-stakes feature to compete with cmux/dmux. |
| `cc-roadmap-tree-view` | View YAML in sidebar | Medium | Accurate | Low | **CUT**. "Nice to have" internal tool that delays shipping core user value. |
| `cc-v033-publish` | Ship the sprint | High | Accurate | High | **Proceed**. Ship it now. |
| `launcher-bug-batch` | Fix bugs & stale state | High | Accurate | High | **Proceed**. Critical path. |
| `team-mode-signal` | Auto-trigger teams | Medium | Accurate | Medium | **Pause**. Get the baseline cmux features working first. |

## What's Missing from the Roadmap?
1. **Un-hardcoding Local Paths:** `package.json` defaults `commandCentral.agentTasksFile` to `~/projects/ghostty-launcher/scripts/tasks.json`. This makes the extension un-shippable to real external users. A generic configuration or bundled launcher approach is desperately needed.
2. **Approval Checkpoints (Lobster integration):** The landscape notes "Don't orchestrate with LLMs." Users need a way to pause agents, review the "Git Sort" diff, and click "Approve/Merge" before the agent continues.
3. **Fleet Dashboard:** A true top-level view of all agents across *all* projects. The current dashboard might be per-workspace.
4. **Terminal Agnosticism:** While Ghostty is great, forcing it as a dependency for an AI orchestration tool in VS Code might alienate standard integrated terminal users.

## Critical Path to v1.0
1. **Fix the Foundation:** Complete `launcher-bug-batch` to ensure reliable task state.
2. **Remove Hardcoded Paths:** Decouple from `~/projects/ghostty-launcher` defaults. Make the setup workflow frictionless for a new user.
3. **Ship UI Parity with cmux:** Implement `cc-cmux-features` (grouping, log viewer, navigation).
4. **Integration of Deterministic Hooks:** Add UI checkpoints for the file-based handoffs and lifecycle hooks (pre-create, pre-merge) mentioned in the competitive landscape.
5. **Documentation & Polish:** Write the "How to use CC without Ghostty" or "How to install the Ghostty Launcher" onboarding guides.
6. **Launch:** Execute `soft-launch-posts`.

## Risks and Mitigations
- **Market Window Closing:** The 8+ competitors are moving fast. *Mitigation:* Cut internal vanity features (`cc-roadmap-tree-view`) and focus strictly on multi-agent multiplexing UI.
- **Over-coupling to Ghostty:** Relying on a specific terminal emulator in a VS Code extension limits adoption. *Mitigation:* Fallback gracefully to the VS Code integrated terminal if Ghostty isn't available.
- **Solo Developer Bottleneck:** *Mitigation:* heavily leverage AI for tests and scaffolding, but ruthlessly prioritize scope.

## Top 3 Recommendations (What to do RIGHT NOW)
1. **Ship v0.3.3 and Fix Bugs:** Execute `cc-v033-publish` and `launcher-bug-batch` immediately to stabilize the current build.
2. **Cut `cc-roadmap-tree-view`:** Remove it from the immediate roadmap to reclaim 4-6 hours of development time.
3. **Elevate `cc-cmux-features` to Highest Priority:** Shift focus entirely to session grouping and the log viewer. This is what users actually want when managing 3+ agents.
