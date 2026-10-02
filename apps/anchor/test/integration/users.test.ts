import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { openRealtime } from '../harness/ws';
import { signup } from '../harness/users';

let anchor: RunningAnchor;
beforeAll(async () => {
  // 0.05 MB is plenty for a tiny png and small enough to exceed in a test
  anchor = await spawnAnchor({ name: 'users', s3: true, config: { files: { max_avatar_size: 0.05 } } });
});
afterAll(() => anchor?.destroy());

const png = (color: { r: number; g: number; b: number }, size = 16) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();

const upload = (u: Awaited<ReturnType<typeof signup>>, field: 'avatar' | 'banner', data: string | Uint8Array, type = 'image/png') => {
  const form = new FormData();
  form.set(field, new File([data], 'file', { type }));
  return u.fetch(`/user/${field}`, { method: 'POST', body: form });
};

const redirectTarget = async (path: string) => {
  const res = await fetch(`${anchor.url}${path}`, { redirect: 'manual' });
  return { res, location: res.headers.get('location') };
};

describe('about', () => {
  test('defaults to null, can be set, read by anyone and cleared', async () => {
    const u = await signup(anchor.url);
    const read = async () => (await (await fetch(`${anchor.url}/user/about/${u.user.id}`)).json()) as any;
    expect((await read()).about).toBeNull();

    const res = await u.fetch('/user/about', { method: 'POST', body: JSON.stringify({ about: 'hello there' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.about).toBe('hello there');
    expect((await read()).about).toBe('hello there');

    await u.fetch('/user/about', { method: 'POST', body: JSON.stringify({ about: null }) });
    expect((await read()).about).toBeNull();
  });

  test('accepts 512 characters and rejects 513', async () => {
    const u = await signup(anchor.url);
    const set = (about: string) => u.fetch('/user/about', { method: 'POST', body: JSON.stringify({ about }) });
    expect((await set('a'.repeat(512))).status).toBe(200);
    expect((await set('a'.repeat(513))).status).toBe(422);
    expect(((await (await fetch(`${anchor.url}/user/about/${u.user.id}`)).json()) as any).about).toHaveLength(512);
  });

  test('unknown user is 404', async () => {
    expect((await fetch(`${anchor.url}/user/about/nobody`)).status).toBe(404);
  });

  test('updating about notifies the user over realtime', async () => {
    const u = await signup(anchor.url);
    const ws = await openRealtime(anchor.url, u.cookie);
    try {
      await u.fetch('/user/about', { method: 'POST', body: JSON.stringify({ about: 'live' }) });
      const event = await ws.waitFor('user.updated', (e) => e.data.user.userId === u.user.id);
      expect(event.data.user.about).toBe('live');
    } finally {
      ws.close();
    }
  });
});

describe('avatar', () => {
  test('upload converts to webp, computes the colour and is served via a presigned redirect', async () => {
    const u = await signup(anchor.url);
    expect((await fetch(`${anchor.url}/user/avatar/${u.user.id}`)).status).toBe(404);

    const res = await upload(u, 'avatar', await png({ r: 255, g: 0, b: 0 }));
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as any;
    expect(user.avatarUrl).toContain(`/user/avatar/${u.user.id}?v=`);
    expect(user.avatarColor).toMatch(/^#FF0000$/i);

    const { res: redirect, location } = await redirectTarget(`/user/avatar/${u.user.id}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('cache-control')).toBe('no-store');
    const stored = await fetch(location!);
    expect(stored.status).toBe(200);
    const meta = await sharp(Buffer.from(await stored.arrayBuffer())).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(16);

    const me = (await (await u.fetch('/auth/me')).json()) as any;
    expect(me.user.avatarUrl).toBe(user.avatarUrl);
  });

  test('a second upload replaces the first', async () => {
    const u = await signup(anchor.url);
    await upload(u, 'avatar', await png({ r: 255, g: 0, b: 0 }));
    const second = (await (await upload(u, 'avatar', await png({ r: 0, g: 0, b: 255 }, 32))).json()) as any;
    expect(second.user.avatarColor).toMatch(/^#0000FF$/i);
    const { location } = await redirectTarget(`/user/avatar/${u.user.id}`);
    const meta = await sharp(Buffer.from(await (await fetch(location!)).arrayBuffer())).metadata();
    expect(meta.width).toBe(32);
  });

  test('an animated gif is flagged animated', async () => {
    const u = await signup(anchor.url);
    const frame = (v: number) => png({ r: v, g: v, b: v }, 8);
    const gif = await sharp([await frame(255), await frame(0)], { join: { animated: true } })
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer();
    const res = await upload(u, 'avatar', gif, 'image/gif');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.avatarUrl).toContain('animated=1');
  });

  test('non png/gif content types are 415', async () => {
    const u = await signup(anchor.url);
    expect((await upload(u, 'avatar', 'just text', 'text/plain')).status).toBe(415);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    expect((await upload(u, 'avatar', jpeg, 'image/jpeg')).status).toBe(415);
    expect((await fetch(`${anchor.url}/user/avatar/${u.user.id}`)).status).toBe(404);
  });

  test('a file over max_avatar_size is rejected and the avatar is unchanged', async () => {
    const u = await signup(anchor.url);
    const res = await upload(u, 'avatar', Buffer.alloc(60 * 1024, 1));
    expect([413, 422]).toContain(res.status);
    expect((await fetch(`${anchor.url}/user/avatar/${u.user.id}`)).status).toBe(404);
  });

  test('a corrupt image with an image content type is a 4xx', async () => {
    const u = await signup(anchor.url);
    const res = await upload(u, 'avatar', 'definitely not a png');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // gap: only avatars/<id>.webp is ever written, but ?format=png|gif redirects to other keys
  test.failing('?format=png redirects to an object that exists', async () => {
    const u = await signup(anchor.url);
    await upload(u, 'avatar', await png({ r: 255, g: 0, b: 0 }));
    const { location } = await redirectTarget(`/user/avatar/${u.user.id}?format=png`);
    expect((await fetch(location!)).status).toBe(200);
  });

  test('uploading requires a session', async () => {
    const form = new FormData();
    form.set('avatar', new File([await png({ r: 1, g: 1, b: 1 })], 'a.png', { type: 'image/png' }));
    expect((await fetch(`${anchor.url}/user/avatar`, { method: 'POST', body: form })).status).toBe(401);
  });
});

describe('avatar colour', () => {
  test('sets both colours upper-cased and persists them', async () => {
    const u = await signup(anchor.url);
    const res = await u.fetch('/user/avatar/color', {
      method: 'POST',
      body: JSON.stringify({ avatarColor: '#aabbcc', speakingRingColor: '#00ff7f' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ avatarColor: '#AABBCC', speakingRingColor: '#00FF7F' });
    const me = (await (await u.fetch('/auth/me')).json()) as any;
    expect(me.user).toMatchObject({ avatarColor: '#AABBCC', speakingRingColor: '#00FF7F' });
  });

  test.each(['red', '#abc', '#gggggg', 'aabbcc', '#aabbccdd'])('rejects %p', async (bad) => {
    const u = await signup(anchor.url);
    const res = await u.fetch('/user/avatar/color', {
      method: 'POST',
      body: JSON.stringify({ avatarColor: bad, speakingRingColor: '#000000' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('banner', () => {
  test('upload is stored as webp and served via a redirect', async () => {
    const u = await signup(anchor.url);
    expect((await fetch(`${anchor.url}/user/banner/${u.user.id}`)).status).toBe(404);
    const res = await upload(u, 'banner', await png({ r: 0, g: 255, b: 0 }, 24));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.bannerUrl).toContain(`/user/banner/${u.user.id}?v=`);
    const { res: redirect, location } = await redirectTarget(`/user/banner/${u.user.id}`);
    expect(redirect.status).toBe(302);
    const meta = await sharp(Buffer.from(await (await fetch(location!)).arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 24 });
  });

  test('wrong type is 415, oversized is rejected', async () => {
    const u = await signup(anchor.url);
    expect((await upload(u, 'banner', 'text', 'text/plain')).status).toBe(415);
    expect([413, 422]).toContain((await upload(u, 'banner', Buffer.alloc(60 * 1024, 1))).status);
  });
});
