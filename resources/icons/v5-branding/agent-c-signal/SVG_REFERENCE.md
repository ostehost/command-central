# SVG Reference: Complete Icon Code

This document contains the actual SVG code for all variations, useful for:
- Implementing in code without file references
- Understanding the geometric structure
- Customizing colors or proportions
- Embedding directly in HTML/CSS

## Variation A: Minimal Signal

### Working - Light Theme
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

### Working - Dark Theme
```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M 8 4 A 4 4 0 0 1 12 8"
        fill="none"
        stroke="#d97706"
        stroke-width="0.8"
        stroke-linecap="round"
        opacity="0.5"/>
  <path d="M 8 5.5 A 2.5 2.5 0 0 1 10.5 8"
        fill="none"
        stroke="#d97706"
        stroke-width="1"
        stroke-linecap="round"/>
  <circle cx="8" cy="8" r="0.6" fill="#d97706"/>
</svg>
```

### Staged - Light Theme
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

### Staged - Dark Theme
```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M 5 6 L 5 10 Q 5 11 6 11"
        fill="none"
        stroke="#059669"
        stroke-width="0.9"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <path d="M 11 6 L 11 10 Q 11 11 10 11"
        fill="none"
        stroke="#059669"
        stroke-width="0.9"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="0.8" fill="#059669"/>
</svg>
```

## Variation B: Balanced Signal (RECOMMENDED)

### Working - Light Theme
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

### Working - Dark Theme
```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <path d="M 8 2 A 6 6 0 0 1 14 8"
        fill="none"
        stroke="#d97706"
        stroke-width="0.7"
        stroke-linecap="round"
        opacity="0.35"/>
  <path d="M 8 4 A 4 4 0 0 1 12 8"
        fill="none"
        stroke="#d97706"
        stroke-width="0.85"
        stroke-linecap="round"
        opacity="0.65"/>
  <path d="M 8 6 A 2 2 0 0 1 10 8"
        fill="none"
        stroke="#d97706"
        stroke-width="1"
        stroke-linecap="round"/>
  <circle cx="8" cy="8" r="0.7" fill="#d97706"/>
</svg>
```

### Staged - Light Theme
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

### Staged - Dark Theme
```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="3.2" fill="none" stroke="#059669" stroke-width="0.75" opacity="0.7"/>
  <line x1="5.5" y1="6" x2="5.5" y2="9" stroke="#059669" stroke-width="0.95" stroke-linecap="round"/>
  <path d="M 5.5 9 Q 5.5 10 6.5 10"
        fill="none"
        stroke="#059669"
        stroke-width="0.95"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <line x1="10.5" y1="6" x2="10.5" y2="9" stroke="#059669" stroke-width="0.95" stroke-linecap="round"/>
  <path d="M 10.5 9 Q 10.5 10 9.5 10"
        fill="none"
        stroke="#059669"
        stroke-width="0.95"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="0.9" fill="#059669"/>
</svg>
```

## Variation C: Maximum Signal

### Working - Light Theme
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

### Working - Dark Theme
```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <line x1="8" y1="8" x2="13" y2="3" stroke="#d97706" stroke-width="0.6" opacity="0.4" stroke-linecap="round"/>
  <line x1="8" y1="8" x2="13" y2="13" stroke="#d97706" stroke-width="0.6" opacity="0.4" stroke-linecap="round"/>
  <path d="M 8 2 A 6 6 0 0 1 14 8"
        fill="none"
        stroke="#d97706"
        stroke-width="0.65"
        stroke-linecap="round"
        opacity="0.3"/>
  <path d="M 8 4 A 4 4 0 0 1 12 8"
        fill="none"
        stroke="#d97706"
        stroke-width="0.8"
        stroke-linecap="round"
        opacity="0.6"/>
  <path d="M 8 6 A 2 2 0 0 1 10 8"
        fill="none"
        stroke="#d97706"
        stroke-width="1"
        stroke-linecap="round"/>
  <circle cx="8" cy="8" r="0.8" fill="#d97706"/>
  <circle cx="8" cy="8" r="0.25" fill="none" stroke="#d97706" stroke-width="0.6" opacity="0.5"/>
</svg>
```

### Staged - Light Theme
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

### Staged - Dark Theme
```svg
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <circle cx="8" cy="8" r="4" fill="none" stroke="#059669" stroke-width="0.65" opacity="0.5"/>
  <circle cx="8" cy="8" r="3" fill="none" stroke="#059669" stroke-width="0.75" opacity="0.75"/>
  <line x1="5" y1="5.5" x2="5" y2="9.5" stroke="#059669" stroke-width="1" stroke-linecap="round"/>
  <path d="M 5 9.5 Q 5 10.5 6 10.5"
        fill="none"
        stroke="#059669"
        stroke-width="1"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <line x1="11" y1="5.5" x2="11" y2="9.5" stroke="#059669" stroke-width="1" stroke-linecap="round"/>
  <path d="M 11 9.5 Q 11 10.5 10 10.5"
        fill="none"
        stroke="#059669"
        stroke-width="1"
        stroke-linecap="round"
        stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="1" fill="#059669"/>
  <path d="M 7 8 L 7.5 8.5 L 8.5 7.5"
        fill="none"
        stroke="#ffffff"
        stroke-width="0.7"
        stroke-linecap="round"
        stroke-linejoin="round"/>
</svg>
```

## Key Geometric Principles

### Center Point
All icons are centered at **(8, 8)** in the 16x16 viewBox.

### Arc Paths
Arcs use SVG `A` command with:
- Syntax: `A rx ry x-axis-rotation large-arc-flag sweep-flag x y`
- Example: `A 4 4 0 0 1 12 8` (4px radius arc to point 12,8)

### Colors by Theme
| Theme | Working | Staged |
|-------|---------|--------|
| Light | #f59e0b | #10b981 |
| Dark | #d97706 | #059669 |

### Opacity Levels
- **0.3**: Faint background elements (searching rays)
- **0.4**: Subtle guides (triangulation rays)
- **0.5**: Secondary elements (outer arcs)
- **0.65**: Active elements (middle arcs)
- **1.0**: Primary elements (inner arcs, center point)

## Customization Examples

### Change Working Color to Blue
```xml
<!-- Replace all #f59e0b with -->
stroke="#3b82f6"  <!-- Blue 500 -->
fill="#3b82f6"
```

### Change Stroke Width (thicker for emphasis)
```xml
<!-- In any path or line, change -->
stroke-width="1"
<!-- to -->
stroke-width="1.3"
```

### Make Icons Simpler (remove outer arcs)
```xml
<!-- Delete the first path that has opacity="0.35" or "0.5" -->
<path d="M 8 2 A 6 6 0 0 1 14 8" ... />  <!-- DELETE THIS -->
```

---

**Last Updated**: 2025-11-08
**Format**: Pure SVG, no dependencies
**Standards**: W3C SVG 1.1 compliant
