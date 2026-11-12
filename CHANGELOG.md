# Changelog

SuperDispatch has no production deploy yet: a release publishes its notes on GitHub.

## Unreleased

- Supply proposals: advice for a person when a lane goes unplaced for want of supply, kept with
  the roster suggestions and listed by kind (`GET /v1/suggestions?kind=`). `change-model` (an
  agent turned away only for its model), `move-to-host` (another station in AgentPod's registry
  has what the lane's stations lack), `add-station` (nobody has it) and `raise-capacity` (every
  capable agent at its board's concurrency). Each names its evidence, its target, its estimated
  effect and the verb a person would use. SuperDispatch changes no station and files no request.
- Learned routing, off by default. Every settled decision is now exported as labelled rows, one
  per candidate (`GET /v1/dataset`, schema 1: filter results, score terms, stage history, tier,
  board, stage, capability, hour, pool load, and a label from `won-claimed`, `won-expired`,
  `won-claimed-by-other`, `lost-claimed`, `lost`, `void`). `POST /v1/models/train` fits a small
  logistic regression on it (no dependency, deterministic) and stores it as a version with its
  holdout AUC, accuracy, log loss and calibration (`GET /v1/models`).
  `SUPERDISPATCH_LEARNED=shadow` records what the latest model would have chosen beside each
  decision without changing it, and `GET /v1/models/:id/shadow-report` compares the two against
  outcomes. `on` holds the model's choice only past a gate (`SUPERDISPATCH_LEARNED_MIN_ROWS`, 500;
  `SUPERDISPATCH_LEARNED_MIN_SHADOW`, 100; `SUPERDISPATCH_LEARNED_MARGIN_PCT`, 5), and otherwise
  places by the formula and logs why. It needs data first: run it in shadow.
- Station filters: a stage's `placement` (isolation, models, tools, credentials) filters
  candidates on AgentPod's capability registry, rejecting with `isolation-too-weak`,
  `model-mismatch`, `tool-missing` or `credential-missing` and recording what the station lacks.
  Off for a stage that states nothing; unchecked when the registry cannot be read. Settings
  `SUPERDISPATCH_STATION_FILTERS` (`on`/`off`) and `SUPERDISPATCH_MIN_PROOF`.
- Code-quality ratchets (`docs/code-quality.md`): lint is type-aware oxlint (with
  oxlint-tsgolint) whose per-rule counts may fall but never rise, and the architecture test also
  refuses a run-time import cycle and a source file over 1,000 lines. No change to what the
  service does.
- The service skeleton: it starts, checks its settings, opens its store and answers a health
  check.
- Placement: for each ready card on an opted-in board it filters every agent (on AgentPod's
  roster, SuperPipeline's own eligibility, a ready station, idle on every board, not a recent
  no-show), scores the rest (load, then success rate on the board, then least recently used),
  asks SuperPipeline to hold the card for the winner for 60 seconds, and records the decision with
  every candidate. What became of the card (claimed, claimed by another, expired, superseded) is
  settled on the next pass.
- Tiered holds: a card is held for the winner (60 seconds), then, if the hold lapses, for each
  runner-up in turn (30 seconds each, up to three holds in all), then left to any matching agent.
  Every step is a decision labelled with its tier. Settings: `SUPERDISPATCH_RUNNER_UP_SECONDS`,
  `SUPERDISPATCH_TOP_K`.
- Fairness across boards: a sweep places one card from each opted-in board in turn, longest
  waiting first, so a busy board does not take every free agent (`SUPERDISPATCH_FAIRNESS`).
- One live hold per agent (`holding-another`): a second hold for an agent that can claim one card
  at a time could only lapse and count against it as a no-show. Load leaves the score; the policy
  is now `idle-success-lru@2`.
- Roster suggestions, advice only: after each sweep, the decisions of the last day flag a lane
  with one agent on the roster for its capability, one whose agents keep being unhealthy or
  no-shows, or one where a card waited 30 minutes with nobody eligible. Each is
  `add-agent-to-board` (with the workspace's agents that have the capability and are not on the
  board) or `lane-single-point` (nobody to add), with the decisions that bear it out. Read them on
  `GET /v1/suggestions`, dismiss one with `POST /v1/suggestions/:id/dismiss`. SuperDispatch never
  edits a roster: a person makes the change. Settings: `SUPERDISPATCH_SUGGEST_EVERY_SECONDS`,
  `SUPERDISPATCH_SUGGEST_WINDOW_HOURS`, `SUPERDISPATCH_STALL_MINUTES`. Each decision now records
  the capability its stage asked for, and whether each agent off the roster has it.
- A card whose candidates are all busy waits for the next pass instead of being recorded
  `none-eligible` and left alone for five minutes (`waiting-on-load`). Before, on a board where
  every agent had work in hand, a freed agent pulled the next card before SuperDispatch looked
  again, so nothing on a loaded board was ever placed.
- History in the score: with `SUPERWITNESS_URL` set, each candidate's record at the card's stage
  (SuperWitness's finished runs there: outcome rate and verdict pass rate, recency-weighted,
  neutral below a minimum sample) ranks first, and is recorded on each candidate. SuperWitness
  absent or failing leaves the score as before. Settings: `SUPERWITNESS_AUDIENCE`,
  `SUPERDISPATCH_HISTORY_DAYS`, `SUPERDISPATCH_HISTORY_MIN_SAMPLE`,
  `SUPERDISPATCH_HISTORY_HALF_LIFE_DAYS`. The policy is now `idle-stage-success-lru@3`.
- A wider candidate set, off until the operator turns it on: with `SUPERDISPATCH_CANDIDATES=all`,
  agents that claim with their own token (no bridge row on the board) become candidates once
  SuperPipeline reports their load and health (`GET /v1/agents/load`), judged by the same filters.
  The roster and SuperPipeline both give one shape, `{agentId, inFlight, capacity, healthy,
lastSeenAt, source}`; health and idle (`inFlight < capacity`) are read from it, and every
  candidate record carries its `source` (`roster` or `direct`). `roster`, the default, places
  exactly as before.
- The dispatch policy, off until the operator turns it on: with `SUPERDISPATCH_POLICY=on`, each
  candidate the card's grant does not already refuse is checked against the workspace's dispatch
  policy in Accounts (`POST /api/policy/decide`, scope `policy:decide`), once a pass per agent and
  board stage. A deny rejects it as `policy-denied`, with Accounts' reasons on the record. A policy
  limit counts the holds SuperDispatch made for the agent in the window (`limit:<id>`). When
  Accounts cannot answer, it fails closed unless Accounts last said the workspace has no policy
  (`policy-unread`). `off`, the default, places exactly as before.
- A sweep of every opted-in board every 30 seconds, and a look at a board as soon as the event
  relay delivers one of its events.
- The operator API: opt a board in or out (`/v1/boards`), and read the decisions
  (`/v1/decisions`).
- A container image, and a staging deploy that stays off until the host is ready.
- The placement window: opting a board in sets its window on SuperPipeline
  (`SUPERDISPATCH_PLACEMENT_WINDOW_SECONDS`, 10 by default) and opting out sets none; a
  `card.ready` from the relay places that card at once with the board's cached roster, which every
  sweep refreshes. An agent SuperPipeline reports at its board's concurrency is waited for
  (`waiting-on-load`) even while its station reads idle.
- Releases run on the suite's shared release workflow: a `vX.Y.Z` tag checks that forge CI passed
  for the tag's commit and publishes release notes on GitHub.
