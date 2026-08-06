#!/usr/bin/env bash
# Validate this checkout's agent skill lanes without consulting HOME or sibling repositories.
set -euo pipefail

root="${1:-.}"
if [[ ! -d "$root" ]]; then
    echo "check-skill-lanes: no such directory: $root" >&2
    exit 2
fi
root="$(cd "$root" && pwd)"
failed=0
lanes_found=0
entries=0
shopt -s nullglob dotglob

for lane in .claude/skills .agents/skills .gemini/skills; do
    lane_path="$root/$lane"
    [[ -d "$lane_path" ]] || continue
    lanes_found=$((lanes_found + 1))
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
            continue
        fi
        entries=$((entries + 1))
    done
done

# A checkout with no lane at all must not report success: that is how a renamed
# or deleted lane turns this gate vacuous instead of informative.
if [[ "$lanes_found" -eq 0 ]]; then
    echo "no agent skill lanes found under $root (expected one of .claude/skills, .agents/skills, .gemini/skills)" >&2
    exit 1
fi

if [[ "$failed" -ne 0 ]]; then
    exit 1
fi
printf 'skill lanes: ok (%d lane(s), %d skill(s))\n' "$lanes_found" "$entries"
