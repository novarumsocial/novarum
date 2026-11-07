import type { APIMessage, APIMessageBody } from './types.js';

/** An error answer from the Anchor API. */
export class NovarumAPIError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string
  ) {
    super(`${method} ${path} failed with ${status}: ${message}`);
    this.name = 'NovarumAPIError';
  }
}

export interface RESTOptions {
  /** the bot token from the developer panel */
  token: string;
  /** the Anchor homeserver the bot lives on, e.g. `https://anchor.example.com` */
  baseUrl: string;
  /** a custom fetch, for tests or proxies */
  fetch?: typeof fetch;
}

const retryAfterMs = (response: Response) => {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
};

/** A small typed wrapper around the Anchor HTTP API, authenticated as the bot. */
export class REST {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: RESTOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  get token() {
    return this.#token;
  }

  /** Sends one request; JSON in, JSON out. Retries once when rate limited (429). */
  async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const response = await this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.#token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && !retried) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs(response)));
      return this.request(method, path, body, true);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
      const error =
        json && typeof json === 'object' && 'error' in json
          ? String(json.error)
          : text || response.statusText;
      throw new NovarumAPIError(response.status, method, path, error);
    }
    return json as T;
  }

  get = <T>(path: string) => this.request<T>('GET', path);
  post = <T>(path: string, body?: unknown) => this.request<T>('POST', path, body ?? {});
  put = <T>(path: string, body?: unknown) => this.request<T>('PUT', path, body);
  patch = <T>(path: string, body?: unknown) => this.request<T>('PATCH', path, body);
  delete = <T>(path: string) => this.request<T>('DELETE', path);

  /** Sends a message to a channel. */
  async sendMessage(channelId: string, body: APIMessageBody & { replyTo?: string }) {
    const { message } = await this.post<{ message: APIMessage }>('/message/send', {
      channelId,
      nonce: crypto.randomUUID(),
      content: body.content ?? null,
      replyTo: body.replyTo,
      embeds: body.embeds,
      components: body.components,
    });
    return message;
  }

  async editMessage(channelId: string, messageId: string, body: APIMessageBody) {
    const { message } = await this.post<{ message: APIMessage }>('/message/edit', {
      channelId,
      messageId,
      content: body.content ?? null,
      embeds: body.embeds,
      components: body.components,
    });
    return message;
  }

  deleteMessage(channelId: string, messageId: string) {
    return this.post<{ success: boolean }>('/message/delete', { channelId, messageId });
  }
}
