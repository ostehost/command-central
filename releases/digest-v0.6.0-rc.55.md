## 🚀 Command Central v0.6.0-rc.55

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc54)**
  • `d8b9388a` test(agent-status): cover single-owner activity badge and canonical worktree grouping
  • `4e828fae` chore: auto-commit agent work [cc-002-activity-badge-count-20260611]
  • `ceca1a97` fix(health): re-read task activity on tree changes to close the 30s contradiction window
  • `e83386ca` fix(health): stop collapsing partial OpenClaw health into a false DOWN
