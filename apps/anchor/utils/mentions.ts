const withoutUrls = (content: string | null) => (content ?? '').replace(/https?:\/\/[^\s]+/g, '');

export function mentionHandles(content: string | null) {
  return new Set(
    [
      ...withoutUrls(content).matchAll(
        /(?<![a-zA-Z0-9._])@[a-zA-Z0-9._]+:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?/g
      ),
    ].map(([handle]) => handle.toLowerCase())
  );
}

// "@everyone", but not a handle like @everyone:example.com
export const mentionsEveryone = (content: string | null) =>
  /(?<![a-zA-Z0-9._])@everyone(?![a-zA-Z0-9_:]|\.[a-zA-Z0-9])/.test(withoutUrls(content));
