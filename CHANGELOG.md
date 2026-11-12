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
- A sweep of every opted-in board every 30 seconds, and a look at a board as soon as the event
  relay delivers one of its events.
- The operator API: opt a board in or out (`/v1/boards`), and read the decisions
  (`/v1/decisions`).
- A container image, and a staging deploy that stays off until the host is ready.
- Releases run on the suite's shared release workflow: a `vX.Y.Z` tag checks that forge CI passed
  for the tag's commit and publishes release notes on GitHub.
