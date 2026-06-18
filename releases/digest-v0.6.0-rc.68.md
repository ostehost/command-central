## 🚀 Command Central v0.6.0-rc.68

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc66)**
  • `fa21879` refactor(agent-status): align hub and node Command Central state
  • `f877746` fix(agent-status): harden launcher metadata handling
  • `3ea8bb3` test(agent-status): cover completed detached Symphony lane attention suppression (PAR-195)
  • `515e132` feat(agent-status): suppress ambiguous attention badge for completed detached Symphony lanes
  • `800394e` refactor(agent-status): add generic TtlCache, adopt it for file-probe caches
  • `2635562` refactor(agent-status): extract pure process-discovery diagnostics formatting
  • `e09addc` refactor(agent-status): extract pure prompt-summary text processing
  • `5bed2b3` refactor(agent-status): extract stateless git-diff execution into git-diff.ts
  • `5d88664` refactor(agent-status): extract OpenClaw/launcher session-matching trio
  • `642ceb3` refactor(agent-status): move agent-type labeling helpers into detection module
  • `87a7147` refactor(agent-status): extract pure OpenClaw task projection/display helpers
  • `8a0b08f` refactor(agent-status): extract pure diff/file-change formatters
  • … and 16 more
