## 🚀 Command Central v0.6.0-rc.77

✨ **Added**
  • **Installed VSIX proof harness** — Added a node-only proof path for the actual packaged extension, including exact VSIX SHA identity, passive/live Agent Status inspection, and read-only action probes.
  • **Symphony proof receipts** — Proof manifests now distinguish accepted prerelease artifacts from temporary proof artifacts so installed-version success cannot be mistaken for release identity.

⚡ **Changed**
  • **Symphony Run Attempts source truth** — Preserves launcher/source-owned metadata during normalization so the installed UI can project real launcher runs instead of collapsing to stale or ownerless rows.
  • **Tracker context clarity** — Missing owner-provided tracker metadata now renders explicitly as unavailable rather than implying Command Central owns tracker polling.

🔧 **Fixed**
  • **Review queue continuation gaps** — Completed runs with handoff evidence but missing review receipts now surface as review-queue gaps instead of silently looking finished.

📦 **Since previous prerelease cut (rc76)**
  • `3ce74a70` feat(agent-status): surface running review-ready lanes as Needs Review (PAR-295)
  • `61b50f5c` fix(biome): update schema version to 2.5.1
  • `62e2d437` docs(release): document CCSTD-05 split-identity trust boundary + Tier 2 gates (PAR-84)
  • `c83462db` test(agent-status): lock lane-GC reconciler dedup via live reader path (PAR-300)
  • `4d6b3718` fix(mock-hygiene): validate real fall-through per mock.module factory
  • `92b6abb0` test(mock-hygiene): guard shared node-builtin mocks against cross-file leaks

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
