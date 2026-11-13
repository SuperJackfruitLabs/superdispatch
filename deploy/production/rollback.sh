#!/usr/bin/env bash
# Put back the release that ran before the deployed one, as root on the production host, by hand:
#   bash /opt/superdispatch/deploy/production/rollback.sh v<the deployed tag>
# The deployed tag is named so the command cannot roll back a release it did not mean to. The host
# knows what ran before: release.sh recorded it in /etc/superdispatch/previous. This runs that
# tag's own release.sh, which sees it is a rollback and restores the store's copy taken before the
# deployed tag when that tag moved the schema. The release on GitHub is left as it is.
set -euo pipefail
tag=${1:?usage: rollback.sh v<x.y.z>}
etc=/etc/superdispatch
repo=/opt/superdispatch
deployed=$(cat "$etc/deployed" 2>/dev/null || true)
previous=$(cat "$etc/previous" 2>/dev/null || true)
[ "$deployed" = "$tag" ] || { echo "deployed is ${deployed:-nothing}, not $tag: nothing to roll back"; exit 1; }
[ -n "$previous" ] || { echo "no release ran before $tag: nothing to put back"; exit 1; }
git -C "$repo" fetch -q --tags origin
script=$(mktemp)
git -C "$repo" show "refs/tags/$previous:deploy/production/release.sh" > "$script"
exec bash "$script" "$previous"
