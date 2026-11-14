---
title: Holds, tiers and fairness
description: How a hold works, how it relaxes from the winner to runner-ups to any match, and how one sweep shares free agents across boards.
---

## A hold

SuperDispatch never claims a card. It asks SuperPipeline to **hold** the card for one agent
(`PUT /v1/boards/:id/cards/:cardId/reservation`). SuperPipeline checks the hold when a claim is
made:

- the held agent may claim the card;
- any other agent's claim waits until the hold lapses;
- the hold lapses on its own, within its tier's window (300 seconds at most), and the card is open
  to any matching agent again.

That is the whole bargain: one agent gets a short head start, and the card never loses its path
back to ordinary pull.

A **reservation outranks priority**: the held agent gets its held card even when a higher-priority
card with no hold is waiting. SuperDispatch already weighed priority when it chose.

A SuperPipeline without the reservation verb refuses each hold. The decision is recorded with the
outcome `not-reserved`, and nothing else changes.

## Tiers

One hold may lapse, so the ladder relaxes the choice without pretending the first pick is forever.

SuperPipeline's hold names one agent, so SuperDispatch relaxes it as a **ladder** of holds, one
decision per step, each labelled with its tier and step:

| Step    | Tier        | Held for                                           | Window                                   |
| ------- | ----------- | -------------------------------------------------- | ---------------------------------------- |
| 1       | `winner`    | the best candidate                                 | `SUPERDISPATCH_RESERVATION_SECONDS` (60) |
| 2 to k  | `runner-up` | the best candidate whose hold has not lapsed on it | `SUPERDISPATCH_RUNNER_UP_SECONDS` (30)   |
| after k | `any-match` | nobody: pull decides, as without SuperDispatch     | until claimed or moved                   |

k is `SUPERDISPATCH_TOP_K` (3). With k = 1, the winner is held and then any match.

- **The next step is taken on the first pass after a hold lapses**, so between two steps any
  matching agent may claim by pull.
- **A runner-up step with nobody left to hold for** opens the card to any match at once.
- **The winner step with nobody eligible** is `none-eligible`, and the card is tried again in five
  minutes.
- **A card open to any match is not held again** until a new ladder starts: when the card reaches
  another stage, comes back after a claim, or a person moves it.
- **Each lapse is a no-show** for its agent. Two within 30 minutes, on any cards, shut the agent
  out of every tier until the older one ages out (`recently-no-show`); on an open card it can still
  claim by pull.
- **A winner that claims late**, after its hold lapsed but before the next pass, is a claim, not a
  no-show.

## Fairness across boards

A busy board does not starve a quiet one. `SUPERDISPATCH_FAIRNESS` says how one sweep orders every
board's ready cards:

- **`round-robin`** (the default): one card from each board a round, and within a round the card
  that has waited longest goes first. A busy board and a quiet one get a card each in the first
  round, and the busy board takes the free agents left after that.
- **`board-order`**: every card of one board before the next: no fairness.

## The placement window

A sweep every 30 seconds would lose most cards to AgentPod's bridge, which claims a ready card
within seconds. The [placement window](/placement/overview/#the-placement-window) closes that gap:
SuperPipeline holds a newly ready card back from pull for a few seconds and tells SuperDispatch,
which places it at once.

## The cost

The charter names it: another idle agent may wait up to the window before it can take a held
card. A slow or absent SuperDispatch costs only that window, never the claim. If SuperDispatch
stops, every hold it made lapses and every card is claimed by pull as before.

You get ordered opportunities rather than a permanent assignment, with the fallback visible at
every step.
