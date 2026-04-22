## 🚀 Command Central v0.6.0-rc.11

🔧 **Fixed**
  • **Grouped Agent Status identity collisions** — per-project TreeItem IDs no longer collide, so grouped trees stay stable instead of reusing the wrong item identity.
  • **Project path canonicalization at both discovery ingress points** — scope detection now normalizes paths consistently before grouping/filtering, which closes a real source of false splits and duplicate-looking project entries.
  • **Tasks-file resolver precedence** — resolver behavior is now explicit and covered: env override for hermetic fixture/dev-host runs, configured path when set, workspace-local `.ghostty-launcher/tasks.json`, then global XDG/legacy fallbacks.
  • **Hook-safe git subprocesses** — both temp-repo test helpers and deleted-file `git log` lookups now scrub outer `GIT_*` environment, so real pre-push hook runs behave the same as normal test runs.

🧪 **Improved**
  • **Release confidence** — RC.11 carries the testing-stack hardening work: unified CI coverage entrypoint, manifest-contract coverage, parser property tests, real VS Code integration harness, fixture-backed EDH support, and canonical JSON assertions for the task-registry property suite.
