export function parseJson<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// remote homeservers can answer with anything, so their bodies are capped (a gzip bomb inflates while it is read)
export const maxRemoteJsonBytes = 16 * 1024 * 1024;

/** the body parsed as JSON, or null when it is not JSON, fails mid-stream or grows past `maxBytes` */
export async function readJson(
  response: Response,
  maxBytes = maxRemoteJsonBytes
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}
