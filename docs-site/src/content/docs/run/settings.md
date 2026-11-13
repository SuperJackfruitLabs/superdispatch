---
title: Settings
description: Every environment variable SuperDispatch reads, with its range and its default.
---

SuperDispatch reads its settings from the environment once, at start. A missing or malformed
setting stops it before it listens, naming the setting, never its value. A docs build checks this
page against `apps/dispatch/src/config.ts`: every setting there is here, with its default.

## Required

| Setting                               | What it is                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `SUPERPIPELINE_URL`                   | Where SuperPipeline's API answers: the ready cards, and the eligibility read for each |
| `ORG_PLANE_URL`                       | Where the organization plane (Accounts) answers                                     |
| `ORG_PLANE_SERVICE_CREDENTIAL`        | This service's credential there, `svc_<20 hex>:<secret>`                            |
| `AGENTPOD_URL`                        | Where AgentPod's API answers: the roster, and each agent's load and health          |
| `TREATY_RELAY_DELIVERY_SECRET`        | The secret the event relay signs its deliveries to this service with                |
| `SUPERDISPATCH_OPERATOR_TOKEN_SHA256` | The SHA-256 (64 hex digits) of the operator's bearer token; the token itself is not kept |

## Where it runs

| Setting                  | What it is                                                                   | Default         |
| ------------------------ | ---------------------------------------------------------------------------- | --------------- |
| `AGENTPOD_AUDIENCE`      | The hub's `ORG_PLANE_AUDIENCE`, when it differs from `AGENTPOD_URL`          | `AGENTPOD_URL`  |
| `SUPERDISPATCH_DATA_DIR` | Where the store keeps its database; absolute                                 | `/data`         |
| `PORT`                   | Where it listens                                                             | `8796`          |

## Placement

| Setting                                  | What it is                                                                                 | Range or values                 | Default       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------- | ------------- |
| `SUPERDISPATCH_SWEEP_SECONDS`            | Seconds between two sweeps of every opted-in board                                         | 5 to 3600                       | `30`          |
| `SUPERDISPATCH_RESERVATION_SECONDS`      | Seconds the winner tier holds a card                                                       | 10 to 300                       | `60`          |
| `SUPERDISPATCH_RUNNER_UP_SECONDS`        | Seconds each runner-up hold lasts                                                          | 10 to 300                       | `30`          |
| `SUPERDISPATCH_PLACEMENT_WINDOW_SECONDS` | The placement window set on each board opted in (0 sets none)                              | 0 to 30                         | `10`          |
| `SUPERDISPATCH_TOP_K`                    | The most holds a card's ladder makes before any match                                      | 1 to 10                         | `3`           |
| `SUPERDISPATCH_FAIRNESS`                 | How a sweep orders cards across boards                                                     | `round-robin`, `board-order`    | `round-robin` |
| `SUPERDISPATCH_CANDIDATES`               | Who is considered: the roster alone, or also agents with their own token that report load  | `roster`, `all`                 | `roster`      |
| `SUPERDISPATCH_STATION_FILTERS`          | Whether a stage's placement filters on AgentPod's capability registry                      | `on`, `off`                     | `on`          |
| `SUPERDISPATCH_MIN_PROOF`                | The weakest registry proof that satisfies a need                                           | `probed`, `installed`, `declared` | `declared`  |
| `SUPERDISPATCH_POLICY`                   | Whether to ask Accounts' dispatch policy (needs `policy:decide`)                           | `off`, `on`                     | `off`         |

## History

| Setting                                | What it is                                                         | Range     | Default           |
| -------------------------------------- | ------------------------------------------------------------------ | --------- | ----------------- |
| `SUPERWITNESS_URL`                     | Where SuperWitness's API answers, for each stage's history          | a URL     | unset: no history |
| `SUPERWITNESS_AUDIENCE`                | SuperWitness's public URL, when it differs from `SUPERWITNESS_URL`  | a URL     | `SUPERWITNESS_URL` |
| `SUPERDISPATCH_HISTORY_DAYS`           | Days of a stage's runs read                                         | 1 to 365  | `30`              |
| `SUPERDISPATCH_HISTORY_MIN_SAMPLE`     | The fewest runs (or verdicts) a stage rate is read from             | 1 to 100  | `3`               |
| `SUPERDISPATCH_HISTORY_HALF_LIFE_DAYS` | Days in which a run's weight halves                                 | 1 to 365  | `7`               |

## Suggestions

| Setting                               | What it is                                                                  | Range      | Default |
| ------------------------------------- | --------------------------------------------------------------------------- | ---------- | ------- |
| `SUPERDISPATCH_SUGGEST_EVERY_SECONDS` | The least time between two computations of the suggestions (0: every sweep) | 0 to 86400 | `0`     |
| `SUPERDISPATCH_SUGGEST_WINDOW_HOURS`  | Hours of decisions the suggestions read                                     | 1 to 720   | `24`    |
| `SUPERDISPATCH_STALL_MINUTES`         | Minutes a card waits with nobody eligible before its lane is suggested for  | 1 to 1440  | `30`    |

## Learned routing

| Setting                            | What it is                                                              | Range or values         | Default |
| ---------------------------------- | ----------------------------------------------------------------------- | ----------------------- | ------- |
| `SUPERDISPATCH_LEARNED`            | Off, shadow (record the model's choice, hold the formula's), or on behind the gate | `off`, `shadow`, `on` | `off` |
| `SUPERDISPATCH_LEARNED_MIN_ROWS`   | The fewest training rows a model needs to place                         | 1 to 10000000           | `500`   |
| `SUPERDISPATCH_LEARNED_MIN_SHADOW` | The fewest settled shadow decisions a model needs to place              | 1 to 1000000            | `100`   |
| `SUPERDISPATCH_LEARNED_MARGIN_PCT` | Points a model must beat the formula by in shadow to place              | 0 to 100                | `5`     |

## In production

The provisioning writes the three settings that widen what SuperDispatch does once, at their
defaults: `SUPERDISPATCH_CANDIDATES=roster`, `SUPERDISPATCH_POLICY=off` and
`SUPERDISPATCH_LEARNED=off`. They are the operator's to change. See [Production](/run/production/).
