# Changelog

SuperDispatch has no production deploy yet: a release publishes its notes on GitHub.

## Unreleased

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
- A sweep of every opted-in board every 30 seconds, and a look at a board as soon as the event
  relay delivers one of its events.
- The operator API: opt a board in or out (`/v1/boards`), and read the decisions
  (`/v1/decisions`).
- A container image, and a staging deploy that stays off until the host is ready.
- Releases run on the suite's shared release workflow: a `vX.Y.Z` tag checks that forge CI passed
  for the tag's commit and publishes release notes on GitHub.
