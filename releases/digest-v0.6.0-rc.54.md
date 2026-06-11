## 🚀 Command Central v0.6.0-rc.54

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc53)**
  • `fea91b9e` refactor(agent-diff): route diffs on explicit diffMode, not taskStatus
  • `26f8f96f` fix(agent-diff): preserve working-tree diff routing
  • `6a19d580` fix(agent-status): hub-aware OpenClaw health probe; reviewed tasks clear Attention
  • `80cb3330` refactor(activation): extract navigation, diff, and OpenClaw task command registration
  • `39981f53` refactor(activation): extract agent registry command registration from extension.ts
  • `805b369a` refactor(activation): extract ghostty command registration from extension.ts
  • `f3ad3d5e` refactor(activation): extract git-sort, grouping, and misc command registration
  • `20572894` refactor(activation): extract cron feature registration from extension.ts
  • `b79969f2` chore(knip): widen analysis scope to scripts/**, drop stale playwright ignore
