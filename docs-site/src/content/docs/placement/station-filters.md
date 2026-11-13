---
title: Station filters
description: How a stage's placement (isolation, models, tools, credentials) filters candidates against AgentPod's capability registry.
---

A SuperPipeline stage may say what a **station** needs to work it, in its `placement`. SuperDispatch
checks each candidate's station against AgentPod's capability registry. AgentPod owns the catalog
and the registry (charter decision of 2026-11-13); SuperDispatch only reads it.

## What a stage can ask for

| Need          | Asks for                                                    | Rejects with         |
| ------------- | ----------------------------------------------------------- | -------------------- |
| `isolation`   | the weakest acceptable: `host` < `container` < `sandbox`    | `isolation-too-weak` |
| `models`      | any one of these models                                     | `model-mismatch`     |
| `tools`       | every one of these, in the ids of AgentPod's catalog        | `tool-missing`       |
| `credentials` | every one of these credential names                         | `credential-missing` |

Each rejection is recorded on its candidate with `missing`: what the station lacks, in the stage's
words. A candidate whose station the registry does not list, or a candidate with no station, has
nothing, so it fails each stated need.

## How strong a fact must be

Each fact in the registry carries a proof: `probed` (strongest), `installed` or `declared`. A fact
counts only when its proof is at least `SUPERDISPATCH_MIN_PROOF`. The default, `declared`, counts
every fact. With `installed`, a tool someone merely declared does not satisfy a need.

## When they run

- **Off for a stage that states nothing.** No filter runs and nothing is recorded for them: such a
  stage is placed exactly as it was before station filters existed.
- **On for a stage that states a placement.** A pass reads AgentPod's registry once
  (`GET /api/catalog/stations`) and filters each candidate's station.
- **Unchecked when the registry cannot be read.** An AgentPod without the registry answers 404, or
  the read is refused: the pass leaves the needs unchecked, says so in the log, and places as if
  none were stated.
- **Never, with `SUPERDISPATCH_STATION_FILTERS=off`.** The registry is not read at all.

The hub answers the registry only to a service listed in its `CATALOG_READERS`. See
[Running it](/run/running-it/#what-it-needs-from-the-others).

## What it leads to

When a lane goes unplaced because no station has what its stage asks for, the same records feed
[supply proposals](/records/supply-proposals/): change a station's model, move the work to a station
that has what is missing, or set up a new one. SuperDispatch changes no station.
