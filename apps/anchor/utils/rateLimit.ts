// One-minute windows per key, kept in memory: enough to stop one person or homeserver flooding us.
export function rateLimiter(maxPerMinute: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string) => {
    const now = Date.now();
    // forget old windows now and then so the map can't grow forever
    if (windows.size > 10_000) {
      for (const [name, old] of windows) if (now - old.start > 60_000) windows.delete(name);
    }
    const window = windows.get(key);
    if (!window || now - window.start > 60_000) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    return ++window.count <= maxPerMinute;
  };
}
