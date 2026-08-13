import type { CapacitorConfig } from '@capacitor/cli';

export default {
  appId: 'me.novarum.mobile',
  appName: 'Novarum',
  webDir: '../frontend/build',
  plugins: {
    CapacitorUpdater: {
      autoUpdate: 'off',
    },
  },
} satisfies CapacitorConfig;
