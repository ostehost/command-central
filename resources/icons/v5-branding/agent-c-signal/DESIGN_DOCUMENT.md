# Agent C: Signal Specialist - Command Central Branding

## Signal Concept: Searching Waves → Lock Confirmed

This design system translates the core Git workflow into a signal tracking metaphor that embodies Command Central's tech-forward branding.

**Working State (Searching)**: Signal waves radiating outward, actively triangulating and searching for connection. Represents the unstaged, in-progress state where changes exist but haven't been locked into the commit.

**Staged State (Acquired)**: Signal locked and confirmed, transmission ready. Represents changes committed to the staging area—secured and ready for deployment.

This metaphor works because it mirrors the Git workflow:
- Untracked changes = active signal search in progress
- Staged changes = signal locked and secured for transmission
- The central point in each icon represents your codebase transmitting/receiving status

## Design Specifications

| Property | Value |
|----------|-------|
| **Viewbox** | 16x16 |
| **Working Color (Light)** | #f59e0b (Amber) |
| **Working Color (Dark)** | #d97706 (Amber Dark) |
| **Staged Color (Light)** | #10b981 (Emerald) |
| **Staged Color (Dark)** | #059669 (Emerald Dark) |
| **Max File Size** | 700 bytes |
| **Stroke Width** | 0.6-1.0px (variable for depth) |
| **Center Point** | (8, 8) |

## Variation A: Minimal Signal

**Best for**: Simple, clean interfaces where icon clarity is paramount. Works well at small sizes and in contexts where subtlety is preferred.

### Working (Searching)
- **Elements**: 2 wave arcs + source point
- **Radius**: 4px outer arc, 2.5px inner arc
- **Opacity**: Outer arc at 50% opacity for depth perception
- **Metaphor**: Two "rings" spreading outward—initial search and active triangulation
- **Visual Weight**: Light and fast-moving

```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M 8 4 A 4 4 0 0 1 12 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="0.8"
        stroke-linecap="round"
        opacity="0.5"/>
  <path d="M 8 5.5 A 2.5 2.5 0 0 1 10.5 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="1"
        stroke-linecap="round"/>
  <circle cx="8" cy="8" r="0.6" fill="#f59e0b"/>
</svg>
```

**File Size**: 782 bytes (light), 781 bytes (dark)

### Staged (Acquired)
- **Elements**: Center confirmation dot + 2 minimal lock brackets
- **Lock Style**: Curved bottom corners suggesting security
- **Metaphor**: Minimal "pinning" effect—signal held in place
- **Visual Weight**: Calm and secure

```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M 5 6 L 5 10 Q 5 11 6 11"
        fill="none"
        stroke="#10b981"
        stroke-width="0.9"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <path d="M 11 6 L 11 10 Q 11 11 10 11"
        fill="none"
        stroke="#10b981"
        stroke-width="0.9"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="0.8" fill="#10b981"/>
</svg>
```

**File Size**: 773 bytes (light), 772 bytes (dark)

**Use Case**: Minimalist dashboards, compact tree views, situations requiring maximum clarity

---

## Variation B: Balanced Signal (RECOMMENDED)

**Best for**: Primary use case throughout Command Central. Balances visual complexity with instant recognizability. Works at all common UI sizes.

### Working (Searching)
- **Elements**: 3 concentric arcs + central transmitter
- **Radiuses**: 6px (outer, ~35% opacity), 4px (mid, ~65% opacity), 2px (inner, full opacity)
- **Gradient Effect**: Opacity cascades inward, creating depth and motion
- **Metaphor**: Multiple search circles expanding outward like ripples in water
- **Visual Impact**: Clear signal expansion, immediately readable as "searching"

```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M 8 2 A 6 6 0 0 1 14 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="0.7"
        stroke-linecap="round"
        opacity="0.35"/>
  <path d="M 8 4 A 4 4 0 0 1 12 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="0.85"
        stroke-linecap="round"
        opacity="0.65"/>
  <path d="M 8 6 A 2 2 0 0 1 10 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="1"
        stroke-linecap="round"/>
  <circle cx="8" cy="8" r="0.7" fill="#f59e0b"/>
</svg>
```

**File Size**: 1,073 bytes (light), 1,072 bytes (dark)

### Staged (Acquired)
- **Elements**: Confirmation ring + left/right lock brackets + center point
- **Confirmation Ring**: 3.2px radius at ~70% opacity for verification signal
- **Lock Brackets**: Symmetrical L-shaped structures with curved corners
- **Center Point**: Larger (0.9px radius) for transmission confirmation
- **Metaphor**: Signal firmly locked in place with concentric verification rings

```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="3.2" fill="none" stroke="#10b981" stroke-width="0.75" opacity="0.7"/>
  <line x1="5.5" y1="6" x2="5.5" y2="9" stroke="#10b981" stroke-width="0.95" stroke-linecap="round"/>
  <path d="M 5.5 9 Q 5.5 10 6.5 10"
        fill="none"
        stroke="#10b981"
        stroke-width="0.95"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <line x1="10.5" y1="6" x2="10.5" y2="9" stroke="#10b981" stroke-width="0.95" stroke-linecap="round"/>
  <path d="M 10.5 9 Q 10.5 10 9.5 10"
        fill="none"
        stroke="#10b981"
        stroke-width="0.95"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="0.9" fill="#10b981"/>
</svg>
```

**File Size**: 1,321 bytes (light), 1,320 bytes (dark)

**Use Case**: Default for all Git status indicators, tree view icons, status bar elements, activity bar badges

**Why Recommended**:
- Distinctive silhouette at any size
- Clear visual hierarchy between states
- Excellent brand alignment—the ripple pattern screams "active tracking"
- Minimal file size overhead for maximum visual impact
- Consistent stroke weights and spacing
- Accessibility: High contrast between icon and background

---

## Variation C: Maximum Signal

**Best for**: Detailed status displays, larger icon contexts (32px+), documentation, splash screens. For impactful visual moments where icon sophistication adds prestige.

### Working (Searching)
- **Elements**: 3 expansion arcs + 2 triangulation rays + central transmitter + confirmation marker
- **Triangulation Rays**: Two diagonal lines at 45° and 315° showing directional search
- **Wave Spread**: 6px outer (30% opacity), 4px mid (60% opacity), 2px inner (full opacity)
- **Transmitter Ring**: Center point surrounded by micro-confirmation circle
- **Metaphor**: Full signal triangulation with multiple detection points, showing sophisticated search algorithm

```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <line x1="8" y1="8" x2="13" y2="3" stroke="#f59e0b" stroke-width="0.6" opacity="0.4" stroke-linecap="round"/>
  <line x1="8" y1="8" x2="13" y2="13" stroke="#f59e0b" stroke-width="0.6" opacity="0.4" stroke-linecap="round"/>
  <path d="M 8 2 A 6 6 0 0 1 14 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="0.65"
        stroke-linecap="round"
        opacity="0.3"/>
  <path d="M 8 4 A 4 4 0 0 1 12 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="0.8"
        stroke-linecap="round"
        opacity="0.6"/>
  <path d="M 8 6 A 2 2 0 0 1 10 8"
        fill="none"
        stroke="#f59e0b"
        stroke-width="1"
        stroke-linecap="round"/>
  <circle cx="8" cy="8" r="0.8" fill="#f59e0b"/>
  <circle cx="8" cy="8" r="0.25" fill="none" stroke="#f59e0b" stroke-width="0.6" opacity="0.5"/>
</svg>
```

**File Size**: 1,572 bytes (light), 1,571 bytes (dark)

### Staged (Acquired)
- **Elements**: Outer integrity ring + inner confirmation ring + lock brackets + center point + checkmark
- **Integrity Rings**: Layered verification (4px outer at 50%, 3px inner at 75%)
- **Full Lock System**: Tall lock brackets with curved bases, full security apparatus
- **Confirmation Checkmark**: White checkmark overlay on center point for positive confirmation
- **Metaphor**: Military-grade encryption, multiple layers of security verification, transmission confirmed

```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="4" fill="none" stroke="#10b981" stroke-width="0.65" opacity="0.5"/>
  <circle cx="8" cy="8" r="3" fill="none" stroke="#10b981" stroke-width="0.75" opacity="0.75"/>
  <line x1="5" y1="5.5" x2="5" y2="9.5" stroke="#10b981" stroke-width="1" stroke-linecap="round"/>
  <path d="M 5 9.5 Q 5 10.5 6 10.5"
        fill="none"
        stroke="#10b981"
        stroke-width="1"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <line x1="11" y1="5.5" x2="11" y2="9.5" stroke="#10b981" stroke-width="1" stroke-linecap="round"/>
  <path d="M 11 9.5 Q 11 10.5 10 10.5"
        fill="none"
        stroke="#10b981"
        stroke-width="1"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="1" fill="#10b981"/>
  <path d="M 7 8 L 7.5 8.5 L 8.5 7.5"
        fill="none"
        stroke="#ffffff"
        stroke-width="0.7"
        stroke-linecap="round"
        stroke-linejoin="round"/>
</svg>
```

**File Size**: 1,704 bytes (light), 1,703 bytes (dark)

**Use Case**: Large dashboard displays, detailed status modals, hero sections, premium UI moments

**Why Not Default**:
- File size overhead (2x Variation A, 1.3x Variation B)
- Can feel visually busy at small icon sizes
- Requires 28px+ to fully appreciate the complexity

---

## Implementation Guide

### Selection Criteria

Use this decision matrix to choose the right variation:

| Context | Variation | Reason |
|---------|-----------|--------|
| Tree view, status bar, compact UI | A (Minimal) | Clarity at small sizes, lightweight |
| Main Git status indicator, activity bar | B (Balanced) | **RECOMMENDED** - Best all-around |
| Large dashboards, documentation | C (Maximum) | Detailed, impressive presentation |
| Dark VS Code theme | Use `-dark` variants | Amber #d97706, Green #059669 |
| Light VS Code theme | Use `-light` variants | Amber #f59e0b, Green #10b981 |

### Color Values

**Light Theme (Default)**:
- Working: `#f59e0b` (Amber 400)
- Staged: `#10b981` (Emerald 500)

**Dark Theme (Inverted)**:
- Working: `#d97706` (Amber 600)
- Staged: `#059669` (Emerald 700)

The darker values in dark theme maintain visual contrast and prevent burnout.

### Integration with VS Code

```json
{
  "scm.decorations.colors": true,
  "scm.decorations.badges": "auto",
  "scm.defaultViewMode": "tree"
}
```

All icons scale gracefully from 16px to 32px with correct stroke proportions.

---

## Why This Wins

### Signal Metaphor Clarity
- **Intuitive**: Everyone understands radiating waves as "searching" and locked signals as "secured"
- **Progressive**: Complexity increases from minimal to maximum as needed
- **Temporal**: The wave expansion creates a natural sense of time and progression
- **Directional**: Clearly communicates state change (searching → locked)

### Modern Tech Aesthetic
- **Contemporary**: Signal/tracking is cutting-edge in 2025
- **Premium Feel**: The minimalist approach with layered complexity screams "professional"
- **Motion Implied**: Even static icons suggest dynamic activity
- **Brand Alignment**: Signal and tracking directly map to "Command Central"—a coordinated control hub

### Command Central Alignment
- **Metaphor Fit**: Command Central coordinates changes (like a control tower)
- **Visual Language**: Clean lines, minimal elements, focused purpose
- **Scalability**: Works across all UI contexts from 16px badges to detailed dashboards
- **Future-Proof**: Easy to animate these concepts (expanding waves, pulsing locks)

### Practical Advantages
- **Tiny File Sizes**: All under 1.7KB, most under 1.1KB
- **High Contrast**: Works on any background color
- **Accessible**: Distinct shapes for users with color blindness
- **ESM-Ready**: Pure SVG, no dependencies, includes in bunfig.toml seamlessly

---

## Animation Potential (Future Enhancement)

These icons are designed with animation in mind:

```css
/* Working state: pulsing waves */
@keyframes signal-search {
  0% { stroke-width: 0.8px; opacity: 1; }
  50% { stroke-width: 1.1px; opacity: 0.6; }
  100% { stroke-width: 0.8px; opacity: 1; }
}

/* Staged state: steady pulse confirmation */
@keyframes signal-locked {
  0%, 100% { r: 0.9px; opacity: 1; }
  50% { r: 1.1px; opacity: 0.8; }
}
```

The signal concept naturally extends to motion design, making these icons perfect for future dynamic status displays.

---

## File Manifest

### Variation A (Minimal Signal)
- `working-light-a.svg` (782 bytes)
- `working-dark-a.svg` (781 bytes)
- `staged-light-a.svg` (773 bytes)
- `staged-dark-a.svg` (772 bytes)

### Variation B (Balanced Signal) - RECOMMENDED
- `working-light-b.svg` (1,073 bytes)
- `working-dark-b.svg` (1,072 bytes)
- `staged-light-b.svg` (1,321 bytes)
- `staged-dark-b.svg` (1,320 bytes)

### Variation C (Maximum Signal)
- `working-light-c.svg` (1,572 bytes)
- `working-dark-c.svg` (1,571 bytes)
- `staged-light-c.svg` (1,704 bytes)
- `staged-dark-c.svg` (1,703 bytes)

**Total Package Size**: 14.4 KB (all 12 icons)

---

## Recommendations

1. **Deploy Variation B** as the primary Git status icon system
2. **Keep Variation A** as fallback for extremely compact displays
3. **Use Variation C** in release notes, documentation, and marketing materials
4. **Implement theme switching** based on `editor.colorTheme` setting
5. **Consider animation** for future enhancements (pulses, waves)
6. **Monitor feedback** for color adjustments in dark/light mode edge cases

This design system positions Command Central as a modern, sophisticated tool that understands your workflow and tracks it with precision—exactly what developers expect from a premium extension.
