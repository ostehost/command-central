## 🚀 Command Central v0.5.1-56

⚡ **Changed**
  • **Simplified Agent Status to one sort mode** — Removed 3-mode sort cycling (recency/status/status-recency). Now hardcoded to `status-recency` — the best mode that combines status grouping with time sub-groups. Removed 6 MVP-excess settings (`sortMode`, `sortByStatus`, `showOnlyRunning`, `maxVisibleAgents`, `scope`, `defaultBackend`). Keep only 4: autoRefreshMs, groupByProject, stuckThresholdMinutes, notifications.
  • **Deleted `agent-backend-switcher.ts`** — Removed the entire backend switching service and its 159-line test file. Auto-detection handles this now.
  • **Updated site SVGs** — 6 new mockups reflecting v0.5.1-54 capabilities: hero, agent status, model display, terminal routing, stale detection, clear completed. Site copy updated to center on See · Click · Know.

🗑️ **Removed**
