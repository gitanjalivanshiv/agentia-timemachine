#!/usr/bin/env bash
# Builds the public copy of the repository (tracked files at HEAD, minus private ones) into <target>.
#   scripts/export-public.sh <target-dir>
# Excluded: CLAUDE.md (the private build brief). local/, fixtures/raw/ and .agentia/ are git-ignored anyway.
set -euo pipefail
target="${1:?usage: scripts/export-public.sh <target-dir>}"
mkdir -p "$target"
git archive HEAD | tar -x -C "$target"
rm -f "$target/CLAUDE.md"
grep -rIl -i -E "accelerator|a0Ufn|a11fn|a0cfn|gitanjali\.mishra|@vanshiv" "$target" --exclude-dir=node_modules --exclude=export-public.sh && { echo "✖ private content found in the export"; exit 1; } || true
echo "✔ exported $(git rev-parse --short HEAD) to $target ($(find "$target" -type f | wc -l | tr -d ' ') files)"
