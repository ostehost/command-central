# Site Workflow — Local Preview & Iteration

> Zero-config local development for the Command Central landing page.

## Quick Start

```bash
# Start local preview with live reload
just site

# Validate before commit
just site-check

# Capture screenshot for comparison
just site-screenshot
```

## Full Edit → Preview → Validate → Deploy Cycle

### 1. Edit (Local Changes)
- Edit HTML/CSS/assets in `site/` directory
- Pure static files — no build step required
- Changes are instantly visible in browser with live reload

### 2. Preview (Local Development)
```bash
just site
# → Starts live-server on http://localhost:3000
# → Auto-refreshes on file changes
# → Press Ctrl+C to stop
```

**For AI Agents:** Use the same `just site` command. The server runs in background and agents can validate changes by taking screenshots.

### 3. Validate (Pre-Commit)
```bash
just site-check
# → Validates test count synchronization (HTML vs actual)
# → Checks for broken links (internal only)
# → Verifies SVG assets exist and non-empty
# → Confirms OG image exists
# → Scans for placeholder text
# → Basic HTML structure validation
```

**Automation:** Pre-push hook runs `site-check` automatically when `site/` files change.

### 4. Commit & Push
```bash
git add site/
git commit -m "Update landing page copy"
git push
# → Pre-push hook validates site automatically
# → ~2 seconds for site-check
```

### 5. Deploy (Automatic)
- GitHub Pages picks up changes in ~2-3 minutes
- Live at https://partnerai.dev

## Agent Workflow (OpenClaw/Claude Code)

### Parallel Iteration Pattern
```bash
# Agent A: Content changes
just site &           # Start preview server
# Edit content
just site-screenshot  # Capture current state
# Make changes
just site-screenshot  # Compare changes

# Agent B: Validation/testing
just site-check       # Validate while A works
```

### Screenshot-Driven Prompts
```bash
# Capture baseline
just site-screenshot

# Make changes...

# Capture result
just site-screenshot
# → Compare screenshots to validate visual changes
```

### Blast Radius Thinking
- **Low risk:** Copy changes, color tweaks
- **Medium risk:** Layout changes, new sections
- **High risk:** Meta tag changes, structural HTML

### Agent Safety Guards
1. **Always run `just site-check` before commit**
2. **Test count must stay synchronized** (validates against actual bun test output)
3. **No broken links** — script checks all internal href/src
4. **All assets must exist** — SVGs, images, fonts

## Technical Details

### Local Server Stack
- **Primary:** live-server via bun (live reload enabled)
- **Fallback:** Python HTTP server (no live reload)
- **Port:** 3000 (configurable in justfile)

### Validation Rules
- **Test count:** HTML `<span class="trust-number">` must match `bun test` output
- **Links:** All internal href/src must resolve to existing files
- **Assets:** All SVGs must exist and be non-empty
- **Meta:** Required tags: title, description, og:image
- **Placeholders:** Warns on TODO, FIXME, Lorem ipsum patterns

### File Structure
```
site/
├── index.html         # Main landing page
├── style.css          # Styles
├── assets/           # Static assets
├── images/           # Images, icons, OG card
└── WORKFLOW.md       # This file
```

### Screenshots
- Saved to `screenshots/site-preview.png`
- Uses Playwright for consistent rendering
- Automated via `just site-screenshot`

## Performance Requirements

- **Site validation:** < 2 seconds (pre-push hook constraint)
- **Live reload:** < 500ms refresh time
- **Screenshot capture:** < 5 seconds end-to-end

## Troubleshooting

### "No server available" error
```bash
# Install bun for live reload
curl -fsSL https://bun.sh/install | bash

# Or use Python fallback
python3 -m http.server 3000 --directory site
```

### "Test count mismatch" error
```bash
# Run tests to see actual count
bun test | tail -5

# Update HTML manually
vim site/index.html
# Find <span class="trust-number">XXX</span>
```

### Screenshot command fails
```bash
# Check Playwright installation
bun x playwright install

# Manual screenshot
open http://localhost:3000  # Start site first
```

## Integration Points

### With Extension Development
- **Justfile:** Site commands integrate with existing extension workflow
- **Git hooks:** Site validation runs alongside extension pre-push checks
- **Documentation:** Same pattern as extension WORKFLOW.md

### With CI/CD
- **GitHub Pages:** Automatic deploy on push to main
- **Pre-push validation:** Prevents broken deployments
- **Test synchronization:** Keeps marketing claims accurate

## Best Practices

### For Solo Development
1. Keep preview server running during editing sessions
2. Use screenshot comparison for visual validation
3. Run `just site-check` before every commit
4. Test on multiple screen sizes via browser tools

### For AI Agents
1. Start with screenshot of current state
2. Make atomic changes (one concept per commit)
3. Validate each change before proceeding
4. Use blast radius thinking for change assessment

### Content Guidelines
- **No hyphens** in copy (existing rule)
- **Test count stays current** (automated validation)
- **Performance claims backed by data** (validated in CI)
- **Visual consistency** with brand guidelines