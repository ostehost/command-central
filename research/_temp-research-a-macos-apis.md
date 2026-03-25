CLEAR
# Research A: macOS APIs, Technical Feasibility & Developer Workflow Analysis

> **Date:** 2026-03-24
> **Author:** researcher-1 (cmdtab-research team)
> **Status:** COMPLETE
> **Purpose:** Feed into "Cmd+Tab as Platform" strategic dissertation

---

## Executive Summary

The Ghostty Launcher + Command Central architecture is **technically sound and extensible**. The core concept — cloning Ghostty.app into per-project `.app` bundles with unique `CFBundleIdentifier` values and emoji dock icons — is an already-implemented and working approach. The macOS platform offers a rich set of APIs to extend this further: dock badges, bounce animations, right-click dock menus, and (with more work) dynamic icon drawing are all viable. However, several features that sound simple (programmatic Split View, Cmd+Tab hover previews, AX-based tmux pane targeting) are either impossible via public APIs or require Accessibility permissions plus significant engineering effort. This document provides a detailed technical breakdown.

---

## 1. macOS Dock APIs

### 1.1 NSDockTile

**Class:** `AppKit.NSDockTile`
**Apple Docs:** https://developer.apple.com/documentation/appkit/nsdocktile
**Availability:** macOS 10.5+

NSDockTile is the primary interface for customizing how an app's icon appears in the Dock. Key capabilities:

#### Badge Labels (Text Badges)
```swift
NSApp.dockTile.badgeLabel = "3"  // Show "3" badge on dock icon
NSApp.dockTile.badgeLabel = ""   // Clear badge
```
- **Feasibility: EASY**
- Badge appears as a red circle with white text, rendered by the OS
- Supports any string (typically numbers 1–99, but any string works)
- Automatically clears when the app is activated
- **Use case for CC:** Show count of running agents, or "!" for agents needing attention

#### Custom ContentView (Custom Drawing)
```swift
let customView = MyStatusView(frame: NSRect(x: 0, y: 0, width: 128, height: 128))
NSApp.dockTile.contentView = customView
NSApp.dockTile.display()  // Must call display() to refresh
```
- **Feasibility: MEDIUM** (for basic use), **HARD** (for live animations)
- The view is rendered statically — `display()` must be called explicitly to update
- Cannot achieve smooth real-time animation without repeatedly calling `display()`
- Third-party library: [DSFDockTile](https://github.com/dagronf/DSFDockTile) (updated Apr 2024) handles this cleanly
- **Use case for CC:** Show agent status overlay on the Ghostty bundle icon

#### Progress Indicators in Dock
- **Feasibility: MEDIUM**
- Add `NSProgressIndicator` as subview of contentView, set `doubleValue`, call `display()`
- Reference implementation: [DockProgressBar](https://github.com/hokein/DockProgressBar), [DockProgress](https://github.com/sindresorhus/DockProgress)
- The progress indicator can be determinate (showing % complete) or indeterminate (spinning)
- **Limitation:** No smooth animation unless you drive it with a timer; each frame requires a `display()` call
- **Use case for CC:** Show aggregate progress when multiple agents are running (e.g., "3 of 5 complete")

#### Dynamic Icon Changes at Runtime
```swift
// Method 1: Change the entire icon
NSApp.applicationIconImage = NSImage(named: "my-new-icon")

// Method 2: Draw on top of existing icon via contentView
// Method 3: Use NSDockTilePlugin for changes when app is not running
```
- **Feasibility: MEDIUM**
- `NSApp.applicationIconImage` can be replaced at runtime — **this is how to show emoji-based icons dynamically**
- `NSDockTilePlugin` allows dock customization even when the app is not running (useful for background status)
- **Critical limitation:** Apps using `NSDockTilePlugin` are **not allowed in the Mac App Store**
- **For Ghostty bundles specifically:** The icon is baked into the `.icns` file at bundle creation time. Changing it at runtime requires either replacing the image reference (`NSApp.applicationIconImage`) or using a custom `contentView` overlay. This is viable.
- Ghostty itself has discussed `NSDockTilePlugIn` (see: https://github.com/ghostty-org/ghostty/actions/runs/20487082431)
- **Custom icon persistence issue:** Known Ghostty bug — custom icons don't persist across restarts if the app is in the Dock (due to code signing invalidation). This does NOT affect our per-project bundle approach because we control the bundle creation process.

#### `display()` Method
- Must be called explicitly after any change to contentView or badgeLabel to refresh the Dock tile
- No automatic refresh; this is the developer's responsibility

### 1.2 Dock Menus (applicationDockMenu)

**Method:** `NSApplicationDelegate.applicationDockMenu(_:) -> NSMenu?`
**Apple Docs:** https://developer.apple.com/documentation/appkit/nsapplicationdelegate/1428564-applicationdockmenu
**Availability:** macOS 10.0+

```swift
func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Agent: project-auth (running 12m)", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "Agent: project-api (completed ✅)", action: #selector(focusAgent), keyEquivalent: ""))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Open Command Central", action: #selector(openCC), keyEquivalent: ""))
    return menu
}
```
- **Feasibility: EASY**
- Called by macOS when user right-clicks (or holds) the dock icon
- Returns a fresh NSMenu each time — can be dynamically generated from current agent state
- Items can have actions (selectors), submenus, icons, keyboard equivalents
- macOS automatically appends system items (Force Quit, etc.) after your custom items
- **Use case for CC:** Right-click on a Ghostty project bundle dock icon → see agent list for that project, click to focus
- **Implementation location:** This goes in the Ghostty bundle's app delegate, OR via a helper process. Since we control the Ghostty bundle clone, this is where it would live.

### 1.3 Dock Bounce (requestUserAttention)

**Method:** `NSApplication.requestUserAttention(_: NSApplication.RequestUserAttentionType) -> Int`
**Apple Docs:** https://developer.apple.com/documentation/appkit/nsapplication/requestuserattention(_:)
**Availability:** macOS 10.0+

```swift
// Bounce once (informational — e.g., agent completed successfully)
let reqId = NSApp.requestUserAttention(.informationalRequest)

// Bounce continuously until app is focused (critical — e.g., agent hit error)
let reqId = NSApp.requestUserAttention(.criticalRequest)

// Cancel the bounce
NSApp.cancelUserAttentionRequest(reqId)
```
- **Feasibility: EASY**
- `informationalRequest` — single bounce (subtle)
- `criticalRequest` — continuous bounce until app receives focus
- Cancels automatically when the app is activated
- **Use case for CC:** Bounce the relevant Ghostty bundle icon when an agent completes (informational) or hits a blocking error (critical)
- **Note:** Only bounces if the app is NOT the frontmost application. No effect if app is already focused.

---

## 2. NSRunningApplication & Window Activation

### 2.1 `open -a` vs `NSRunningApplication.activate`

**Current CC approach:** `open -a <bundle_id>` (see `src/extension.ts:718`)

#### `open -a <bundle_id>`
- Launches the app if not running, or brings it to front if already running
- **Behavior:** Activates the entire application (all windows come forward)
- **Does NOT:** target a specific window within the app
- **Cross-macOS-version reliability:** High — `open` is a system utility with stable behavior
- **Subprocess overhead:** ~50ms for the `open` command to fork/exec, then async

#### `NSRunningApplication.activate(options:)`
```swift
let apps = NSWorkspace.shared.runningApplications
let app = apps.first { $0.bundleIdentifier == "dev.partnerai.ghostty.myproject" }
app?.activate(options: [.activateIgnoringOtherApps])
```
- **Known issues (critical):** `NSApplicationActivateAllWindows` broke around macOS 11.4 and was never properly fixed. In Sonoma (macOS 14), `activateWithOptions` can fail to bring apps to the foreground entirely.
- **Recommendation:** Stick with `open -a` for activation. It's more reliable across macOS versions.
- An NSRunningApplication instance cannot give you the application's window list directly.

### 2.2 Targeting a Specific Window

To activate a specific window within an app (not just the app):

**Option A: AppleScript (most reliable for Ghostty)**
```applescript
tell application id "dev.partnerai.ghostty.myproject"
    activate
    set index of window 1 to 1
end tell
```
- Requires `NSAppleEventsUsageDescription` in Info.plist
- Works without Accessibility permissions for basic activation
- Window targeting via index or name

**Option B: AXUIElement (requires Accessibility permission)**
```swift
let axApp = AXUIElementCreateApplication(pid)
var windowList: CFTypeRef?
AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowList)
// Iterate windows, find target, call AXUIElementSetAttributeValue(window, kAXMainAttribute, ...)
```
- Requires user to grant Accessibility permission in System Settings
- Can bring specific windows to front, not just the application

**Option C: CGWindowListCopyWindowInfo + SetFrontProcessWithOptions**
```swift
let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
// Find window with matching kCGWindowOwnerName and kCGWindowNumber
// Then use deprecated SetFrontProcessWithOptions (still works in practice)
```
- `CGWindowListCopyWindowInfo` is available but deprecated as of macOS 14.2; replacement is ScreenCaptureKit
- Requires Screen Recording permission for window content, but just the list of windows is available without it

**For the Ghostty Launcher architecture:** The `window_id` field in `/tmp/ghostty-terminals.json` (`tab-group-c885ffb60`) represents Ghostty's internal window identifier. This is NOT a macOS `CGWindowID` — it's a Ghostty-internal opaque ID. To use it for targeting, Ghostty would need to expose an IPC mechanism to map its internal IDs to macOS window numbers.

### 2.3 Programmatic Split View

**Feasibility: HARD / NEAR-IMPOSSIBLE via public API**

- macOS Split View (tiled windows, green traffic light) has **no public API**
- `NSSplitViewController` is for within-app split panes, not OS-level window tiling
- The best available approaches:
  1. AppleScript: partial success (can tile one window, but selecting the second is unreliable)
  2. Third-party tools (Moom, Rectangle) use Accessibility APIs to resize/reposition windows — this requires Accessibility permission and substantial engineering
  3. Workaround: instead of Split View, use `NSScreen.main?.visibleFrame` to calculate half-screen dimensions and resize both windows programmatically
- **Recommendation:** Skip true Split View automation. Implement "side-by-side" layout by using AX APIs to move/resize VS Code + Ghostty to each half of the screen. This is achievable with Accessibility permission and less fragile than Split View automation.

---

## 3. Accessibility APIs (AXUIElement)

### 3.1 What's Possible

**Requires:** User grants "Accessibility" permission in System Settings > Privacy & Security

Key capabilities:
- Get list of open windows for any app
- Bring a specific window to front (`kAXMainAttribute`, `kAXFocusedAttribute`)
- Read window titles, positions, sizes
- Find UI elements within a window by their role and label
- Simulate keypresses and clicks on specific UI elements

### 3.2 Targeting tmux Panes in Ghostty

**Can we use AX APIs to find and focus specific tmux panes within a Ghostty window?**

**Feasibility: HARD — significant limitations**

The AX tree for a terminal emulator like Ghostty exposes the terminal as a single opaque drawing surface. Unlike a structured app (browser, code editor), a terminal's "panes" are not AX-visible as separate elements. The terminal emulator renders them as pixels — tmux pane borders are just text characters.

What IS possible via AX on Ghostty:
- Bring the Ghostty window to front (`kAXRaiseAttribute`)
- Get the window title (which tmux sets to the pane title)
- Send keystrokes (e.g., send `Ctrl+B, q` for tmux pane number overlay)

What is NOT possible via AX on a terminal:
- Identifying which tmux pane contains which session
- Clicking on a specific tmux pane by name
- Reading terminal output content (would need Screen Recording permission + ScreenCaptureKit)

**Better approach for tmux pane focus:** Use tmux IPC directly:
```bash
tmux select-window -t <session>:<window>
tmux select-pane -t <session>:<window>.<pane>
```
Then activate the Ghostty window that's attached to that tmux session. This is what CC already does (Strategy 1 in `src/extension.ts`).

### 3.3 Reading Terminal Content

**Feasibility: VERY HARD, requires Screen Recording permission**

- Reading terminal text content via AX is not reliable for GPU-rendered terminals like Ghostty
- ScreenCaptureKit (macOS 12.3+, replaces CGWindowListCopyWindowInfo for content) can capture window content as images, but parsing text from screenshots is OCR territory
- **Recommendation:** Don't attempt terminal content inspection. Rely on tmux's own IPC for pane management.

---

## 4. URL Schemes & Deep Linking

### 4.1 How Custom URL Schemes Work in .app Bundles

**Apple Docs:** https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app
**Feasibility: EASY**

Registration in `Info.plist`:
```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleTypeRole</key>
        <string>Viewer</string>
        <key>CFBundleURLName</key>
        <string>dev.partnerai.ghostty.myproject</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>cc-myproject</string>
        </array>
    </dict>
</array>
```

Handling in the app:
```swift
// NSAppleEventManager or NSApplicationDelegate
func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls {
        // url = cc-myproject://focus-agent/agent-id-123
        handleDeepLink(url)
    }
}
```

### 4.2 URL Scheme Payloads

**Feasibility: EASY**

URL schemes can carry rich payloads:
- `commandcentral-project://focus-agent/agent-id`
- `commandcentral-project://notify?event=completed&agent=project-auth&exit=0`
- `commandcentral-project://status?query=all`

Parameters are passed as path segments or query strings and are fully parsed on receipt. **No size limit in practice** (URLs up to ~2KB are reliable; avoid very large payloads).

### 4.3 Per-Project Scheme Registration

**Critical consideration:** Each per-project Ghostty bundle gets a unique `CFBundleIdentifier` (e.g., `dev.partnerai.ghostty.project-auth`). We can give each bundle a unique URL scheme too (e.g., `cc-project-auth://`). This means:

- CC can send a URL to a specific project's Ghostty instance
- The Ghostty bundle receives it and focuses the right agent, pane, or window
- macOS Launch Services routes `open cc-project-auth://focus` to the correct bundle automatically

**Collision risk:** If two bundles claim the same scheme, macOS will pick one (the most recently installed). Use project-specific scheme names to avoid this.

### 4.4 Integration with terminal-notifier

[terminal-notifier](https://github.com/julienXX/terminal-notifier) supports action URLs — clicking the notification activates a URL scheme. This means:
- Agent completes → `oste-notify.sh` fires a macOS notification via `terminal-notifier`
- User clicks the notification → triggers `cc-project-auth://focus-agent/agent-id`
- Ghostty bundle for that project activates and focuses the correct session

**Feasibility: EASY** — terminal-notifier supports `-open` and `-execute` parameters for URL callbacks.

---

## 5. Developer Workflow Analysis: 5 Agents, 3 Projects

### 5.1 Current State: Minute-by-Minute Reality

**Setup:** Developer has 5 Claude Code agents running across 3 projects (project-auth, project-api, project-ui). Each has a Ghostty bundle with emoji icon. Command Central sidebar shows all agents.

#### Scenario: Agent finishes, developer needs to review output

| Step | Action | Time | Friction Point |
|------|--------|------|----------------|
| 1 | macOS notification "agent-auth completed" appears | 0s | — |
| 2 | Developer finishes current thought in VS Code | 5-30s | Context interruption |
| 3 | Look at CC sidebar to confirm which agent | 5s | Must read sidebar, identify agent |
| 4 | Click agent in CC sidebar | 1s | Must navigate to sidebar view |
| 5 | `open -a <bundle_id>` fires, brings Ghostty to front | ~100ms | Correct window may not be visible |
| 6 | All Ghostty windows come forward (not just the right one) | 0s | Must identify correct window/tab |
| 7 | Look at tmux pane names to find correct session | 5-10s | Mental overhead, visual scanning |
| 8 | Switch to correct tmux window if needed | 3s | Keystrokes: `Ctrl+B, N` or `tmux select-window` |
| 9 | Review agent output (scroll up, read) | 30-120s | Core task |
| 10 | Switch back to VS Code | 2s | `Cmd+Tab` |
| **Total** | | **~50-180s** | 3 unnecessary friction points |

#### Identified Friction Points

**Friction 1 (Steps 5-6): Wrong window comes forward**
- `open -a <bundle_id>` activates the application, not a specific window
- If the project has multiple Ghostty windows, the wrong one may come to front
- **Fix:** AppleScript window targeting, or Ghostty IPC (when available)

**Friction 2 (Steps 7-8): tmux pane identification**
- Even with the right Ghostty window, if multiple tmux windows exist, must navigate manually
- `tmux select-window` fires but user doesn't always see it take effect
- **Fix:** More aggressive tmux window selection + visual feedback

**Friction 3 (Step 3): Information deficit at notification time**
- The macOS notification says "completed" but doesn't show: exit code, changed files, or a summary
- Developer can't triage without switching to CC sidebar
- **Fix:** Rich notifications — include exit code, file count, last line of output

### 5.2 Current Keystrokes/Clicks Count

**From "agent finished notification" to "reviewing output":**
- Best case (correct window already visible): 3 clicks + 0 keystrokes
- Typical case: 5 clicks + 4 keystrokes (`Ctrl+B`, window select, scroll)
- Worst case (multiple projects, tmux confusion): 8 clicks + 8+ keystrokes

**Competitor comparison (dmux):** `j` to jump to pane = 1 keystroke. That's the target UX.

### 5.3 Information Missing at Each Step

| Moment | What Developer Has | What's Missing |
|--------|-------------------|----------------|
| Notification arrives | "Agent completed" | Exit code, file delta, last output line |
| CC sidebar glance | Status, name, duration | Diff summary (files changed, +/- lines) |
| After click-to-focus | Ghostty window focused | Which tmux pane to look at |
| In terminal reviewing | Raw output | Structured summary (what worked, what failed) |

---

## 6. Technical Feasibility Matrix

### Enhancement A: Dynamic Dock Icon Changes Based on Agent Status

**Feasibility: MEDIUM**
**Implementation:** `NSApp.applicationIconImage = NSImage(...)` in the Ghostty bundle's app delegate. Drive updates from agent state via:
1. Ghostty bundle reads a shared state file (`/tmp/cc-<project>-status.json`)
2. Sets up a file watcher on that file
3. On change: swap icon image or update contentView overlay, call `display()`

**Technology:** NSDockTile contentView overlay (add status badge on top of project emoji icon)
**Limitation:** The Ghostty bundle needs to be modified to include this logic — currently it's a cloned unmodified Ghostty.app. Requires adding a plugin or modifying the app delegate.
**Alternative (no bundle modification needed):** Run a helper process that uses AppleScript `set the image of the dock item of application...` — but this is fragile and requires Accessibility access.
**Recommended approach:** Bake the status-checking logic into the bundle creation script. When `launcher --create-bundle` runs, inject a minimal Swift plugin into `Contents/PlugIns/` that monitors `/tmp/cc-<project>.json` and updates the dock tile.

---

### Enhancement B: Dock Badge Showing Agent Count/Status

**Feasibility: EASY**
**Implementation:** `NSApp.dockTile.badgeLabel = "2"` (in Ghostty bundle's app delegate)
**Technology:** NSDockTile.setBadgeLabel
**Trigger:** Same file-watcher approach as Enhancement A
**Limitation:** Badge is only visible when app is running. Badge persists until cleared or app quits.
**Specific values to show:**
- Running: show count of active agents (e.g., "2")
- All complete: empty string (clear badge)
- Error: "!" or "✗"

---

### Enhancement C: Right-Click Dock Menu Listing Agents

**Feasibility: EASY**
**Implementation:** `NSApplicationDelegate.applicationDockMenu(_:)` returning a dynamically-built NSMenu
**Technology:** NSMenu + NSMenuItem with actions
**Data source:** Read `/tmp/cc-<project>-status.json` to populate menu items
**Each menu item:** agent name + status emoji + duration
**Action on click:** trigger URL scheme `cc-<project>://focus-agent/<agent-id>`
**Limitation:** Menu is rebuilt fresh each time (no caching issue). Menu can't show real-time updates — it's static at the moment of right-click.

---

### Enhancement D: Dock Bounce on Agent Completion/Error

**Feasibility: EASY**
**Implementation:** `NSApp.requestUserAttention(.informationalRequest)` for completion, `.criticalRequest` for error
**Technology:** NSApplication.requestUserAttention
**Trigger:** File watcher detects status change in `/tmp/cc-<project>-status.json`
**Specifics:**
- Agent completes with exit 0 → `.informationalRequest` (single bounce)
- Agent completes with exit ≠ 0 → `.criticalRequest` (continuous bounce until user focuses)
**Limitation:** Only bounces when the Ghostty bundle is NOT the frontmost app. If dev is already in that project's Ghostty window, no bounce.

---

### Enhancement E: Progress Bar in Dock Icon

**Feasibility: MEDIUM**
**Implementation:** NSDockTile with NSProgressIndicator in contentView
**Technology:** NSDockTile contentView + NSProgressIndicator + timer-driven display() calls
**Reference:** [DockProgressBar](https://github.com/hokein/DockProgressBar), [DockProgress](https://github.com/sindresorhus/DockProgress)
**Limitation:**
- Progress is only meaningful if we have a "total steps" concept (e.g., N subtasks completed of M)
- Most Claude Code sessions don't have a measurable progress metric
- An indeterminate spinner in the dock is achievable but may be more noise than signal
**Recommendation:** Skip for v1. Add only when tasks have measurable sub-steps.

---

### Enhancement F: Window Preview on Cmd+Tab Hover

**Feasibility: IMPOSSIBLE via public API**
**Why:** macOS Cmd+Tab uses a private `com.apple.dock` process. There is no public API to inject content into the app switcher overlay, override its preview logic, or hook into its hover events.
**What's possible instead:**
- Third-party app switchers (AltTab, DockDoor) can show window previews using Accessibility + Screen Recording APIs, but these require user permission grants and are separate apps
- VS Code Extension cannot intercept or augment Cmd+Tab behavior
- The Ghostty bundle itself cannot customize its Cmd+Tab thumbnail beyond having a good window title (which tmux sets)
**Recommendation:** Improve window titles to be descriptive (e.g., "project-auth — agent-id running 12m") so the stock Cmd+Tab is more informative. This is pure tmux config, no API needed.

---

### Enhancement G: Drag-and-Drop Files onto Dock Icon

**Feasibility: EASY** (for receiving drops), **MEDIUM** (for useful behavior)
**Implementation:** Register in Info.plist that the app accepts file drops (`LSItemContentTypes`), then handle in `application(_:open:)` delegate method
**Technology:** NSApplicationDelegate, NSPasteboard, LSItemContentTypes in Info.plist
**Reference:** [SwiftUI macOS Drag Files Into Dock tutorial (2024)](https://imgracehuang.medium.com/swiftui-macos-drag-files-into-dock-0a5447edb9b2)
**Useful behavior for Ghostty Launcher:** Dragging a file onto a project's dock icon could:
- Open the file in that project's Ghostty (e.g., `cat file.txt` in the session)
- Send the file path to the active tmux pane
**Limitation:** Requires modifying the Ghostty bundle's app delegate to handle `open` events

---

### Enhancement H: Split View Automation (VS Code + Terminal)

**Feasibility: HARD — not via public API, partial workaround exists**
**Why it's hard:** macOS Split View (full-screen tiling via green button) has no public API. Apple has never exposed programmatic control of Mission Control or Split View.
**What IS possible:**
1. **Window resize/reposition via AX API** (requires Accessibility permission):
   - Get VS Code window bounds: `AXUIElementCopyAttributeValue(vsCodeWindow, kAXFrameAttribute, ...)`
   - Get Ghostty window bounds: same approach
   - Set both to cover half-screen each: `AXUIElementSetAttributeValue(window, kAXFrameAttribute, newFrame)`
   - This achieves the same visual effect as Split View, just without the macOS animation
2. **AppleScript window sizing** (no extra permissions if scripting standard apps):
   ```applescript
   tell application "Visual Studio Code" to set bounds of window 1 to {0, 25, 960, 1080}
   tell application id "dev.partnerai.ghostty.myproject" to set bounds of window 1 to {960, 25, 1920, 1080}
   ```
**Recommendation:** Implement the AppleScript/AX window layout approach as a CC command ("Side by side: VS Code + Agent Terminal"). This gives 80% of the UX value of Split View without the fragility.

---

### Enhancement I: Cross-App Cmd+Tab Selection Triggering CC Sidebar Updates

**Feasibility: MEDIUM — via NSWorkspace notifications**
**Implementation:**
```swift
NSWorkspace.shared.notificationCenter.addObserver(
    self,
    selector: #selector(appDidActivate),
    name: NSWorkspace.didActivateApplicationNotification,
    object: nil
)
```
**What this enables:**
- When user Cmd+Tabs to a specific Ghostty bundle, CC sidebar can auto-select the corresponding project/agent group
- VS Code extension registers an NSWorkspace observer (via a helper process or Node.js `NSWorkspace` binding) that fires when the active app changes
- CC receives the `bundleIdentifier` of the newly active app, maps it to a project, updates sidebar selection
**Technology:** NSWorkspace.didActivateApplicationNotification (no special permissions needed)
**Limitation:** The VS Code extension runs in Node.js, not native macOS. To observe NSWorkspace notifications from VS Code:
- Option 1: Write a small native helper process that listens for the notification and communicates via stdout/stdin or Unix socket back to the VS Code extension
- Option 2: Use Node.js `node-mac-permissions` or a Bun FFI binding
**Recommendation:** This is a high-value feature ("smart focus follows app switch") worth building. Implement a small Swift helper binary that the extension spawns, listens on stdout for `{"activated": "dev.partnerai.ghostty.project-auth"}` events.

---

## 7. Ghostty IPC: Current State and Future

**Key finding:** Ghostty does not yet have a stable public IPC/socket API as of early 2026.

From GitHub discussion #2353 (Scripting API for Ghostty):
- Developers are considering Unix socket-based IPC similar to Kitty's approach
- macOS-specific AppleScript control is being evaluated
- A developer has built a working prototype using JSON-RPC over Unix socket on macOS
- No commitment to stable API timeline yet

**cmux's approach:** cmux (built on libghostty) has implemented its own socket API that supports creating workspaces, splitting panes, sending keystrokes, and opening URLs. This is a fork-level feature, not available in upstream Ghostty.

**What this means for CC:** Our current approach (`open -a <bundle_id>`) is the right call. Ghostty IPC remains an unofficial/unstable interface. The `window_id` and `terminal_id` fields in `/tmp/ghostty-terminals.json` are currently unused dead weight — they would only become useful once Ghostty exposes a stable way to target windows by ID.

**Recommended watch:** Follow https://github.com/ghostty-org/ghostty/discussions/2353 for IPC progress.

---

## 8. Per-Project Bundle Architecture: Technical Validation

The core Ghostty Launcher concept — cloning `Ghostty.app` to `/Applications/Projects/<name>.app` with unique `CFBundleIdentifier` — is technically sound. Here's why it works:

1. **Unique `CFBundleIdentifier`:** macOS Launch Services treats each bundle identifier as a distinct application. `dev.partnerai.ghostty.project-auth` and `dev.partnerai.ghostty.project-api` appear as separate apps in the Dock, Cmd+Tab, and Mission Control.

2. **Emoji dock icons:** Ghostty supports `macos-icon` config option (see `ghostty.org/docs/config/reference`). By setting this per-bundle-config file, each project gets a distinct emoji icon. **Known issue:** Custom icons don't persist when app is "Keep in Dock" because the icon is applied at runtime via NSApp, and the dock stores the last-seen icon from the bundle's `.icns`. Our workaround: bake the emoji icon directly into the cloned bundle's `.icns` file at creation time.

3. **Separate dock presence:** Each bundle appears independently in Dock, Mission Control, Cmd+Tab. This is the entire point — a developer with 5 projects sees 5 distinct Ghostty instances, each with its project emoji.

4. **URL scheme registration:** Each bundle can register a unique URL scheme at creation time, enabling deep linking per-project.

5. **Ghostty config isolation:** Each bundle points to its own `~/.config/ghostty/` equivalent or a per-project config path, giving project-specific terminal settings (theme, font, shell RC, etc.).

**Code signing note:** Modifying the bundle invalidates its code signature. On Apple Silicon Macs, this means Gatekeeper will flag the modified bundle. Solutions:
- Sign the modified bundle with a personal dev certificate (works for local use)
- Use `codesign --remove-signature` followed by re-signing
- Run the launcher setup once with user approval
- The existing `launcher --create-bundle` script presumably handles this already

---

## 9. Practical Implementation Recommendations

### Near-Term (Easy wins, implement in current sprint)

1. **Dock badge on agent count** — When CC starts an agent in a project bundle, write the count to `/tmp/cc-<bundle-id>.json`. Inject a minimal watcher into the bundle that reads this and calls `NSApp.dockTile.badgeLabel`. **Effort: ~1 day**

2. **Dock bounce on completion** — Same watcher fires `NSApp.requestUserAttention` on status change to "completed" or "failed". **Effort: ~2 hours**

3. **Dock right-click menu** — Implement `applicationDockMenu` to show agents for that project with click-to-focus actions via URL scheme. **Effort: ~1 day**

4. **Rich notifications** — Pass exit code + file change count in `oste-notify.sh` notification payload. **Effort: ~2 hours**

### Medium-Term (Requires more engineering)

5. **NSWorkspace activation watcher** — Swift helper binary that sends bundle ID activations to CC extension for smart sidebar sync. **Effort: ~3 days**

6. **AppleScript window layout** ("Side by side") — CC command to tile VS Code + current project's Ghostty side-by-side. **Effort: ~1 day**

7. **URL scheme deep linking** — Per-project `cc-<project>://` schemes for notification clickthrough. **Effort: ~1 day**

### Skip or Deprioritize

8. **Progress bar in dock** — Low signal/noise value without measurable sub-steps. Skip for v1.

9. **Dynamic icon change (runtime)** — High complexity relative to value. Emoji is set at bundle creation time; that's sufficient for Cmd+Tab distinction.

10. **Split View automation** — Public API doesn't exist; AX approach is fragile. Use window resize workaround only if users specifically request it.

11. **AX-based tmux pane targeting** — Terminal emulators are opaque to the AX tree. Use tmux IPC directly (already implemented in CC).

12. **Cmd+Tab hover previews** — Impossible via public API.

---

## 10. Summary: API Capability Map

| Feature | API | Feasibility | Permissions Required | App Store? |
|---------|-----|-------------|---------------------|------------|
| Dock badge (text) | NSDockTile.badgeLabel | **Easy** | None | Yes |
| Dock bounce | NSApp.requestUserAttention | **Easy** | None | Yes |
| Right-click dock menu | applicationDockMenu | **Easy** | None | Yes |
| Custom dock icon (static) | NSApp.applicationIconImage | **Easy** | None | Yes |
| Custom dock icon (dynamic) | NSDockTile.contentView | **Medium** | None | No (NSDockTilePlugin) |
| Progress in dock | NSDockTile + NSProgressIndicator | **Medium** | None | Yes (if no plugin) |
| URL scheme deep linking | CFBundleURLTypes + NSApplicationDelegate | **Easy** | None | Yes |
| Drag files to dock icon | Info.plist + NSApplicationDelegate | **Easy** | None | Yes |
| Activate specific app | open -a (recommended over NSRunningApplication) | **Easy** | None | Yes |
| Activate specific window | AppleScript / AXUIElement | **Medium** | AX permission | Yes |
| Window resize/layout | AXUIElement frame manipulation | **Medium** | AX permission | Yes |
| Split View tiling | No public API | **Impossible** | N/A | N/A |
| Cmd+Tab hover previews | No public API | **Impossible** | N/A | N/A |
| tmux pane targeting via AX | Not possible (opaque surface) | **Hard/No** | AX permission | N/A |
| App activation notifications | NSWorkspace.didActivateApplicationNotification | **Medium** | None | Yes |
| Ghostty-specific window IPC | Not stable yet | **Hard** | None | N/A |

---

## Sources

- [NSDockTile | Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsdocktile)
- [NSDockTilePlugin | Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsdocktileplugin)
- [applicationDockMenu | Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/1428564-applicationdockmenu)
- [requestUserAttention | Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsapplication/requestuserattention(_:))
- [NSRunningApplication | Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsrunningapplication)
- [CGWindowListCopyWindowInfo | Apple Developer Documentation](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:))
- [Defining a custom URL scheme | Apple Developer Documentation](https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app)
- [NSProgressIndicator | Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nsprogressindicator)
- [DSFDockTile — Swift dock tile library (updated Apr 2024)](https://github.com/dagronf/DSFDockTile)
- [DockProgress — Show progress in Dock icon](https://github.com/sindresorhus/DockProgress)
- [DockProgressBar — Reference implementation](https://github.com/hokein/DockProgressBar)
- [Ghostty Scripting API Discussion #2353](https://github.com/ghostty-org/ghostty/discussions/2353)
- [Ghostty NSDockTilePlugin commit](https://github.com/ghostty-org/ghostty/actions/runs/20487082431)
- [Ghostty macOS badge on dock icon Discussion #7104](https://github.com/ghostty-org/ghostty/discussions/7104)
- [cmux — Ghostty-based terminal with socket API](https://github.com/manaflow-ai/cmux)
- [SwiftUI macOS Drag Files Into Dock (Medium, 2024)](https://imgracehuang.medium.com/swiftui-macos-drag-files-into-dock-0a5447edb9b2)
- [Activating Applications via AppleScript (Michael Tsai, 2022)](https://mjtsai.com/blog/2022/05/31/activating-applications-via-applescript/)
- [NSRunningApplication activate(options:) — macOS 11/14 breakage thread](https://developer.apple.com/forums/thread/739524)
- [How to display a Custom View inside macOS Dock using NSDockTile](https://thisdevbrain.com/custom-view-inside-dock-with-nsdocktile/)
- [MacOS dock — Bouncing and badges from web apps (Medium)](https://medium.com/@vitalyb/macos-dock-bouncing-and-badges-from-web-apps-ceec029dbccd)
- [Automating split screen view — Automators Talk](https://talk.automators.fm/t/automating-split-screen-view/12146)
- [AltTab — Open source window switcher (uses AX + Screen Recording)](https://dockdoor.net/)
- [Command Central FOCUS-FEATURE-RESEARCH.md](../research/FOCUS-FEATURE-RESEARCH.md)
- [Command Central STRATEGY-SYNTHESIS-2026-03-22.md](../research/STRATEGY-SYNTHESIS-2026-03-22.md)
