## 🚀 Command Central v0.6.0-rc.85

🔧 **Fixed**
  • **Project icons no longer overwrite other repositories** — resolving a project's icon for the Agent Status tree used to persist a hash-derived emoji into that project's `.vscode/settings.json`, creating `.vscode/` if absent. Rendering the tree was enough to permanently stamp an arbitrary icon into a repository the extension does not own, which is how most of the workspace ended up disagreeing with Linear. Reads never write now; only the explicit change-icon command does.
  • **Icons come from the work registry** — resolution is now registry (published from Linear, the surface where these are actually curated) → the `commandCentral.project.icon` settings key → a display-only fallback that is never persisted. The registry is located by searching `PROJECTS_WORK_REGISTRY`, `OPENCLAW_CONFIG_HOME`, `XDG_CONFIG_HOME`, then `~/projects/config`, so it resolves on either machine rather than assuming one username.

⚡ **Changed**
  • **Bundled launcher reads the registry too** — `parse_icon` gained a tier above `.vscode/settings.json`, so a freshly built bundle renders Linear's icon without the launcher ever calling Linear (it builds offline and holds no token).

📦 **Since previous prerelease cut (rc83)**
  • `e3be8d17` test(bridge): adopt PAR-595 row-authoritative workroom lineage contract
  • `f35332cf` fix(justfile): drop unrunnable test-backup recipe and complete clean contract
  • `3bdcb12f` feat(lint): add shellcheck gate following the fleet convention
  • `95e0acc7` refactor(justfile): run knip exactly once per entrypoint
  • `99475792` fix(test-quality): close it.skip evasion in the skipped-test gate
  • `530ae36d` fix(skill-lanes): fail on vacuous lane state; correct CI reproduction docs
  • `c1f39473` docs: correct user-facing install and discovery documentation
  • `17941588` docs(workflow): align command docs with the local-eight contract
  • `db16e452` feat(justfile): adopt local-eight entrypoints and self-contained skill-lane gate
  • `0d690283` docs(agents): migrate root policy to AGENTS triad without loss
  • `3932d500` fix(justfile): forward preview-status and vsix-gate arguments as argv
  • `77855403` fix(justfile): forward test and info arguments as argv, not shell source
  • … and 1 more

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
