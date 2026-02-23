# SVG → PNG Conversion

## Quick Start

```bash
# Convert all marketing SVGs
bun run scripts/svg-to-png.ts

# Convert a specific file
bun run scripts/svg-to-png.ts site/assets/hero.svg
```

Output is placed alongside the source SVG (`hero.svg` → `hero.png`).

## How It Works

Uses **Playwright** (Chromium) to render SVGs to PNG at 2× resolution.

**Why a browser?** Only a real browser engine renders Apple Color Emoji. All standalone SVG rasterizers (resvg, cairo, librsvg/sharp, cairosvg) produce monochrome glyphs for emoji characters. This was verified through research — there is no non-browser solution that handles color emoji on macOS.

### What the script does:
1. Reads SVG, extracts `viewBox` dimensions
2. Launches Chromium (headless) with `deviceScaleFactor: 2`
3. Sets viewport to exact SVG dimensions (no margins)
4. Injects SVG into a minimal HTML page
5. Takes a full-page screenshot → PNG

### Output dimensions:
- SVG viewBox `480×490` → PNG `960×980`
- SVG viewBox `480×370` → PNG `960×740`
- SVG viewBox `480×320` → PNG `960×640`

## When to Run

Run this after modifying any SVG in `site/assets/`:
- `hero.svg` — main product illustration
- `git-status.svg` — staged/working changes illustration
- `filter.svg` — extension filter illustration

The PNGs are what GitHub README and Marketplace display. The site uses SVGs directly.

## Dependencies

- `playwright` (dev dependency)
- Chromium browser (installed via `npx playwright install chromium`)

## Alternatives Considered

| Tool | Color Emoji | Why Not |
|------|:-----------:|---------|
| `rsvg-convert` | ❌ | Monochrome emoji |
| `resvg` / `resvg-js` | ❌ | No system font access |
| `cairosvg` | ❌ | Cairo can't render SBIX/COLR emoji |
| `sharp` (librsvg) | ❌ | Same as rsvg-convert |
| `Inkscape` | ⚠️ | Unreliable emoji, 500MB install |
| Chrome headless CLI | ✅ | Works but needs wrapper HTML + magenta-crop hack |
| **Playwright** | ✅ | Clean API, auto-clips, `deviceScaleFactor` for 2× |
