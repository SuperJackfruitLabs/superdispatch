# SuperDispatch landing page

The public page at `superdispatch.dev`. Astro, one page and a 404, wearing the suite frame
(`@superjackfruit/frontdoor`, vendored in `vendor/` beside vibekit). Outside the Bun workspace,
with its own `package.json` and `package-lock.json`: `bun install` never looks in here.

```sh
npm ci
npm run dev     # http://localhost:4507
npm run build   # -> dist/, then checks the frame is in the HTML
```

Astro 7 needs Node 22.23.4 or newer.

## How it deploys

A Cloudflare Worker with static assets named `superdispatch-site`, configured by
`landing/wrangler.jsonc`. The custom domains (the apex and `www`) are declared there, so a deploy
attaches them. CI runs `scripts/deploy-sites.sh landing` on merge to main from the GitHub mirror
(`.github/workflows/sites.yml`) with the organisation's Cloudflare token; by hand it uses your
`wrangler login`. `assets.not_found_handling: "404-page"` serves `dist/404.html` with a real 404.

## What is deliberate about the page

**It says where the product is.** Early, proven on staging, production being set up. No release
to download and no app to sign in to, so the header's button is the source.

**The hero is a placement decision**, the record SuperDispatch keeps for every card. Its field names
are real and its values made up; the comment at the top of `src/pages/index.astro` maps each one to
the code. The policy name and the list of rejection reasons are read from
`apps/dispatch/src/placement/index.ts` at build time, so the page cannot name a reason the code
does not have.

**One scene, scrubbed by scroll.** "How it places a card" pins a small three.js scene
(`src/scripts/scenes/placement.js`) beside its five steps: a card becomes ready, agents are
filtered, scored, one is held, it claims. One beat per step, driven by scroll position, never
autoplayed. A still per beat and sun phase in `public/scenes/` covers reduced motion, no WebGL and
the moment before it loads; `scripts/render-stills.mjs` regenerates them.

**Teal is spent on the chosen agent, the hold and the claim.** SuperDispatch's colour is vibekit's
teal (OKLCH hue 192), named by `PRODUCT_ACCENTS.superdispatch` since vibekit 0.0.15. The scenes take
its hue from there (`src/scripts/scenes/common.js`), and `src/accent.ts` reads its Daylight tokens for
light and dark from the package's `accents.css` at build time, so the page follows vibekit rather
than a copy. Only the grounds are the page's own. The suite frame keeps its own SuperDispatch colour,
`#00afab`, for its bar and header.

**Discovery.** `public/llms.txt`, a sitemap (`@astrojs/sitemap`), JSON-LD in the page head, and
`public/og.png`, rendered from the suite's one share-image template (see `og/README.md`).

**No analytics, no sign-in.** The page says only what ships today.
