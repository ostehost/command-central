## 🚀 Command Central v0.6.0-rc.13

⚡ **Changed**
  • **Codex Runs lifecycle wording** — Agent Status now labels Codex run provenance as `Lifecycle authority`, and run hover text makes the source-owner boundary explicit.
  • **Codex Runs status summary** — The root `Codex Runs` row now separates active, attention, stopped, cancelled, unknown, and done buckets so stopped runs are visible instead of hidden behind the total count.

🔧 **Fixed**
  • **Codex Runs root tooltip** — The group tooltip now clearly states that these runs are a read-only projection and that lifecycle authority remains with OpenClaw, TaskFlow, or the launcher/source owner.
