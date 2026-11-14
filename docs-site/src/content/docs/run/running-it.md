---
title: Running it
description: How to start SuperDispatch, and what it needs from SuperPipeline, AgentPod, Accounts, SuperWitness and the event relay.
---

We'll start SuperDispatch as a plain Bun process, prove it is listening, and then map each
dependency to the exact read or write it needs. Its own state lives in SQLite; everything else is
reached through a product's public API.

## Start it

From the repository root, install the workspace and start the dispatch service with its required
URLs, credential, relay secret, operator-token hash and data directory. Then ask the health
endpoint whether it made it all the way up:

```sh
bun install
SUPERPIPELINE_URL=http://127.0.0.1:8787 \
ORG_PLANE_URL=http://127.0.0.1:8788 \
ORG_PLANE_SERVICE_CREDENTIAL=svc_…:… \
AGENTPOD_URL=http://127.0.0.1:3001 \
AGENTPOD_AUDIENCE=http://127.0.0.1:3001 \
TREATY_RELAY_DELIVERY_SECRET=… \
SUPERDISPATCH_OPERATOR_TOKEN_SHA256=$(printf '%s' "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1) \
SUPERDISPATCH_DATA_DIR=$PWD/.data \
bun apps/dispatch/src/main.ts
curl http://127.0.0.1:8796/healthz
```

`/healthz` answers `{ "ok": true, "service": "superdispatch" }`. That response is our first useful
payoff: the process has accepted its configuration and is listening. Its start line also names the
settings that widen what it does:

```
superdispatch: listening on :8796, sweeping every 30s, candidates roster, policy off, learned routing off
```

A missing or malformed setting stops it before it listens, naming the setting, never its value.
Every setting is on [Settings](/run/settings/).

You now have a live service and a health response. It still places nothing until a board is
[opted in](/run/opting-a-board-in/), which keeps startup pleasantly free of surprise scheduling.

## What it needs from the others

The process is alive; now let's trace the access that makes it useful. We will work outward one
product at a time, so every permission has an obvious reason to exist.

**Accounts.** Mint one service credential for SuperDispatch in the workspace
(`ORG_PLANE_SERVICE_CREDENTIAL`), with the scopes:

| Scope              | For                                                 |
| ------------------ | --------------------------------------------------- |
| `cards:read`       | the board read                                      |
| `dispatch:read`    | the eligibility read, and the agents' load with `all` |
| `dispatch:reserve` | the hold                                            |
| `policy:decide`    | only with `SUPERDISPATCH_POLICY=on`                 |

Its tokens are asked for SuperPipeline's URL, the hub's `ORG_PLANE_AUDIENCE` (`AGENTPOD_AUDIENCE`)
and, when it is set, SuperWitness's public URL.

With that credential in place, SuperDispatch can ask for narrowly scoped tokens instead of carrying
one sprawling key around. Sprawling keys are memorable, but not in the good way.

**SuperPipeline.** Make the following routes available to that credential:

- `GET /v1/boards/:id`: the board and its cards;
- `GET /v1/boards/:id/cards/:cardId/eligibility`: who could claim a card, and why not;
- `PUT /v1/boards/:id/cards/:cardId/reservation`: the hold. A SuperPipeline without it refuses each
  hold, and the decision is recorded as `not-reserved`;
- `PUT /v1/boards/:id/scheduling`: the board's placement window, set on opt-in and opt-out;
- with `SUPERDISPATCH_CANDIDATES=all`, `GET /v1/agents/load` (on `dispatch:read`). A SuperPipeline
  without it places the roster alone.

Those routes give SuperDispatch the board, the eligibility facts and the one temporary hold it is
allowed to request. The card itself still belongs to SuperPipeline.

**AgentPod.** Allow the service to read the board roster and, when placement requirements are in
use, the station catalog:

- `GET /api/bridge/boards/:boardId/roster`, which the hub answers for a service listed in its
  `ROSTER_READERS`;
- for stages that state a placement, `GET /api/catalog/stations`, for a service listed in its
  `CATALOG_READERS`. A hub without the catalog read leaves those placements unchecked.

Now the scheduler knows who is on the board and, when the catalog is available, which stations meet
the stage's requirements.

**SuperWitness** is optional. Make `GET /v1/runs` available to any token for its audience; it needs
no grant scope. Runs carry `stage_key` only from a SuperPipeline that reports it
(`SUPERWITNESS_REPORT_STAGE`). Without it, scoring leaves the stage record out.

When that history is present, scoring gains a stage record. When it is absent, the formula carries
on without pretending the missing history was evidence.

**The event relay** is optional. Configure a subscriber for `evt.*.superpipeline.>` delivering to
`/v1/relay/events`, signed with `TREATY_RELAY_DELIVERY_SECRET` ([how the relay delivers and
signs](https://treaty.superjackfruit.com/relay/#delivery-and-retries)). A [`card.ready`](https://treaty.superjackfruit.com/events/card-ready-v1/) places its card at
once, alone, with the board's cached roster; any other event looks at its board two seconds later.
Without the relay the sweep alone places cards, and most are lost to pull before it comes round.

With the relay, a ready card gets an immediate placement attempt. Without it, the service still
works, but the 30-second sweep is often too late to beat normal pull.

Once those reads are available, SuperDispatch has the cards, candidates, policy and history it can
actually use; an optional dependency that is absent degrades only the feature described above.

## What it writes

We have followed every read; now let's close the loop by naming every write.

Its own store, under `SUPERDISPATCH_DATA_DIR`: the boards opted in, the decisions, and the
suggestions. Outside it, two writes, both to SuperPipeline: the hold, and a board's placement
window. Nothing else, and nothing to AgentPod.

That is the complete write boundary. You can audit it without hunting through a thicket of side
effects.

## Without it

Finally, stop the service in your mental model and check the blast radius.

SuperDispatch never claims a card and never hands one to anybody. A hold it asks for lapses on its
own within its tier's window, and a card's ladder ends with pull. If it stops, every hold it made
lapses and every card is claimed by pull as before; SuperPipeline and AgentPod work the same with
it or without it.

So the safe failure mode is deliberately boring: the temporary hold ends, and pull carries on.
