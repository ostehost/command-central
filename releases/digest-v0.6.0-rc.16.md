## 🚀 Command Central v0.6.0-rc.16

🔧 **Fixed**
  • **Symphony visibility** — Agent Status now shows a root-level `Symphony / Codex Runs` container even when no source rows are currently projected.
  • **Codex Runs empty state** — Expanding the empty Symphony container shows `No projected Codex runs` so the read-only projection surface is discoverable before OpenClaw, TaskFlow, or launcher rows feed it.

🧪 **Verified**
  • `bun test test/services/codex-run-observer-service.test.ts test/tree-view/openclaw-task-nodes.test.ts`
  • `just check`
