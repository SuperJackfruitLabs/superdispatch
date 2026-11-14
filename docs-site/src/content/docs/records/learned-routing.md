---
title: Learned routing
description: The dataset of settled decisions, the model trained on it, and the shadow mode and gate it must pass before it places a card. Off by default.
---

Learned routing is off by default, and **it needs data first.** Every settled decision is a labelled example: the
candidates, what each filter said, the score terms, the tier and what became of the card. That log,
more than any formula fitted to it, is the asset, and it only grows as boards are placed. A model
fitted on a few dozen decisions is noise. We keep the model behind a shadow period and an explicit
gate so you can measure it before it gets a vote.

## The dataset

`GET /v1/dataset?since=&format=jsonl|json` (schema 1): one row per settled decision and candidate,
oldest first, at most 100,000 decisions a read.

```sh
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/dataset?since=2026-11-01" > dataset.jsonl
```

A row carries:

- the decision: `decisionId`, `boardId`, `cardId`, `stageKey`, `capability`, `policy`, `tier`,
  `tierStep`, `createdAt`, `hour` (UTC), `outcome`, `outcomeBy`, `outcomeAt`;
- the candidate: `agentId`, `source`, `chosen`, `eligible`, `filters` as
  `{ filter: true | reason }`, `score`, `stageHistory`;
- how busy the pool was: `pool: { candidates, inSet, eligible, busy }`;
- its `label`, its `target`, and the model's inputs (`features`, null when it was not eligible).

| Label                  | When                                                                       | Target |
| ---------------------- | -------------------------------------------------------------------------- | ------ |
| `won-claimed`          | chosen, and it claimed the card                                            | 1      |
| `won-expired`          | chosen, and its hold lapsed unclaimed                                      | 0      |
| `won-claimed-by-other` | chosen, and somebody else claimed the card                                 | 0      |
| `lost-claimed`         | not chosen (or nobody was, in the any-match tier), and it claimed the card | 1      |
| `lost`                 | not chosen, and did not claim it                                           | null   |
| `void`                 | a person moved the card, or the hold was refused: no signal about anyone   | null   |

A `lost` candidate was never offered the card, so it says nothing about whether it would have
taken it: it is kept, and not trained on. Only eligible candidates are trained on. The target is the
claim: whether the claimed run then succeeded is SuperWitness's to say, and is not joined yet.

That last gap matters: this dataset learns willingness to claim, not whether the work ultimately
went well.

## The model

`POST /v1/models/train`, body `{ since?, seed? }`: logistic regression over 12 features (stage
record, whether it weighed, stage runs, board success rate, recency, never dispatched, direct, tier
step, hour of day as sine and cosine, eligible candidates, pool busy), standardised, fitted by
full-batch gradient descent from zero weights in plain TypeScript, with no dependency.

- The holdout is a hash of each decision's id with the seed (20%), so the same rows and seed give
  the same model.
- The answer carries the metrics: `count`, `trainCount`, `holdoutCount`, `positives`, holdout
  `auc`, `accuracy`, `logLoss`, a five-bin `calibration` table, and `trainAuc` beside the
  holdout's.
- Each model is stored as the next version (`GET /v1/models`, `GET /v1/models/:id`).
- Training only stores a model. It places nothing.

So training is safe to repeat while you inspect the metrics; it changes no live placement.

```sh
curl -X POST -H "authorization: Bearer $TOKEN" -d '{"seed":1}' http://127.0.0.1:8796/v1/models/train
```

## Shadow first

`SUPERDISPATCH_LEARNED`:

- **`off`** (the default): no model is read. Placement is the formula's alone.
- **`shadow`**: each placed decision also records what the latest model would have chosen and the
  probability it gave each eligible candidate. The formula's choice is what is recorded and held:
  the model never changes a decision.
- **`on`**: the model's choice is held only when the model passes the gate:
  - trained on at least `SUPERDISPATCH_LEARNED_MIN_ROWS` rows (500);
  - at least `SUPERDISPATCH_LEARNED_MIN_SHADOW` settled shadow decisions (100);
  - in them, it beat the formula by at least `SUPERDISPATCH_LEARNED_MARGIN_PCT` points (5).

  Such a decision is recorded under the policy `idle-stage-success-lru@3+learned:v<version>`.
  Short of the gate the formula places, as in shadow, and the log says which test failed. The gate
  is read again at most every minute.

## The shadow report

`GET /v1/models/:id/shadow-report` compares the two choices against what happened.

- Where they agree, both had the card's outcome.
- Where they disagree, only the formula's choice was held, so the model is credited only when its
  choice claimed the card anyway (after the hold lapsed, or in the any-match tier). Otherwise what
  it would have done is unknown and counts as a miss, so the model's rate is a lower bound.
- Only decisions in which the formula's choice had its chance (`claimed`, `claimed-by-other`,
  `expired`) count, and decisions the model placed itself are never its own evidence.

The report also says how the gate reads under the current settings.

The lower-bound treatment is intentionally cautious. It refuses to award the model a success that
the live system never gave it a fair chance to demonstrate.

```sh
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/models/mdl_…/shadow-report
```

Placement stays pure: the loop reads the model from the store and hands it to placement as data.

You can therefore compare the model, keep it in shadow, or turn it back off without changing the
placement engine's authority boundaries.
