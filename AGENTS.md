# SuperDispatch

The suite's scheduler: for a ready SuperPipeline card it names the agent that should take it, and
records why. The charter decision that sets its scope is
`decisions/2026-11-12-superdispatch-owns-the-scheduler.md`.

## Rules

- **It advises; SuperPipeline holds.** SuperDispatch names a preferred agent and SuperPipeline
  holds a short reservation for it. It never hands a card to an agent, and never claims one.
- **It reads, and owns no other product's data.** `src/sources` reads SuperPipeline,
  AgentPod and Accounts through their public APIs; its one write is the reservation, which
  SuperPipeline holds and lets lapse. It never edits a roster: a roster suggestion is advice a
  person acts on.
- **Nothing requires it.** No change here may make SuperPipeline or AgentPod need this service
  to work. When it is slow or absent, the cost is the reservation window, never the claim.
- **Every decision is a record**: the card, the chosen agent, every candidate with each filter's
  result and its score. A rejection carries its filter's reason code.
- **Placement is pure.** `src/placement` is functions over plain inputs: no I/O, no clock, no
  randomness. The time it needs comes in its input.
- **The layers hold.** `apps/dispatch/test/architecture.test.ts`: config < store < sources <
  placement < loop < routes < main. An import stays in its layer or points down. The same test
  allows no run-time import cycle and no source file over 1,000 lines.
- **A setting's value never reaches a log, an error or a response.**
- **Every guard has a test that fails when the guard is reverted.**
- **Events are treaty's.** Read relay deliveries with `@superjackfruitlabs/treaty-cloudevents`;
  a new event shape is a treaty change first.

## Layout

- `apps/dispatch/`: the service. `src/store` is its SQLite store and migrations, `src/sources`
  the clients of the other products, `src/placement` filter, score and decide, `src/loop` the
  pass over a board (read, settle, place, reserve, record) and the sweep, `src/routes` the HTTP
  surface.
- `deploy/staging/`: the staging deploy, run on the staging host by its forced-command key.
- `landing/`: superdispatch.dev, an Astro site outside the Bun workspace with its own lockfile
  (`landing/README.md`). It deploys from the GitHub mirror on merge to main.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint, tests. Run it before pushing.

Lint is type-aware oxlint with a ratchet: per-rule counts in `scripts/lint-baseline.json` may
fall but never rise. After a cleanup, `bun run lint --update` locks the lower count in. The
ratchets, and what each holds, are in `docs/code-quality.md`.

## Hosting

Forge is primary and push-mirrors to GitHub. Open pull requests on forge only. CI and review run
on forge (`.forgejo/workflows`). Deploy jobs go in `.github/workflows` and run only on GitHub,
guarded with `if: github.server_url == 'https://github.com'`.

Never commit secrets or keys.

## Releases

Versions start at 0.0.1, and only the operator pushes tags. A tag runs the shared release workflow: it checks forge CI, deploys
production through the host's forced-command key (`deploy/production/release.sh`, settings in
`.github/release-config.json`) and publishes the release notes. `CHANGELOG.md` keeps an `## Unreleased` section: add an entry
with each change people will notice. Before a tag, a release-prep PR runs
`sh .github/release/prep-release.sh vX.Y.Z`.

## Shared kit

`.forgejo/workflows/claude-review.yml`, the `claude-triage` job in `ci.yml`, and
`.github/claude/claude-ci.mjs` are copies of the shared claude-ci kit. Change the master and
sync; never edit a copy.

`.github/workflows/release.yml` and `.github/release/` are copies of the shared release kit
(estate `release/`). Change the master and sync; never edit a copy. The exception: this repo's own release hook, `.github/release/ci-check.sh`.
