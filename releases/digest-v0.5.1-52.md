## 🚀 Command Central v0.5.1-52

🔧 **Fixed**
  • **Resume/Focus routes to exact task terminal** — Clicking Focus Terminal or Resume Session now selects the exact tmux window and pane for that task instead of just activating the Ghostty app. Multiple tasks in the same project now land in their own tabs. New `task-terminal-routing.ts` module resolves the precise target; `window-focus.ts` uses AppleScript terminal-ID lookup for targeted activation.
