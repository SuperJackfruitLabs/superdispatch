---
title: Candidates and filters
description: Every filter a candidate passes through, in order, and the reason code each one rejects with.
---

Every agent of the workspace goes through the filters for each card. A candidate that fails a
filter is recorded with that filter's **reason code** and is not scored. A candidate that passes
them all is [scored](/placement/scoring/).

An agent outside the [candidate set](/placement/overview/#the-candidate-set) goes through the first
filter only. Every other candidate goes through all of them, so its record says each thing that
was wrong, not just the first.

## The filters

In the order they run:

| Filter        | Rejects with         | Passes when                                                                                       |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `roster`      | `not-on-roster`      | the agent is in the candidate set: on AgentPod's roster for the board, or (with `all`) reporting its load |
| `capability`  | `capability-missing` | the agent has the capability the stage asks for (SuperPipeline's `capability_mismatch`)           |
| `grant`       | `grant-denied`       | the card's dispatch grant covers the agent (SuperPipeline's `grant_denied`)                       |
| `claimable`   | `not-claimable`      | SuperPipeline would let the agent claim the card, for every other reason it gives                 |
| `isolation`   | `isolation-too-weak` | the station is isolated at least as strongly as the stage asks                                    |
| `model`       | `model-mismatch`     | the station runs one of the models the stage asks for                                             |
| `tools`       | `tool-missing`       | the station has every tool the stage asks for                                                     |
| `credentials` | `credential-missing` | the station reaches every credential name the stage asks for                                      |
| `policy`      | `policy-denied`      | the workspace's dispatch policy lets the agent take this work                                     |
| `health`      | `unhealthy`          | the agent is healthy by its load: ready to take a card held for it                                |
| `capacity`    | `at-capacity`        | the agent is under its board's concurrency (SuperPipeline's `concurrency_reached`)                |
| `idle`        | `not-idle`           | the agent has less in hand than its capacity anywhere in the workspace                            |
| `held`        | `holding-another`    | the agent holds no other card now                                                                 |
| `noShow`      | `recently-no-show`   | the agent has not let two holds lapse unclaimed in the last 30 minutes                            |
| `passedOver`  | `passed-over`        | the agent's hold on this card has not already lapsed in the card's current ladder                 |

## What each one means

**`not-on-roster`.** At first SuperDispatch places only agents on AgentPod's roster for the board.
An agent that claims with its own token is recorded as outside the set and keeps working by pull,
as it did before. `SUPERDISPATCH_CANDIDATES=all` widens the set.

**`capability-missing`, `grant-denied`, `at-capacity`, `not-claimable`.** SuperPipeline's
eligibility read judges every agent of the workspace for the card and gives its reasons.
SuperDispatch names three of them with its own filters. Any other reason, including one a later
SuperPipeline release adds, and an "ineligible" with no reason at all, is `not-claimable`.

**The station filters** (`isolation-too-weak`, `model-mismatch`, `tool-missing`,
`credential-missing`) run only for a stage that states what a station needs. Each rejection
records what the station lacks. See [Station filters](/placement/station-filters/).

**`policy-denied`** runs only with `SUPERDISPATCH_POLICY=on`, and only narrows. See
[The dispatch policy](/placement/policy/).

**`unhealthy` and `not-idle`** read the [load shape](/placement/overview/#the-load-shape). For a
rostered agent, idle means no work in hand at all: capacity is 1. This is the workspace-wide cap
the charter asks for, so a hold is only ever made for an idle agent. SuperPipeline's per-board
concurrency (`at-capacity`) stays as it is.

**`holding-another`.** One live hold per agent. An agent claims one card at a time, so a second
hold could only lapse against it.

**`recently-no-show`.** Each hold that lapses unclaimed is a no-show for its agent. Two within 30
minutes, on any cards, shut the agent out of every tier until the older one ages out. On a card
open to any match it can still claim by pull.

**`passed-over`.** Once an agent's hold on a card lapses, the card's ladder moves on without it.
A new ladder starts when the card reaches another stage, comes back after a claim, or a person
moves it.

## Failing only for load

A candidate that fails only for its load (`at-capacity`, `not-idle`, `holding-another`, or
`unhealthy` while it has no room) will pass once its work in hand is done. When nobody is eligible
and such a candidate exists, the card waits for the next pass (`waiting-on-load` or
`waiting-on-holds`) and nothing is recorded. See
[When nobody is chosen](/placement/overview/#when-nobody-is-chosen).
