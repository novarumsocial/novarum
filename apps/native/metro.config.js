const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);
// Expo detects the Bun workspace on its own, so `anchor` and hoisted packages resolve without extra setup
config.resolver.assetExts.push('opus'); // the sounds we share with the web

module.exports = withNativeWind(config, { input: './global.css' });
