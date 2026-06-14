# RESULT — Installed/live retest of the History rattle stable-`TreeItem.id` fix

- **Task:** `cc-history-installed-live-retest-20260614`
- **Repo:** `/Users/ostehost/projects/command-central` (Mike MacBook Pro / hub)
- **Date:** 2026-06-14
- **Source fix under test:** `98732e82` — *fix(agent-status): stable TreeItem.id anchors History tree-resolve storm*
- **CC HEAD after this task:** `70eab886` (local prerelease cut, **not pushed**)
- **Launcher HEAD:** `fb5a26bf` (clean)

---

## Verdict: **GO for user retest** (fix is verified present in the installed product; final audible click-confirmation is the user's step)

- The fix is **correct** (13/13 stable-id unit tests + full strict CI 2122 pass / 0 fail).
- The previously-installed **rc.61 did NOT contain the fix** — proven three independent ways.
- A focused local **rc.62 was built and installed**, and its bundle **definitively contains** the History stable-id fix and the two sibling fixes the manager named.
- The remaining step — reload the window, click/expand History while agents run, and confirm the **audible rattle is gone** — **cannot be automated** from this agent (no VS Code Electron-UI click automation; no audio capture). Exact user steps + log-grep are below.

---

## 1. Did the installed rc.61 include fix `98732e82`?  →  **No.**

Three independent confirmations:

| Evidence | rc.61 (was installed) | Conclusion |
|---|---|---|
| `getStableTreeItemId` in installed `dist/extension.js` | **0** | fix symbol absent |
| `project:__unregistered__` in installed bundle | **0** | fix sentinel absent |
| Installed bundle vs `releases/command-central-0.6.0-rc.61.vsix` | **byte-identical** (`cmp` match) | the shipped rc.61 artifact also lacks the fix |

Timing corroborates it: the rc.61 VSIX/install mtime is **2026-06-14 10:34**, while fix `98732e82` was committed at **2026-06-14 11:11** — ~37 minutes later. rc.61 was cut before the fix existed.

> So on rc.61 the user would still hear the rattle — consistent with the diagnosis doc's live evidence of **204** `Failed to resolve tree node` errors on rc.61
> (`research/RESULT-cc-history-rattle-diagnosis-20260614.md`).

Commands used:
```bash
EXT=~/.vscode/extensions/oste.command-central-0.6.0-rc.61/dist/extension.js
grep -c 'getStableTreeItemId' "$EXT"            # → 0
grep -c 'project:__unregistered__' "$EXT"       # → 0
# byte-compare installed bundle to the released rc.61 VSIX bundle:
TMP=$(mktemp -d); unzip -q releases/command-central-0.6.0-rc.61.vsix -d "$TMP"
cmp -s "$TMP/extension/dist/extension.js" "$EXT" && echo same   # → same
```

---

## 2. Decision: build a local rc.62?  →  **Yes — safety gate passed.**

The manager's gate was: *use the launcher registry (not raw `ps`) to find running Command Central lanes; if only this lane runs and the tree is clean, a local rc.62 build/install is allowed.*

- **Authoritative running-state registry** `~/.config/ghostty-launcher/tasks.json` → exactly **one** `running` task: `cc-history-installed-live-retest-20260614` (this lane). No other CC lane active.
  (`~/.config/openclaw/lanes.json` is a lane *config* store with no live status field — not a running-state source. Raw `ps` showed ~91 historical `claude` PIDs and is misleading, per the manager's note.)
- **Git tree clean** before build (`git status --porcelain` empty).
- **Launcher clean** at `fb5a26bf` (cross-repo dependency healthy).

Gate proof before building:
```bash
just ci      # → 2122 pass / 1 skip / 0 fail; biome ci + tsc + knip + quality all green
bun test ./test/tree-view/agent-status-tree-item-stable-id.test.ts   # → 13 pass / 0 fail
```

**Build path chosen:** `just dist --prerelease` (bumps rc.61 → rc.62, builds + content-gates + auto-installs the VSIX).
I deliberately did **not** run the full cross-repo `just prerelease` hard gate for this *validation* build, because:
1. its hard gate calls `openclaw nodes status --json`, and the node is frequently saturated (unrelated spurious failures), and
2. the only cross-repo drift is a **+4-line, same-version (1.2.8)** stale bundled launcher — orthogonal to the History fix (which lives in `src/`, not `resources/bin/`).
The CC strict gate (`just ci`) — the CC half of the prerelease gate — passed, which is the relevant green signal for this fix.

> **Known orthogonal item (does not affect this fix):** the bundled launcher in `resources/bin/` is 4 lines behind canonical (`just sync-launcher --check` reports `+4`). For a *real* release cut (not this local retest build), run `just sync-launcher` first. It was intentionally left out to keep the commit scoped to the History-fix release.

---

## 3. Does the installed **rc.62** bundle contain the fixes?  →  **Yes — all three families.**

Installed: `oste.command-central@0.6.0-rc.62` (`code --list-extensions --show-versions`).

| Marker (installed bundle / package.json) | rc.61 | **rc.62** | Source fix |
|---|:--:|:--:|---|
| `getStableTreeItemId` (JS bundle) | 0 | **1** | `98732e82` History stable-id |
| `project:__unregistered__` (JS bundle) | 0 | **1** | `98732e82` |
| `summary:sources` (JS bundle) | 0 | **1** | `4690bc95` flat-mode Sources summary id |
| `/^agentTask\.running/` when-clause refs (package.json) | 1 | **3** | `e9dfde5f` running-only inline focus/capture |

- The released `releases/command-central-0.6.0-rc.62.vsix` bundle is **byte-identical** to the installed bundle (`cmp` match) and also carries the markers — so the artifact and the install agree.
- VSIX content gate passed: **280,678 B compressed / 923,960 B uncompressed / 54 files** (budgets 600 KB / 2 MB / 120).

Commands used:
```bash
B62=~/.vscode/extensions/oste.command-central-0.6.0-rc.62/dist/extension.js
P62=~/.vscode/extensions/oste.command-central-0.6.0-rc.62/package.json
grep -c 'getStableTreeItemId' "$B62"        # → 1
grep -c 'summary:sources' "$B62"            # → 1
grep -c 'agentTask\\.running' "$P62"        # → 3  (rc.61 had 1)
```

---

## 4. Extension-host log evidence

**Before (baseline storm — real logs, fix absent):**
```
~/Library/Application Support/Code/logs/20260611T150816/window2/exthost/exthost.log → 214 hits
~/Library/Application Support/Code/logs/20260611T150816/window1/exthost/exthost.log → 118 hits
```
of `Failed to resolve tree node`, concentrated on exactly the nodes the fix anchors:
`symphony` (92), `agentStatus` (29), `status-group:done` (16), `status-group:limbo` (4), `status-group:attention` (2).
Diagnosis doc records **204** such errors on live rc.61 (62 agentStatus + 163 symphony — one provider renders both views).

**After (rc.62, live click):** **NOT YET OBSERVABLE from this agent.**
- rc.62 was installed at 11:43, but VS Code **caches the running extension — a window reload is required** to activate it (`just dist` prints this requirement).
- The newest window log dir (`20260614T114408`) had not yet loaded the extension / clicked History.
- **I cannot click the History tree or hear the audible alert** — VS Code is an Electron app; the available browser automation drives Chrome web pages only, not the VS Code UI. This is the honest limit of native verification here.

---

## 5. Exact user validation steps (the final, human-only step)

1. **Activate rc.62:** in VS Code, `Cmd+Shift+P` → **Developer: Reload Window** (or open a fresh window).
2. Confirm the running build is rc.62:
   ```bash
   LOGS="$HOME/Library/Application Support/Code/logs"
   NEW=$(ls -dt "$LOGS"/*/ | head -1)
   grep -rhoE 'command-central-0\.6\.0-rc\.[0-9]+' "$NEW"*/exthost/exthost.log | sort -u   # expect rc.62
   ```
3. Open **Command Central → Agent Status** (and the **Symphony** view) while agents are active.
4. Click/expand the **History** section header (`status-group:done`) several times, and expand/re-sort the project-group headers. **Listen:** the rattle should be **gone**.
5. Confirm zero new resolve errors:
   ```bash
   grep -rc 'Failed to resolve tree node' "$NEW"*/exthost/exthost.log   # expect 0 on every line
   ```
   - **0 → GO**, ship rc.62 to the user / promote for real release (run `just sync-launcher` first for the launcher resync).
   - **>0 → NO-GO**, capture the offending element ids and reopen the diagnosis.

---

## Artifacts & commands summary

| Item | Value |
|---|---|
| History fix under test | `98732e82` |
| Local prerelease commit (not pushed) | `70eab886` — `chore(release): cut local prerelease v0.6.0-rc.62 …` |
| Tracked files changed | `package.json` (0.6.0-rc.61 → 0.6.0-rc.62), `releases/digest-v0.6.0-rc.62.md` |
| Built/installed VSIX | `releases/command-central-0.6.0-rc.62.vsix` (274 KB) — installed as `oste.command-central@0.6.0-rc.62` |
| Gates | `just ci` → 2122 pass/0 fail; stable-id test → 13 pass/0 fail; VSIX content gate → pass |
| Not done (by policy) | no push / no tag / no publish; full cross-repo `just prerelease` not run (node-status saturation + orthogonal launcher drift) |

```bash
# Reproduce the build + install (only my lane running, tree clean):
just ci
just dist --prerelease
code --install-extension releases/command-central-0.6.0-rc.62.vsix   # (dist already auto-installs)
```
