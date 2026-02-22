# Typography — Partner AI Brand Standard

> v1.0 — 2026-02-22. Canonical reference for all Partner AI typography.

## Brand Typeface: Space Grotesk

**Space Grotesk** is the official display and branding typeface for Partner AI and all its products.

- **Source:** [Google Fonts](https://fonts.google.com/specimen/Space+Grotesk)
- **Designer:** Florian Karsten (derived from Space Mono)
- **License:** SIL Open Font License 1.1 — free for web, print, marketing, embedding
- **Variable font:** Yes (weight axis 300–700)
- **Static weights used:** Light (300), Regular (400), Medium (500), SemiBold (600), Bold (700)

### Why Space Grotesk

Space Grotesk was chosen after evaluating five finalists (Space Grotesk, Geist Sans, Sora, Outfit, IBM Plex Sans) against Partner AI's brand requirements:

1. **Technical DNA.** Born from Space Mono — a monospace coding font. The geometric letterforms carry developer credibility without needing to literally be monospace.

2. **Distinctive character.** The slightly unconventional `a`, `g`, and `R` give it personality in a sea of Inter/Helvetica developer sites. It's opinionated — like an engineering partner with strong (good) opinions about architecture.

3. **Dark-mode native.** Open counters and clean geometry render crisply on #0D1117 backgrounds. Excellent contrast at all sizes.

4. **Works everywhere.** Strong performance in ALL CAPS (`PARTNER AI`), Mixed Case (`Command Central`), and smaller tagline sizes. Holds up from 16px body to 96px hero headlines.

5. **"Partner" + "AI" balance.** Warm enough for "partner" (human, approachable), precise enough for "AI" (technical, engineered). This balance is the hardest thing to get right, and Space Grotesk nails it.

---

## Usage Rules

### Where Space Grotesk appears

| Context | Weight | Size (web) | Notes |
|---------|--------|------------|-------|
| "Partner AI" wordmark | Bold (700) | — | Used in logo lockups, social cards |
| Product names ("Command Central") | Bold (700) | 36–56px | Hero headlines, social previews |
| Landing page headlines | SemiBold (600) | 32–48px | Section headers, feature titles |
| Subheadlines / taglines | Regular (400) | 20–28px | Below headlines, card descriptions |
| Navigation wordmark | Medium (500) | 18–20px | Site header "Partner AI" |

### Where Space Grotesk does NOT appear

- **Body text / paragraphs.** Use the system font stack or Inter for long-form content.
- **Code samples.** Use a monospace font (JetBrains Mono, Fira Code, etc.).
- **VS Code UI elements.** The extension inherits VS Code's native theming.

### Casing

- **Product names:** Mixed Case — `Command Central`, `DiffGuard`
- **Brand name:** Mixed Case — `Partner AI`
- **Headlines:** Sentence case — `Code changes, sorted by time`
- **ALL CAPS:** Reserved for short labels, badges, or accent text — `PARTNER AI`, `NEW`

---

## Color Pairings

Space Grotesk on Partner AI's dark palette:

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| Primary text | White | `#F0F6FC` | Headlines, product names |
| Accent text | Blue | `#79C0FF` | Brand attribution, links, "Partner AI" |
| Secondary text | Dim | `#8B949E` | Taglines, descriptions |
| Muted text | Border | `#30363D` | Labels, metadata |
| Background | Dark | `#0D1117` | All surfaces |

---

## Web Implementation

### Google Fonts (recommended)

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

### CSS

```css
:root {
  --font-brand: 'Space Grotesk', system-ui, -apple-system, sans-serif;
}

/* Wordmark in navigation */
.nav-brand {
  font-family: var(--font-brand);
  font-weight: 500;
  font-size: 1.25rem;
  letter-spacing: -0.01em;
}

/* Hero headline */
.hero-title {
  font-family: var(--font-brand);
  font-weight: 700;
  font-size: 3rem;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

/* Section headlines */
.section-title {
  font-family: var(--font-brand);
  font-weight: 600;
  font-size: 2rem;
  letter-spacing: -0.01em;
}

/* Taglines and subtitles */
.tagline {
  font-family: var(--font-brand);
  font-weight: 400;
  font-size: 1.25rem;
  letter-spacing: 0;
}
```

### Self-Hosting (alternative)

Download from Google Fonts or the [GitHub repo](https://github.com/nicol/spacegrotesk). Host `.woff2` files. Use `font-display: swap` for performance.

---

## Social Preview / OG Card Specs

### GitHub Social Preview (`social-preview.png`)
- **Size:** 1280 × 640
- **Safe margins:** 40px all sides
- **Layout:** Logo (160px) → Title (Space Grotesk Bold 54px, #F0F6FC) → Tagline (Regular 27px, #8B949E) → Brand URL (Medium 24px, #79C0FF)
- **Background:** #0D1117
- **Content vertically centered** within safe area, nudged +10px for optical balance

### Open Graph Card (`og-card.png`)
- **Size:** 1200 × 630
- **Same layout as social preview**, scaled to fit

### Rendering
Both cards are generated via Python/Pillow using `.ttf` files from Google Fonts. The generation script lives at `workspace/create_social_preview_final.py`.

---

## Landing Page Application

### Current site: partnerai.dev

Space Grotesk should appear in these locations:

1. **Navigation:** "Partner AI" wordmark — Medium 500, ~18px
2. **Hero:** Product name "Command Central" — Bold 700, large (48–64px)
3. **Hero tagline:** Below the product name — Regular 400, ~24px
4. **Section headers:** "What it does", feature names — SemiBold 600, ~32px
5. **Feature cards:** Feature titles — Medium 500, ~20px

Body text (feature descriptions, bullet points) should remain in the system font stack or Inter for readability.

---

## Evaluation Notes (for reference)

### Finalists Considered

| Rank | Font | Score | Verdict |
|------|------|-------|---------|
| **#1** | **Space Grotesk** | 24/25 | Technical roots, distinctive character, warm + sharp. The pick. |
| #2 | Geist Sans | 22/25 | Purpose-built for dev contexts. Slightly too "platform," not enough "partner." |
| #3 | IBM Plex Sans | 20/25 | Trustworthy and mature. Leans enterprise — heavy for a modern tool. |
| #4 | Sora | 16/25 | Friendly but generic. Lacks technical edge. |
| #5 | Outfit | 12/25 | Wrong genre — consumer/lifestyle, not dev tools. |

### Key Differentiator

> "Partner AI" in Space Grotesk looks like a tool you'd actually install. "DiffGuard" and "Command Central" look like real tools. In most other fonts, they look like marketing copy.

---

## Future Products

When Partner AI ships new products, they inherit:

- **Space Grotesk Bold** for the product name
- **Space Grotesk Regular/Medium** for taglines
- The same color pairings on #0D1117
- The same social card template (swap product name + tagline)

This ensures visual cohesion across the Partner AI product family while letting each product have its own identity through naming and iconography.
