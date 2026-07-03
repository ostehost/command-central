# PAR-297 — [CCREL-08] Regenerate rc71 node consumption receipt on the real node; record genuine hub/node parity

- **Date:** 2026-07-03
- **Linear:** PAR-297 (Command Central project); work_item_ref: `linear:PAR-297`
- **Task:** `symphony-PAR-297-591c88aa`
- **Host:** real node — `ostehost` (Apple M1 Max, `$HOME=/Users/ostehost`)
- **Repo:** `/Users/ostehost/projects/command-central` @ branch `main` (task-start HEAD `00eb6bfc` before the PAR-297 closeout commit)
- **Depends on:** PAR-237 (CCREL-05 dual-host consumption proof), PAR-233 (CCREL-01 hub/node source alignment)
- **Sibling follow-up (NOT in this lane):** PAR-298 (CCREL-09) — automated gate cross-validation of the two receipts
- **Disposition:** the fabricated node receipt is **replaced with a genuine node-produced receipt**; hub/node consumption parity for rc71 is now demonstrated, not asserted.

## Why this task exists — the fabrication finding

The rc71 dual-host consumption proof was a PAR-237/CCREL-05 acceptance criterion
(install proof on **both** hub and node). Two adversarial reviews
(`research/HANDOFF-cc-review-and-hubnode-alignment-2026-06-25.md`,
`research/HANDOFF-cc-main-agent-2026-06-25.md`) found the committed node receipt
was **not** a real node-side run:

- `research/prerelease-gate/vscode-consumption-0.6.0-rc.71-node.json` (commit
  `db7aa11c`, 2026-06-25) was **byte-identical to the hub receipt** except (a) the
  timestamp was nudged `2026-06-25T13:14:30.825Z` → `…T13:37:28.031Z`, and (b) three
  paths were rewritten `ostemini` → `ostehost`.
- It was **missing the `nodeLabel` key**. Its `-node.json` filename is exactly what
  `receiptFileName(version, "node")` emits, and that path is only reached via
  `--node-label node` — which also serializes `"nodeLabel":"node"` into the body
  (`scripts-v2/verify-vscode-extension-consumption.ts:201`). The recording of
  `nodeLabel` in the body landed 2026-06-24 (`c715ea04`), **before** the Jun-25
  receipts, so a genuine canonical run on Jun 25 would have carried the key. Its
  absence is the tell: the file was hand-derived from the hub receipt, not produced
  on the node.

**Blast radius (why nothing false-shipped):** the prerelease gate never reads
consumption receipts, and `.vscodeignore` excludes `research/**`, so no build or
release consumed the fabricated file. The damage was narrow but real — the
hub/node parity *claim* was unbacked. CCREL-08 closes exactly that gap.

## What was done (on the real node, `ostehost`)

1. **Confirmed same artifact.** `shasum -a 256 releases/command-central-0.6.0-rc.71.vsix`
   → `f7e66a4b8296e6b578fef1143ed60512aea632bbbca0a6019fa77fc6209b19ef`, identical to
   the sha256 the hub receipt records. Hub and node verify the same bytes.
2. **Recorded pre-state honestly.** The node's active extension at task start was
   **rc72** (`code --list-extensions --show-versions` → `oste.command-central@0.6.0-rc.72`);
   rc71 was no longer installed. rc72 is the current preview, so a bare re-run would
   have (correctly) reported a version mismatch — genuine parity for rc71 requires
   rc71 to actually be installed.
3. **Genuinely consumed rc71.** `code --install-extension
   releases/command-central-0.6.0-rc.71.vsix --force` — installed and activated rc71
   on this node; `code --list-extensions` then reported `oste.command-central@0.6.0-rc.71`.
4. **Regenerated the receipt the canonical way:**
   ```bash
   just verify-vscode-consumption -- \
     --vsix releases/command-central-0.6.0-rc.71.vsix \
     --expected-version 0.6.0-rc.71 \
     --node-label node --receipt-dir research/prerelease-gate
   ```
   Exit 0, `success: true`. The receipt now carries `"nodeLabel": "node"`, the node's
   **own** `generatedAt` (`2026-07-03T16:47:26.780Z`), a node-side
   `installedVersionFromCode: "0.6.0-rc.71"`, and `ostehost` paths — none of which a
   path-rewritten copy can honestly claim.
5. **Restored the current release.** `code --install-extension
   releases/command-central-0.6.0-rc.72.vsix --force` returned the node's active
   extension to **rc72**. The regenerated receipt is a timestamped point-in-time
   snapshot of the genuine rc71 install and remains valid after the restore.

## Genuine hub/node parity (rc71)

| Field | Hub receipt (`…-hub.json`) | Node receipt (`…-node.json`, regenerated) | Parity |
|---|---|---|---|
| `vsixSha256` | `f7e66a4b…19ef` | `f7e66a4b…19ef` | **EQUAL** ✅ |
| `expectedVersion` / identity `version` | `0.6.0-rc.71` | `0.6.0-rc.71` | **EQUAL** ✅ |
| `installedVersionFromCode` | `0.6.0-rc.71` | `0.6.0-rc.71` | **EQUAL** ✅ |
| `success` | `true` | `true` | **EQUAL & true** ✅ |
| host (`extensionsDir` prefix) | `/Users/ostemini/…` (hub) | `/Users/ostehost/…` (node) | **DISTINCT** ✅ |
| `generatedAt` | `2026-06-25T13:14:30.825Z` | `2026-07-03T16:47:26.780Z` | **DISTINCT** ✅ |
| `nodeLabel` | *(absent)* | `"node"` | node marker **present** ✅ |

This is the exact assertion set CCREL-09/PAR-298 will automate: **equal**
`vsixSha256` + `version` + `success`; **distinct** host / `extensionsDir` /
`generatedAt`; a **non-empty `nodeLabel` on the node receipt**. Same bytes, both
hosts genuinely install and activate rc71 — parity is now demonstrated, not copied.

## Honest scope boundaries

- **Hub receipt left untouched.** It is the genuine original (the fabricated node
  copy was derived from it) and it also predates the canonical `--node-label` path,
  so it too lacks `nodeLabel`. I am on the node and cannot honestly regenerate a
  hub-side receipt from here; hand-adding `nodeLabel` to it would be the same
  fabrication this task removes. CCREL-09's cross-validation only requires
  `nodeLabel` on the *node* receipt, so this asymmetry does not block parity. A
  future canonical hub re-run would close it.
- **Repo-HEAD alignment (ff-only pull) is out of scope here.** The broader P0 also
  asked to align the node repo to hub HEAD via `git pull --ff-only`. Per the lane
  owner's steering, no `git pull`/`fetch` was run — remote freshness is an operator
  decision. This lane is scoped to the CCREL-08 tracker line ("regenerate genuine
  node receipt + parity"); repo-HEAD parity remains for an operator-run sync.
- **Gate cross-validation (PAR-298/CCREL-09) is not implemented here** — it is a
  separate tracker. No change was made to `scripts-v2/prerelease-gate.ts`.
- **No push / tag / publish / `--no-verify`.** Extension install/uninstall touched
  only `~/.vscode/extensions` (reversible, off-repo); the node ends on rc72 as it
  started.

## Acceptance-criteria status

| AC | Status | Evidence |
|---|---|---|
| Regenerate rc71 node consumption receipt on the real node | **done** | `vscode-consumption-0.6.0-rc.71-node.json` regenerated on `ostehost` with `nodeLabel:"node"`, real `generatedAt`, node-side `code --list-extensions`, `success:true` |
| Receipt is genuine (not a path-rewritten copy) | **done** | produced by `just verify-vscode-consumption … --node-label node`; body carries the `nodeLabel` marker a copy cannot fake |
| Record genuine hub/node parity | **done** | parity table above: equal artifact/version/success, distinct host/dir/time, node `nodeLabel` present |
| No push / tag / publish | **satisfied** | evidence + doc edits only; node restored to rc72 |
```
