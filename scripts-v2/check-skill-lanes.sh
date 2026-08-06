#!/usr/bin/env bash
# Validate this checkout's agent skill lanes without consulting HOME or sibling repositories.
set -euo pipefail

root="${1:-.}"
root="$(cd "$root" && pwd)"
failed=0
shopt -s nullglob dotglob

for lane in .claude/skills .agents/skills .gemini/skills; do
    lane_path="$root/$lane"
    [[ -d "$lane_path" ]] || continue
    for entry in "$lane_path"/*; do
        rel="${entry#"$root/"}"
        if [[ ! -d "$entry" ]]; then
            echo "$rel is not a skill directory" >&2
            failed=1
            continue
        fi
        if [[ ! -f "$entry/SKILL.md" ]]; then
            echo "$rel has no SKILL.md" >&2
            failed=1
        fi
    done
done

if [[ "$failed" -ne 0 ]]; then
    exit 1
fi
printf 'skill lanes: ok\n'
