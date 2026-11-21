// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'Novarum Docs',
      plugins: [
        // generated from the SDK's source into src/content/docs/bots/api on every build
        starlightTypeDoc({
          entryPoints: ['../sdk/src/index.ts', '../sdk/src/voice/index.ts'],
          tsconfig: '../sdk/tsconfig.json',
          output: 'bots/api',
          sidebar: { label: 'API reference', collapsed: true },
        }),
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/novarumsocial/novarum' },
      ],
      sidebar: [
        { label: 'Introduction', slug: 'docs' },
        {
          label: 'Guides',
          items: [
            { label: 'Deploy an Anchor server', slug: 'guides/deployment' },
            { label: 'Using the CLI', slug: 'guides/cli' },
          ],
        },
        {
          label: 'Bots',
          items: [
            { label: 'Your first bot', slug: 'bots/getting-started' },
            { label: 'Slash commands', slug: 'bots/slash-commands' },
            { label: 'Embeds and buttons', slug: 'bots/embeds-and-buttons' },
            { label: 'Voice', slug: 'bots/voice' },
            { label: 'SDK reference', slug: 'bots/sdk' },
            typeDocSidebarGroup,
            { label: 'HTTP API', slug: 'bots/http-api' },
            { label: 'Across homeservers', slug: 'bots/federation' },
          ],
        },
      ],
      customCss: ['./src/styles/global.css'],
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
