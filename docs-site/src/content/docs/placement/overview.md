---
title: A placement, end to end
description: One pass over a board, from reading the cards to recording the decision, and the load shape every candidate is judged by.
---

SuperDispatch places cards on the boards the operator [opted in](/run/opting-a-board-in/). It
looks at every one of them on a sweep, every `SUPERDISPATCH_SWEEP_SECONDS` (30 by default), and
at one board as soon as the event relay delivers one of its events.

## One pass

1. **Settle what it held.** It reads each board from SuperPipeline and settles what became of each
   card it holds:

   | Outcome            | What happened                                                       |
   | ------------------ | ------------------------------------------------------------------- |
   | `claimed`          | the chosen agent claimed the card                                   |
   | `claimed-by-other` | somebody else claimed it: another agent, or one off the roster      |
   | `expired`          | the hold lapsed and the card still waits                            |
   | `superseded`       | a person moved or archived the card before anyone claimed it        |
   | `not-reserved`     | SuperPipeline refused the hold, so nothing was held (set at once)   |

   A winner that claims late, after its hold lapsed but before the next pass, is `claimed`, not a
   no-show.

2. **Queue the ready cards.** A card is ready when it waits in a capability lane and is not
   already held. Each board's cards are queued, and the boards are taken
   [fairly](/placement/holds-and-tiers/#fairness-across-boards): one card from each board a round,
   the longest-waiting card first within a round.

3. **Place each card.** For a card, SuperDispatch reads the board's roster from AgentPod and the
   card's eligibility from SuperPipeline (which judges every agent of the workspace), then:
   - [filters](/placement/filters/) every agent, each rejection with a reason code;
   - [scores](/placement/scoring/) the ones that passed every filter;
   - with two or more rostered candidates, chooses the best and asks SuperPipeline to
     [hold the card](/placement/holds-and-tiers/) for it for the tier's window. With one, there is
     no choice to make and pull already gives it the card (`one-candidate`).

4. **Record the decision**: the card, the policy, the tier and step, every candidate with each
   filter's result and the score that ranked it, the hold and, on a later pass, the outcome. See
   [Decision records](/records/decisions/).

After the sweep it computes [roster suggestions](/records/roster-suggestions/) and
[supply proposals](/records/supply-proposals/) from its own decisions.

## When nobody is chosen

A decision that chooses nobody says why:

| Reason             | When                                                                                   | Recorded |
| ------------------ | -------------------------------------------------------------------------------------- | -------- |
| `no-candidates`    | nobody was considered                                                                  | yes      |
| `one-candidate`    | fewer than two candidates are on the roster: no choice to make, pull decides           | yes      |
| `none-eligible`    | at the winner step, every candidate failed a filter                                    | yes      |
| `any-match`        | the tiers are spent, or a runner-up step has nobody left: nothing is held, pull decides | yes      |
| `waiting-on-holds` | nobody is eligible, but a free agent fails only because it holds another card          | no       |
| `waiting-on-load`  | nobody is eligible, but an agent fails only for its load: work in hand, or busy        | no       |

The two waiting reasons are not recorded. The card is looked at again on the next pass, so it is
held for the first agent to free up, rather than recorded as `none-eligible` and looked away from
while that agent pulls it unplaced.

A card whose last decision chose nobody, or whose hold was refused, is not decided again for five
minutes, so a card nobody can take is not recorded every sweep.

## The candidate set

`SUPERDISPATCH_CANDIDATES` says who is considered:

- **`roster`** (the default): the agents on AgentPod's roster for the board, an enabled bridge row
  each. An agent that claims with its own token is recorded as `not-on-roster` and keeps working
  by pull.
- **`all`**: those, and every agent of the workspace with no bridge row on the board, once
  SuperPipeline reports its load and health (`GET /v1/agents/load`, read once a pass). When that
  read fails, only the roster is placed that pass.

An agent with a disabled bridge row stays out either way: a person turned it off on this board.

## The load shape

The health and idle filters read one shape, whichever source gave it:

```
{ agentId, inFlight, capacity, healthy, lastSeenAt, source: "roster" | "direct" }
```

| Source   | `inFlight`                         | `capacity`          | `healthy`                                | `lastSeenAt`                    |
| -------- | ---------------------------------- | ------------------- | ---------------------------------------- | ------------------------------- |
| `roster` | 1 when the station is busy, else 0 | 1                   | the row is enabled and the bridge ready  | when the station last took work |
| `direct` | cards held over every board        | as reported, else 1 | heard from on a run within the last hour | its latest run heartbeat        |

Idle is `inFlight < capacity`. A direct agent never heard from is not healthy: nothing says it is
there, so it keeps pulling until it has run once. Every candidate record carries its `source`.

## The placement window

AgentPod's bridge claims a ready card within seconds, so a sweep alone would lose most cards to
pull. When the operator opts a board in, SuperDispatch sets the board's **placement window** on
SuperPipeline (`SUPERDISPATCH_PLACEMENT_WINDOW_SECONDS`, 10 by default; 0 on opt-out). Inside it:

- SuperPipeline holds a card that just became ready back from pull and relays `card.ready`;
- SuperDispatch places that card on delivery, alone, with the roster the sweep cached (AgentPod's
  roster read probes every station and takes seconds, longer than the window can spare);
- a hold made inside the window is claimable by its agent at once.

Any other event from a board makes SuperDispatch look at that board two seconds later. If
SuperDispatch is absent, the window simply ends and pull proceeds.
