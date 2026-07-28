## 🚀 Command Central v0.6.0-rc.83

🔧 **Fixed**
  • **Project icons no longer overwrite other repositories** — resolving a project's icon for the Agent Status tree used to persist a hash-derived emoji into that project's `.vscode/settings.json`, creating `.vscode/` if absent. Rendering the tree was enough to permanently stamp an arbitrary icon into a repository the extension does not own, which is how most of the workspace ended up disagreeing with Linear. Reads never write now; only the explicit change-icon command does.
  • **Icons come from the work registry** — resolution is now registry (published from Linear, the surface where these are actually curated) → the `commandCentral.project.icon` settings key → a display-only fallback that is never persisted. The registry is located by searching `PROJECTS_WORK_REGISTRY`, `OPENCLAW_CONFIG_HOME`, `XDG_CONFIG_HOME`, then `~/projects/config`, so it resolves on either machine rather than assuming one username.

⚡ **Changed**
  • **Bundled launcher reads the registry too** — `parse_icon` gained a tier above `.vscode/settings.json`, so a freshly built bundle renders Linear's icon without the launcher ever calling Linear (it builds offline and holds no token).

📦 **Since previous prerelease cut (rc82)**
  • `76fe9737` fix(agent-status): give the release-generation guard a direction

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
