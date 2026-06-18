## 🚀 Command Central v0.6.0-rc.60

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc58)**
  • `3c03b50` docs(agent-status): record independent review receipt for render perf polish
  • `755647b` docs(agent-status): record independent review results in perf-polish receipt
  • `706cbfb` docs(agent-status): amend perf-polish receipt to final HEAD with click-guard commits
  • `92788e0` fix(agent-status): avoid stale tmux attach clicks
  • `815d4d9` fix(agent-status): expose cached tmux liveness for click routing
  • `b2b4123` docs(agent-status): record render perf polish receipt
  • `3abaf82` fix(agent-status): rename 'review queue pending' → 'review receipt missing'
  • `f2096bc` fix(agent-status): promote completion evidence (Tier 2c) above liveness check
  • `11e4fc1` test(agent-status): fix mock TS error + add resurrection guard for alive-session completed task
  • `83c8088` chore: auto-commit agent work [cc-agent-status-render-perf-polish-20260612]
  • `0eed7f0` test(agent-status): regression tests for completed-tmux misclassification
  • `93e2e69` perf(agent-status): cache stream/commit probes and memoize display-task list
  • … and 3 more
