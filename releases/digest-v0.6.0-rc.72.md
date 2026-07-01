## 🚀 Command Central v0.6.0-rc.72

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc71)**
  • `4dafbbe` refactor(providers): convert 4 more hand-rolled TTL caches to TtlCache
  • `da7c950` refactor(providers): use TtlCache in TmuxLivenessChecker instead of hand-rolled maps
  • `79b0d12` refactor(providers): extract TaskRegistryReader from AgentStatusTreeProvider
  • `a1a986a` refactor(providers): finish migration to agent-task-normalize.ts
  • `deabf3c` refactor(providers): extract TmuxLivenessChecker from AgentStatusTreeProvider
  • `dddd8dc` docs(review): record final rc71 review outcome; document nested daemon-smoke shapes
  • `a2fdea6` fix(release): accept current daemon status shape

🛡️ **Release gate evidence**
  • ✅ Node readiness: passed
  • ✅ Daemon smoke: passed
  • ✅ Hub repo parity: passed
  • ✅ Launcher contract / sync: passed
