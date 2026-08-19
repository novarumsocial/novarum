interface Env {
  B2_ENDPOINT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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