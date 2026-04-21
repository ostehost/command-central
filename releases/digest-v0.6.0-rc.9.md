## 🚀 Command Central v0.6.0-rc.9

🔧 **Fixed**
  • **Project launcher focus fallback** — When a tmux-backed task has no task-specific launcher surface metadata, clicking it now prefers the canonical project launcher app (for example `/Applications/Projects/command-central.app`) before falling back to a generic stock Ghostty `tmux attach` window. This keeps focus inside the proper project terminal when that launcher surface exists.
