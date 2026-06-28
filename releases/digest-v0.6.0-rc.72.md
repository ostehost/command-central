## 🚀 Command Central v0.6.0-rc.72

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc71)**
  • `17e5f44c` chore(bundle): sync launcher resources for paused lane lifecycle
  • `ca7cce59` feat(agent-status): first-class paused lane lifecycle + pauseAgent command
  • `f762f61d` test(focus): cover resolveAuthorizationTmuxLiveness native-room fast path
  • `c3397aa1` perf(focus): fast-path native-room launch-decision authorization via cached tmux probe
  • `dd43696e` chore: auto-commit agent work [symphony-PAR-237-4121df04]
  • `a2fdea66` fix(release): accept current daemon status shape

🛡️ **Release gate evidence**
  • ✅ Node readiness: passed
  • ✅ Daemon smoke: passed
  • ✅ Hub repo parity: passed
  • ✅ Launcher contract / sync: passed
