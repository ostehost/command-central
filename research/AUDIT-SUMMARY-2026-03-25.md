# Research Audit Summary — 2026-03-25

## Document Status

| Document | Status | Notes |
|---|---|---|
| `research/AMENDMENT-persist-backend-fix.md` | CLEAR | Focus stale-guard issue covered by current focus strategy flow. |
| `research/ANALYSIS-agent-activity-2026-03-24.md` | CLEAR | Activity Timeline feature and references were removed. |
| `research/COMPETITIVE-FEATURES-2026-03-23.md` | CLEAR | Core competitive positioning is reflected in shipped feature set. |
| `research/DESIGN-activity-timeline.md` | GAPS | Timeline design implementation not present. |
| `research/DISSERTATION-cmdtab-platform-2026-03-24.md` | GAPS | Dock-platform Phase 1/2 items remain incomplete. |
| `research/FOCUS-FEATURE-RESEARCH.md` | CLEAR | Core stale-guard/focus-path recommendations are reflected in code. |
| `research/PMF-ANALYSIS-2026-03-22.md` | CLEAR | MVP core observability items are shipped; later-phase items are roadmap-deferred. |
| `research/RESEARCH-failed-state-ux.md` | GAPS | Priority 3 items are still missing. |
| `research/RESEARCH-orchestration-completion-chain-2026-03-21.md` | GAPS | Completion-chain enrichment/structured wake items are still missing. |
| `research/RESEARCH-sidebar-ux-2026-03-24.md` | GAPS | Advanced sidebar recommendations remain unimplemented. |
| `research/ROADMAP-REVIEW-2026-03-22.md` | GAPS | Fleet dashboard/checkpoint recommendations not shipped; timeline recommendation superseded. |
| `research/SPEC-ci-fix-v3.md` | CLEAR | Mock-spread and CI stability work is present. |
| `research/SPEC-ci-fix.md` | CLEAR | CI/test stabilization work is reflected in current tests/helpers. |
| `research/SPEC-polish-tests.md` | CLEAR | Targeted test additions exist and are integrated. |
| `research/SPEC-resume-click.md` | GAPS | Non-running safety redirect and context exposure are not fully aligned. |
| `research/SPEC-schema-migration.md` | CLEAR | v1→v2 session field migration and compatibility are implemented. |
| `research/SPEC-session-resume.md` | CLEAR | Resume-session capability is implemented. |
| `research/SPEC-sidebar-ux.md` | CLEAR | Label/icon/grammar/status polish changes are implemented. |
| `research/STRATEGY-SYNTHESIS-2026-03-22.md` | CLEAR | Pre-launch strategic recommendations are reflected in roadmap + shipped features. |
| `research/UI-UX-STRATEGY-2026-03-24.md` | GAPS | Dock-native and platform-phase items remain incomplete. |
| `research/_temp-research-a-macos-apis.md` | CLEAR | Findings are incorporated into later synthesis docs/roadmap decisions. |
| `research/_temp-research-b-strategy.md` | CLEAR | Findings are incorporated into later synthesis docs/roadmap decisions. |

## Consolidated Uncovered Items

- Activity Timeline implementation from `DESIGN-activity-timeline.md` is absent (collector/provider/commands/shared reader/wiring).
- Dock-platform features are not yet shipped: dock badge, dock bounce, dock menu, NSWorkspace sync, status menu bar, and true window-id targeting.
- Failed-state Phase 3 UX is missing: bulk clear terminal-state tasks and status-priority grouping.
- Orchestration completion-chain enrichment is missing in launcher/hook flow: forwarding `last_assistant_message`, pending-review `agent_summary`/`transcript_path`, structured wake payload, SessionEnd fallback hook.
- Advanced sidebar workflow items are missing: PR creation/management action, token/cost tracking, status timeline, issue integration, merge action, plus P3 advanced compare/fork/mobile/search items.
- Roadmap-review suggestions still missing: fleet dashboard and deterministic approval checkpoint UI.
- Resume-click spec alignment gap: non-running fallback redirect in `focusAgentTerminal` and broad focus command exposure for terminal states.

## Priority Recommendations

1. **P0:** Finish completion-chain reliability/enrichment in launcher hooks (`last_assistant_message` propagation, structured wake payload, SessionEnd safety net).
2. **P0:** Deliver minimal dock-native loop (badge + bounce + actionable deep-link path) to close the highest-impact strategic gap.
3. **P1:** Complete the high-value sidebar workflow gap: PR creation/management action and token/cost visibility.
4. **P1:** Implement failed-state cleanup improvements (`clearTerminalTasks` + status-priority ordering).
5. **P2:** Resolve strategy/doc drift around Activity Timeline (formally mark as deprecated/superseded across design/roadmap research docs).
6. **P2:** Tighten resume-click behavior by limiting `focusAgentTerminal` on terminal states and enforcing non-running redirect safety.
