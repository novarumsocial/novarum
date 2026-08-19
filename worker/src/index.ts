interface Env {
  B2_ENDPOINT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.host = env.B2_ENDPOINT;
    const res = await fetch(new Request(url, request), {
      redirect: 'manual',
      cf: { cacheKey: request.url },
    });
    return new Response(res.body, res);
  },
} satisfies ExportedHandler<Env>;