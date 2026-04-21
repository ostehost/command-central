## 🚀 Command Central v0.6.0-rc.10

🔧 **Fixed**
  • **Non-running task clicks now resume** — Completed, failed, stopped, and stale task rows now route straight to `Resume Session` instead of falling through a generic action menu first.
  • **Prerelease cleanup no longer deletes rc builds out from under install** — Release artifact sorting now understands prerelease names like `rc.10`, so the freshly built VSIX survives cleanup and installs correctly.
  • **Project launcher focus fallback remains live** — tmux-backed tasks still prefer the canonical project launcher app before stock Ghostty attach when a project bundle exists.
