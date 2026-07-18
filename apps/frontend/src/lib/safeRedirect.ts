export function safeRedirect(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/guilds';

  return value;
}
