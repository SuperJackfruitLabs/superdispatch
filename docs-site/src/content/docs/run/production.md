---
title: Production
description: How a SuperDispatch release reaches production, what the release checks, how to roll back, and where its settings and store live.
---

v0.0.1 runs in production and places cards on every board the operator has opted in.

## How a release deploys

A `vX.Y.Z` tag on main deploys production through the suite's shared release workflow
(`.github/workflows/release.yml`, settings in `.github/release-config.json`, on the GitHub mirror
only). Only the operator pushes tags.

1. It checks that forge CI passed for the tag's commit, or runs `bun run check` at the tag when it
   cannot read that.
2. The production host runs that tag's `deploy/production/release.sh` through its forced-command
   deploy key.
3. The release notes go up on GitHub with the tag's section of `CHANGELOG.md`.

A merge to main deploys staging.

## What the release checks

`release.sh` takes an online copy of the store, builds the tag's image, recreates the service and
checks, in order:

1. `/healthz`;
2. a token from Accounts with the service's own credential, for SuperPipeline;
3. the hub, at `AGENTPOD_URL`;
4. the loop's first sweep, in the log: `loop: first sweep, <n> boards opted in, <n> unread`.

Those checks are the release's smoke test: the service has no public address. If the release
fails one, the release that ran before is put back, with the store's copy when the new build had
moved the schema, because a build refuses a database written by a newer one.

## On the host

As root:

```sh
bash /opt/superdispatch/deploy/production/smoke.sh v0.0.1      # the checks again, changing nothing
bash /opt/superdispatch/deploy/production/rollback.sh v0.0.2   # put back the release before v0.0.2
cd /opt/superdispatch && SUPERDISPATCH_TAG=$(cat /etc/superdispatch/deployed) \
  docker compose -f deploy/production/compose.yml logs --tail 20 dispatch
```

| What           | Where                                                                                   |
| -------------- | --------------------------------------------------------------------------------------- |
| Settings       | `/etc/superdispatch/superdispatch.env`, written by the host's provisioning              |
| Store          | `/var/lib/superdispatch` on the host, mounted at `/data`                                |
| Listens        | `127.0.0.1:8798` on the host (8796 in the container): the operator API                  |
| Relay delivery | on the event relay's network: deploy the relay first                                    |
| The hub        | through the host gateway, as the relay reaches it                                       |
| Deployed tag   | `/etc/superdispatch/deployed`; the one before it, `/etc/superdispatch/previous`          |

## What a deploy does not change

A deploy opts no board in. The settings that widen what SuperDispatch does are written once by the
provisioning at their defaults, `SUPERDISPATCH_CANDIDATES=roster`, `SUPERDISPATCH_POLICY=off` and
`SUPERDISPATCH_LEARNED=off`, and are the operator's to change in `superdispatch.env`. A change takes
at the next release, or at `docker compose ... up -d --force-recreate dispatch`. The start line
names all three:

```
superdispatch: listening on :8796, sweeping every 30s, candidates roster, policy off, learned routing off
```
