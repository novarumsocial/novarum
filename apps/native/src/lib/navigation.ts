// Native-only: the web calls `goto(href)`; this wraps expo-router's imperative `router` for plain string paths
import { router, type Href } from 'expo-router';

export const goto = (href: string, { replaceState = false } = {}) =>
  replaceState ? router.replace(href as Href) : router.push(href as Href);

// back to the hub (servers, channels and DMs), closing every channel screen above it
export const goHome = () => router.dismissTo('/guilds');
