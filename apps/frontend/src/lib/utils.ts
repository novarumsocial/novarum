import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const urlPattern = /(https?:\/\/[^\s]+)/g;
// putting the regex here again since the /g does funny stuff with the test method
export const isUrl = (value: string) => /^https?:\/\/[^\s]+$/.test(value);

// "@everyone", but not a handle like @everyone:example.com. The server pings every guild member
// for it without listing them in pingedHandles, so clients look for it in the content.
export const everyonePattern = /(?<![a-zA-Z0-9._])@everyone(?![a-zA-Z0-9_:]|\.[a-zA-Z0-9])/;
export const mentionsEveryone = (content: string | null) =>
  everyonePattern.test((content ?? '').replace(urlPattern, ''));

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

// links to this app (e.g. app.novarum.me) navigate in place instead of opening a new tab
export const linkTarget = (url: string) =>
  url === location.origin || url.startsWith(`${location.origin}/`) ? undefined : '_blank';
