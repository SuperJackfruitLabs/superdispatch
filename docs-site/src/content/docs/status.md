---
title: Status and limits
description: Where SuperDispatch stands. v0.0.1 places cards in production, and what it does not do yet.
---

SuperDispatch is early. These docs describe what the current source does, and this page says what
it does not.

## Where it stands

- **Placement is proven end to end on staging**: filtering, scoring, holds in tiers, fairness
  across boards and the placement window, with decisions settled against what became of each card.
- **v0.0.1 runs in production, placing cards on the boards the operator has opted in.** A deploy
  opts no board in by itself; each board is [opted in](/run/opting-a-board-in/) by the operator.
- **The settings that widen what it does are off**: the candidate set is the roster
  (`SUPERDISPATCH_CANDIDATES=roster`), the dispatch policy is not asked
  (`SUPERDISPATCH_POLICY=off`) and learned routing is off (`SUPERDISPATCH_LEARNED=off`).

## What it does not do yet

**The dispatch policy is not enforced on pull.** SuperPipeline does not check Accounts' dispatch
policy when an agent claims. With `SUPERDISPATCH_POLICY=on`, SuperDispatch will not hold a card
for an agent the policy refuses, but that agent can still claim the card by pull. Until
SuperPipeline enforces it, policy here is advice like the rest of SuperDispatch. See
[The dispatch policy](/placement/policy/).

**Decisions are not published as events.** The charter decision says every decision is published
through [Treaty's relay](https://treaty.superjackfruit.com/relay/), so SuperWitness can audit it and chat can show it. That needs a decision
event in [Treaty's catalogue](https://treaty.superjackfruit.com/events/) first. Until then, read decisions on the
[operator API](/run/operator-api/).

**Suggestions do not reach chat.** Roster suggestions and supply proposals are kept in
SuperDispatch's own store and read on the operator API (`GET /v1/suggestions`). Nothing posts them
to a board's room yet.

**Station filters need AgentPod's capability catalog.** A stage's `placement` (isolation, models,
tools, credentials) filters candidates only when AgentPod answers its capability registry
(`GET /api/catalog/stations`) for this service. A hub without the catalog read, or one that refuses
it, leaves those needs unchecked: the pass logs that and places as if none were stated. See
[Station filters](/placement/station-filters/).

**Learned routing needs data first.** The dataset, training and shadow mode exist, but a model
fitted on a few dozen decisions is noise. It is off by default and should run in shadow long
before it places anything. See [Learned routing](/records/learned-routing/).

**Cards carry no labels yet.** The dispatch policy is asked about an agent, a board stage, labels
and capabilities, but SuperPipeline cards have no labels, so none are sent.

**The stage record joins claims, not results.** A learned model's target is whether the agent
claimed the card. Whether the claimed run then succeeded is SuperWitness's to say, and is not
joined into the dataset yet. The [scoring formula](/placement/scoring/) does read finished runs
from SuperWitness, when it is set.

**The reservation window is not settled.** The charter left its length to be measured against real
claim latency. The defaults (60 seconds for the winner, 30 for each runner-up, a 10-second
placement window) are where it starts.
