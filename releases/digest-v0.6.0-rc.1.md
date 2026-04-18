## 🚀 Command Central v0.6.0-rc.1

🔧 **Fixed**
  • **Automatic settings migration** — On activation, detects and removes stale Agent Status settings from pre-simplification versions (`sortMode`, `sortByStatus`, `showOnlyRunning`, `maxVisibleAgents`, `scope`, `defaultBackend`). Flips `groupByProject` to `true` if it was explicitly `false`. Runs once, shows a one-time migration message. The upgrade path is now part of the product.
