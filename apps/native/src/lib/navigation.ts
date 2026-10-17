// Native-only: the web calls `goto(href)`; this wraps expo-router's imperative `router` for plain string paths
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

export const goto = (href: string, { replaceState = false } = {}) =>
  replaceState ? router.replace(href as Href) : router.push(href as Href);

// back to the hub (servers, channels and DMs), closing every channel screen above it
export const goHome = () => router.dismissTo('/guilds');

// a link to the web app (an invite, channel or message) opens here instead of in the browser
export const openLink = (url: string) => {
  const path = url.match(/^https:\/\/app\.novarum\.me(\/(?:guilds|i)\/[^?#]+)/i)?.[1];
  if (path) goto(path);
  else void WebBrowser.openBrowserAsync(url);
};
