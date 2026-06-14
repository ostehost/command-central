## 🚀 Command Central v0.6.0-rc.64

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc63)**
  • `5ef4c4bd` fix(agent-status): render detached truth for liveness-unobservable running lanes
  • `15ecd13a` fix(agent-status): give Symphony root containers stable tree ids
  • `0372cc37` fix(agent-status): make agentTask menu gates survive the .linked suffix
  • `0c6ca0d0` fix(agent-status): scope olderRuns identity to parent, not hidden-node hash
  • `5ad63d14` fix(agent-status): unify tree identity keys
