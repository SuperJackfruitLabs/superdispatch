#!/usr/bin/env bash
# Deploy a release of SuperDispatch to production, as root on the production host: run by the
# host's prod-deploy forced command (`superdispatch v<x.y.z>`), which runs this file as it is at
# the tag. Idempotent. Builds the image for the tag, recreates the service, waits for /healthz and
# checks that the service reaches its sources: a token from Accounts with its own credential, the
# hub on the host, and a first sweep of the loop. If the new release does not pass, the release
# that was running before is put back.
#
# The store refuses a database written by a newer build, so a rollback across a migration needs
# the database as it was: an online copy is taken before each release, and put back on rollback
# when the new build moved the schema.
#
# The checks above are the release's smoke: the workflow's smoke step does not see the host's
# address or key, and the service has no public one, so a failed check here is a failed deploy.
#
# A rollback after this script passed is the operator's: rollback.sh, beside this file, runs the
# release that ran before (/etc/superdispatch/previous) through that tag's own copy of this
# script, which sees it is putting back the release before the deployed one and restores the copy
# taken before the deployed one instead of taking a new copy.
set -euo pipefail
tag=${1:?usage: release.sh v<x.y.z>}
repo=/opt/superdispatch
etc=/etc/superdispatch
env=$etc/superdispatch.env
data=/var/lib/superdispatch
db=$data/superdispatch.sqlite
snapshot=$data/pre-release.sqlite
[ -f "$env" ] || { echo "no $env (the host's provisioning writes it)"; exit 1; }
docker network inspect treaty_relay >/dev/null 2>&1 || { echo "no treaty_relay network: deploy the event relay first"; exit 1; }

cd "$repo"
git fetch -q --tags origin
deployed=$(cat "$etc/deployed" 2>/dev/null || true)
compose="docker compose -f deploy/production/compose.yml"

# An online copy of the store (SQLite's backup API), or nothing when there is no store yet.
take_snapshot() {
  rm -f "$snapshot"
  [ -f "$db" ] || return 0
  python3 - "$db" "$snapshot" <<'PY'
import sqlite3, sys
from contextlib import closing
with closing(sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)) as live, closing(sqlite3.connect(sys.argv[2])) as copy:
    live.backup(copy)
    assert copy.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "snapshot failed its integrity check"
PY
}

schema_of() {
  python3 -c 'import sqlite3, sys; print(sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True).execute("PRAGMA user_version").fetchone()[0])' "$1"
}

# Put the copy taken before $1 back when $1 moved the store's schema; the live file is kept aside.
restore_if_moved() {
  [ -f "$snapshot" ] && [ -f "$db" ] || return 0
  [ "$(schema_of "$db")" != "$(schema_of "$snapshot")" ] || return 0
  echo "the store's schema moved; restoring the copy taken before $1"
  $compose stop dispatch || true
  cp -p "$db" "$db.failed-$1-$(date -u +%Y%m%dT%H%M%SZ)"
  rm -f "$db-wal" "$db-shm"
  cp "$snapshot" "$db" && chown --reference="$data" "$db"
}

# Called inside `if`, where set -e does not apply, so every step returns on its own failure.
up() {
  git checkout -q --detach "refs/tags/$1" || return 1
  export SUPERDISPATCH_TAG=$1
  $compose build dispatch || return 1
  # The data directory belongs to the user the image runs as.
  owner=$(docker run --rm --entrypoint sh "superdispatch:$1" -c 'echo "$(id -u bun):$(id -g bun)"') || return 1
  install -d -m 700 "$data" || return 1
  chown "$owner" "$data" || return 1
  $compose up -d --force-recreate --remove-orphans dispatch || return 1
  for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8798/healthz >/dev/null && break; sleep 1; done
  curl -sf http://127.0.0.1:8798/healthz >/dev/null || { $compose logs --tail 50 dispatch; return 1; }
  # Its own token, from Accounts, for SuperPipeline: the credential is good and Accounts answers.
  $compose exec -T dispatch bun -e "
    fetch(process.env.ORG_PLANE_URL.replace(/\/+\$/, '') + '/api/token/service', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.ORG_PLANE_SERVICE_CREDENTIAL, 'content-type': 'application/json' },
      body: JSON.stringify({ audience: process.env.SUPERPIPELINE_URL }),
    }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    || { echo "superdispatch gets no token from Accounts with its credential"; return 1; }
  # The hub, as the service reaches it.
  $compose exec -T dispatch bun -e \
    "fetch(process.env.AGENTPOD_URL.replace(/\/+\$/, '') + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    || { echo "superdispatch does not reach the hub at AGENTPOD_URL"; return 1; }
  # The loop ran: its first sweep logs once, with no board opted in too.
  for _ in $(seq 1 30); do $compose logs dispatch 2>/dev/null | grep -q 'loop: first sweep' && break; sleep 1; done
  $compose logs dispatch 2>/dev/null | grep -q 'loop: first sweep' || { $compose logs --tail 50 dispatch; echo "the loop did not sweep"; return 1; }
  $compose logs dispatch 2>/dev/null | grep -E 'listening on|loop: first sweep' | tail -2
}

# Putting back the release before the deployed one (rollback.sh).
if [ -n "$deployed" ] && [ "$tag" != "$deployed" ] \
  && [ "$(cat "$etc/previous" 2>/dev/null || true)" = "$tag" ] \
  && [ "$(cat "$etc/snapshot-for" 2>/dev/null || true)" = "$deployed" ]; then
  echo "putting $tag back in place of $deployed"
  restore_if_moved "$deployed"
  if up "$tag"; then
    echo "$tag" > "$etc/deployed"
    rm -f "$etc/previous" "$etc/snapshot-for"
    echo "rolled back to $tag ($(git rev-parse --short HEAD))"
    exit 0
  fi
  echo "rollback to $tag failed; superdispatch needs a person"
  exit 1
fi

take_snapshot
echo "$tag" > "$etc/snapshot-for"
if up "$tag"; then
  if [ -n "$deployed" ] && [ "$deployed" != "$tag" ]; then echo "$deployed" > "$etc/previous"; fi
  echo "$tag" > "$etc/deployed"
  echo "released $tag ($(git rev-parse --short HEAD))"
  exit 0
fi
echo "release $tag failed its checks"
if [ -n "$deployed" ] && [ "$deployed" != "$tag" ]; then
  echo "putting $deployed back"
  restore_if_moved "$tag"
  up "$deployed" || echo "rollback to $deployed failed too; superdispatch needs a person"
fi
exit 1
