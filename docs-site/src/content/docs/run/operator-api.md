---
title: Operator API
description: Every route of SuperDispatch's HTTP API - boards, decisions, suggestions, the dataset and models - and how it is authenticated.
---

SuperDispatch's HTTP API is deliberately small and operator-only. You use it to choose boards,
inspect decisions and work with suggestions or learned-routing records. It listens on `PORT`
(8796); in production it has no public address.

## Authentication

Every call but `/healthz` and the relay's deliveries carries
`Authorization: Bearer <token>`. The token's SHA-256 must equal
`SUPERDISPATCH_OPERATOR_TOKEN_SHA256`; the service is never given the token itself. The check is
constant-time and comes before anything is read, and a refusal is `401` and says nothing else.

```sh
SUPERDISPATCH_OPERATOR_TOKEN_SHA256=$(printf '%s' "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1)
```

## Routes

This is the whole surface. The table stays literal so you can scan it without translating prose.

| Method   | Path                              | What it does                                                                      |
| -------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `GET`    | `/healthz`                        | `{ ok: true, service: "superdispatch" }`; no token                               |
| `POST`   | `/v1/relay/events`                | the event relay's deliveries, signed with `TREATY_RELAY_DELIVERY_SECRET`; no token |
| `GET`    | `/v1/boards`                      | every board opted in, enabled or not                                              |
| `PUT`    | `/v1/boards/:boardId`             | opt a board in, or enable it again; no body                                       |
| `DELETE` | `/v1/boards/:boardId`             | opt it out                                                                        |
| `GET`    | `/v1/boards/:boardId`             | one board                                                                         |
| `GET`    | `/v1/decisions`                   | decisions, newest first: `board`, `card`, `before`, `limit` (1 to 200, 50)        |
| `GET`    | `/v1/decisions/:id`               | one decision (`pld_…`)                                                            |
| `GET`    | `/v1/suggestions`                 | suggestions and proposals: `board`, `kind`, `state`                               |
| `GET`    | `/v1/suggestions/:id`             | one (`sug_…`)                                                                     |
| `POST`   | `/v1/suggestions/:id/dismiss`     | dismiss it                                                                        |
| `GET`    | `/v1/dataset`                     | the labelled rows: `since`, `format` (`jsonl`, the default, or `json`)            |
| `POST`   | `/v1/models/train`                | train and store a model: body `{ since?, seed? }`                                 |
| `GET`    | `/v1/models`                      | every stored model                                                                |
| `GET`    | `/v1/models/:id`                  | one model, with its metrics                                                       |
| `GET`    | `/v1/models/:id/shadow-report`    | the model against the formula, in shadow                                          |

`kind` is any roster kind (`add-agent-to-board`, `lane-single-point`) or supply kind
(`add-station`, `change-model`, `move-to-host`, `raise-capacity`). `state` is `open` (the default:
not resolved, not dismissed), `dismissed`, `resolved` or `all`.

## What they answer

The routes return records rather than hiding the useful part behind a summary:

- A board: `{ boardId, enabled, createdAt, updatedAt }`. See
  [Opting a board in](/run/opting-a-board-in/).
- A decision: see [Decision records](/records/decisions/).
- A suggestion: see [Roster suggestions](/records/roster-suggestions/) and
  [Supply proposals](/records/supply-proposals/).
- The dataset and models: see [Learned routing](/records/learned-routing/).

## Examples

```sh
curl -X PUT    -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…   # opt in
curl -X DELETE -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards/brd_…   # opt out
curl           -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/boards
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/decisions?board=brd_…&card=card_…&limit=20"
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/decisions/pld_…
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/suggestions?board=brd_…&state=open"
curl -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/suggestions/sug_…/dismiss
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:8796/v1/dataset?since=2026-11-01" > dataset.jsonl
curl -X POST -H "authorization: Bearer $TOKEN" -d '{"seed":1}' http://127.0.0.1:8796/v1/models/train
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8796/v1/models/mdl_…/shadow-report
```

Those examples cover every route family; follow the linked record pages when you need the fields,
not just the endpoint.
