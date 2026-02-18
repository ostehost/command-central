# V3 Radar Icons - Visual Variations Reference

## Quick Visual Guide

### STAGED ICONS (Emerald Green - Ready to Deploy)

#### Variation A: Minimal
- **Concept**: Triangle + targeting brackets
- **Use case**: Clean, professional look
- **Complexity**: 3 elements
- **Files**: `staged-light-a.svg` | `staged-dark-a.svg`
- **Visual**:
  ```
      ▲
     /|\
    < | >
   /  |  \
  ```
  (Triangle with top-corner brackets)

#### Variation B: Medium (RECOMMENDED)
- **Concept**: Triangle + reticle rings at apex + confirmation corners at base
- **Use case**: Professional radar aesthetic, clear "target locked" signal
- **Complexity**: 5 elements
- **Files**: `staged-light-b.svg` | `staged-dark-b.svg`
- **Visual**:
  ```
      ⊙
     /|\
    / | \
   <  △  >
  ```
  (Triangle with targeting rings and confirmation points)

#### Variation C: Maximum Impact
- **Concept**: Triangle + full reticle system (rings + crosshair) + launch brackets
- **Use case**: High-visibility, distinctive appearance
- **Complexity**: 7 elements
- **Files**: `staged-light-c.svg` | `staged-dark-c.svg`
- **Visual**:
  ```
      ⊙
     ╱│╲
   ◄─┼─►
    ╲│╱
      ▼
  ```
  (Triangle with full targeting system and launch indication)

---

### WORKING ICONS (Amber - Active Radar Scan)

#### Variation A: Minimal
- **Concept**: Arc sweep + motion dot
- **Use case**: Clean, minimalist scanning indication
- **Complexity**: 2 elements
- **Files**: `working-light-a.svg` | `working-dark-a.svg`
- **Visual**:
  ```
    ╱─────╲
   ╱       ●
  ╱         ╲
  ```
  (Arc with motion indicator)

#### Variation B: Medium (RECOMMENDED)
- **Concept**: Arc + center hub + sweep line + secondary arc
- **Use case**: Clear "active radar scan from center" feeling
- **Complexity**: 4 elements
- **Files**: `working-light-b.svg` | `working-dark-b.svg`
- **Visual**:
  ```
    ╱─────╲
   ╱   ◉─●  ╲
  ╱    ╲     ╲
  ```
  (Arc with center point and sweep line)

#### Variation C: Maximum Impact
- **Concept**: Reference ring + primary arc + center hub + sweep line + active indicator
- **Use case**: High-detail mission control radar appearance
- **Complexity**: 6 elements
- **Files**: `working-light-c.svg` | `working-dark-c.svg`
- **Visual**:
  ```
    ◎───────◎
   ╱   ◉─●   ╲
  ◎    ╲     ◎
   ╲     ╲  ╱
    ◎──●─◎
  ```
  (Full radar system with reference ring, scan, and active indicators)

---

## File Structure

```
resources/icons/v3-radar/
├── staged-light-a.svg        (599B)  - Minimal targeting
├── staged-light-b.svg        (809B)  - Medium reticle (RECOMMENDED)
├── staged-light-c.svg       (1.2KB) - Maximum impact
├── staged-dark-a.svg         (599B)  - Dark theme minimal
├── staged-dark-b.svg         (809B)  - Dark theme medium (RECOMMENDED)
├── staged-dark-c.svg        (1.2KB) - Dark theme maximum
├── working-light-a.svg       (460B)  - Minimal arc
├── working-light-b.svg       (735B)  - Medium scan (RECOMMENDED)
├── working-light-c.svg       (928B)  - Maximum impact
├── working-dark-a.svg        (460B)  - Dark theme minimal
├── working-dark-b.svg        (735B)  - Dark theme medium (RECOMMENDED)
├── working-dark-c.svg        (928B)  - Dark theme maximum
└── VARIATIONS.md              (this file)
```

---

## Color Specifications

### Staged (Ready to Deploy)
- **Light Theme**: `#10b981` (Emerald-600)
- **Dark Theme**: `#34d399` (Emerald-400)
- **Semantics**: "Target locked and ready for launch"

### Working (Active Scan)
- **Light Theme**: `#f59e0b` (Amber-500)
- **Dark Theme**: `#fbbf24` (Amber-300)
- **Semantics**: "Actively monitoring for changes"

---

## Centering Verification

All icons are mathematically centered at canvas coordinates (8, 8):

### Staged Icons
- Triangle apex positioned at x=8 (centered horizontally)
- All targeting elements symmetric around x=8
- Visual center of triangle = geometric center

### Working Icons
- All arcs computed with center point at (8, 8)
- Sweep line radiates from (8, 8)
- Center hub placed at (8, 8)
- No off-center drift

**Result**: Perfect visual balance in 16x16 viewBox

---

## Implementation Notes

### For VS Code package.json
```json
"icons": {
  "git-sort-staged": {
    "description": "Staged changes (target ready for launch)",
    "default": {
      "fontPath": "./resources/icons/v3-radar/staged-light-b.svg"
    }
  },
  "git-sort-working": {
    "description": "Working directory changes (active scan)",
    "default": {
      "fontPath": "./resources/icons/v3-radar/working-light-b.svg"
    }
  }
}
```

### Theme Support
VS Code automatically handles light/dark themes if files follow naming convention:
- `*-light-*.svg` for light themes
- `*-dark-*.svg` for dark themes

---

## Recommendations

### Production Deployment
**Use Variation B (Medium)** for both staged and working icons:

1. **Staged-Light-B** + **Staged-Dark-B**: Clear target aesthetic, professional
2. **Working-Light-B** + **Working-Dark-B**: Clear scan aesthetic, dynamic

### Why Variation B?
- ✅ Perfect balance of detail and simplicity
- ✅ Clearly reads as "radar" without being cluttered
- ✅ Distinctive visual appearance
- ✅ Scales well in tree view (16x16)
- ✅ Reasonable file sizes (809B, 735B)
- ✅ Strong visual hierarchy

### Alternative Strategy
If you want **maximum distinction** between the two states:
- Use **Variation C (Maximum)** for Staged
- Use **Variation B (Medium)** for Working
- This creates clear visual separation: "Complex locked system" vs "Simple active scan"

---

## Testing Checklist

Before integration:
- [ ] Icons render crisp in VS Code light theme
- [ ] Icons render crisp in VS Code dark theme
- [ ] Colors are correct in both themes (#10b981/#34d399 for staged, #f59e0b/#fbbf24 for working)
- [ ] Centered at (8, 8) - no visual drift
- [ ] SVG validates without errors
- [ ] Files are under 1KB (except Variation C at 1.2KB)
- [ ] Proper aspect ratio maintained (square, 16x16)
- [ ] Icons distinct from existing VS Code icons
- [ ] Light theme colors visible on white background
- [ ] Dark theme colors visible on dark background

---

## File Sizes Summary

| Variation | Staged Light | Staged Dark | Working Light | Working Dark | Total |
|-----------|-------------|------------|---------------|-------------|-------|
| A (Minimal) | 599B | 599B | 460B | 460B | 2.118 KB |
| B (Medium) | 809B | 809B | 735B | 735B | 3.088 KB |
| C (Maximum) | 1.2KB | 1.2KB | 928B | 928B | 4.256 KB |
| **B Only** (Recommended) | 809B | 809B | 735B | 735B | **3.088 KB** |

---

Generated: 2025-11-08
V3 Radar Icons: Triangle Rocket + Half-Spinner Refinement
