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
   - **filters** every agent of the workspace: in the **candidate set** (`not-on-roster`; an
     agent outside it keeps working by pull; see below), SuperPipeline's own verdict
     (`capability-missing`, `grant-denied`, `at-capacity`, and `not-claimable` for any other
     reason it gives), the workspace's **dispatch policy** in Accounts when it is on
     (`policy-denied`; see below), healthy by its load (`unhealthy`), room for work by its load (`not-idle`:
     less in hand than its capacity on every board, which for a rostered agent is no work in hand
     at all, the workspace-wide cap, so a hold is only ever made for an idle agent), not holding another card (`holding-another`:
     one live hold per agent, since an agent claims one card at a time and a second hold could
     only lapse against it), not a recent no-show (`recently-no-show`: two holds lapsed unclaimed
     in the last 30 minutes, on any cards), and not passed over (`passed-over`: its hold on this
     card already lapsed in the card's current ladder);
   - **scores** the rest: the agent's **record at this stage** (from SuperWitness, below), then
     its success rate on this board (holds it claimed, smoothed), then least recently used;
   - with two or more rostered candidates, **chooses** the best and asks SuperPipeline to hold
     the card for it for the tier's window; with one there is no choice, and pull already gives
     it the card (`one-candidate`). When the only free candidates hold other cards, or every
     candidate it could wait for fails only for its load (work in hand, its concurrency, a
     station not ready because it is busy), the card waits for a later pass and nothing is
     recorded, so it is held for the first agent to free up rather than looked away from for
     five minutes while that agent pulls it unplaced;
4. records the decision: the card, the policy, the tier and step, every candidate with each
   filter's result and the score that ranked it, the hold and, on a later pass, the outcome. A
   settled decision is a labelled example.

After each sweep it also computes **roster suggestions** from its own decisions: advice for a
person, never a change (see below).

Not yet: publishing each decision as an event through treaty's relay (it needs a decision event
in treaty's catalogue first), and publishing roster suggestions to chat (read them on the operator API until then).

### The candidate set

`SUPERDISPATCH_CANDIDATES` says who is considered:

- `roster` (the default): the agents on AgentPod's roster for the board, an enabled bridge row
  each. An agent that claims with its own token is recorded as `not-on-roster` and keeps working
  by pull. This is the first slice's rule, kept until the operator changes the setting.
- `all`: those, and every agent of the workspace with no bridge row on the board, once
  SuperPipeline reports its load and health (`GET /v1/agents/load`, read once a pass). An agent
  with a disabled bridge row stays out either way: a person turned it off on this board. When the
  read fails, only the roster is placed that pass.

### Station filters

A stage may say what a **station** needs to work it, in its `placement` (SuperPipeline):
`isolation` (the weakest acceptable, `host` < `container` < `sandbox`), `models` (any one),
`tools` and `credentials` (every one), in the ids of AgentPod's capability catalog (charter
2026-11-13: AgentPod owns the catalog and the registry; SuperDispatch reads it). For a card whose
stage states one, a pass reads AgentPod's registry once (`GET /api/catalog/stations`) and filters
each candidate's station:

| Filter        | Rejects with         | When                                                  |
| ------------- | -------------------- | ----------------------------------------------------- |
| `isolation`   | `isolation-too-weak` | the station is isolated less strongly than asked      |
| `model`       | `model-mismatch`     | the station's model is none of those asked for        |
| `tools`       | `tool-missing`       | the station lacks a catalog entry asked for           |
| `credentials` | `credential-missing` | the station reaches no credential of a name asked for |

Each rejection is recorded on its candidate with `missing`: what the station lacks, in the stage's
words. A candidate whose station the registry does not list has nothing, so it fails each stated
need. A fact counts only when its proof is at least `SUPERDISPATCH_MIN_PROOF` (`probed` >
`installed` > `declared`; every fact counts by default).

They are **off** for a stage that states nothing: no filter runs and nothing is recorded for them.
When the registry cannot be read (an AgentPod without it answers 404, or the read is refused), the
pass leaves the needs **unchecked**, says so in the log, and places as if none were stated.
`SUPERDISPATCH_STATION_FILTERS=off` never reads the registry.

### The load shape

Both sources give one shape, and the health and idle filters read only that:

```
{ agentId, inFlight, capacity, healthy, lastSeenAt, source: "roster" | "direct" }
```

| Source   | `inFlight`                         | `capacity`          | `healthy`                                | `lastSeenAt`                    |
| -------- | ---------------------------------- | ------------------- | ---------------------------------------- | ------------------------------- |
| `roster` | 1 when the station is busy, else 0 | 1                   | the row is enabled and the bridge ready  | when the station last took work |
| `direct` | cards held over every board        | as reported, else 1 | heard from on a run within the last hour | its latest run heartbeat        |

Idle is `inFlight < capacity`. A direct agent never heard from is not healthy: nothing says it is
there, so it keeps pulling until it has run once. Every candidate record carries its `source`, and
the least-recently-used term reads `lastSeenAt` for both.

### The dispatch policy

`SUPERDISPATCH_POLICY=on` asks Accounts' dispatch policy who may take each card
(`POST /api/policy/decide`, which needs the scope `policy:decide` on this service's credential).
`off`, the default, asks nothing, and the filter passes everyone. The policy only narrows: an agent
SuperPipeline already refuses on the card's grant is never asked about, and a policy never adds an
agent the grant leaves out. The design is the sketchbook idea `2026-11-13-dispatch-policy`.

- **One question per agent, board stage, labels and capabilities a pass**, at most. SuperPipeline
  cards carry no labels yet, so none are sent; the capabilities are the stage's `requires`.
- **The answer is the verdict**, recorded on the candidate (`policy: {allow, reasons,
policyVersion}`). A workspace with no policy answers `no-policy`, which allows.
- **Limits**: an allowed agent that already had `maxRuns` holds from SuperDispatch within the
  last `windowHours` is rejected (`limit:<id>`). It counts holds SuperDispatch made, so it limits
  what is steered to an agent, not what the agent pulls.
- **Accounts could not answer** (unreachable, a refusal, an answer that cannot be read): if the
  last answer said the workspace has no policy, the candidate passes. Otherwise, including a cold
  start, it is rejected (`policy-unread`). That fails closed, and costs only the advice: a card
  nobody is held for is still claimed by pull. An agent with no principal cannot be asked about,
  so it is treated the same way (`no-principal`).

A pull ignores the policy: SuperPipeline does not enforce it on claim yet. Until it does, policy
here is advice like the rest of SuperDispatch.

### History in the score

When `SUPERWITNESS_URL` is set, each pass reads SuperWitness's finished runs at each board stage it
places a card at, once per board stage (`GET /v1/runs?source=superpipeline&scope=<board>&stage_key=<stage>&status=succeeded&status=failed&since=<window>`,
up to 1000 runs), and joins them to candidates by the run's executor principal. A cancelled run
judged nothing and is not read. For each candidate:

- each run weighs `0.5 ^ (age / half-life)`;
- the **outcome rate** is the weighted share that succeeded, `(Σ w·succeeded + 1) / (Σ w + 2)`;
- the **verdict rate** is the weighted mean of the newest verdict's pass mark,
  `(Σ w·mark + 1) / (Σ w + 2)`: a `score` as it stands, a `decision` of pass, approve or accept
  as 1 and fail, reject or request_changes as 0; any other verdict is no mark;
- each rate is exactly one half below `SUPERDISPATCH_HISTORY_MIN_SAMPLE` runs (or marks), so a
  new agent is neither starved nor favoured;
- the **stage record** is the mean of the two rates, and ranks first.

Every candidate's history is recorded on the decision (`stageHistory`: runs, succeeded, verdicts,
passes, weight, both rates and the record). SuperWitness unset, refusing or unreachable never
blocks a placement: the record term is left out for everyone and the order is the board's own;
the decision's candidates carry `stageHistory: null`. The record weighs only when it was read for
every eligible candidate.

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

### Roster suggestions

A board where each capability has one agent stalls when that agent does. After each sweep (or at
most every `SUPERDISPATCH_SUGGEST_EVERY_SECONDS`), SuperDispatch reads its decisions of the last
`SUPERDISPATCH_SUGGEST_WINDOW_HOURS` on the opted-in boards and flags a lane (a board's stage and
the capability it asks for) when:

| Rule            | When                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `one-candidate` | the lane's latest decision found exactly one agent on the board's roster with the capability                              |
| `unreliable`    | in three or more decisions, every agent on the roster with the capability was `unhealthy` or a `recently-no-show`         |
| `stalled`       | a card waited at the stage, on one attempt, with nobody eligible (`none-eligible`) for `SUPERDISPATCH_STALL_MINUTES` (30) |

A flagged lane is one suggestion. It is `add-agent-to-board` when the workspace has agents with the
capability that are not on the board's roster (SuperPipeline's eligibility read judges every agent
of the workspace, and each decision records whether an agent off the roster has the capability),
and `lane-single-point` when it has none, so somebody must set up another agent for it. It reads:
`{ id, kind, boardId, stageKey, capability: { all, any } | null, rostered: [agentId], candidates:
[{ agentId, principalId, stationId }], reasons: [rule], reason, evidence: [decision id],
evidenceCount, firstSeenAt, lastSeenAt, resolvedAt, dismissedAt }`.

There is one suggestion per kind, board and stage. A computation that no longer finds it resolves
it; the operator can dismiss it, and it stays dismissed while it is found again. One that resolved
and comes back later opens anew.

**It never edits a roster.** A person makes the change, in AgentPod. The computation reads and
writes this service's own store and nothing else: no client of another product has a roster
write, a test calls every method of every client and checks each request, and another fails if
the computation touches a client at all.

## The rulings it implements

From the charter decision
[SuperDispatch owns the Scheduler plane](https://github.com/SuperJackfruitLabs/charter/blob/main/decisions/2026-11-12-superdispatch-owns-the-scheduler.md):

- **A reservation outranks priority.** The reserved agent gets its reserved card even when a
  higher-priority card with no reservation is waiting. SuperDispatch already weighed priority
  when it chose.
- **AgentPod-rostered agents only, at first.** Agents that claim with a token of their own are
  recorded as outside the candidate set, and keep working by pull. The later slice that widens
  the set, once those agents report load and health in a shared shape, is behind
  `SUPERDISPATCH_CANDIDATES=all`; `roster` stays the default.
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

| Setting                                | What it is                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SUPERPIPELINE_URL`                    | Where SuperPipeline's API answers: the ready cards and the eligibility read for each                          |
| `ORG_PLANE_URL`                        | Where the organization plane (Accounts) answers                                                               |
| `ORG_PLANE_SERVICE_CREDENTIAL`         | This service's credential there, `svc_<20 hex>:<secret>`                                                      |
| `AGENTPOD_URL`                         | Where AgentPod's API answers: the roster, and each agent's load and health                                    |
| `AGENTPOD_AUDIENCE`                    | The hub's `ORG_PLANE_AUDIENCE`, when it differs from `AGENTPOD_URL`; that URL when unset                      |
| `TREATY_RELAY_DELIVERY_SECRET`         | The secret the event relay signs its deliveries to this service with                                          |
| `SUPERDISPATCH_OPERATOR_TOKEN_SHA256`  | The SHA-256 (64 hex digits) of the operator's bearer token; the token itself is not kept                      |
| `SUPERDISPATCH_DATA_DIR`               | Where the store keeps its database; `/data` when unset; absolute                                              |
| `SUPERDISPATCH_SWEEP_SECONDS`          | Seconds between two sweeps of every opted-in board, 5 to 3600; 30 when unset                                  |
| `SUPERDISPATCH_RESERVATION_SECONDS`    | Seconds the winner tier holds a card, 10 to 300; 60 when unset                                                |
| `SUPERDISPATCH_RUNNER_UP_SECONDS`      | Seconds each runner-up hold lasts, 10 to 300; 30 when unset                                                   |
| `SUPERDISPATCH_TOP_K`                  | The most holds a card's ladder makes before any match, 1 to 10; 3 when unset                                  |
| `SUPERDISPATCH_FAIRNESS`               | `round-robin` (a card from each board in turn) or `board-order`; `round-robin` when unset                     |
| `SUPERDISPATCH_CANDIDATES`             | `roster` (the roster alone) or `all` (also agents with their own token that report load); `roster` when unset |
| `SUPERDISPATCH_STATION_FILTERS`        | `on` (a stage's placement filters on AgentPod's capability registry) or `off`; `on` when unset                |
| `SUPERDISPATCH_MIN_PROOF`              | The weakest registry proof that satisfies a need: `probed`, `installed` or `declared`; `declared` when unset  |
| `SUPERDISPATCH_POLICY`                 | `off` or `on` (ask Accounts' dispatch policy, which needs `policy:decide`); `off` when unset                  |
| `SUPERDISPATCH_SUGGEST_EVERY_SECONDS`  | The least time between two computations of the roster suggestions, 0 to 86400; 0 (every sweep) when unset     |
| `SUPERDISPATCH_SUGGEST_WINDOW_HOURS`   | Hours of decisions the roster suggestions read, 1 to 720; 24 when unset                                       |
| `SUPERDISPATCH_STALL_MINUTES`          | Minutes a card waits with nobody eligible before its lane is suggested for, 1 to 1440; 30 when unset          |
| `SUPERWITNESS_URL`                     | Where SuperWitness's API answers, for each stage's history; unset, the score leaves it out                    |
| `SUPERWITNESS_AUDIENCE`                | SuperWitness's public URL, when it differs from `SUPERWITNESS_URL`; that URL when unset                       |
| `SUPERDISPATCH_HISTORY_DAYS`           | Days of a stage's runs read, 1 to 365; 30 when unset                                                          |
| `SUPERDISPATCH_HISTORY_MIN_SAMPLE`     | The fewest runs (or verdicts) a stage rate is read from, 1 to 100; 3 when unset                               |
| `SUPERDISPATCH_HISTORY_HALF_LIFE_DAYS` | Days in which a run's weight halves, 1 to 365; 7 when unset                                                   |
| `PORT`                                 | Where it listens; 8796 when unset                                                                             |

A missing or malformed setting stops it before it listens, naming the setting, never its value.

What it needs of the others:

- **Accounts**: one service credential for this service, minted in the workspace, with the
  scopes `cards:read` (the board read), `dispatch:read` (the eligibility read) and
  `dispatch:reserve` (the hold). Its tokens are asked for SuperPipeline's URL, the hub's
  `ORG_PLANE_AUDIENCE` and, when it is set, SuperWitness's public URL.
- **SuperPipeline**: `GET /v1/boards/:id`, `GET /v1/boards/:id/cards/:cardId/eligibility` and
  `PUT /v1/boards/:id/cards/:cardId/reservation`. A SuperPipeline without the reservation verb
  refuses each hold, and the decision is recorded as `not-reserved`. With
  `SUPERDISPATCH_CANDIDATES=all`, also `GET /v1/agents/load` (on `dispatch:read`); a
  SuperPipeline without it places the roster alone.
- **AgentPod**: `GET /api/bridge/boards/:boardId/roster`, which the hub answers for a service
  listed in its `ROSTER_READERS`; and, for stages that state a placement,
  `GET /api/catalog/stations`, for a service listed in its `CATALOG_READERS`. A hub without the
  catalog read leaves placements unchecked.
- **SuperWitness** (optional): `GET /v1/runs`, which any token for its audience may read; no grant
  scope. Runs carry `stage_key` only from a SuperPipeline that reports it
  (`SUPERWITNESS_REPORT_STAGE`).
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
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/suggestions?board=brd_…&state=open"
curl -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/suggestions/sug_…/dismiss
```

A decision reads: `{ id, boardId, cardId, stageKey, policy, chosen, reason, tier: { name, step }
| null, requires: { all, any } | null, candidates: [{ candidate: { agentId, principalId, stationId
}, filters: [{ filter, passed, reason? }], score: { total, terms: { stageRecord?, successRate,
sinceLastDispatchS } } | null, capable?, stageHistory: { runs, succeeded, verdicts, passes, weight,
outcomeRate, verdictRate, stageRecord } | null }], reservation:
{ reservedUntil } | null, reservationRefused, outcome: { status, by, at } | null, createdAt }`.
`tier` is null on decisions made before tiers, and `requires` (the capability the stage asked
for) on those made before roster suggestions. `capable` is set only for an agent off the roster.

Suggestions: `GET /v1/suggestions?board=&state=` (`state` is `open`, the default, `dismissed`,
`resolved` or `all`), `GET /v1/suggestions/:id`, and `POST /v1/suggestions/:id/dismiss`.

## Nothing requires it

SuperDispatch never claims a card and never hands one to anybody. A hold it asks for lapses on
its own within its tier's window (300 seconds at most), and a card's ladder ends with pull. If it stops, every hold it made
lapses and every card is claimed by pull as before; SuperPipeline and AgentPod work the same
with it or without it.

## Layout

- `apps/dispatch/src/config.ts`: the settings.
- `apps/dispatch/src/store/`: SQLite (WAL) and its append-only migrations: the `decisions`
  table, the opted-in `boards`, and the roster `suggestions`.
- `apps/dispatch/src/sources/`: clients of SuperPipeline, AgentPod and Accounts.
- `apps/dispatch/src/placement/`: filter, score and decide, and the roster suggestions
  (`suggest.ts`), as pure functions over plain inputs.
- `apps/dispatch/src/loop/`: one pass over a board, and the sweep that runs it.
- `apps/dispatch/src/routes/`: the HTTP surface: the health check, the relay's deliveries, the
  operator API.
- `apps/dispatch/src/main.ts`: reads the settings, opens the store, starts the sweep, listens.
- `deploy/staging/`: the staging deploy, off until the host is ready.

An import goes down that list, never up, and placement does no I/O. A test holds both.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint and tests. The lint ratchet and the
architecture test are described in [docs/code-quality.md](docs/code-quality.md).

## Releases

A `vX.Y.Z` tag on main runs the suite's shared release workflow (`.github/workflows/release.yml`,
settings in `.github/release-config.json`, on the GitHub mirror only). It checks that forge CI
passed for the tag's commit, or runs `bun run check` at the tag when it cannot read that, and
publishes the release notes on GitHub with the tag's section of [`CHANGELOG.md`](CHANGELOG.md).
There is no production deploy yet. Only the operator pushes tags.

## Licence

[Apache-2.0](LICENSE)
