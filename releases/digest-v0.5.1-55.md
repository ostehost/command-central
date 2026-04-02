## 🚀 Command Central v0.5.1-55

✨ **Added**
  • **Stale agent detection + auto-reaping** — Tasks that are stuck AND have a dead tmux session get an automatic `completed_stale` overlay with ⚠️ warning icon and "Stale — session ended without completion signal" description. New "Reap Stale Agents" toolbar button finds and marks all stale agents as failed in one click.
  • **"Mark as Failed" quick action** — Right-click any stale agent to permanently mark it as failed in tasks.json.
