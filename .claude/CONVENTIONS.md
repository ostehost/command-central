# Skill Conventions — Command Central

## Single Source of Truth

Canonical skill source is `.claude/skills/<name>/` in this repo. Every other copy is a deployment artifact installed from here.

Do not treat `~/.codex/skills/`, `~/.openclaw/workspace/skills/`, or any other location as canonical. Those are staging or install targets.

## Directory Layout

```
.claude/skills/<name>/
  SKILL.md              # Required — frontmatter + guidance (Codex skill spec)
  proof.md              # Required — provenance, validation results, safety review
  agents/openai.yaml    # Recommended — UI metadata (display_name, short_description)
  references/           # Optional — detailed docs loaded on demand
  scripts/              # Optional — executable tools (bash, python)
```

## Creating a New Skill

### 1. Scaffold

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/init_skill.py <name> \
  --path .claude/skills \
  --resources scripts,references \
  --interface display_name="<Display Name>" \
  --interface short_description="<25-64 char label>"
```

### 2. Write content

- **SKILL.md frontmatter**: only `name` and `description` are required. No `allowed-tools` unless you've reviewed the security implications. Description must be under 1024 chars, no angle brackets.
- **SKILL.md body**: concrete guidance, not vague principles. Reference actual file paths, function names, and patterns from the repo. Keep under 5k words; put details in `references/`.
- **proof.md**: document provenance (local-only vs forked), validation results, safety review checklist, and distribution table.
- **Scripts**: use `#!/usr/bin/env bash` and `set -euo pipefail`. No hardcoded `/Users/<username>` paths. Default to read-only or dry-run.

### 3. Validate

```bash
# All three must pass before commit
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/<name>
bash -n .claude/skills/<name>/scripts/*.sh
shellcheck .claude/skills/<name>/scripts/*.sh
```

### 4. Commit

Skills are source-controlled in this repo. Commit them like any other code change.

### 5. Propagate to OpenClaw

```bash
openclaw skills install .claude/skills/<name> --as <name> --force
```

This copies the skill into `~/.openclaw/workspace/skills/<name>/`. The OpenClaw gateway may need a restart to pick up new skills (quit and reopen the app).

**Verify:**
```bash
openclaw skills info <name>
```

## Consumers and Propagation

| Consumer | Discovery | Propagation |
|----------|-----------|-------------|
| Claude Code | Auto-discovers `.claude/skills/` when CWD is this repo | Automatic — reads canonical on every session |
| OpenClaw | Installed copy at `~/.openclaw/workspace/skills/` | Manual — re-run `openclaw skills install --force` after changes |

Claude Code needs no action after edits. OpenClaw requires the install command after every change to the canonical copy.

## Anti-Patterns

- **Multiple canonical copies.** One repo, one source. Everything else is installed from it.
- **Editing the OpenClaw install directly.** Changes there are overwritten on next install and aren't version-controlled.
- **Leaving `~/.codex/skills/` as the source.** That's a staging artifact from `skill-creator`. Move to `.claude/skills/` and delete the staging copy.
- **Stale docs.** If you change the extension code in a way that affects a skill's references (status enums, file paths, API shapes), update the skill in the same commit.
- **`allowed-tools` without review.** The Codex validator allows it, but elevated permissions need explicit justification in proof.md.

## Validation Checklist

Before committing a new or modified skill:

- [ ] `quick_validate.py` passes
- [ ] `bash -n` passes on all scripts
- [ ] `shellcheck` passes on all scripts
- [ ] No hardcoded `/Users/<username>` in any file
- [ ] No writes to VS Code `settings.json` from scripts
- [ ] No process killing from scripts
- [ ] Destructive scripts default to `--dry-run`
- [ ] proof.md is current with validation results
- [ ] References verified against current source code
