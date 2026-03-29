# DEV NOTES: marketing-site-update

## Task
Update the Command Central marketing site (`site/`) for the M4 launch messaging.

## What Changed
- Updated hero copy to lead with the Dock icon + agent multiplexer story.
- Added required hero message: "See all your AI coding agents — even ones VS Code can't see — from one sidebar."
- Reworked launch feature cards to reflect current v0.5.1-19 state:
  - Per-project emoji Dock icons (auto-assign, user override, persistent identity)
  - Auto-discovery across external terminals
  - Sidebar lifecycle controls (kill/restart/output/diff)
  - Per-agent inline diff summary plus per-file +/- stats
  - Terminal stack compatibility + VS Code integrated terminal fallback
- Added explicit mention of cross-repo prerelease gate with provenance in launch copy.
- Reworked comparison section into "Why Command Central?" and compared against dmux/cmux/FleetCode on the external-terminal discovery wedge.
- Updated install command CTA to:
  - `code --install-extension oste.command-central`
- Updated screenshot alt text and captions to match current product behavior.
- Synced on-page test count from 894 to 963 to satisfy site validation.

## Verification
- `just format` attempted, but this repo does not define a `format` recipe.
- Ran `just fix` as nearest equivalent formatting/linting command.
- Ran `just site-check` (passes).
- Verified server startup with `cd site && python3 -m http.server 8091` (starts successfully).

## Files Changed
- `site/index.html`

IMPLEMENTATION COMPLETE
