// Port of apps/frontend/src/lib/formatDate.ts
import { settings } from './settings';

const timeOptions = { hour: '2-digit', minute: '2-digit' } as const;

export function formatTime(date: Date): string {
  const { timeFormat } = settings();
  if (timeFormat === 'auto') return date.toLocaleTimeString(undefined, timeOptions);
  return date.toLocaleTimeString('en-US', { ...timeOptions, hour12: timeFormat === '12hr' });
}

export function formatDate(date: Date): string {
  // show today, yesterday or date in their locale
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
