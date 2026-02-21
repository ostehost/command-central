# Command Central Landing Page — Copy Draft v4

## Phase 1: Critique

### What works

**The headline is excellent.** "Code changes, sorted by time" communicates the product in six words. It's specific, factual, and differentiated. This is the best thing on the page. Don't touch it.

**The subtitle lands.** "See what changed, in the order it changed." Rephrases the headline just enough to reinforce it. Good second punch.

**The tone is right.** Flat, factual, developer to developer. The copy on individual lines reads well. "Separate staged files from working changes. Or don't. One toggle." That's the voice.

**Trust signals are useful.** 536 tests, MIT, zero config. Developers care about these. The compat pills (VS Code, Cursor, Claude Code, Copilot, Windsurf) answer a real question.

**The dark theme fits.** Developer tool, dark editor. Correct.

### What doesn't work

**1. SVG illustrations instead of real product.**
This is the biggest problem. The page shows three stylized SVG mockups that approximate the UI but don't match it. The actual product (visible in the real screenshot) is more information dense, more functional, more impressive. Developers trust screenshots over illustrations. Linear shows their actual product. The SVGs create a credibility gap: the user installs the extension and sees something that looks different from what they were sold.

**2. Three features get full cards. Two features get a footnote.**
The page gives large alternating cards to time sorting, git status, and extension filtering. Then workspace support and emoji icons are crammed into a single throwaway line: "Also: multi repo workspaces, emoji icons per project, zero config." These are real features. The actual UI screenshot shows three repos with emoji labels front and center. Workspace support and emoji icons are visible, differentiating features being treated as afterthoughts.

**3. The alternating card layout is template energy.**
Text left / image right, then image left / text right, then text left / image right. This is a generic landing page pattern. It creates visual monotony and forces each feature into an oversized card whether it needs that space or not. Two sentences of copy don't need half a viewport.

**4. No narrative arc.**
The page structure is: hero → trust → feature → feature → feature → use cases → install. Each section exists independently. There's no progressive build. The scroll doesn't reward you with increasing understanding or excitement. You could rearrange the feature cards and nothing would change.

**5. The "Good for" scenarios all say the same thing.**
"Agent touched files, they're listed by time." "Morning after, grouped by time." "End of day, time groups." Three variations of one point. This section either needs genuinely different angles or should be cut.

**6. The hero screenshot is too small and too abstract.**
520px max width in a 960px container. It doesn't command the viewport. Compare to Linear: their product screenshot extends nearly edge to edge and dominates the below fold area. The hero SVG here is a miniature that you have to squint at.

**7. The panel view is invisible.**
The product works in the VS Code sidebar AND as a horizontal bottom panel with repos displayed in columns. The panel view is unique and visually impressive. It's nowhere on the landing page. The actual UI screenshot shows both views running simultaneously. This is a selling point being left on the table.

**8. "What it does" is a weak section heading.**
It's generic. Every product page could have this heading. It signals that the page is about to list features rather than weaving features into a narrative.

### What would Linear or Tailwind do differently

**Linear:** Massive confident headline. Let the product screenshot dominate. Minimal copy. Trust the visual to sell. Features below fold in tight, purposeful sections.

**Tailwind:** Dense feature grid. Lots of examples. Show don't tell. Compact presentation that respects developer time.

Both: real product visuals, not illustrations. Confidence in sizing and whitespace. No generic section headings.


---

## Phase 2: Structural Recommendation

### Kill the alternating card layout.

It forces three features into oversized containers and dumps two into a footnote. Replace with a uniform feature list that treats all five equally. The hero screenshot does the visual work. Feature descriptions are labels and context, not standalone visual stories.

### Use real screenshots, not SVGs.

The hero should be a real (or extremely high fidelity) screenshot of the product. Large. The current SVGs should be replaced with cropped screenshots showing the specific feature in context if individual feature visuals are needed at all.

### Proposed page structure:

```
1. NAV
2. HERO (headline + subtitle + CTAs + large screenshot)
3. TRUST STRIP (compat pills + numbers)
4. FEATURES (all 5, compact grid or list, no illustrations)
5. TWO VIEWS (sidebar + panel callout)
6. INSTALL (command + marketplace link)
7. EMAIL (release notes signup)
8. FOOTER
```

### Section details:

**NAV** — Same as current. Clean, minimal.

**HERO** — Keep headline and subtitle. Keep CTAs. Replace SVG with a large real screenshot of the sidebar view showing time groups, staged/working split, multiple repos with emoji icons, and the extension filter. Make it wider (up to container width). Add a subtle glow/shadow treatment.

**TRUST STRIP** — Same content as current. Compat pills + three trust numbers. This works. Keep it tight.

**FEATURES** — New format. A section with five items in a 2 column or 3 column grid of small cards. Each card: a short bold name, one to three sentences. No images per card. The five features are:
1. Time sorted
2. Staged and working
3. Extension filter
4. Multi repo workspaces
5. Emoji icons

Optionally, a sixth card could be "Zero config" (install and it works). Or keep zero config in the trust strip.

**TWO VIEWS** — A brief section calling out that the extension works as a sidebar or bottom panel. One sentence of context. Optionally a small screenshot of the panel view (the horizontal columns layout is visually distinctive).

**INSTALL** — Same as current. Command + marketplace link.

**EMAIL** — Same as current. Release notes, one email per release.

**FOOTER** — Same as current.

### What's removed:

**"Good for" / use cases section.** Cut. The scenarios are redundant with the feature descriptions. Developers understand when they'd use a file change tracker. The page is tighter without it.

**"What it does" heading.** Cut. Features flow from the hero naturally. No need to announce them.

**Feature SVG illustrations.** Cut (or replace with real screenshots). The hero screenshot carries the visual load. Individual feature cards are text only.

**The "Also:" footnote.** Eliminated because all five features now have equal weight.


---

## Phase 3: Complete Copy

Everything below is final copy. Every heading, description, and micro element.

### Nav

```
[Partner AI™]                    [Command Central]  [GitHub]
```

Left: brand link. Right: product name (active), GitHub.


### Hero

**Badge:** Free & open source

**H1:** Code changes, sorted by time

**Subtitle:** See what changed, in the order it changed.

**Primary CTA:** Install for VS Code

**Secondary CTA:** GitHub

**Image:** [Real screenshot of Command Central sidebar showing multiple repos with time groups, staged/working sections, emoji icons, and extension filter. Full container width. This should be an actual screenshot of the product, not an SVG illustration.]


### Trust Strip

**Compat label:** WORKS WITH

**Compat pills:** VS Code · Cursor · Claude Code · Copilot · Windsurf

**Trust numbers:**
* 536 tests passing
* MIT licensed
* Zero config needed


### Features

**Section heading:** Five things you get

**Feature 1: Time sorted**
Files grouped by when they were modified. Most recent on top. The groups are configurable: minutes, hours, days, weeks. Watch an agent edit files in real time, or catch up on yesterday's work.

**Feature 2: Staged and working**
One toggle. Staged files in one section, working changes in another. Or turn it off and see everything together. 

**Feature 3: Extension filter**
Show only `.ts`. Or `.ts` and `.json`. Check the extensions you want. Everything else hides. File counts update as you filter.

**Feature 4: Multi repo workspaces**
Each repo gets its own section. Open three repos in one workspace and Command Central splits them automatically. In the panel view, repos sit side by side in columns.

**Feature 5: Emoji icons**
Each repo gets a unique emoji. 🎉 MY-APP. ⚡ API-SERVER. 🍊 SHARED-LIB. You spot your repo before you read the name.


### Two Views

**Heading:** Sidebar or panel. Your call.

**Body:** Works as a VS Code sidebar for vertical scanning. Or drag it to the bottom panel and get repos in columns, side by side. Same data. Pick the layout that fits how you work.

**Image:** [Screenshot or illustration showing the bottom panel view with repos in horizontal columns. This is visually distinct from the sidebar hero image and shows the product's flexibility.]


### Install

**Heading:** Install

**Code block:** `ext install oste.command-central`

**Note:** Or install from the Marketplace


### Email

**Heading:** Release notes

**Description:** One email per release. Nothing else.

**Input placeholder:** you@example.com

**Button:** Notify me

**Note:** Or star the repo for release notifications.


### Footer

MIT licensed · GitHub · 𝕏 @mikeoste

A Partner AI™ project.


---

## Implementation Notes

### On replacing SVGs with screenshots

The single highest impact change is replacing the SVG illustrations with real product screenshots. The actual VS Code UI is more compelling than any illustration of it. Crop and prepare these screenshots:

1. **Hero screenshot:** Sidebar view showing all features visible (time groups, staged/working, multiple repos, emoji icons, extension filter visible in the sidebar options). Full container width, with the dark VS Code chrome creating a natural frame.

2. **Panel screenshot (optional, for "Two Views" section):** The bottom panel view showing repos in side by side columns. This is visually unique and worth showing.

If creating new screenshots, use the same three repos visible in the existing UI: MY-APP, API-SERVER, SHARED-LIB with their emoji icons.

### On the feature grid layout

The five features should be in a grid, not alternating cards. Options:

**Option A: 3+2 grid.** Three cards top row, two cards bottom row (centered or left aligned). Each card has a short bold title and a paragraph.

**Option B: 2+2+1 grid.** Two per row, with the fifth card spanning or centered in the third row.

**Option C: Vertical list.** Single column, each feature as a tight block with bold title inline before the description. Most compact option.

Recommendation: **Option A (3+2 grid)** gives each feature equal visual weight and uses space well. Cards should have subtle borders or background (like the current use case cards), not large with heavy shadows.

### On removing the use cases section

The "Good for" section currently has three scenarios. They all describe the same thing: files changed, you look at Command Central, they're sorted by time. If the team wants to keep scenarios, limit to two genuinely different ones:

* **Watching an agent work.** Real time. The agent modifies files. They appear at the top as it touches them.
* **Morning after.** You open your editor. Yesterday's changes are already grouped. No git log needed.

But the page is tighter without this section. The feature descriptions already imply the use cases. Trust the reader to connect the dots.

### Copy quality checklist

* [x] Zero hyphens or dashes in copy
* [x] No "finally," "seamlessly," "noise," "powerful," "supercharge"
* [x] Flat, factual, dry tone throughout
* [x] Short sentences, plain words
* [x] All five features given equal weight
* [x] Matches the voice of "Code changes, sorted by time"
