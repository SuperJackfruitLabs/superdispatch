#!/usr/bin/env bash
set -euo pipefail

# A route is docs-only only when a PR has a known, non-empty diff and every changed path is
# documentation. Every uncertain case deliberately falls back to the full suite.
event=${1:-}
base=${2:-}
head=${3:-HEAD}
docs_only=false

if [[ "$event" == pull_request ]] &&
  [[ -n "$base" ]] &&
  [[ "$base" != 0000000000000000000000000000000000000000 ]] &&
  git cat-file -e "$base^{commit}" 2>/dev/null &&
  git cat-file -e "$head^{commit}" 2>/dev/null; then
  if changed=$(git diff --name-only "$base" "$head") && [[ -n "$changed" ]]; then
    docs_only=true
    while IFS= read -r path; do
      case "$path" in
        README | README.md | README.markdown | README.txt | README.rst | docs/* | docs-site/*) ;;
        *)
          docs_only=false
          break
          ;;
      esac
    done <<<"$changed"
  fi
fi

printf 'docs_only=%s\n' "$docs_only" >>"${GITHUB_OUTPUT:-/dev/null}"
printf 'docs_only=%s\n' "$docs_only"
