## 🚀 Command Central v0.6.0-rc.80

⚡ **Changed**
  • **Terminal background watermark is now 600px** — doubled from 300px. The project emoji is drawn at 75% of a square canvas of this size, so this is the only value governing how large the watermark renders. Ships via the bundled launcher; a bundle picks it up on its next rebuild.
  • **Cutting a preview now refreshes installed launcher bundles** — the cut runs a bundle sync so a released launcher change reaches `/Applications/Projects/*.app` instead of sitting in the VSIX unconsumed. Bundles whose Ghostty client is running are skipped and reported rather than torn down mid-session.

🔧 **Fixed**
  • **App-stamp identity no longer keys on git sha** — the sha moves for commits that cannot change bundle content, which badged current bundles stale and suppressed their liveness probe.

📦 **Since previous prerelease cut (rc79)**
  • `2c446eff` fix(agent-status): drop git_sha from the app-stamp identity fields
  • `39091f0c` feat(release): refresh installed launcher bundles when cutting a preview

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
