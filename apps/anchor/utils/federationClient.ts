import { z } from 'zod';
import { postSignedFederationJson } from './discovery';
import { federationUserPayload } from './federationPayload';

// Helpers for the routes that pass a request on to the homeserver hosting a guild or DM.
// They all do the same dance: sign the request, send it, turn the remote's errors into ours
// and check that a successful answer has the shape we expect.

const remoteErrorSchema = z.object({ error: z.string() });

/** `/federation/channels/<id>/<action>`, the url of an action on a channel the remote hosts. */
export const federationChannelPath = (channel: { id: string }, action: string) =>
  `/federation/channels/${encodeURIComponent(channel.id)}/${action}`;

/**
 * A `forward` map that keeps these statuses as they are: `passThrough(404, 403)` is `{ 404: 404, 403: 403 }`.
 * Spread it and override single entries to translate a status, e.g. `{ ...passThrough(404), 403: 401 }`.
 */
export const passThrough = <const Status extends number>(...statuses: Status[]) =>
  Object.fromEntries(statuses.map((status) => [status, status])) as { [S in Status]: S };

type Failure<Status extends number> = { ok: false; status: Status | 502; error: { error: string } };

/**
 * Sends `body` to a path on the remote homeserver as `session`'s user, and returns either the
 * parsed answer or the error to give back to our own client.
 *
 * - `forward` maps the error statuses of the remote to the status we answer with. Any other
 *   status becomes a 502, since it means something is wrong with the remote, not with the client.
 * - `errors` are the messages used when the remote didn't explain itself (`failed`) or answered
 *   success with something that doesn't match `response` (`invalid`).
 */
export async function callRemote<Schema extends z.ZodType, Status extends number>(
  homeserver: string,
  path: string,
  session: Parameters<typeof federationUserPayload>[0],
  body: Record<string, unknown>,
  options: {
    response: Schema;
    forward: Partial<Record<number, Status>>;
    errors: { failed: string; invalid: string };
  }
): Promise<{ ok: true; data: z.infer<Schema> } | Failure<Status>> {
  const fail = (status: Status | 502, error: string): Failure<Status> => ({
    ok: false,
    status,
    error: { error },
  });

  const result = await postSignedFederationJson(homeserver, path, {
    user: federationUserPayload(session),
    ...body,
  }).catch(() => null);
  if (!result) return fail(502, 'Could not reach remote homeserver');

  if (!result.response.ok) {
    const remoteError = remoteErrorSchema.safeParse(result.data);
    return {
      ok: false,
      status: options.forward[result.response.status] ?? 502,
      error: remoteError.success ? remoteError.data : { error: options.errors.failed },
    };
  }

  const data = options.response.safeParse(result.data);
  if (!data.success) return fail(502, options.errors.invalid);
  return { ok: true, data: data.data };
}
