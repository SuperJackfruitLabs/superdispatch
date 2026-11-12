# SuperDispatch

The suite's scheduler. When a SuperPipeline card is ready, SuperDispatch decides which agent
should take it, and records why.

It reads cards from SuperPipeline, the roster and each agent's load and health from AgentPod,
and its own token from Accounts, all through their public APIs. It owns none of their data. For
each ready card it filters the candidates, scores the ones left and names a preferred agent;
SuperPipeline then holds the card for that agent for a short reservation. Each decision is
recorded with every candidate considered and the reason for each.

## Status

It places cards, with holds that relax in tiers and fairness across boards. On the boards the
operator opts in, every 30 seconds (and as soon as the event relay delivers one of a board's
events, for that board) it:

1. reads each board from SuperPipeline, and settles what became of each card it holds: `claimed`
   by the chosen agent, `claimed-by-other`, `expired` (the hold lapsed, the card still waits),
   or `superseded` (a person moved or archived it);
2. queues each board's ready cards (waiting, in a capability lane, not held), and places them
   **fairly across boards**: one card from each board a round, the card that has waited longest
   first within a round, so a busy board cannot take every free agent before a quiet board's
   card is looked at;
3. for each card, reads the roster from AgentPod and the card's eligibility from SuperPipeline,
   and places it at its **tier**:
   - **filters** every agent of the workspace: on the board's roster (`not-on-roster`; an agent
     off it keeps working by pull), SuperPipeline's own verdict (`capability-missing`,
     `grant-denied`, `at-capacity`, and `not-claimable` for any other reason it gives), a ready
     station (`unhealthy`), no work in hand on any board (`not-idle`: the workspace-wide cap, so
     a hold is only ever made for an idle agent), not holding another card (`holding-another`:
     one live hold per agent, since an agent claims one card at a time and a second hold could
     only lapse against it), not a recent no-show (`recently-no-show`: two holds lapsed unclaimed
     in the last 30 minutes, on any cards), and not passed over (`passed-over`: its hold on this
     card already lapsed in the card's current ladder);
   - **scores** the rest: the agent's success rate on this board (holds it claimed, smoothed),
     then least recently used;
   - with two or more rostered candidates, **chooses** the best and asks SuperPipeline to hold
     the card for it for the tier's window; with one there is no choice, and pull already gives
     it the card (`one-candidate`). When the only free candidates hold other cards, the card
     waits for a later pass and nothing is recorded;
4. records the decision: the card, the policy, the tier and step, every candidate with each
   filter's result and the score that ranked it, the hold and, on a later pass, the outcome. A
   settled decision is a labelled example.

Not yet: publishing each decision as an event through treaty's relay (it needs a decision event
in treaty's catalogue first), history from SuperWitness in the score, and roster suggestions.

### Tiers

SuperPipeline's hold names one agent, so the softer fallback is a ladder of holds the loop makes
for each card, one decision per step, each labelled with its tier and step:

| Step    | Tier        | Held for                                           | Window                                   |
| ------- | ----------- | -------------------------------------------------- | ---------------------------------------- |
| 1       | `winner`    | the best candidate                                 | `SUPERDISPATCH_RESERVATION_SECONDS` (60) |
| 2 to k  | `runner-up` | the best candidate whose hold has not lapsed on it | `SUPERDISPATCH_RUNNER_UP_SECONDS` (30)   |
| after k | `any-match` | nobody: pull decides, as without SuperDispatch     | until claimed or moved                   |

k is `SUPERDISPATCH_TOP_K` (3). The next step is taken on the first pass after a hold lapses, so
between two steps any matching agent may claim by pull. A runner-up step with nobody left to hold
for opens the card to any match at once; the winner step with nobody eligible is `none-eligible`
and is tried again in five minutes. A card open to any match is not held again until a new
ladder starts: when the card reaches another stage, comes back after a claim, or was moved by a
person. A winner that claims late, after its hold lapsed but before the next pass, is a claim,
not a no-show. Each lapse is a no-show for the agent, so an agent that lets two holds lapse
within 30 minutes, on any cards, is shut out of every tier until the older ages out; on an open
card it can still claim by pull.

## The rulings it implements

From the charter decision
[SuperDispatch owns the Scheduler plane](https://github.com/SuperJackfruitLabs/charter/blob/main/decisions/2026-11-12-superdispatch-owns-the-scheduler.md):

- **A reservation outranks priority.** The reserved agent gets its reserved card even when a
  higher-priority card with no reservation is waiting. SuperDispatch already weighed priority
  when it chose.
- **AgentPod-rostered agents only, at first.** Agents that claim with a token of their own are
  recorded as outside the candidate set, and keep working by pull.
- **The idle filter is the workspace-wide cap.** It reserves only for agents with no work in
  hand anywhere, and holds at most one card for an agent at a time. SuperPipeline's per-board
  concurrency stays as it is.
- **A hold relaxes in tiers.** The winner, then the runner-ups one at a time, then any match.
  Each step is its own decision, labelled with its tier.
- **A busy board does not starve a quiet one.** One sweep places a card from each board in turn,
  longest-waiting first, before any board takes a second free agent.
- **Every decision is a record**: the card, the chosen agent, every rejected candidate with its
  reason (`not-on-roster`, `capability-missing`, `grant-denied`, `unhealthy`, `at-capacity`,
  `not-idle`, and this service's own `not-claimable`, `holding-another`, `recently-no-show`,
  `passed-over`), and the score that ranked the rest.
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
AGENTPOD_AUDIENCE=http://127.0.0.1:3001 \
TREATY_RELAY_DELIVERY_SECRET=… \
SUPERDISPATCH_OPERATOR_TOKEN_SHA256=$(printf '%s' "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1) \
SUPERDISPATCH_DATA_DIR=$PWD/.data \
bun apps/dispatch/src/main.ts
curl http://127.0.0.1:8796/healthz
```

| Setting                               | What it is                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `SUPERPIPELINE_URL`                   | Where SuperPipeline's API answers: the ready cards and the eligibility read for each      |
| `ORG_PLANE_URL`                       | Where the organization plane (Accounts) answers                                           |
| `ORG_PLANE_SERVICE_CREDENTIAL`        | This service's credential there, `svc_<20 hex>:<secret>`                                  |
| `AGENTPOD_URL`                        | Where AgentPod's API answers: the roster, and each agent's load and health                |
| `AGENTPOD_AUDIENCE`                   | The hub's `ORG_PLANE_AUDIENCE`, when it differs from `AGENTPOD_URL`; that URL when unset  |
| `TREATY_RELAY_DELIVERY_SECRET`        | The secret the event relay signs its deliveries to this service with                      |
| `SUPERDISPATCH_OPERATOR_TOKEN_SHA256` | The SHA-256 (64 hex digits) of the operator's bearer token; the token itself is not kept  |
| `SUPERDISPATCH_DATA_DIR`              | Where the store keeps its database; `/data` when unset; absolute                          |
| `SUPERDISPATCH_SWEEP_SECONDS`         | Seconds between two sweeps of every opted-in board, 5 to 3600; 30 when unset              |
| `SUPERDISPATCH_RESERVATION_SECONDS`   | Seconds the winner tier holds a card, 10 to 300; 60 when unset                            |
| `SUPERDISPATCH_RUNNER_UP_SECONDS`     | Seconds each runner-up hold lasts, 10 to 300; 30 when unset                               |
| `SUPERDISPATCH_TOP_K`                 | The most holds a card's ladder makes before any match, 1 to 10; 3 when unset              |
| `SUPERDISPATCH_FAIRNESS`              | `round-robin` (a card from each board in turn) or `board-order`; `round-robin` when unset |
| `PORT`                                | Where it listens; 8796 when unset                                                         |

A missing or malformed setting stops it before it listens, naming the setting, never its value.

What it needs of the others:

- **Accounts**: one service credential for this service, minted in the workspace, with the
  scopes `cards:read` (the board read), `dispatch:read` (the eligibility read) and
  `dispatch:reserve` (the hold). Its tokens are asked for two audiences: SuperPipeline's URL and
  the hub's `ORG_PLANE_AUDIENCE`.
- **SuperPipeline**: `GET /v1/boards/:id`, `GET /v1/boards/:id/cards/:cardId/eligibility` and
  `PUT /v1/boards/:id/cards/:cardId/reservation`. A SuperPipeline without the reservation verb
  refuses each hold, and the decision is recorded as `not-reserved`.
- **AgentPod**: `GET /api/bridge/boards/:boardId/roster`, which the hub answers for a service
  listed in its `ROSTER_READERS`.
- **The event relay** (optional): a subscriber for `evt.*.superpipeline.>` delivering to
  `/v1/relay/events`, signed with `TREATY_RELAY_DELIVERY_SECRET`. Without it the sweep alone
  places cards.

## Operator API

Every call carries `Authorization: Bearer <operator token>`.

```sh
curl -X PUT    -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…   # opt in
curl -X DELETE -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…   # opt out
curl           -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/decisions?board=brd_…&card=card_…&limit=20"
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/decisions/pld_…
```

A decision reads: `{ id, boardId, cardId, stageKey, policy, chosen, reason, tier: { name, step }
| null, candidates: [{ candidate: { agentId, principalId, stationId }, filters: [{ filter, passed,
reason? }], score: { total, terms: { successRate, sinceLastDispatchS } } | null }], reservation:
{ reservedUntil } | null, reservationRefused, outcome: { status, by, at } | null, createdAt }`.
`tier` is null on decisions made before tiers.

## Nothing requires it

SuperDispatch never claims a card and never hands one to anybody. A hold it asks for lapses on
its own within its tier's window (300 seconds at most), and a card's ladder ends with pull. If it stops, every hold it made
lapses and every card is claimed by pull as before; SuperPipeline and AgentPod work the same
with it or without it.

## Layout

- `apps/dispatch/src/config.ts`: the settings.
- `apps/dispatch/src/store/`: SQLite (WAL) and its append-only migrations: the `decisions`
  table, and the opted-in `boards`.
- `apps/dispatch/src/sources/`: clients of SuperPipeline, AgentPod and Accounts.
- `apps/dispatch/src/placement/`: filter, score and decide, as pure functions over plain inputs.
- `apps/dispatch/src/loop/`: one pass over a board, and the sweep that runs it.
- `apps/dispatch/src/routes/`: the HTTP surface: the health check, the relay's deliveries, the
  operator API.
- `apps/dispatch/src/main.ts`: reads the settings, opens the store, starts the sweep, listens.
- `deploy/staging/`: the staging deploy, off until the host is ready.

An import goes down that list, never up, and placement does no I/O. A test holds both.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint and tests.

## Releases

A `vX.Y.Z` tag on main runs the suite's shared release workflow (`.github/workflows/release.yml`,
settings in `.github/release-config.json`, on the GitHub mirror only). It checks that forge CI
passed for the tag's commit, or runs `bun run check` at the tag when it cannot read that, and
publishes the release notes on GitHub with the tag's section of [`CHANGELOG.md`](CHANGELOG.md).
There is no production deploy yet. Only the operator pushes tags.

## Licence

[Apache-2.0](LICENSE)
