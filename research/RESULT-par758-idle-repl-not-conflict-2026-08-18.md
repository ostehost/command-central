# RESULT — PAR-758 idle REPL is not a lifecycle conflict

2026-08-18 screenshot (`8.11.57 AM`) after the process canary.

## What Command Central got right

- File list is the canary receipt, not the previous ADR pin.
- `RESULT-V2-DRILL-20260818-01-process-canary.md` `+43 / -0`
- `HEAD · 7e39628` matches the worktree `end_commit`
- Owner-bound via `agent:main:discord:channel:1539243044904378489`
- Row already said `live REPL · idle (exit to clear)`

## What was still a lie

The expanded detail (and hover) said **Lifecycle conflict — Launcher marked completed but process is still alive in terminal**.

That is the designed wait-at-prompt leftover after a clean visible-lane complete. Grouping already kept it out of Action Required. The detail did not.

## Change

When `status === completed` and the pane is a benign live leftover (`idle-agent-repl` / completed-at-prompt / idle shell), the detail is **Idle REPL after complete** with “exit the pane to clear”. Failure-ish statuses and mid-turn / awaiting-input panes still say Lifecycle conflict.

## Not claimed

- Not production E2E
- Does not authorize owner review, close Linear, or kill the pane
- Next live item still needs owner-review authorization + authenticated Runner transport
