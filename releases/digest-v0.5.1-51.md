## 🚀 Command Central v0.5.1-51

⚡ **Changed**
  • **Shared time-grouping primitives** — Git Sort and Agent Status now share a common `classifyTimePeriod()` + `groupByTimePeriod()` utility, reducing duplicate code and ensuring consistent Today/Yesterday/Older grouping across both panels.
  • **OpenClaw task audit in diagnostics** — The discovery diagnostics report now includes OpenClaw task ledger health: total tasks, running/succeeded/failed counts, stale-running detection, and audit findings summary.

🔧 **Fixed**
  • **Dead agent buttons now work** — Clicking Focus Terminal or Show Output on a failed/stopped/killed agent now opens the stream transcript file (`/tmp/codex-stream-*.jsonl`) in a VS Code editor tab instead of silently failing. No more dead buttons on ended sessions.
