# Command Central Landing Page — Mobile Design Brief

**UX Audit & Redesign Specifications**  
*For mobile-first optimization targeting inexperienced AI coding agent users*

---

## 1. Mobile Audit — Current Issues

### Critical Mobile Problems

#### Dock SVG (`feature-dock.svg`) — Too Complex
- **Icon cramping**: 30x30px icons render as ~12px on mobile. Emoji and text illegible.
- **Dual interface overload**: Shows both Dock AND Cmd+Tab simultaneously. Mobile users can't process both.
- **Cognitive load**: 8+ app icons, separator lines, status indicators — overwhelming on 375px viewport.
- **Platform assumption**: "Dock" and "Cmd+Tab" meaningless to Windows/Linux users (60%+ of VS Code users).

#### Agent Status SVG (`feature-agents.svg`) — Broken Layout
- **Callout arrow disaster**: Arrow + "Live agent status / See what's running" text breaks responsive flow.
- **Text collision**: Arrow positioning hardcoded for desktop. On mobile, overlaps VS Code sidebar content.
- **Information density**: 7+ UI elements crammed into 280px wide sidebar. Text at 8-11px unreadable.

#### Workflow SVG (`feature-workflow.svg`) — Sequential Confusion
- **Horizontal overflow**: 3-step workflow assumes 480px+ width. Mobile cuts off step 3.
- **Arrow dependency**: Connecting arrows break when steps stack vertically.
- **Icon inconsistency**: Mix of filled circles, outlined boxes, text emoji creates visual chaos.

### Copy Problems

#### Feature Card #4: Platform Assumptions
- Current: "Click ▶ and your project appears in the Dock and Cmd+Tab switcher"
- Problem: Assumes macOS knowledge. 64% of VS Code users on Windows/Linux.

#### Feature Card #5: Jargon Overload
- Current: "Know what your agents are doing" + "See Claude Code, Codex, and other AI agents..."
- Problem: Two sentences violates card rule. "Codex" requires context. Assumes agent familiarity.

#### Hero: Value Unclear
- Current: "Code changes, sorted by time"
- Problem: Accurate but misses the agent workflow value prop. Sounds like basic file browser.

---

## 2. SVG Redesign Specifications

### New `feature-dock.svg` — Project Windows
**Concept**: Focus on ONE key insight — project windows get unique icons. Remove all macOS references.

**Dimensions**: 380x180px (mobile-optimized)
**Visual Hierarchy**: Single project terminal → unique emoji icon → "different windows" concept

```
Layout:
┌─────────────────┐
│  Terminal Window │ ← 280x100px
│  🚀 My App      │ ← 24px emoji, 16px text
│  $ npm run dev  │ ← Terminal content
└─────────────────┘

Below: 2-3 additional window previews at 40% scale
🚀 My App    ⚡ API    🔧 Tools

Text: "Each project gets its own window with a unique icon"
```

**Exact Specs**:
- Background: `#161b22`
- Main terminal: 280x100px, `#1c2128`, 8px border radius
- Title bar: 280x28px, `#21262d`
- Emoji: 24px, positioned at 16px from left, vertically centered in title
- Project name: 16px `Space Grotesk` medium, `#e6edf3`
- Terminal content: `$ npm run dev` in 14px Cascadia Code, `#58a6ff`
- Preview windows: 112x40px each, same styling at 40% scale
- Spacing between previews: 20px
- Bottom text: 14px `Space Grotesk` medium, `#e6edf3`, centered

### New `feature-agents.svg` — Simple Status Panel
**Concept**: Strip to bare essentials — just the agent status without VS Code chrome or callouts.

**Dimensions**: 340x200px
**Visual Hierarchy**: Agent status panel only, no arrows, no complex UI

```
Layout:
┌─────────────────────────┐
│ AI Agents               │ ← Header
│                         │
│ 🤖 Refactoring auth     │ ← Running (green dot)
│    4m 12s               │
│                         │
│ ✅ Added tests          │ ← Completed (checkmark)
│    Done                 │
└─────────────────────────┘

Text: "See what AI agents are doing in real time"
```

**Exact Specs**:
- Background: `#161b22`
- Panel: 300x120px, `#1c2128`, 12px border radius, 2px border `#21262d`
- Header: "AI Agents" 16px `Space Grotesk` semibold, `#e6edf3`
- Agent rows: 260x32px each, 8px padding
- Status icons: 8px circle (green `#3fb950` for running) OR checkmark path for completed
- Robot emoji: 16px
- Task text: 14px `Space Grotesk` medium, `#e6edf3`
- Duration: 12px Cascadia Code, `#8b949e`, right-aligned
- Bottom text: 14px `Space Grotesk` medium, `#e6edf3`, centered

### New `feature-workflow.svg` — Time Flow
**Concept**: Replace technical workflow with time-based change tracking. Focus on "when things changed."

**Dimensions**: 360x160px
**Visual Layout**: Vertical timeline instead of horizontal steps

```
Layout:
     Timeline
     │
Now  ● auth.ts modified      ← Green dot
     │
2h   ● tests added          ← Green dot  
     │
6h   ● config updated       ← Green dot
     │

Text: "Track exactly when your code changed"
```

**Exact Specs**:
- Background: `#161b22`
- Timeline line: 2px wide, `#30363d`, vertical at x=40
- Time markers: 8px circles, `#3fb950`, centered on timeline
- Time labels: 12px `Space Grotesk` medium, `#8b949e`, left of timeline (x=10)
- File names: 14px Cascadia Code, `#e6edf3`, right of timeline (x=60)
- "modified"/"added"/"updated": 12px `Space Grotesk`, `#8b949e`
- Spacing between entries: 36px
- Bottom text: 14px `Space Grotesk` medium, `#e6edf3`, centered

---

## 3. Copy Rewrite — Beginner-Friendly

### Feature Card Headlines & Descriptions

#### Card 1: Time Ordering (keep existing SVG)
- **Headline**: "See recent changes first"
- **Description**: "Code that changed minutes ago appears above code that changed yesterday."

#### Card 2: Git Status (keep existing SVG) 
- **Headline**: "Staged vs. working files"
- **Description**: "Toggle to separate files you've staged from files still being worked on."

#### Card 3: Filter (keep existing SVG)
- **Headline**: "Focus on what matters"  
- **Description**: "Filter by file type to see only JavaScript, CSS, or whatever you're working on."

#### Card 4: Project Windows (new SVG)
- **Headline**: "Every project gets its own window"
- **Description**: "Launch a terminal for each project. Each gets a unique emoji icon so you can tell them apart."

#### Card 5: AI Agent Monitoring (new SVG)  
- **Headline**: "Track your AI assistants"
- **Description**: "When AI tools are writing code for you, see their progress without leaving your editor."

### Hero Section Rewrite

#### New Hero Headline (10 words max)
**"See recent code changes and AI agent progress"** *(8 words)*

#### New Subtitle
**"Track what changed when, plus monitor AI coding assistants — all in your VS Code sidebar."** *(16 words)*

#### Value Proposition Hierarchy
1. **Primary**: Time-sorted change tracking (universal need)
2. **Secondary**: AI agent monitoring (growing but not universal)
3. **Tertiary**: Per-project organization (power user feature)

---

## 4. Layout Recommendations

### CSS Changes for Mobile Optimization

#### Feature Cards — Mobile Stacking  
```css
@media (max-width: 768px) {
  .feature-visual {
    max-width: 340px; /* Match new SVG widths */
    margin: 0 auto;
  }
  
  .feature-visual svg,
  .feature-visual img {
    border: 1px solid rgba(88, 166, 255, 0.1); /* Lighter border for clarity */
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); /* Reduced shadow */
  }
}
```

#### Trust Section — Horizontal Scroll for Compat Pills
```css
@media (max-width: 480px) {
  .compat-pills {
    justify-content: flex-start;
    overflow-x: auto;
    padding: 0 var(--space-3);
    gap: var(--space-3);
  }
  
  .compat-pill {
    flex-shrink: 0;
    min-width: 100px;
  }
}
```

#### Features Plus Section — Tighter Wrapping
```css
@media (max-width: 480px) {
  .features-also-item {
    padding: 8px 16px;
    font-size: 0.85rem;
  }
  
  .features-also-item::before {
    font-size: 0.7rem;
  }
}
```

---

## 5. VS Code Extension UI Vision

### Sidebar Layout Specifications

#### Information Hierarchy
1. **Primary**: Project list with emoji icons and play buttons  
2. **Secondary**: Agent status (when agents are running)
3. **Tertiary**: Time-grouped file changes

#### Ideal Sidebar Structure
```
┌─────────────────────────────┐
│ COMMAND CENTRAL        ⚙️   │ ← Header with settings
├─────────────────────────────┤
│ 🚀 my-app              ▶️   │ ← Project 1 + launch button
│   🤖 Adding tests (2m)      │ ← Agent status (when active)
│                             │
│ ⚡ api-server           ▶️   │ ← Project 2 + launch button  
│                             │
│ 🔧 shared-lib          ▶️   │ ← Project 3 + launch button
├─────────────────────────────┤
│ 📄 Recent Changes           │ ← Collapsible section
│ ▼ Today (4 files)          │
│   ● auth.ts            2m   │ ← Modified file + time
│   ● tests.ts           5m   │ ← New file + time
│ ▼ Yesterday (2 files)      │
│   ● config.js         13h   │
└─────────────────────────────┘
```

#### Interaction Patterns

**Project Launch**:
- Click ▶️ → Opens terminal in new app window
- macOS: Appears in Dock with emoji icon
- Windows/Linux: Appears in taskbar with emoji icon
- Status changes to 🟢 (running) with option to ⏹️ (stop)

**Agent Monitoring**: 
- Appears automatically when agents start
- Shows under relevant project
- 🤖 icon + task description + elapsed time
- Click to expand/view full agent output
- ✅ icon when complete, ❌ if failed

**File Change Tracking**:
- Auto-refreshes as files change
- Groups by time periods (configurable)
- Click file → opens in editor
- Status dots: ● modified, ● new, ● deleted

#### Settings Panel Access
- ⚙️ icon in header → configuration panel
- Time grouping options: Minutes/Hours/Days
- Agent monitoring on/off
- File type filters
- Project emoji customization

---

## 6. Implementation Priority

### Phase 1: Critical Mobile Fixes
1. Replace `feature-dock.svg` with project windows version
2. Replace `feature-agents.svg` with simple status panel  
3. Update copy for cards 4 & 5
4. Fix CSS for mobile feature card stacking

### Phase 2: Content Optimization
1. Replace `feature-workflow.svg` with time flow version
2. Update hero headline and subtitle
3. Implement mobile CSS improvements
4. Test on actual mobile devices

### Phase 3: Advanced Enhancements  
1. Add mobile-specific interactions (touch targets)
2. Optimize font sizes for mobile readability
3. Consider progressive enhancement for larger screens
4. A/B test new copy with target users

---

**Execution Note**: All SVGs should be optimized for mobile-first viewing while remaining clear on desktop. Prioritize immediate comprehension over technical accuracy. Target users who may never have used AI coding agents — explain the value, don't assume knowledge.