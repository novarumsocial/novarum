// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightThemeFlexoki from 'starlight-theme-flexoki';

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: 'Novarum Docs',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/novarumsocial/novarum' },
      ],
      plugins: [starlightThemeFlexoki()],
      sidebar: [
        { label: 'Introduction', slug: '' },
        {
          label: 'Guides',
          items: [{ label: 'Deploy an Anchor server', slug: 'guides/deployment' }],
        },
      ],
    }),
  ],
});
