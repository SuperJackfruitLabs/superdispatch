# SuperDispatch

The suite's scheduler. When a SuperPipeline card is ready, SuperDispatch decides which agent
should take it, and records why.

It reads cards from SuperPipeline, the roster and each agent's load and health from AgentPod,
and its own token from Accounts, all through their public APIs. It owns none of their data. For
each ready card it filters the candidates, scores the ones left and names a preferred agent;
SuperPipeline then holds the card for that agent for a short reservation. Each decision is
recorded with every candidate considered and the reason for each, and published as an event
through the suite's event relay.

## Status

A scaffold: the service starts, checks its settings, opens its store and answers a health check.
The placement types are in place, and `place()` does not choose an agent yet. The filters, the
score, the sources and the relay route come next.

## The rulings it implements

From the charter decision
[SuperDispatch owns the Scheduler plane](https://github.com/SuperJackfruitLabs/charter/blob/main/decisions/2026-11-12-superdispatch-owns-the-scheduler.md):

- **A reservation outranks priority.** The reserved agent gets its reserved card even when a
  higher-priority card with no reservation is waiting. SuperDispatch already weighed priority
  when it chose.
- **AgentPod-rostered agents only, at first.** Agents that claim with a token of their own are
  recorded as outside the candidate set, and keep working by pull.
- **The idle filter is the workspace-wide cap.** It reserves only for agents with no work in
  hand anywhere. SuperPipeline's per-board concurrency stays as it is.
- **Every decision is a record**: the card, the chosen agent, every rejected candidate with its
  reason (`not-on-roster`, `capability-missing`, `grant-denied`, `unhealthy`, `at-capacity`,
  `not-idle`), and the score that ranked the rest.
- **Roster suggestions are advice only.** It may propose a roster change later; a person makes
  it. It never edits a roster.
- **Nothing requires it.** SuperPipeline without SuperDispatch is the same board it is now, and
  AgentPod's roster works without it. When it is slow or absent, the cost is the reservation
  window, never the claim.

## Run it

```sh
bun install
SUPERPIPELINE_URL=http://127.0.0.1:8787 \
ORG_PLANE_URL=http://127.0.0.1:8788 \
ORG_PLANE_SERVICE_CREDENTIAL=svc_…:… \
AGENTPOD_URL=http://127.0.0.1:3001 \
TREATY_RELAY_DELIVERY_SECRET=… \
SUPERDISPATCH_OPERATOR_TOKEN_SHA256=$(printf '%s' "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1) \
SUPERDISPATCH_DATA_DIR=$PWD/.data \
bun apps/dispatch/src/main.ts
curl http://127.0.0.1:8796/healthz
```

| Setting                               | What it is                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `SUPERPIPELINE_URL`                   | Where SuperPipeline's API answers: the ready cards and the eligibility read for each     |
| `ORG_PLANE_URL`                       | Where the organization plane (Accounts) answers                                          |
| `ORG_PLANE_SERVICE_CREDENTIAL`        | This service's credential there, `svc_<20 hex>:<secret>`                                 |
| `AGENTPOD_URL`                        | Where AgentPod's API answers: the roster, and each agent's load and health               |
| `TREATY_RELAY_DELIVERY_SECRET`        | The secret the event relay signs its deliveries to this service with                     |
| `SUPERDISPATCH_OPERATOR_TOKEN_SHA256` | The SHA-256 (64 hex digits) of the operator's bearer token; the token itself is not kept |
| `SUPERDISPATCH_DATA_DIR`              | Where the store keeps its database; `/data` when unset; absolute                         |
| `PORT`                                | Where it listens; 8796 when unset                                                        |

A missing or malformed setting stops it before it listens, naming the setting, never its value.

## Layout

- `apps/dispatch/src/config.ts`: the settings.
- `apps/dispatch/src/store/`: SQLite (WAL) and its append-only migrations. Migration 1 is the
  `decisions` table.
- `apps/dispatch/src/sources/`: read-only clients of SuperPipeline, AgentPod and Accounts.
- `apps/dispatch/src/placement/`: filter, score, decide and record, as pure functions over
  plain inputs.
- `apps/dispatch/src/routes/`: the HTTP surface.
- `apps/dispatch/src/main.ts`: reads the settings, opens the store, listens.
- `deploy/staging/`: the staging deploy, off until the host is ready.

An import goes down that list, never up, and placement does no I/O. A test holds both.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint and tests.

## Licence

[Apache-2.0](LICENSE)
