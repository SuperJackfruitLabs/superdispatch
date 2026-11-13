---
title: Supply proposals
description: What SuperDispatch proposes when a lane goes unplaced for want of agents or stations - a model, a station, a move or more capacity. Advice only - it changes no station.
---

Placement can only choose among the agents and stations there are. When a lane goes unplaced for
want of supply, the same computation that makes [roster suggestions](/records/roster-suggestions/)
proposes what a person could change.

**It never changes a station.** Each proposal names the verb a person would use (`howToApply`), in
AgentPod or in SuperPipeline. SuperDispatch calls none of them and files no request for one: every
one of those verbs is a person's. A test calls every method of every client and fails on any
request to such a path, or on any write but the reservation.

## What it reads

The same decisions: each rejected candidate records which filter turned it away, and a
[station filter](/placement/station-filters/) what the station lacked. And AgentPod's capability
registry, as it last answered.

A lane gets proposals only **while its latest decision chose nobody**, and each kind needs **at
least two decisions** in the window that bear it out. A **blocked** decision is one in which nobody
was eligible: `none-eligible`, or `one-candidate` (a lane with one agent on the roster is left to
pull, but its filters still ran).

## The kinds

| Kind             | When                                                                                                                                                                                 | Target                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `change-model`   | in blocked decisions, an agent on the roster was turned away only by `model-mismatch`                                                                                                | the agent, its station, the first model the stage asks for     |
| `move-to-host`   | in blocked decisions, an agent on the roster was turned away only by station filters, and another station in the registry has all of what the lane's stations lacked (an empty station first) | that station, its occupant, runtime, harness, isolation, model |
| `add-station`    | the same shortfall with no station in the registry that has it (or no registry read), or no agent on the roster has the capability and no agent in the workspace does                | the isolation, models, tools, credentials or capability needed |
| `raise-capacity` | in decisions that chose nobody, every agent on the roster with the capability was turned away for its load alone, at least one by `at-capacity`                                      | none: the board's agent concurrency in SuperPipeline           |

AgentPod's registry names no host, so `move-to-host` names the station that has what is needed,
and the runtime its node was provisioned on.

When the registry says one of the lane's own stations has what it lacked by now, nothing is
proposed: the next decision will say. A registry fact counts only at `SUPERDISPATCH_MIN_PROOF` or
stronger.

## How each would be applied

| Kind             | What a person does                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `add-station`    | sets up a station in AgentPod (a runtime, then station setup) with what the target names, and adds its agent to the board's roster |
| `change-model`   | declares the model for the station in AgentPod's declared harness configuration                                       |
| `move-to-host`   | puts the lane's agent in the target station in AgentPod, or adds the target station's agent to the board's roster    |
| `raise-capacity` | raises the board's agent concurrency in SuperPipeline                                                                 |

## What one reads

A proposal is a row in the same table as the roster suggestions, with its own kind:

```
{ id, kind, boardId, stageKey, rationale, target, estimatedEffect: { cards, agents, summary },
  howToApply, registry: "read" | "unread", evidence, evidenceCount,
  firstSeenAt, lastSeenAt, resolvedAt, dismissedAt }
```

Roster suggestions and supply proposals are synced in one step, so neither resolves the other.
List one kind with `GET /v1/suggestions?kind=change-model`.

## Why not file the change

A hand-off would need a new AgentPod verb first: a supply-request queue that a named service may
file into under an allowlist, that a workspace admin approves or declines in the console, and whose
approval runs the existing verb as that person, with an audit row. AgentPod has no such queue, so
a proposal is something a person reads.
