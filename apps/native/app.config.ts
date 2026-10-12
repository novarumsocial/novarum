import type { ExpoConfig } from 'expo/config';

// Same app id as the Capacitor app (apps/mobile) so the native app installs as an update over it
const config: ExpoConfig = {
  name: 'Novarum',
  slug: 'novarum',
  scheme: 'novarum',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: 'me.novarum.mobile',
    supportsTablet: true,
    infoPlist: {
      UIBackgroundModes: ['audio', 'voip'],
      NSCameraUsageDescription: 'Send photos and join video calls',
      NSMicrophoneUsageDescription: 'Talk in voice channels and calls',
    },
    associatedDomains: ['applinks:app.novarum.me'],
  },
  android: {
    package: 'me.novarum.mobile',

    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0c090c' },
    permissions: [
      'RECORD_AUDIO',
      'CAMERA',
      'POST_NOTIFICATIONS',
      'MODIFY_AUDIO_SETTINGS',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MICROPHONE',
    ],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          { scheme: 'https', host: 'app.novarum.me', pathPrefix: '/i' },
          { scheme: 'https', host: 'app.novarum.me', pathPrefix: '/guilds' },
        ],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      { image: './assets/icon.png', imageWidth: 160, backgroundColor: '#0c090c' },
    ],
    'expo-font',
    'expo-image-picker',
    ['expo-video', { supportsBackgroundPlayback: true, supportsPictureInPicture: true }],
    [
      'expo-media-library',
      {
        photosPermission: 'Save images and videos to your photos',
        isAccessMediaLocationEnabled: false,
      },
    ],
    'expo-audio',
    'expo-notifications',
    'expo-unified-push',
    '@livekit/react-native-expo-plugin',
    [
      'expo-build-properties',
      { android: { minSdkVersion: 24 }, ios: { deploymentTarget: '16.4' } },
    ],
  ],
  // OTA updates turn on when EAS_UPDATE_URL is set (the `eas update` URL from `eas init`)
  updates: { enabled: Boolean(process.env.EAS_UPDATE_URL), url: process.env.EAS_UPDATE_URL },
  runtimeVersion: { policy: 'appVersion' }, // set `updates.url` after `eas init` to turn on OTA updates
  experiments: { typedRoutes: true },
};

export default config;
