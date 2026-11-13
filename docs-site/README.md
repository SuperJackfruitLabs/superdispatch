# SuperDispatch docs site

The documentation published at `docs.superdispatch.dev`. Astro + Starlight.

```sh
npm ci
npm run dev     # http://localhost:4517
npm run build   # checks the claims, then -> dist/
```

Astro 7 needs Node 22.23.4 or newer.

## Why npm, and why it sits outside the Bun workspace

Like `landing/`, the site has its own `package.json` and `package-lock.json`, so `bun install`
never looks in here and the service's dependency tree carries nothing of Astro's. The site ships
nothing the service imports.

## Claims are checked

`scripts/check-claims.mjs` runs before every build and fails it when a page says something the
code does not back. It reads the service's source one directory up:

- every setting `apps/dispatch/src/config.ts` reads is on `run/settings.md`, with the code's range
  and default, and the required ones under Required; any other page that names a setting names one
  the code reads (or another product's, listed in the script);
- the filters table on `placement/filters.md` is `FILTERS` in `placement/index.ts`, row for row and
  in order;
- the reasons nobody is chosen, the outcomes, the roster suggestion kinds and rules, the supply
  proposal kinds, the tiers and the policy name each appear where they are described;
- every page has a `title` and a `description`.

So CI builds the docs when `docs-site/` changes and when the service's source does
(`.forgejo/workflows/ci.yml`).

## What is deliberate about it

**It wears the landing page's identity**, as the suite's other docs sites do. `src/styles/theme.css`
maps the landing page's tokens onto Starlight's gray ramp and accent, with the measured contrast
of every accent pairing in a comment at the top. `src/components/SiteTitle.astro` puts the mark
beside the name. `public/favicon.svg`, `src/assets/mark.svg` and `public/og.png` are copies of
`landing/public/favicon.svg` and `landing/public/og.png`; change them there and copy them here.

**It says only what ships**, and says where the product is: early, v0.0.1 in production with no
board opted in yet. `status.md` lists what it does not do. Nothing here describes planned work as
if it were done.

**For agents**: `/llms.txt`, `/llms-full.txt` and `/llms-small.txt` (`starlight-llms-txt`).
Search is Starlight's Pagefind; the sitemap and the 404 page are Starlight's.

## Publishing

A Cloudflare Worker with static assets named `superdispatch-docs`, configured by
`docs-site/wrangler.jsonc`. From the repo root:

```sh
scripts/deploy-sites.sh docs   # checks, builds, then wrangler deploy --config docs-site/wrangler.jsonc
```

The custom domain is declared in the config, so a deploy also attaches it. CI runs
`scripts/deploy-sites.sh all` on merge to main from the GitHub mirror
(`.github/workflows/sites.yml`) with the organisation's Cloudflare token; by hand it uses your
`wrangler login`. `assets.not_found_handling: "404-page"` serves `dist/404.html` with a real 404.

The site is static and has no runtime, so the deploy either served the built tree or it did not.
`curl -sI https://docs.superdispatch.dev/run/settings/` is the whole smoke test.
