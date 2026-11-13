---
title: Decision records
description: What a placement decision records, every field of it, and how to read one to answer "why did this card go there?".
---

Every placement is a **decision**, kept in SuperDispatch's own store. A decision alone answers
"why did this card go there?": the card, the policy, the tier, every candidate with each filter's
result and the score that ranked it, the hold, and on a later pass what became of the card. A
settled decision is also a labelled example for [learned routing](/records/learned-routing/).

Decisions are read on the [operator API](/run/operator-api/):

```sh
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/decisions?board=brd_…&card=card_…&limit=20"
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/decisions/pld_…
```

The list is newest first. It takes `board`, `card` (with its board), `before` (a time) and `limit`
(1 to 200, 50 when unset).

## An example

The field names are real; the agents and numbers are made up.

```jsonc
{
  "id": "pld_3f9a0c1e7b2d4a6f8e0c1b2a",
  "boardId": "brd_review",
  "cardId": "card_1042",
  "stageKey": "review",
  "policy": "idle-stage-success-lru@3",
  "chosen": "agt_ada",
  "reason": null,
  "tier": { "name": "winner", "step": 1 },
  "requires": { "all": ["code-review"], "any": [] },
  "candidates": [
    {
      "candidate": { "agentId": "agt_ada", "principalId": "prn_ada", "stationId": "stn_1", "source": "roster" },
      "filters": [{ "filter": "roster", "passed": true }, { "filter": "capability", "passed": true } /* …the rest */],
      "score": { "total": 2, "terms": { "stageRecord": 0.81, "successRate": 0.75, "sinceLastDispatchS": 5400 } },
      "stageHistory": { "runs": 12, "succeeded": 10, "verdicts": 6, "passes": 5, "weight": 7.4, "outcomeRate": 0.82, "verdictRate": 0.79, "stageRecord": 0.81 }
    },
    {
      "candidate": { "agentId": "agt_cyd", "principalId": "prn_cyd", "stationId": "stn_3", "source": "roster" },
      "filters": [{ "filter": "roster", "passed": true }, /* … */ { "filter": "idle", "passed": false, "reason": "not-idle" } /* …the rest */],
      "score": null,
      "stageHistory": null
    },
    {
      "candidate": { "agentId": "agt_eli", "principalId": "prn_eli", "stationId": null, "source": "direct" },
      "filters": [{ "filter": "roster", "passed": false, "reason": "not-on-roster" }],
      "score": null,
      "capable": true,
      "stageHistory": null
    }
  ],
  "reservation": { "reservedUntil": "2026-11-13T10:04:12.000Z" },
  "reservationRefused": null,
  "outcome": { "status": "claimed", "by": "agt_ada", "at": "2026-11-13T10:03:31.000Z" },
  "createdAt": "2026-11-13T10:03:12.000Z"
}
```

## The fields

| Field                | What it is                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                 | `pld_` and 24 hex digits                                                                            |
| `boardId`, `cardId`  | the card, on its board                                                                              |
| `stageKey`           | the stage the card was at                                                                           |
| `policy`             | the ranking it was placed by: `idle-stage-success-lru@3`, or with `+learned:v<version>` when a model placed it |
| `chosen`             | the agent held for, or null                                                                         |
| `reason`             | why nobody was chosen, when nobody was ([the reasons](/placement/overview/#when-nobody-is-chosen))  |
| `tier`               | `{ name, step }`: `winner`, `runner-up` or `any-match`, and the ladder's step; null on decisions made before tiers |
| `requires`           | the capability the stage asked for, `{ all, any }`; null on decisions made before roster suggestions |
| `candidates`         | every agent considered, below                                                                       |
| `reservation`        | `{ reservedUntil }` when SuperPipeline held the card, else null                                    |
| `reservationRefused` | why SuperPipeline refused the hold, when it did                                                     |
| `outcome`            | `{ status, by, at }` once settled, else null                                                        |
| `createdAt`          | when it was decided                                                                                 |

Each candidate:

| Field          | What it is                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `candidate`    | `{ agentId, principalId, stationId, source }`: `source` is `roster` or `direct`                          |
| `filters`      | `[{ filter, passed, reason?, missing? }]`: every filter it went through; a rejection carries its reason code, and a station filter's what the station lacks |
| `score`        | `{ total, terms }` when it passed every filter, else null ([Scoring](/placement/scoring/))               |
| `capable`      | only for an agent off the roster: whether it has the stage's capability, by SuperPipeline's verdict      |
| `stageHistory` | its record at this stage from SuperWitness, or null when that was not read                               |
| `policy`       | `{ allow, reasons, policyVersion }`, when the dispatch policy was asked                                   |

## The outcome

| `status`           | What became of the card                                             |
| ------------------ | ------------------------------------------------------------------- |
| `claimed`          | the chosen agent claimed it                                         |
| `claimed-by-other` | somebody else claimed it: another agent, after the hold lapsed, or one off the roster |
| `expired`          | the hold lapsed and the card still waits                            |
| `superseded`       | the card left the stage or the board without a claim: a person moved or archived it |
| `not-reserved`     | SuperPipeline refused the hold, so nothing was held                 |

## Reading one

- **Why this agent?** Find the candidate with the highest `score.total`. Its `terms` say what
  weighed: its record at the stage, its success on the board, how long since it last took work.
- **Why not that agent?** Find its candidate. The first `passed: false` filter's `reason` says what
  turned it away, and every other failing filter is there too. A station filter's `missing` names
  what its station lacked.
- **Why nobody?** `chosen` is null and `reason` says why. `one-candidate` and `any-match` are not
  failures: pull decides those cards.
- **Did it work?** `outcome`. A run of `expired` outcomes for one agent is what shuts it out as a
  `recently-no-show`, and what the `unreliable` [roster suggestion](/records/roster-suggestions/)
  reads.
- **Several decisions for one card** are the steps of its ladder: filter the list by `card` and
  read `tier.step`.

## Not yet an event

The charter asks for each decision to be published through treaty's relay, so SuperWitness can
audit it and chat can show it. That needs a decision event in treaty's catalogue first. Until then
the operator API is the only way to read decisions.
