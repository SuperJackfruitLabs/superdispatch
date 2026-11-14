---
title: What you need
description: The first page of the tutorial. What SuperDispatch needs from SuperPipeline, AgentPod and Accounts before it can place a card, where each product's docs start, and the opt-in command last.
---

Let's give SuperDispatch enough context to make a real choice. It holds no cards and runs no
agents, so before it can place anything, three things have to exist. We'll collect them here and
finish with the opt-in that makes the board visible to the scheduler.

If you only want to see what a placement looks like, you need none of this: the
[replay on the docs home](/) steps through a real recorded decision.

## A SuperPipeline board

A board with a stage that asks for a capability, such as `research`. SuperDispatch places the cards
that wait in that stage.

- Quick start: [Your first board](https://docs.superpipeline.dev/start/first-board/)
- Boards and stages: [Boards](https://docs.superpipeline.dev/use/boards/)
- Docs home: [docs.superpipeline.dev](https://docs.superpipeline.dev/)

With the board in place, you have a lane for SuperDispatch to watch and a capability to match.

## AgentPod agents on its roster

At least two agents on the board's roster with that capability. With one, there is nothing to
choose between: the card is recorded as `one-candidate` and left to pull.

- Quick start: [Your first node](https://docs.agentpod.dev/start/first-node/)
- Putting an agent on a board: [Register an agent](https://docs.superpipeline.dev/use/register-an-agent/)
  in SuperPipeline, and [Boards](https://docs.agentpod.dev/use/boards/) in AgentPod
- Docs home: [docs.agentpod.dev](https://docs.agentpod.dev/)

Now there is an actual choice to make: two or more agents can serve the lane, rather than one agent
being left to normal pull.

## An Accounts service credential

One service credential for SuperDispatch, minted in your workspace in Accounts, with the scopes
`cards:read`, `dispatch:read` and `dispatch:reserve`. SuperDispatch reads it from
`ORG_PLANE_SERVICE_CREDENTIAL`.

- What a service token is and how its scopes work:
  [Services](https://docs.superpipeline.dev/build/services/) in SuperPipeline's docs
- Every scope SuperDispatch asks for, and why: [Running it](/run/running-it/#what-it-needs-from-the-others)

That credential lets SuperDispatch read the facts and request a hold without giving it ownership of
the card or the roster.

## Then: start SuperDispatch and opt the board in

[Running it](/run/running-it/) starts the service with those three settings and an operator token.
The last step is the opt-in. Put your board id in place of `brd_…` and the operator token in
`$TOKEN`:

```sh
curl -X PUT -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…
```

The board is now opted in, so its ready cards can enter the placement loop. Nothing else is placed
until you opt its board in too. [Your first placement](/start/first-placement/) continues from here.
