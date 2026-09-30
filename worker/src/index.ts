interface Env {
  B2_ENDPOINT: string;
  // same value as anchor's files.cdn_signing_secret; leave unset to skip the check.
  CDN_SIGNING_SECRET?: string;
}

// cache hits never reach storage, so its presign signature can't protect them. anchor adds
// cdn_exp/cdn_sig (hmac of `${pathname}:${exp}`) and we check that before anything else.
async function hasValidCdnSignature(url: URL, secret: string) {
  const exp = Number(url.searchParams.get('cdn_exp'));
  const sig = url.searchParams.get('cdn_sig') ?? '';
  if (!(exp > Date.now() / 1000) || !/^[0-9a-f]{64}$/.test(sig)) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBytes = Uint8Array.from(sig.match(/../g)!, (byte) => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(`${url.pathname}:${exp}`));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (env.CDN_SIGNING_SECRET) {
      if (!(await hasValidCdnSignature(url, env.CDN_SIGNING_SECRET))) {
        return new Response('Forbidden', { status: 403 });
      }
      // anchor appends these last; strip them as text so the storage signature stays byte-identical
      url.search = url.search.replace(/[?&]cdn_exp=\d+&cdn_sig=[0-9a-f]{64}$/, '');
    }

    url.protocol = 'https:';
    url.host = env.B2_ENDPOINT;
    // query string is per-request presign auth; the object is identified by path alone
    const cacheKey = new URL(request.url);
    cacheKey.search = '';
    const res = await fetch(new Request(url, request), {
      redirect: 'manual',
      cf: {
        cacheKey: cacheKey.toString(),
        cacheEverything: true,
        cacheTtl: 31536000,
        cacheTtlByStatus: { '200-299': 31536000, '404': 1 },
      },
    });
    return new Response(res.body, res);
  },
} satisfies ExportedHandler<Env>;
