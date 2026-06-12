## 🚀 Command Central v0.6.0-rc.58

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc56)**
  • `05b5616c` docs(agent-status): add projection-reader gate fixup review
  • `806b72f7` docs(agent-status): add projection-reader gate fixup receipt
  • `db809078` fix(gates): make projection-reader verification gates truthful
  • `7101eca3` docs(agent-status): add work-system projection reader review receipt
  • `f94ec43d` docs(agent-status): add work-system projection reader receipt
  • `b1803349` feat(agent-status): ingest work-system-lanes-projection lane registry shape
  • `9ee35623` docs(agent-status): add lane registry fixup review receipt
  • `1452f615` docs(agent-status): fix stale installed-VSIX proof contract comments
  • `bc6e91f7` docs(agent-status): add lane registry review receipt
  • `2f1ab599` feat(agent-status): zero-config lane registry defaults + legacy launcher deprecation
  • `70901b74` fix(agent-status): surface registry-backed LaneRef lanes via explicit lane registry source
  • `3ff311d5` chore: cut command central rc57
  • … and 1 more
