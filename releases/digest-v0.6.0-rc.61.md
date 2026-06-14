## 🚀 Command Central v0.6.0-rc.61

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc60)**
  • `5f1c9d63` feat(agent-status): complete Agent Status V2 project-first section model
  • `153f9948` chore: auto-commit agent work [cc-agent-status-v2-implementation-20260613]
  • `c17f3de5` fix(agent-status): keep detached/unconfirmable running lanes in Current·Live
  • `4a64e74b` chore: auto-commit agent work [cc-unified-status-tree-ux-20260613]
  • `807f1158` chore: auto-commit agent work [cc-current-running-surface-fix-20260613]
  • `add9b0fc` fix(agent-status): replace idle "none active" with history-preserving "0 live now"
  • `05af4109` fix(agent-status): suppress duplicate registry-fallback log spam
  • `72216ce1` fix(agent-status): collapse stale Needs Review backlog and calm idle Symphony summary
  • `f7b5c0b0` docs(agent-status): record rc.61 black-box readiness receipt
  • `9ace3f74` fix(agent-status-audit): keep status breakdown honest for null-status rows
  • `3c03b509` docs(agent-status): record independent review receipt for render perf polish
  • `755647b9` docs(agent-status): record independent review results in perf-polish receipt
  • … and 10 more
