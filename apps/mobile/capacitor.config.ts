import type { CapacitorConfig } from '@capacitor/cli';

export default {
  appId: 'me.novarum.mobile',
  appName: 'Novarum',
  webDir: '../frontend/build',
  plugins: {
    CapacitorUpdater: {
      updateUrl: 'https://mobile.novarum.me/updates'
    },
  },
} satisfies CapacitorConfig;
