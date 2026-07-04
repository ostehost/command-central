## 🚀 Command Central v0.6.0-rc.75

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc74)**
  • `72d7cc11` feat(fresh-slate): cover the Work System lanes projection in reset + audit
  • `6635fc01` fix(agent-status): stream-freshness veto on confirmed-dead demotion
  • `b70d57ff` feat(prerelease-gate): cross-validate hub/node consumption receipts (PAR-298)
  • `0ab43134` fix(agent-status): gate lane-GC reconcile on receipt freshness (PAR-299)
  • `1aed06ce` feat(verify-consumption): report stale sibling command-central extension dirs (PAR-270)

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
