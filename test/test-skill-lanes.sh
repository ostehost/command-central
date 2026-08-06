#!/usr/bin/env bash
set -euo pipefail

CHECK="$(cd "$(dirname "$0")/.." && pwd)/scripts-v2/check-skill-lanes.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/command-central-skill-lanes.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/.claude/skills/valid"
printf '%s\n' '---' 'name: valid' 'description: Valid fixture.' '---' >"$tmp/.claude/skills/valid/SKILL.md"
bash "$CHECK" "$tmp" >/dev/null

mkdir -p "$tmp/.agents/skills/missing"
if bash "$CHECK" "$tmp" >"$tmp/missing.out" 2>&1; then
    echo "missing SKILL.md mutation passed unexpectedly" >&2
    exit 1
fi
grep -F '.agents/skills/missing has no SKILL.md' "$tmp/missing.out" >/dev/null
rm -rf "$tmp/.agents/skills/missing"

mkdir -p "$tmp/.gemini/skills"
printf 'not a skill\n' >"$tmp/.gemini/skills/stray.md"
if bash "$CHECK" "$tmp" >"$tmp/stray.out" 2>&1; then
    echo "stray-file mutation passed unexpectedly" >&2
    exit 1
fi
grep -F '.gemini/skills/stray.md is not a skill directory' "$tmp/stray.out" >/dev/null

echo "skill-lane detector mutations: ok"
