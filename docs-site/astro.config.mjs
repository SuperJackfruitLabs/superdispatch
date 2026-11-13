// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

const REPO = 'https://github.com/SuperJackfruitLabs/superdispatch';

export default defineConfig({
  site: 'https://docs.superdispatch.dev',
  integrations: [
    starlight({
      title: 'SuperDispatch',
      description:
        'The scheduler for SuperPipeline and AgentPod: when a card is ready, it decides which agent should take it, and records why.',
      // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs. The
      // full file carries every page, reference pages included; the small one drops asides
      // and <details> but keeps every page too, since nothing here is noise.
      plugins: [
        starlightLlmsTxt({
          projectName: 'SuperDispatch',
          description:
            'SuperDispatch is the scheduler for SuperPipeline and AgentPod. For each ready card on a ' +
            'board the operator opted in, it filters every candidate agent (each rejection carries a ' +
            'reason code), scores the ones left by their record at the stage, their success on the ' +
            'board and how long since they last took work, and names a preferred agent. SuperPipeline ' +
            'then holds the card for that agent for a short reservation that lapses on its own, in ' +
            'tiers: the winner, then runner-ups, then any match by pull. Every decision is recorded ' +
            'with every candidate and the reason for each. Roster suggestions and supply proposals are ' +
            'advice for a person; it never edits a roster or a station. Nothing requires it: without ' +
            'it, agents claim by pull as before. It is an early, Apache-2.0 Bun service; v0.0.1 runs ' +
            'in production with no board opted in yet.',
          optionalLinks: [
            { label: 'SuperDispatch', url: 'https://superdispatch.dev', description: 'The product site.' },
            { label: 'Source', url: REPO, description: 'The SuperDispatch repository on GitHub.' },
          ],
        }),
      ],
      // The mark beside the name, as on the landing page. See the component for why it
      // replaces Starlight's own rather than using the `logo` option.
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      // The landing page's palette and faces; see src/styles/theme.css for each value.
      customCss: ['./src/styles/theme.css'],
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href:
              'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700' +
              '&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
          },
        },
        // The link preview, copied from landing/public/og.png so this host serves its own.
        // Absolute URLs: several unfurlers ignore a relative og:image.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.superdispatch.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'SuperDispatch — which agent takes the card, and why' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.superdispatch.dev/og.png' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      // Four sections, in the order a reader needs them: what it is and where it stands, how
      // a card is placed, what it keeps, then running it.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'What SuperDispatch is', slug: 'what-it-is' },
            { label: 'Status and limits', slug: 'status' },
          ],
        },
        {
          label: 'How a card is placed',
          items: [
            { label: 'A placement, end to end', slug: 'placement/overview' },
            { label: 'Candidates and filters', slug: 'placement/filters' },
            { label: 'Station filters', slug: 'placement/station-filters' },
            { label: 'The dispatch policy', slug: 'placement/policy' },
            { label: 'Scoring', slug: 'placement/scoring' },
            { label: 'Holds, tiers and fairness', slug: 'placement/holds-and-tiers' },
          ],
        },
        {
          label: 'What it keeps',
          items: [
            { label: 'Decision records', slug: 'records/decisions' },
            { label: 'Roster suggestions', slug: 'records/roster-suggestions' },
            { label: 'Supply proposals', slug: 'records/supply-proposals' },
            { label: 'Learned routing', slug: 'records/learned-routing' },
          ],
        },
        {
          label: 'Run it',
          items: [
            { label: 'Running it', slug: 'run/running-it' },
            { label: 'Settings', slug: 'run/settings' },
            { label: 'Opting a board in', slug: 'run/opting-a-board-in' },
            { label: 'Operator API', slug: 'run/operator-api' },
            { label: 'Production', slug: 'run/production' },
          ],
        },
      ],
    }),
  ],
});
