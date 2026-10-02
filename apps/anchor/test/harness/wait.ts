export async function eventually<T>(
  fn: () => T | Promise<T>,
  { timeout = 5000, interval = 50, message = 'condition' } = {}
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(interval);
  }
  throw new Error(`eventually: ${message} not met in ${timeout}ms${last ? `: ${last}` : ''}`);
}
