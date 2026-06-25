## 🚀 Command Central v0.6.0-rc.71

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc70)**
  • `37ccc75` Merge branch 'refactor/agent-status-cleanup'
  • `39f54c0` fix(agent-status): remove stale exported helpers
  • `b14b386` fix(release): stop internal ledger.json from shipping in the VSIX
  • `b7c64cf` fix(release): stop internal ledger.json from shipping in the VSIX
  • `66b679b` refactor(agent-status): break remaining AgentTask import cycles into the leaf
  • `6131844` refactor(agent-status): dedup computeDiffSummaryAsync into git-diff sibling
  • `9dd1000` docs(architecture): document Agent Status module layering
  • `3fcc19d` refactor(agent-status): make agent-status-tree-nodes the single source of node types
  • `ca87f94` refactor(agent-status): dedup git-diff command helpers into sibling module
  • `568f81a` refactor(agent-status): dedup Symphony projection into sibling module
  • `a06408d` refactor(agent-status): dedup OpenClaw task formatting into sibling module
  • `775885f` refactor(agent-status): dedup git-diff parsing/formatting into sibling module
  • … and 15 more

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
