## 🚀 Command Central v0.6.0-rc.78

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc77)**
  • `1bae3ac4` test: repair strict-CI gate — TS4111 bracket access + align bridge fixtures with row-derived status
  • `219c3421` ci: make the publish gate mirror CI instead of a drifted/phantom test subset
  • `c9e4a1c0` docs: add OpenClaw-native fleet work surface spec v1
  • `3e1531cc` test(work-system-bridge): add authenticated hook HTTP workroom-route smoke (PAR-243)

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
