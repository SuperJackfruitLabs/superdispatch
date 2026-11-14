---
title: Opting a board in
description: How the operator chooses which boards SuperDispatch places cards on, what opting in changes, and how to opt out.
---

Let's turn placement on for one board—deliberately, and only for that board. SuperDispatch starts
with none opted in, and a production deploy does not choose one for you.

## Opt a board in

Set the board id in the URL and send the operator token in the bearer header, then make the opt-in
explicit:

```sh
curl -X PUT -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…
```

There is no body. The answer is the board:
`{ "board": { boardId, enabled, createdAt, updatedAt } }`. That `enabled` value is the first receipt
that you changed the intended board rather than merely sending an enthusiastic `PUT` into the void.

Opting in:

- adds the board to every sweep, and looks at it at once without waiting for the next one;
- sets the board's **placement window** on SuperPipeline (`PUT /v1/boards/:id/scheduling`, with
  `SUPERDISPATCH_PLACEMENT_WINDOW_SECONDS`, 10 by default), so a card that just became ready is held
  back from pull for that long and placed on delivery of its `card.ready`. See
  [The placement window](/placement/overview/#the-placement-window).

If SuperPipeline refuses the window, SuperDispatch tries again after five minutes, and the board is
still swept meanwhile.

The board is now in every sweep, its first look has already started, and its placement window is
being kept in step with the opt-in.

## Before you do

Before we watch the first placement, check the three dependencies that make the opt-in useful:

- The **roster** for the board in AgentPod is what is placed (with `SUPERDISPATCH_CANDIDATES=roster`,
  the default). A board with fewer than two rostered agents for a capability has no choice to make:
  its cards are recorded as `one-candidate` and left to pull, and the lane is flagged as a
  [roster suggestion](/records/roster-suggestions/).
- The hub must list SuperDispatch in its `ROSTER_READERS`, and SuperDispatch's credential must
  have `cards:read`, `dispatch:read` and `dispatch:reserve`. See
  [Running it](/run/running-it/#what-it-needs-from-the-others).
- For the placement window to help, the **[event relay](https://treaty.superjackfruit.com/relay/)** must deliver SuperPipeline's events to
  SuperDispatch. Without it, the sweep alone places cards and most are lost to pull first.

## Watch it work

Now ask for the latest decisions on the board. This is where the opt-in turns from configuration
into evidence:

```sh
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/decisions?board=brd_…&limit=20"
```

Each placed card has a [decision](/records/decisions/); each decision settles to an outcome on a
later pass. The service log has a line per decision and per settlement:

```
loop: brd_… card_… pld_… settled claimed by agt_…
```

You can now connect a card to its choice and, on a later pass, to what actually happened.

## Opt it out

When you want SuperDispatch to stop making new placements on this board, remove the opt-in:

```sh
curl -X DELETE -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…
```

The board's row stays, so it can be listed and enabled again with another `PUT`. Its decisions stay
readable, holds already made lapse on their own, and its placement window goes back to none.

Placement is off for this board; the evidence is still there when you need it.

## List the boards

If you only need to check the current state, use a read instead of changing anything:

```sh
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards          # every board, enabled or not
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…    # one board
```

That gives you the current opt-in state without changing it.
