// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sjlDocs from '@superjackfruit/docs-theme';

export default defineConfig({
  site: 'https://docs.superdispatch.dev',
  integrations: [
    starlight({
      title: 'SuperDispatch',
      description:
        'The scheduler for SuperPipeline and AgentPod: when a card is ready, it decides which agent should take it, and records why.',
      // The suite's docs theme: vibekit's teal, the faces, the street, status badges, the footers,
      // the 404, the edit link and llms.txt. See @superjackfruit/docs-theme's README.
      plugins: [
        sjlDocs({
          product: 'superdispatch',
          status: 'wet paint',
          // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs.
          llms: {
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
              'in production on the boards the operator has opted in.',
          },
        }),
      ],
      favicon: '/favicon.svg',
      head: [
        // The link preview, copied from landing/public/og.png so this host serves its own.
        // Absolute URLs: several unfurlers ignore a relative og:image.
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.superdispatch.dev/og.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'SuperDispatch — which agent takes the card, and why' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.superdispatch.dev/og.png' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/SuperJackfruitLabs/superdispatch' }],
      // The suite's five groups, in the order a reader needs them.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'What SuperDispatch is', slug: 'what-it-is' },
            { label: 'Your first placement', slug: 'start/first-placement' },
            { label: 'Status and limits', slug: 'status' },
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'A placement, end to end', slug: 'placement/overview' },
            { label: 'Candidates and filters', slug: 'placement/filters' },
            { label: 'Station filters', slug: 'placement/station-filters' },
            { label: 'The dispatch policy', slug: 'placement/policy' },
            { label: 'Scoring', slug: 'placement/scoring' },
            { label: 'Holds, tiers and fairness', slug: 'placement/holds-and-tiers' },
            { label: 'Decision records', slug: 'records/decisions' },
            { label: 'Roster suggestions', slug: 'records/roster-suggestions' },
            { label: 'Supply proposals', slug: 'records/supply-proposals' },
            { label: 'Learned routing', slug: 'records/learned-routing' },
          ],
        },
        {
          label: 'Build on it',
          items: [{ label: 'Operator API', slug: 'run/operator-api' }],
        },
        {
          label: 'Run it',
          items: [
            { label: 'Running it', slug: 'run/running-it' },
            { label: 'Opting a board in', slug: 'run/opting-a-board-in' },
            { label: 'Production', slug: 'run/production' },
          ],
        },
        {
          label: 'Reference',
          items: [{ label: 'Settings', slug: 'run/settings' }],
        },
      ],
    }),
  ],
});
