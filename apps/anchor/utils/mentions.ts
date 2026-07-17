export function mentionHandles(content: string) {
  return new Set(
    [...content.matchAll(/(?<![a-zA-Z0-9._])@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?/g)].map(
      ([handle]) => handle.toLowerCase()
    )
  );
}
