import { settings } from './settings.svelte';

export function formatTime(date: Date): string {
  if (settings.value.timeFormat === 'auto') {
    const locale = navigator.language || 'en-US';
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (settings.value.timeFormat === '12hr') {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  if (settings.value.timeFormat === '24hr') {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  // this should never show up unless you have manipulated the settings in the console or something
  return 'what did you do lmao';
}

export function formatDate(date: Date): string {
  // show today, yesterday or date in their locale
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString(navigator.language || 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
