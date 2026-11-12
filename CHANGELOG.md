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
- A sweep of every opted-in board every 30 seconds, and a look at a board as soon as the event
  relay delivers one of its events.
- The operator API: opt a board in or out (`/v1/boards`), and read the decisions
  (`/v1/decisions`).
- A container image, and a staging deploy that stays off until the host is ready.
- Releases run on the suite's shared release workflow: a `vX.Y.Z` tag checks that forge CI passed
  for the tag's commit and publishes release notes on GitHub.
