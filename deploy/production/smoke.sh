#!/usr/bin/env bash
# The production smoke check, as root on the production host, at any time after a release:
#   bash /opt/superdispatch/deploy/production/smoke.sh v<x.y.z>
# Changes nothing. Passes when the tag is the one deployed, its container is running and healthy,
# /healthz answers, and the loop has swept since the container started. release.sh runs the same
# checks as it deploys.
set -euo pipefail
tag=${1:?usage: smoke.sh v<x.y.z>}
etc=/etc/superdispatch
deployed=$(cat "$etc/deployed" 2>/dev/null || true)
[ "$deployed" = "$tag" ] || { echo "deployed is ${deployed:-nothing}, not $tag"; exit 1; }
cd /opt/superdispatch
export SUPERDISPATCH_TAG=$tag
compose="docker compose -f deploy/production/compose.yml"
id=$($compose ps -q dispatch)
[ -n "$id" ] || { echo "no dispatch container"; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$id")
[ "$image" = "superdispatch:$tag" ] || { echo "the container runs $image, not superdispatch:$tag"; exit 1; }
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
[ "$health" = healthy ] || { echo "the container's health is $health"; exit 1; }
curl -sf http://127.0.0.1:8798/healthz >/dev/null || { echo "/healthz did not answer on 127.0.0.1:8798"; exit 1; }
docker logs "$id" 2>&1 | grep -q 'loop: first sweep' || { echo "the loop has not swept"; exit 1; }
echo "superdispatch $tag: healthy, $(docker logs "$id" 2>&1 | grep 'loop: first sweep' | tail -1)"
