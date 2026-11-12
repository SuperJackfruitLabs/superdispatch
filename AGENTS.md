# SuperDispatch

The suite's scheduler: for a ready SuperPipeline card it names the agent that should take it, and
records why. The charter decision that sets its scope is
`decisions/2026-11-12-superdispatch-owns-the-scheduler.md`.

## Rules

- **It advises; SuperPipeline holds.** SuperDispatch names a preferred agent and SuperPipeline
  holds a short reservation for it. It never hands a card to an agent, and never claims one.
- **It reads, and owns no other product's data.** `src/sources` only reads SuperPipeline,
  AgentPod and Accounts through their public APIs. It never edits a roster: a roster suggestion
  is advice a person acts on.
- **Nothing requires it.** No change here may make SuperPipeline or AgentPod need this service
  to work. When it is slow or absent, the cost is the reservation window, never the claim.
- **Every decision is a record**: the card, the chosen agent, every candidate with each filter's
  result and its score. A rejection carries its filter's reason code.
- **Placement is pure.** `src/placement` is functions over plain inputs: no I/O, no clock, no
  randomness. The time it needs comes in its input.
- **The layers hold.** `apps/dispatch/test/architecture.test.ts`: config < store < sources <
  placement < routes < main. An import stays in its layer or points down.
- **A setting's value never reaches a log, an error or a response.**
- **Every guard has a test that fails when the guard is reverted.**
- **Events are treaty's.** Read relay deliveries with `@superjackfruitlabs/treaty-cloudevents`;
  a new event shape is a treaty change first.

## Layout

- `apps/dispatch/`: the service. `src/store` is its SQLite store and migrations, `src/sources`
  the read-only clients, `src/placement` filter, score, decide and record, `src/routes` the HTTP
  surface.
- `deploy/staging/`: the staging deploy, run on the staging host by its forced-command key.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint, tests. Run it before pushing.

## Hosting

Forge is primary and push-mirrors to GitHub. Open pull requests on forge only. CI and review run
on forge (`.forgejo/workflows`). Deploy jobs go in `.github/workflows` and run only on GitHub,
guarded with `if: github.server_url == 'https://github.com'`.

Never commit secrets or keys.

## Releases

Versions start at 0.0.1, and only the operator pushes tags. There is no production deploy yet:
a tag runs the shared release workflow, which checks forge CI and publishes release notes
(`.github/release-config.json`). `CHANGELOG.md` keeps an `## Unreleased` section: add an entry
with each change people will notice. Before a tag, a release-prep PR runs
`sh .github/release/prep-release.sh vX.Y.Z`.

## Shared kit

`.forgejo/workflows/claude-review.yml`, the `claude-triage` job in `ci.yml`, and
`.github/claude/claude-ci.mjs` are copies of the shared claude-ci kit. Change the master and
sync; never edit a copy.

`.github/workflows/release.yml` and `.github/release/` are copies of the shared release kit
(estate `release/`). Change the master and sync; never edit a copy.
