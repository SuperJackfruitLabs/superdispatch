# Code quality ratchets

Every number on this page is held by a script or a test that fails when it is wrong; the numbers
themselves live in the files it cites. Each check records how the code looks and fails if it gets
worse. Each one also fails if it gets **better** without the record being lowered, so a stale
record cannot let the next regression through.

All of them run in `bun run check`, which is what CI's `check` job runs.

## Lint: `bun run lint`

[oxlint](https://oxc.rs) `1.88.0` with `oxlint-tsgolint` `7.0.2004`, both pinned exactly in the
root `package.json`. tsgolint type-checks with its own TypeScript-Go, so the typed rules do not
depend on the repo's TypeScript. Configuration: [`.oxlintrc.json`](../.oxlintrc.json). Script:
[`scripts/lint.mjs`](../scripts/lint.mjs).

- **Covers** `apps/`, `deploy/` and `scripts/`.
- **Rules:** the `correctness` and `suspicious` categories, plus floating and misused promises,
  `await` of a non-promise, exhaustive `switch` (a `default` counts), type-only imports, no
  `any`, no `!` non-null assertion, no empty block (an empty `catch` included), no unused code,
  and no `console` outside tests and scripts.
- **The ratchet.** Findings are counted per rule in
  [`scripts/lint-baseline.json`](../scripts/lint-baseline.json). A count may fall but never rise;
  a rule not in the baseline must be clean. After a cleanup, `bun run lint --update` writes the
  lower counts (it refuses to raise one); lint fails until you do.
- **Shipped source stays clean** of the rules in `SRC_CLEAN` in `scripts/lint.mjs`, whatever the
  baseline allows in tests. "Shipped" means under a `src/` folder and not in `test/`. Every rule
  whose findings are all in tests is listed there, so a first finding in `src/` fails at once.
- **Before running it:** `bun install --frozen-lockfile`. Without it the typed rules cannot load
  the project and report `tsconfig-error`, which the baseline does not allow.

What the baseline holds in shipped source (measured 2026-11-13), and why it is held rather than cleared:

- `no-console`: the service's log lines go to stdout on purpose; there is no logger.
- `no-unsafe-type-assertion`: assertions on parsed JSON, SQLite rows and timer handles.
  Rewriting them risks changing what is accepted.
- `no-array-sort`, `no-array-reverse`: in-place `sort()` and `reverse()`; `toSorted()` and
  `toReversed()` would differ wherever the array is shared.
- `no-shadow`, `unbound-method`, `consistent-function-scoping`: renames, rebinding and hoisting,
  left to the code's next change.

Lower them in code you touch, then `bun run lint --update`.

The baseline was recounted on main after the station filters (#14) and the policy filter (#13)
landed, so it starts from the code as it is: `consistent-function-scoping` 22 to 29,
`no-array-sort` 7 to 11, `no-console` 7 to 8 and `no-unsafe-type-assertion` 31 to 41. From here
the counts only fall.

## Architecture: `apps/dispatch/test/architecture.test.ts`

Run by `bun test`. It holds:

- **The layers:** config < store < sources < placement < loop < routes < main. A file belongs to
  the layer named by its first path segment under `src/`; an import stays in its layer or points
  down. A new top-level folder or file fails until it is given a place in the order.
- **Placement is pure:** no package or runtime import, no global that does I/O, reads the clock
  or draws a random number.
- **No run-time import cycle** larger than `LARGEST_CYCLE` (0). `import type` and `export type`
  are erased and are not edges; every other import, re-export and dynamic import is.
- **No source file over 1,000 lines** (`SIZE_LIMIT`), except files listed in `OVERSIZE` with the
  most lines each may have (none). An entry above its file's size fails until it is lowered.

Each rule is also run against inputs it must refuse, so none can pass by checking nothing.
