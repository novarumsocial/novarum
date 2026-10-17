// Port of apps/frontend/src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const urlPattern = /(https?:\/\/[^\s]+)/g;
// putting the regex here again since the /g does funny stuff with the test method
export const isUrl = (value: string) => /^https?:\/\/[^\s]+$/.test(value);

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
