# Changelog

SuperDispatch has no production deploy yet: a release publishes its notes on GitHub.

## Unreleased

- The service skeleton: it starts, checks its settings, opens its store and answers a health
  check. The placement types are in place; `place()` does not choose an agent yet.
- A container image, and a staging deploy that stays off until the host is ready.
- Releases run on the suite's shared release workflow: a `vX.Y.Z` tag checks that forge CI passed
  for the tag's commit and publishes release notes on GitHub.
