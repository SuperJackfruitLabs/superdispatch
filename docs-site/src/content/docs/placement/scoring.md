---
title: Scoring
description: How the candidates that pass every filter are ranked - their record at this stage, their success on this board, then least recently used.
---

Every candidate that passes all the [filters](/placement/filters/) is scored. The ranking is a
fixed policy, recorded on each decision by name: `idle-stage-success-lru@3`.

## The order

Candidates are compared term by term; a later term only breaks a tie in the earlier ones.

1. **`stageRecord`**: the agent's record at this board stage, from SuperWitness. Higher first.
2. **`successRate`**: its success on this board, from SuperDispatch's own holds. Higher first.
3. **`sinceLastDispatchS`**: seconds since it last took work. Longer first: least recently used.
4. The agent id, so the order is always the same for the same facts.

The decision records each candidate's `score` as `{ total, terms }`. `total` is how many eligible
candidates it outranks plus one, so the best has the highest total and the record reads as a
ranking. `terms` holds the numbers above, so the record says what weighed.

## Success on this board

`successRate` is the share of SuperDispatch's settled holds for the agent on this board that it
claimed, smoothed: `(claimed + 1) / (settled + 2)`. A new agent starts at one half.

## Least recently used

`sinceLastDispatchS` reads `lastSeenAt` from the [load shape](/placement/overview/#the-load-shape):
when the station last took work, or a direct agent's latest run heartbeat. A station that never
took work ranks first among the least recently used.

## History at the stage

When `SUPERWITNESS_URL` is set, each pass reads SuperWitness's finished runs at each board stage it
places a card at, once per board stage:

```
GET /v1/runs?source=superpipeline&scope=<board>&stage_key=<stage>&status=succeeded&status=failed&since=<window>
```

up to 1000 runs from the last `SUPERDISPATCH_HISTORY_DAYS` (30). They are joined to candidates by
the run's executor principal. A cancelled run judged nothing and is not read. For each candidate:

- each run weighs `0.5 ^ (age / half-life)`, with a half-life of
  `SUPERDISPATCH_HISTORY_HALF_LIFE_DAYS` (7);
- the **outcome rate** is the weighted share that succeeded, `(Σ w·succeeded + 1) / (Σ w + 2)`;
- the **verdict rate** is the weighted mean of the newest verdict's pass mark,
  `(Σ w·mark + 1) / (Σ w + 2)`: a `score` as it stands, a `decision` of pass, approve or accept as
  1, and fail, reject or request_changes as 0; any other verdict is no mark;
- each rate is exactly one half below `SUPERDISPATCH_HISTORY_MIN_SAMPLE` runs or marks (3), so a
  new agent is neither starved nor favoured;
- the **stage record** is the mean of the two rates.

Every candidate's history is recorded on the decision as `stageHistory`: runs, succeeded,
verdicts, passes, weight, both rates and the record.

**History never blocks a placement.** SuperWitness unset, refusing or unreachable: the record term
is left out for everyone, the ranking falls back to the board terms, and the candidates carry
`stageHistory: null`. The record weighs only when it was read for every eligible candidate.

Runs carry `stage_key` only from a SuperPipeline that reports it (its `SUPERWITNESS_REPORT_STAGE`
setting).

## A learned model

Learned routing can, past a gate, hold a model's choice instead of the formula's. It is off by
default and records its choice beside the formula's in shadow first. See
[Learned routing](/records/learned-routing/).
