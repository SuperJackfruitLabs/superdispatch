# Combined review ledger — SuperDispatch voice exemplar

This is the single exemplar PR for docs voice pass step 1. It changes the tutorial plus this review record; theme 0.0.2, styling, components, quick starts, product code, CI, and generated reference docs are out of scope and untouched.

## Immutable revisions

- PR base: `26b8d9023184fd37d530de518d625e0fdca4fec9`
- Exemplar: `0e9a928ba8b9081e7bf1fed781347463e8053a5d`
- Exemplar path: `docs-site/src/content/docs/start/first-placement.mdx`
- Guide: `SuperJackfruitLabs/sketchbook@29690e4397467bcf92ea7ef7e88b4e89cffba88f`
- Guide path: `ideas/2026-11-14-docs-voice-guide-v1/README.md`
- Guide count: 1,003 words, excluding frontmatter and link definitions, counted with `\b[\w’'-]+\b`
- Full draft ledger artifact: https://app.superlibrary.dev/a/itm_c79d70101829478e
- Independent final verification: https://app.superlibrary.dev/a/itm_af355f00c2cc424e

## Eight-row rubric

| Row | Result | Evidence |
|---|---|---|
| Narrator and momentum | pass | Opening establishes “we”/“you”; direct address and narrative nudges continue through all six steps. |
| Step payoffs | pass | Each numbered step ends with a concrete result: live API, opted-in board/window, placeable card, explainable choice, settled outcome, then disabled board with retained history. No mechanical `Payoff:` labels remain. |
| Tutorial running gag | pass | Exactly one recurring premise, the broadcast booth: opening introduction, step-4 replay, final broadcast/headset payoff. |
| Candor | pass | Optional relay and possible 30-second wait are stated before action; recovery covers connection failure, `401`, malformed IDs, missing decisions, and `one-candidate`. |
| Exact and safety material | pass | Commands use `$TOKEN`/`$BOARD`; commands, JSON, literals, tables, warning, and recovery contain no humour. |
| Vocabulary and privacy | pass | Product names and authority boundaries are exact; no customer, credential, private-message, or real agent/team data appears. |
| Originality | pass | Original broadcast-booth narrative; no RedwoodJS reference wording is copied. |
| Claims | pass | Commands, routes, defaults, fields, enums, policy, and outcomes were checked against the recorded base and by the claims ratchet. |

## Step/payoff matrix

| Step | Action | Immediate result |
|---|---|---|
| 1 | `GET /healthz` | Confirms the operator API is listening on the default port. |
| 2 | `PUT /v1/boards/$BOARD` | Enables the board, triggers a look, and sets the placement window. |
| 3 | Make a card ready | Supplies placement input for filtering, ranking, and a hold request. |
| 4 | Query decisions | Makes the choice traceable through filters and score terms. |
| 5 | Query the outcome | Distinguishes claim, other claimant, expiry, movement, and refusal. |
| 6 | `DELETE /v1/boards/$BOARD` | Stops new placement while retaining readable decision history. |

## Running gag and humour audit

The only recurring premise is the broadcast booth: introduced in the opening, recalled as a replay in step 4, and paid off once after step 6 when the broadcast ends and SuperDispatch removes the headset. Other jokes are one-offs in narrative prose. Commands, values, JSON, tables, warnings, and recovery are literal and humour-free.

## Claims checked at the PR base

| Claim | Base evidence |
|---|---|
| Default port `8796`; sweep `30s`; placement window `10s`; winner/runner-up holds `60s`/`30s` | `apps/dispatch/src/config.ts` |
| `GET /healthz`; response body | `apps/dispatch/src/routes/index.ts`; route tests |
| Bearer auth and `401`; board ID validation | `apps/dispatch/src/routes/operator.ts`; `apps/dispatch/src/routes/body.ts` |
| Board `PUT`/`DELETE`, response fields, immediate look | `apps/dispatch/src/routes/operator.ts`; store and window tests |
| `card.ready` immediate placement; relay optional | `apps/dispatch/src/loop/runner.ts`; window tests |
| At least two candidates; `one-candidate` | `apps/dispatch/src/placement/index.ts`; placement tests |
| Decision query, newest-first ordering, fields, limits | `apps/dispatch/src/routes/operator.ts`; `apps/dispatch/src/store/index.ts` |
| `idle-stage-success-lru@3`, tiers, filters, scoring | `apps/dispatch/src/placement/index.ts`; placement tests |
| Five outcome statuses and meanings | `apps/dispatch/src/store/index.ts` |
| SuperDispatch advises/requests a hold; agents claim through SuperPipeline | `AGENTS.md`; `apps/dispatch/src/sources/superpipeline.ts`; loop tests |
| Opt-out leaves history and lets holds lapse | operator routes; store/window tests |

The independent verification item above records the detailed line-level matrix and source recheck.

## Real checks

- `bun run check`: pass — formatting, TypeScript, lint baseline, 333 tests passed, 0 failed.
- `npm run check:claims --prefix docs-site`: pass — 31 settings, 15 reason codes, 6 no-decision reasons, 5 outcomes, 6 kinds match code.
- `npm run build --prefix docs-site`: pass — 21 pages, including `/start/first-placement/`; Pagefind and sitemap complete.
- Structural/rendered assertions: pass — six numbered steps and payoffs, four `$TOKEN` commands, zero `Payoff:` labels, and the single final gag payoff.
- `npm run check --prefix docs-site`: known pre-existing TS7016 for vendored `@superjackfruit/docs-theme/schema`; the tutorial leaves the relevant config and lockfile blobs unchanged.

## Claude review

Pending. Every finding and its resolution will be recorded here before publication.

## Rendered exemplar and operator gate

- Rendered exemplar URL: pending.
- Operator record: pending. It must say `approved for rollout` and bind the rendered URL, exemplar `0e9a928ba8b9081e7bf1fed781347463e8053a5d`, and guide `29690e4397467bcf92ea7ef7e88b4e89cffba88f`.

Do not merge or touch another product until that operator record exists.
