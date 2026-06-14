## 🚀 Command Central v0.6.0-rc.62

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc61)**
  • `e9dfde5f` fix(agent-status): scope inline focus/capture to running rows
  • `869e7a21` chore: auto-commit agent work [cc-history-stable-id-flat-fixup-20260614]
  • `4690bc95` fix(agent-status): distinct stable id for flat-mode Sources summary
  • `98732e82` fix(agent-status): stable TreeItem.id anchors History tree-resolve storm
  • `ad77b307` test(agent-status): lock History section rows as native non-actionable group rows
