## 🚀 Command Central v0.6.0-rc.24

✨ **Added**
  • **Top-level Symphony surface** — Agent Status now exposes `Symphony` as a first-class root with `Operations Dashboard`, read-only `Running Sessions`, `Retry Queue`, and nested `Workstreams` / `Run Attempts`.
  • **Operations Dashboard summary** — The Symphony dashboard summarizes run attempts, workstreams, active sessions, retry queue pressure, turns, token totals, runtime, rate-limit snapshots, and the read-only status-surface boundary.

⚡ **Changed**
  • **Read-only kanban grouping** — Source-owned Run Attempts now appear under spec-language groups without adding drag/drop, retry/cancel controls, Linear polling, scheduler state, tracker writes, or lifecycle ownership.
  • **Nested Symphony navigation** — Existing `Workstreams` and `Run Attempts` surfaces now live under `Symphony`, preserving room for future TaskFlow/launcher-owned parent nodes.

🔧 **Fixed**
  • **Installed VSIX proof** — Local `0.6.0-rc.24` proof confirms the packaged extension loads from VSIX and renders `Symphony` as the sole top-level Agent Status root.
