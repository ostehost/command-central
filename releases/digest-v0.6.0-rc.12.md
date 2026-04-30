## 🚀 Command Central v0.6.0-rc.12

✨ **Added**
  • **Codex Runs visibility** — Agent Status now shows a root-level `Codex Runs` group that projects OpenClaw, TaskFlow, and launcher records into one read-only operator view with visible status, source status, lifecycle owner, run id, workspace, source, event, and artifact details.

🔧 **Fixed**
  • **Launcher-only Codex run projection** — Launcher-only Codex rows now stay distinct even when they share broad session identities or prompt/title text, while launcher metadata can still enrich existing OpenClaw/TaskFlow-owned rows.
  • **Codex Runs project filtering** — Project filters now keep out-of-project Codex run rows hidden, matching the rest of Agent Status.
