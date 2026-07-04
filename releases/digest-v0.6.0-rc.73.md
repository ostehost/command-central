## 🚀 Command Central v0.6.0-rc.73

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc71)**
  • `77b4ca54` fix(release): require explicit node VSIX transfer receipt (PAR-269)
  • `e6c767e3` feat(release): add just dogfood-node-vsix file-transfer node dogfood loop (PAR-269)
  • `400e0cd4` refactor(preserve-baseline): store capture-less {scheme,host,hasCredential} not redacted URL (PAR-268)
  • `b19ba454` feat(providers): project native visible-lane attention receipts (PAR-323)
  • `5b16b047` feat(providers): detect visible Claude permission/input waits (PAR-322)
  • `9daea34f` docs(release): refresh rc72 digest after sync
  • `c81b934a` chore(sync): merge hub and node command-central state
  • `4dafbbe3` refactor(providers): convert 4 more hand-rolled TTL caches to TtlCache
  • `da7c9500` refactor(providers): use TtlCache in TmuxLivenessChecker instead of hand-rolled maps
  • `79b0d126` refactor(providers): extract TaskRegistryReader from AgentStatusTreeProvider
  • `a1a986a8` refactor(providers): finish migration to agent-task-normalize.ts
  • `deabf3c0` refactor(providers): extract TmuxLivenessChecker from AgentStatusTreeProvider
  • … and 10 more

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
