## 🚀 Command Central v0.5.1-50

⚡ **Changed**
  • **Faster sidebar with 100+ agents** — Tree refreshes are now debounced and batched instead of cascading on every async diff/port resolution. With 166 tasks in the registry, the sidebar no longer stutters.
  • **Smarter cache management** — Diff summary cache is pruned (stale entries removed) instead of nuked on every reload, so resolved diffs persist across refreshes.
  • **Status-grouped agent view** — When using the Status or Status+Recency sort modes, agents are grouped into collapsible **Running**, **Failed & Stopped**, and **Completed** sections — matching the Source Control panel pattern.
  • **Targeted tree updates** — Individual tree items refresh when their data changes, instead of always redrawing the entire list.

🔧 **Fixed**
  • **`oste-steer.sh` not found on resume** — The "Resume Session" command now resolves helper scripts via the launcher path resolver instead of relying on PATH, fixing `ENOENT` errors when steering launcher sessions.
  • **PATH init corruption on Codex spawns** — The 108-line PATH initialization snippet that was sent inline via tmux `send-keys` (and getting mangled) is now written to a temp file and sourced cleanly.

⚡ *Performance improvements in this release*
