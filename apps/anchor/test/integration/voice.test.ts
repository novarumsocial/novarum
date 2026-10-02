import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { z } from 'zod';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { livekitUrl } from '../harness/env';
import { befriend, connect, createGuild, joinGuild, post } from '../harness/realtime';
import { signup, type TestUser } from '../harness/users';

// @livekit: needs the optional livekit container, e.g.
//   docker compose -f test/compose.yml --profile livekit up -d livekit
//   ANCHOR_TEST_LIVEKIT=1 ANCHOR_TEST_LIVEKIT_URL=ws://127.0.0.1:$TEST_LIVEKIT_PORT bun test test/integration/voice.test.ts
const enabled = process.env.ANCHOR_TEST_LIVEKIT === '1';

// same values as test/config.toml [voice]
const key = 'devkey';
const secret = 'test-livekit-secret-not-real-0123456789';

setDefaultTimeout(30_000);

const claimsSchema = z.object({
  sub: z.string(),
  name: z.string(),
  metadata: z.string(),
  iss: z.literal(key),
  exp: z.number(),
  nbf: z.number(),
  video: z.object({
    roomJoin: z.literal(true),
    room: z.string(),
    canPublish: z.literal(true),
    canSubscribe: z.literal(true),
    canPublishData: z.literal(true),
  }),
});

/** what livekit does: POST the event body with a JWT whose sha256 claim is the body's base64 sha256 */
async function webhook(anchor: RunningAnchor, event: object, signWith = secret, tamperBody = false) {
  const body = JSON.stringify({ id: crypto.randomUUID(), createdAt: Math.floor(Date.now() / 1000), ...event });
  const token = new AccessToken(key, signWith);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return fetch(`${anchor.url}/channel/livekit/webhook`, {
    method: 'POST',
    headers: { authorization: await token.toJwt(), 'content-type': 'application/webhook+json' },
    body: tamperBody ? `${body} ` : body,
  });
}

describe.skipIf(!enabled)('voice @livekit', () => {
  let anchor: RunningAnchor;
  beforeAll(async () => {
    anchor = await spawnAnchor({ name: 'voice' });
  });
  afterAll(() => anchor.destroy());

  async function voiceChannel(owner: TestUser) {
    const { guildId } = await createGuild(owner);
    const channel = await post(owner, '/channel/create', { name: 'voice', guildId, type: 'VOICE' });
    return { guildId, channelId: channel.id as string };
  }

  describe('GET /channel/:id/call/token', () => {
    test('returns a signed JWT for voice:<channel> with the user identity and join grants', async () => {
      const u = await signup(anchor.url, { displayName: 'Vox Pop' });
      const { guildId, channelId } = await voiceChannel(u);
      const res = await u.fetch(`/channel/${channelId}/call/token`);
      expect(res.status).toBe(200);
      const body = z.object({ serverUrl: z.string(), token: z.string() }).parse(await res.json());
      expect(body.serverUrl).toBe(livekitUrl);

      // signature and expiry are verified by livekit's own verifier; claims decoded from the payload
      await new TokenVerifier(key, secret).verify(body.token);
      const claims = claimsSchema.parse(JSON.parse(Buffer.from(body.token.split('.')[1]!, 'base64url').toString()));
      expect(claims.sub).toBe(u.user.id);
      expect(claims.name).toBe('Vox Pop');
      expect(claims.video.room).toBe(`voice:${channelId}`);
      expect(JSON.parse(claims.metadata)).toEqual({ channelId, guildId, userId: u.user.id });
      expect(claims.exp - claims.nbf).toBeGreaterThan(250);
      expect(claims.exp - claims.nbf).toBeLessThanOrEqual(310);
    });

    test('a token signed with another secret fails verification', async () => {
      const u = await signup(anchor.url);
      const { channelId } = await voiceChannel(u);
      const { token } = (await (await u.fetch(`/channel/${channelId}/call/token`)).json()) as { token: string };
      await expect(new TokenVerifier(key, 'some-other-secret-0123456789abcdef').verify(token)).rejects.toThrow();
    });

    test('a guild member can get a token', async () => {
      const owner = await signup(anchor.url);
      const guest = await signup(anchor.url);
      const { guildId, channelId } = await voiceChannel(owner);
      await joinGuild(owner, guest, guildId);
      expect((await guest.fetch(`/channel/${channelId}/call/token`)).status).toBe(200);
    });

    test('non-member is refused', async () => {
      const owner = await signup(anchor.url);
      const outsider = await signup(anchor.url);
      const { channelId } = await voiceChannel(owner);
      // the route answers 401 for a non-member
      expect((await outsider.fetch(`/channel/${channelId}/call/token`)).status).toBe(401);
    });

    // Known gap: the plan expects 403 (the response schema even declares it) but the route returns 401.
    test.failing('non-member gets 403, not 401', async () => {
      const owner = await signup(anchor.url);
      const outsider = await signup(anchor.url);
      const { channelId } = await voiceChannel(owner);
      expect((await outsider.fetch(`/channel/${channelId}/call/token`)).status).toBe(403);
    });

    test('no cookie, text channel and unknown channel', async () => {
      const u = await signup(anchor.url);
      const { channelId: textId } = await createGuild(u);
      const { channelId } = await voiceChannel(u);
      expect((await fetch(`${anchor.url}/channel/${channelId}/call/token`)).status).toBe(401);
      expect((await u.fetch(`/channel/${textId}/call/token`)).status).toBe(404);
      expect((await u.fetch('/channel/nope/call/token')).status).toBe(404);
    });

    test('DM participants can get a token, with the dm id as room', async () => {
      const a = await signup(anchor.url);
      const b = await signup(anchor.url);
      const outsider = await signup(anchor.url);
      await befriend(a, b);
      const dm = await post(a, '/dm', { userId: b.user.id });
      const res = await b.fetch(`/channel/${dm.id}/call/token`);
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };
      expect(claimsSchema.parse(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).video.room).toBe(
        `voice:${dm.id}`
      );
      expect((await outsider.fetch(`/channel/${dm.id}/call/token`)).status).toBe(401);
    });
  });

  describe('POST /channel/livekit/webhook', () => {
    const joinedEvent = (u: TestUser, channelId: string, name = 'Webhook Guy') => ({
      event: 'participant_joined',
      room: { name: `voice:${channelId}` },
      participant: { identity: u.user.id, name, metadata: JSON.stringify({ channelId }) },
    });

    // Known gap: an unverifiable webhook should be 401, the SDK's receive() throws and it surfaces as 500.
    test.failing('invalid signature -> 401', async () => {
      const u = await signup(anchor.url);
      const { channelId } = await voiceChannel(u);
      const res = await webhook(anchor, joinedEvent(u, channelId), 'wrong-secret-0123456789abcdefghijkl');
      expect(res.status).toBe(401);
    });

    test('invalid signature, missing and tampered body are rejected and change nothing', async () => {
      const u = await signup(anchor.url);
      const { guildId, channelId } = await voiceChannel(u);
      const rt = await connect(u);
      rt.send({ type: 'subscribe.guild', guildId });
      await rt.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

      const forged = await webhook(anchor, joinedEvent(u, channelId), 'wrong-secret-0123456789abcdefghijkl');
      const tampered = await webhook(anchor, joinedEvent(u, channelId), secret, true);
      const unsigned = await fetch(`${anchor.url}/channel/livekit/webhook`, {
        method: 'POST',
        body: JSON.stringify(joinedEvent(u, channelId)),
      });
      for (const res of [forged, tampered, unsigned]) expect(res.status).toBeGreaterThanOrEqual(400);

      await Bun.sleep(300);
      expect(rt.events.filter((e) => e.type === 'voice.state.changed')).toHaveLength(0);
      expect((await fetch(`${anchor.url}/`)).ok).toBe(true);
      rt.close();
    });

    test('valid participant_joined sets presence and publishes voice.state.changed; participant_left clears it', async () => {
      const owner = await signup(anchor.url);
      const peer = await signup(anchor.url);
      const { guildId, channelId } = await voiceChannel(owner);
      await joinGuild(owner, peer, guildId);
      const rt = await connect(owner);
      rt.send({ type: 'subscribe.guild', guildId });
      await rt.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);

      const joined = await webhook(anchor, joinedEvent(peer, channelId, 'Peer'));
      expect(joined.status).toBe(200);
      expect(await joined.json()).toEqual({ ok: true });
      const ev = await rt.waitFor('voice.state.changed', (e) => e.data.connected);
      expect(
        z
          .object({
            guildId: z.literal(guildId),
            channelId: z.literal(channelId),
            userId: z.literal(peer.user.id),
            name: z.literal('Peer'),
            connected: z.literal(true),
          })
          .parse(ev.data).userId
      ).toBe(peer.user.id);

      // presence is visible in the snapshot of a fresh socket
      const fresh = await connect(owner);
      const snap = await fresh.waitFor('voice.states.snapshot');
      expect(snap.data.states.map((s: any) => s.userId)).toEqual([peer.user.id]);

      const left = await webhook(anchor, {
        event: 'participant_left',
        room: { name: `voice:${channelId}` },
        participant: { identity: peer.user.id, name: 'Peer' },
      });
      expect(left.status).toBe(200);
      const gone = await rt.waitFor('voice.state.changed', (e) => !e.data.connected);
      expect(gone.data).toMatchObject({ userId: peer.user.id, channelId, connected: false });

      const fresh2 = await connect(owner);
      expect((await fresh2.waitFor('voice.states.snapshot')).data.states).toEqual([]);
      for (const r of [rt, fresh, fresh2]) r.close();
    });

    test('participant_left for a room the user is not in is ignored; unrelated events and unknown channels are ok', async () => {
      const owner = await signup(anchor.url);
      const { guildId, channelId } = await voiceChannel(owner);
      const other = await voiceChannel(owner);
      const rt = await connect(owner);
      rt.send({ type: 'subscribe.guild', guildId });
      await rt.waitFor('voice.states.snapshot', (e) => e.data.guildIds[0] === guildId);
      expect((await webhook(anchor, joinedEvent(owner, channelId))).status).toBe(200);
      await rt.waitFor('voice.state.changed', (e) => e.data.connected);

      // stale leave from a different room
      await webhook(anchor, {
        event: 'participant_left',
        room: { name: `voice:${other.channelId}` },
        participant: { identity: owner.user.id },
      });
      expect((await webhook(anchor, { event: 'room_started', room: { name: 'x' } })).status).toBe(200);
      expect((await webhook(anchor, joinedEvent(owner, 'doesnotexist'))).status).toBe(200);
      await Bun.sleep(300);
      expect(rt.events.filter((e) => e.type === 'voice.state.changed' && !e.data.connected)).toHaveLength(0);
      const fresh = await connect(owner);
      expect((await fresh.waitFor('voice.states.snapshot')).data.states.map((s: any) => s.channelId)).toEqual([channelId]);
      rt.close();
      fresh.close();
    });
  });
});
