CLEAR
# Strategic Analysis: Agent Activity Timeline

**Date:** 2026-03-24
**Decision:** REMOVE
**Confidence:** High

## Executive Summary

Agent Activity should be removed. It's a well-built feature that occupies a dead zone between Agent Status (live monitoring) and Git Sort (file review). Its removal cleans 1,700 lines from the codebase with zero user-facing regression — the feature is hidden behind a config toggle, absent from the marketing site, and its value proposition is fully covered by the other two views.

## Analysis

### 1. Overlap Assessment

| Capability | Agent Status | Git Sort | Agent Activity |
|---|---|---|---|
| Who's running now? | **Primary** | - | - |
| What files changed? | Partial (commit summary) | **Primary** | Partial (commit events) |
| Task lifecycle (start/complete/fail) | **Primary** (live) | - | Duplicate (historical) |
| Time-based organization | By elapsed time | **Primary** (recency sort) | Duplicate (period groups) |
| Agent identification | **Primary** | - | Duplicate |

Agent Activity's "what happened while I was away?" use case is almost entirely served by:
- **Agent Status:** Shows completed/failed tasks with timestamps, exit codes, durations
- **Git Sort:** Shows all changed files sorted by recency — the actual artifacts you need to review

The only unique value Agent Activity adds is correlating "which agent made which commit" — but this is low-priority information when you can already see agent status + file changes separately.

### 2. Code Quality Assessment

The code itself is solid:
- Clean separation: types (59 LOC), collector (244 LOC), provider (277 LOC), view manager (138 LOC), commands (69 LOC)
- Well-tested: 576 lines of provider tests, 337 lines of collector tests
- Good patterns: debounced refresh, file watchers, proper disposal

But quality doesn't justify existence. The feature is engineering looking for a problem.

### 3. Marketing Alignment

The partnerai.dev site tells a 4-beat story: DISCOVER → MONITOR → NOTIFY → REVIEW.

Agent Activity fits none of these beats. It wasn't added to the site because there's no compelling user story that isn't already told by the existing beats. Adding a 5th beat ("HISTORY"?) would muddy a clean narrative.

### 4. The "Unified Timeline" Counter-Argument

Could Agent Activity evolve into a unified view merging Agent Status + Git Sort? In theory, yes — a timeline showing "agent started → files changed → agent completed" is compelling. In practice:
- It would require a complete rewrite (current impl only reads git log for commits)
- The task-started/completed/failed events in the type system are unused — the collector only produces commit events
- Agent Status already tells this story in real-time; a historical duplicate adds little
- The unified timeline is a v2.0 concept that shouldn't block cleaning up v1.0

### 5. Default Config Observation

The config shows `"default": true` — meaning it was turned ON at some point. But visibility gated behind `when: "config.commandCentral.activityTimeline.enabled"` still makes it a secondary feature. The fact that no one noticed or complained when it was hidden confirms low usage.

## Files to Remove

### Source (787 lines)
- `src/providers/activity-timeline-tree-provider.ts` (277)
- `src/providers/activity-timeline-view-manager.ts` (138)
- `src/commands/activity-timeline-commands.ts` (69)
- `src/services/activity-event-types.ts` (59)
- `src/services/activity-collector.ts` (244)

### Tests (913 lines)
- `test/providers/activity-timeline-tree-provider.test.ts` (576)
- `test/services/activity-collector.test.ts` (337)

### References to clean
- `src/extension.ts` — remove Activity Timeline initialization block (~15 lines)
- `package.json` — remove:
  - `commandCentral.activityTimeline.enabled` config
  - `commandCentral.activityTimeline.lookbackDays` config
  - `commandCentral.refreshActivityTimeline` command
  - `commandCentral.activityTimeline` view registration
  - Activity timeline menu entry
  - `commandCentral.filterActivityByAgent` command (if present)

### Total cleanup: ~1,700 lines removed

## Risk Assessment

- **User impact:** Zero — feature is config-gated with no evidence of external users
- **Build impact:** Fewer files to compile, smaller bundle
- **Test impact:** Net reduction of ~913 test lines; remaining tests unaffected
- **Marketing impact:** None — feature isn't on the site

## Future Consideration

If a unified timeline concept resurfaces, it should be designed from scratch with:
1. Real-time event streaming (not git log polling)
2. Integration with Agent Status events natively
3. A clear user story that earns its place in the marketing narrative
4. The ActivityCollector's co-author parsing logic could be extracted if needed — it's the one genuinely reusable piece
