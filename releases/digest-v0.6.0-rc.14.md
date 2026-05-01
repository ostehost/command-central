## 🚀 Command Central v0.6.0-rc.14

🔧 **Fixed**
  • **Codex Runs identity joins** — Launcher metadata now joins OpenClaw/TaskFlow-owned Codex runs only by explicit `taskId`, `runId`, or session identity. Display titles no longer act as join keys, preventing unrelated launcher rows from lending workspace/model/artifact metadata to authoritative owner rows.
  • **Codex Runs release alignment** — The preview artifact now includes the final identity-join hardening instead of leaving it source-only after the rc13 cut.
