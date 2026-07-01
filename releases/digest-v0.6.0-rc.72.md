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
  • `c81b934` chore(sync): merge hub and node command-central state
  • `4dafbbe` refactor(providers): convert 4 more hand-rolled TTL caches to TtlCache
  • `da7c950` refactor(providers): use TtlCache in TmuxLivenessChecker instead of hand-rolled maps
  • `79b0d12` refactor(providers): extract TaskRegistryReader from AgentStatusTreeProvider
  • `a1a986a` refactor(providers): finish migration to agent-task-normalize.ts
  • `deabf3c` refactor(providers): extract TmuxLivenessChecker from AgentStatusTreeProvider
  • `7e25111` feat(agent-status): surface lane-projection GC receipt verdict for audit (PAR-227)
  • `1600fa1` feat(agent-status): honest hub+node sync-readiness identity for remote lanes (PAR-229)
  • `124f7e5` feat(agent-status): surface hub/node sync-readiness card in the tree (PAR-229)
  • `17e5f44` chore(bundle): sync launcher resources for paused lane lifecycle
  • `ca7cce5` feat(agent-status): first-class paused lane lifecycle + pauseAgent command
  • `f762f61` test(focus): cover resolveAuthorizationTmuxLiveness native-room fast path
  • … and 4 more

🛡️ **Release gate evidence**
  • ✅ Node readiness: passed
  • ✅ Daemon smoke: passed
  • ✅ Hub repo parity: passed
  • ✅ Launcher contract / sync: passed
