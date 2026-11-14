---
title: Roster suggestions
description: How SuperDispatch flags lanes that rest on one agent, and what it suggests a person change. Advice only - it never edits a roster.
---

A board where each capability has one agent stalls when that agent does. After each sweep,
SuperDispatch reads its own recent decisions and flags the **lanes** (a board's stage and the
capability it asks for) that rest on too few working agents. Each flag is a **suggestion** for a
person. It turns a repeated placement symptom into something you can inspect and choose to act on.

**It never edits a roster.** A person makes the change, in AgentPod. The computation reads and
writes SuperDispatch's own store and nothing else: no client it holds of another product has a
roster write, a test calls every method of every client and checks each request, and another fails
if the computation touches a client at all.

## When a lane is flagged

It reads the decisions of the last `SUPERDISPATCH_SUGGEST_WINDOW_HOURS` (24) on the opted-in
boards, after each sweep or at most every `SUPERDISPATCH_SUGGEST_EVERY_SECONDS` (0: every sweep).

| Rule            | When                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `one-candidate` | the lane's latest decision found exactly one agent on the board's roster with the capability                              |
| `unreliable`    | in three or more decisions, every agent on the roster with the capability was `unhealthy` or a `recently-no-show`         |
| `stalled`       | a card waited at the stage, on one attempt, with nobody eligible (`none-eligible`) for `SUPERDISPATCH_STALL_MINUTES` (30) |

## What it suggests

A flagged lane is one suggestion, of one of two kinds:

- **`add-agent-to-board`**: the workspace has agents with the capability that are not on the
  board's roster. They are the suggestion's `candidates`. SuperPipeline's eligibility read judges
  every agent of the workspace, and each decision records whether an agent off the roster has the
  capability (`capable`), so the decisions alone say who could be added.
- **`lane-single-point`**: nobody else in the workspace has the capability, so somebody must set
  up another agent for it.

## What one reads

```
{ id, kind, boardId, stageKey, capability: { all, any } | null, rostered: [agentId],
  candidates: [{ agentId, principalId, stationId }], reasons: [rule], reason,
  evidence: [decision id], evidenceCount, firstSeenAt, lastSeenAt, resolvedAt, dismissedAt }
```

`reasons` are the rules that flagged it, `evidence` the decisions that bear it out.

## Its life

- There is **one suggestion per kind, board and stage**.
- A computation that **no longer finds it resolves it** (`resolvedAt`).
- The operator can **dismiss** it (`POST /v1/suggestions/:id/dismiss`). It stays dismissed while it
  is found again.
- One that resolved and **comes back later opens anew**.

That lifecycle keeps a suggestion useful: it can clear itself when the evidence clears, stay quiet
after dismissal, and return if the problem genuinely returns.

```sh
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/suggestions?board=brd_…&state=open"
curl -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/suggestions/sug_…/dismiss
```

## Not in chat yet

Suggestions are read on the [operator API](/run/operator-api/). Nothing posts them to a board's
room yet.

For now, plan to read them from the API; there is no chat notification to catch a missed lane for
you.
