## 🚀 Command Central v0.6.0-rc.79

🔧 **Fixed**
  • **Work-registry resolver no longer assumes one username** — the bundled `scripts/lib/project-ref.sh` hardcoded an absolute `/Users/<name>` resolver path, so on any machine with a different username every lane spawn failed closed, naming the wrong cause and suggesting remedies that could not fix it. It now searches `$OSTE_PROJECT_RESOLVER`, `$OPENCLAW_CONFIG_HOME`, `$XDG_CONFIG_HOME` (default `~/.config`), then `~/projects/config`.
  • **zellij panes lost the user's config home** — the bundle's embedded `XDG_CONFIG_HOME` leaked into every shell zellij spawned, pointing fish at a config dir inside the `.app` with no `conf.d`. `launch-zellij.sh` now restores it before the interactive PATH probe, mirroring `launch-tmux.sh`.
  • **`--send` could kill the user's terminal window** — it re-derived the multiplexer from the settings/env precedence chain instead of reading the bundle's own `GHL_MULTIPLEXER` marker, so a tmux bundle could be driven down the zellij path (kill server, kill Ghostty client, wait for a session that never appears, exit 4). It now dispatches on the installed bundle's marker and reports any divergence.
  • **Agent-driven rebuilds switched panes from fish to zsh** — the pane shell was baked from `$SHELL`, which is `/bin/zsh` in a non-interactive agent context regardless of the account's real login shell. It is now resolved from directory services, with `$SHELL` as fallback.

⚡ **Changed**
  • **Baseline multiplexer for new bundles is now tmux** — was zellij. Agent orchestration only supports tmux/persist, so a zellij baseline meant every new bundle was born in a mode its primary consumer rejects and paid a full rebuild on first agent contact. zellij remains fully selectable per project via `commandCentral.terminal.multiplexer`, `GHL_DEFAULT_MULTIPLEXER`, or `--multiplexer`.

📦 **Since previous prerelease cut (rc78)**
  • No functional commits since the rc78 cut (release-process commits only)

🛡️ **Release gate evidence**
  • ✅ Launcher contract / sync: passed
