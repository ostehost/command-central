## 🚀 Command Central v0.6.0-rc.69

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc68)**
  • `4c39fba` fix(agent-status): preserve workroom refs in extracted normalizer
  • `008e89d` test(agent-status): prove workroom/work-item refs surface on ingested projection row (PAR-239)
  • `3db28b9` feat(agent-status): surface workroom_ref/work_item_ref on ingested lane projection row
  • `895352c` chore(launcher-sync): sync bundled bridge with workroom/work-item row-backfill fix
  • `026064e` fix(agent-status): surface stale review gaps as action
