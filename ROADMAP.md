# Command Central — Product Roadmap

> v1.1 — 2026-03-22. Living document. Updated as priorities shift.
> Strategy basis: `research/STRATEGY-SYNTHESIS-2026-03-22.md`, `research/PMF-ANALYSIS-2026-03-22.md`
> **Critical path:** M0 ✅ → M1 (finish) → M2 (discovery) → M4 (launch) → M3 (post-launch, feedback-driven)

## Vision

**The VS Code agent control tower.** See all your AI coding agents — even ones running in external terminals — from one sidebar. The only extension that auto-discovers Claude Code instances VS Code can't see.

## Positioning

> "Stop managing terminals. Start managing agents."

- **Old identity:** "Code changes, sorted by time" (Git time-sorter)
- **New identity:** Agent multiplexer + diff tracker for multi-agent coding workflows
- **Unique wedge:** VS Code's native Agent Sessions View only sees agents it spawned. CC sees ALL agents — external terminals, Ghostty, tmux, iTerm2.

## ICP (Ideal Customer Profile)

Solo/small-team devs running 2–10 Claude Code instances in parallel. Already pays for AI tools. Uses VS Code + terminal workflow. Frustrated by "terminal hell." Follows AI coding content on HN/X/Reddit.

---

## Milestones

### M0: Ship & Stabilize (v0.3.3) — NOW
**Goal:** Get the 8-phase agent sidebar out the door. Fix known bugs. Make it installable by strangers.

| ID | Item | Status | Priority | Notes |
|----|------|--------|----------|-------|
| M0-1 | Squash auto-commit history into clean feature commits | ✅ DONE | P0 | 30 → 4 clean commits |
| M0-2 | Fix: `oste-spawn.sh` registers task before terminal creation | ✅ DONE | P0 | `terminal_exists` check before `register_task` |
| M0-3 | Fix: auto-commit misses lint-reformatted files | ✅ DONE | P1 | Double-pass porcelain recheck + auto-commit |
| M0-4 | Fix: `--team` flag silently fails in print mode | ✅ DONE | P1 | Hard error without `--interactive` |
| M0-5 | End-to-end test all 16 agent sidebar features | SKIPPED | P0 | Unit coverage sufficient (660 tests). Revisit during M1. |
| M0-6 | Build VSIX and publish v0.3.3 to Marketplace | ⏳ BLOCKED | P0 | Blocked on M1 (unhardcode). Pre-release only until then. |

### M1: Unhardcode & Onboard (v0.4.0)
**Goal:** Make CC installable and usable by someone who has never heard of Ghostty Launcher.

| ID | Item | Status | Priority | Notes |
|----|------|--------|----------|-------|
| M1-1 | Remove `~/projects/ghostty-launcher` default from `package.json` | ✅ DONE | P0 | Hardcoded paths removed, empty defaults |
| M1-2 | Auto-detect `tasks.json` location via workspace config | ✅ DONE | P0 | `tasks-file-resolver.ts` — workspace → XDG → home |
| M1-3 | Graceful degradation when Ghostty not installed | ✅ DONE | P0 | `hasLauncher` context key, menu items gated |
| M1-4 | First-run experience: "No agents detected" → helpful onboarding | ✅ DONE | P1 | Updated viewsWelcome with getting started guide |
| M1-5 | Update Marketplace listing: description, screenshots, keywords | ✅ DONE | P0 | Agent control tower copy, new keywords, categories |
| M1-6 | Reframe Git Sort as "Agent Diff Tracker" in UI/docs | ✅ DONE | P1 | markdownDescription + viewsWelcome reframed |
| M1-7 | README rewrite for external users | ✅ DONE | P0 | Full rewrite: problem/solution, features, config ref, roadmap |
| M1-8 | Fix: Click-to-focus should select correct Ghostty tab | ✅ DONE | P0 | `tmux select-window` after `open -a`. 4 tests added. |
| M1-9 | Fix: Don't open terminal for dead/stale sessions | ✅ DONE | P0 | `tmux has-session` guard. Shows "Session ended" if stale. |
| M1-10 | Wire PostHog telemetry for install/activation/feature tracking | ✅ DONE | P0 | 6 events, no SDK, batch flush, 14 tests |
| M1-11 | Fix: native fs.watch fallback for task file outside workspace | ✅ DONE | P1 | v0.3.6 — VS Code watcher unreliable for ~/.config paths |
| M1-12 | Fix: tmux-only agents should open in Ghostty, not VS Code terminal | TODO | P0 | Strategy 3 falls back to integrated terminal. Should `osascript` a new Ghostty tab with `tmux attach`. |

### M2: Process Auto-Discovery (v0.5.0) — THE DIFFERENTIATOR
**Goal:** Auto-detect running Claude Code agents without any configuration. This is the unique capability no competitor has inside VS Code.

| ID | Item | Status | Priority | Notes |
|----|------|--------|----------|-------|
| M2-1 | Detect Claude Code processes via `ps` scanning | TODO | P0 | Parse process args for project dir, model, session |
| M2-2 | Watch `~/.claude/` for active session files | TODO | P0 | Claude Code writes session state here |
| M2-3 | Detect git worktrees via `git worktree list` | TODO | P1 | Reliable, no permission issues |
| M2-4 | Merge discovered agents with Launcher-managed agents | TODO | P0 | Two sources of truth → unified agent list |
| M2-5 | Terminal-agnostic: work with Ghostty, iTerm2, Terminal.app, tmux | TODO | P0 | Don't require Ghostty for discovery |
| M2-6 | Performance: poll interval tuning, debounce, lazy refresh | TODO | P1 | Can't hammer `ps` every second |

### M4: Launch & Distribute (v0.7.0) — BEFORE M3
**Goal:** First 100 installs. Validate distribution. Ship the differentiator (M2) and launch before building competitive parity. Real feedback > guessing.

| ID | Item | Status | Priority | Notes |
|----|------|--------|----------|-------|
| M4-1 | Show HN post with demo video | TODO | P0 | "See all your Claude Code agents in VS Code" |
| M4-2 | X/Twitter launch thread with screen recording | TODO | P0 | Short demo: "3 agents, 1 dashboard, 0 switching" |
| M4-3 | DEV Community article: "How I manage 10 agents" | TODO | P1 | SEO play + community credibility |
| M4-4 | Ghostty community post (Discord/forums) | TODO | P1 | High-quality leads, small volume |
| M4-5 | Track installs, activations, feature usage (PostHog) | TODO | P0 | Can't improve what you can't measure. Wire during M1. |

### M3: Competitive Parity (v0.8.0) — POST-LAUNCH
**Goal:** Match dmux/cmux/FleetCode on table-stakes features. Prioritize based on real user feedback from M4 launch.

| ID | Item | Status | Priority | Notes |
|----|------|--------|----------|-------|
| M3-1 | Session grouping (by project, by role, by status) | TODO | P0 | cmux's core UX — vertical tabs with grouping |
| M3-2 | Agent output log viewer (click → see stdout) | TODO | P0 | FleetCode, 1Code have this |
| M3-3 | Agent lifecycle controls (kill, restart from sidebar) | TODO | P0 | Read-only dashboard isn't enough |
| M3-4 | Diff summary per agent ("touched 12 files, +340/-87") | TODO | P1 | QA signal for review-before-merge |
| M3-5 | Multi-workspace agent tracking | PARKED | P2 | Scope creep — evaluate post-launch |
| M3-6 | Stuck-agent detection (heuristic: same state for N min) | TODO | P1 | Address "runaway agent" fear |

### M5: Monetization (v1.0)
**Goal:** Pro tier generating revenue.

| ID | Item | Status | Priority | Notes |
|----|------|--------|----------|-------|
| M5-1 | Licensing infrastructure (Stripe or LemonSqueezy) | TODO | P0 | VS Code has no native paid extension support |
| M5-2 | Free tier: agent status tree, basic launch, git branch | TODO | P0 | The hook — daily-use value for free |
| M5-3 | Pro tier ($9-12/mo): cost estimation, stuck detection, lifecycle controls, diff summaries | TODO | P0 | Pay for power features |
| M5-4 | Token/cost estimation per agent session | TODO | P0 | Pain point #2 from PMF analysis |
| M5-5 | Early-adopter lifetime deal ($49 one-time Pro) | TODO | P1 | Launch incentive, test willingness to pay |

---

## Cut / Deferred

| Item | Reason | Source |
|------|--------|--------|
| `cc-roadmap-tree-view` | Internal vanity feature, delays core work | Strategy Synthesis, Roadmap Review |
| `team-mode-signal` | Get baseline features working first | Roadmap Review |
| Non-Ghostty terminal launch integration | Core value is discovery, not launch. Ghostty launch is bonus. | Strategy Synthesis |
| Conflict detection between worktrees | High value but complex. Evaluate `clash-sh` integration post-launch. | Strategy Synthesis |
| Budget caps / kill-on-budget | Requires tight API integration. After cost tracking is stable. | PMF Analysis |
| Slack/webhook notifications | Post-launch feature for async workflows | PMF Analysis |

---

## Risks (from Strategy Synthesis)

1. **VS Code builds it natively** — Agent Sessions View is already in 1.109. Window: 6-9 months. Mitigation: our wedge is external terminal visibility.
2. **VC-backed competitors (1Code, Emdash)** — funded teams move fast. Mitigation: win on the VS Code extension niche, not feature breadth.
3. **Claude Code ships its own dashboard** — IPC server already exists. Mitigation: be cross-agent (Claude + Codex + others).
4. **Cursor 2.0 makes VS Code irrelevant** — 8 parallel agents in one IDE. Mitigation: VS Code + Claude Code is still dominant stack per surveys.
5. **Category commoditization** — 12+ tools entering space. Mitigation: moat is distribution (marketplace ranking), not technology.

---

## Metrics That Matter

| Metric | Target | When |
|--------|--------|------|
| Marketplace installs | 100 | M4 launch |
| Marketplace installs | 1,000 | M4 + 3 months |
| Weekly active users | 50 | M4 + 1 month |
| Pro conversions | 5% of WAU | M5 launch |
| HN front page | 1 post | M4 launch |

---

## References

- Strategy Synthesis: `research/STRATEGY-SYNTHESIS-2026-03-22.md`
- PMF Analysis: `research/PMF-ANALYSIS-2026-03-22.md`
- Competitive Analysis: `research/ROADMAP-REVIEW-2026-03-22.md`
- Competitive Landscape: `memory/projects/competitive-landscape.md` (workspace)
- Launcher Bugs: `memory/projects/launcher-bugs.md` (workspace)
