#!/usr/bin/env bash
# Build superdispatch.dev and deploy it as a Cloudflare Worker with static assets.
#
# CI runs it on every merge to main that touches the site (.github/workflows/sites.yml), with
# the organisation's CLOUDFLARE_API_TOKEN. It also runs by hand with a `wrangler login`.
# landing/wrangler.jsonc names the Worker and its custom domains, so this attaches the domains too.
#
# --config is explicit and wrangler runs from a scratch directory: in a site directory without a
# config, wrangler's project detection scaffolds an adapter into the site and rewrites
# astro.config.mjs. Other products learned that against the live account; do not simplify it away.
#
# Usage: scripts/deploy-sites.sh [landing|all]   (default: all)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
which="${1:-all}"
case "$which" in landing|all) ;; *) echo "usage: $0 [landing|all]" >&2; exit 2 ;; esac

command -v wrangler >/dev/null 2>&1 || {
  echo "wrangler is not installed. npm i -g wrangler, then wrangler login." >&2; exit 1; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

ship() { # <dir> <url>
  echo "==> building $1"
  # --force: the content layer caches into node_modules/.astro, and a stale store can report an
  # empty collection while the dev server works fine.
  (cd "$root/$1" && npm ci --silent && npx astro build --force && node scripts/check-frame.mjs)
  echo "==> deploying $1"
  (cd "$scratch" && wrangler deploy --config "$root/$1/wrangler.jsonc" --cwd "$root/$1")
  echo "==> $2"
}

ship landing "https://superdispatch.dev"

echo
echo "The site claims what the current source does. If the page and the repository disagree,"
echo "the page is wrong — check before telling anyone it is live."
