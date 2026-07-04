## 🚀 Command Central v0.6.0-rc.76

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc75)**
  • `56310edd` feat(agent-status): classify idle agent REPLs as benign on clean completion
  • `fc31f6ea` fix(installed-proof): keep VS Code IPC socket under the macOS 103-byte cap

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
