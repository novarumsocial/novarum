import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { connect } from '../harness/db';
import { signup } from '../harness/users';

// needs Garage (test/compose.yml). Attachments are presigned PUTs straight to storage; the message send claims them.
let anchor: RunningAnchor;
let cdn: RunningAnchor;
beforeAll(async () => {
  anchor = await spawnAnchor({
    name: 'uploads',
    s3: true,
    config: { misc: { save_attachment_thumbnails: true }, files: { max_file_size: 1 } },
  });
  cdn = await spawnAnchor({ name: 'uploadscdn', s3: true, config: { files: { cdn_signing_secret: 'test-cdn-secret' } } });
});
afterAll(async () => {
  await Promise.all([anchor?.destroy(), cdn?.destroy()]);
});

type User = Awaited<ReturnType<typeof signup>>;
type Presigned = { attachmentId: string; uploadUrl: string; headers: Record<string, string> };

/** owner + guild + its default channel; `join` adds another user through the invite flow */
async function setup(url = anchor.url, databaseUrl = anchor.databaseUrl) {
  const owner = await signup(url);
  const { guild } = (await (await owner.fetch('/guilds/create', { method: 'POST', body: JSON.stringify({ name: 'g' }) })).json()) as any;
  const sql = connect(databaseUrl);
  let channelId: string;
  try {
    [{ id: channelId }] = await sql`SELECT id FROM channel WHERE "guildId" = ${guild.id}`;
  } finally {
    await sql.close();
  }
  const join = async () => {
    const member = await signup(url);
    const { invite } = (await (await owner.fetch(`/guilds/${guild.id}/invites`, { method: 'POST', body: '{}' })).json()) as any;
    expect((await member.fetch('/invite/accept', { method: 'POST', body: JSON.stringify({ code: invite.code }) })).status).toBe(200);
    return member;
  };
  return { owner, channelId: channelId!, guildId: guild.id as string, join };
}

const presign = (u: User, body: Record<string, unknown>) => u.fetch('/upload/presign', { method: 'POST', body: JSON.stringify(body) });
const put = (p: Presigned, data: string | Uint8Array) => fetch(p.uploadUrl, { method: 'PUT', headers: p.headers, body: data });

/** presign + PUT in one go */
async function uploaded(u: User, channelId: string, data: Uint8Array | Buffer, contentType: string, filename = 'file.bin') {
  const res = await presign(u, { channelId, filename, contentType, size: data.byteLength });
  expect(res.status).toBe(200);
  const p = (await res.json()) as Presigned;
  const stored = await put(p, data);
  expect(stored.status).toBe(200);
  return p;
}

const send = (u: User, channelId: string, attachmentIds: string[], content: string | null = null) =>
  u.fetch('/message/send', { method: 'POST', body: JSON.stringify({ channelId, content, nonce: crypto.randomUUID(), attachmentIds }) });

const png = (size = 600) =>
  sharp({ create: { width: size, height: size / 2, channels: 3, background: '#336699' } }).png().toBuffer();

describe('presign', () => {
  test('returns an id, a presigned PUT url and the headers to send', async () => {
    const { owner, channelId } = await setup();
    const res = await presign(owner, { channelId, filename: 'notes.txt', contentType: 'text/plain', size: 5 });
    expect(res.status).toBe(200);
    const p = (await res.json()) as Presigned;
    expect(p.attachmentId).toBeTruthy();
    expect(new URL(p.uploadUrl).searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(p.headers).toEqual({ 'content-type': 'text/plain' });
  });

  test('rejects an unsupported content type with 415', async () => {
    const { owner, channelId } = await setup();
    for (const contentType of ['text/html', 'application/x-msdownload', 'image/svg+xml']) {
      expect((await presign(owner, { channelId, filename: 'a', contentType, size: 5 })).status).toBe(415);
    }
  });

  test('rejects sizes outside 1..max_file_size with 422', async () => {
    const { owner, channelId } = await setup();
    const sizes = [0, -1, 1024 * 1024 + 1, 1.5];
    for (const size of sizes) {
      expect((await presign(owner, { channelId, filename: 'a', contentType: 'text/plain', size })).status).toBe(422);
    }
    expect((await presign(owner, { channelId, filename: 'a', contentType: 'text/plain', size: 1024 * 1024 })).status).toBe(200);
  });

  test('rejects an empty or 256 character filename', async () => {
    const { owner, channelId } = await setup();
    for (const filename of ['', 'a'.repeat(256)]) {
      expect((await presign(owner, { channelId, filename, contentType: 'text/plain', size: 5 })).status).toBe(422);
    }
  });

  test('unknown channel is 404 and a non-member is 403', async () => {
    const { owner, channelId } = await setup();
    const stranger = await signup(anchor.url);
    expect((await presign(owner, { channelId: 'nope', filename: 'a', contentType: 'text/plain', size: 5 })).status).toBe(404);
    expect((await presign(stranger, { channelId, filename: 'a', contentType: 'text/plain', size: 5 })).status).toBe(403);
  });

  test('a path in the filename is reduced to its last segment', async () => {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, Buffer.from('hello'), 'text/plain', '../../etc/pass wd?.txt');
    const { message } = (await (await send(owner, channelId, [p.attachmentId])).json()) as any;
    expect(message.attachments[0].filename).toBe('pass wd_.txt');
  });
});

describe('upload and send', () => {
  test('presign -> PUT -> send: the message carries a signed url that serves the bytes', async () => {
    const { owner, channelId } = await setup();
    const data = Buffer.from('some attachment bytes');
    const p = await uploaded(owner, channelId, data, 'text/plain', 'a.txt');
    const res = await send(owner, channelId, [p.attachmentId], 'with file');
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as any;
    expect(message.content).toBe('with file');
    expect(message.attachments).toHaveLength(1);
    const [att] = message.attachments;
    expect(att).toMatchObject({ id: p.attachmentId, filename: 'a.txt', contentType: 'text/plain', size: data.byteLength });
    const url = new URL(att.url);
    expect(url.pathname).toBe(`/attachment/${p.attachmentId}`);
    expect(Number(url.searchParams.get('exp'))).toBeGreaterThan(Date.now() / 1000);

    // the signed url is the credential: no cookie needed; it redirects to storage
    const redirect = await fetch(`${anchor.url}${url.pathname}${url.search}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('cache-control')).toBe('no-store');
    const file = await fetch(redirect.headers.get('location')!);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
    expect(file.headers.get('content-disposition')).toContain('filename="a.txt"');

    // and it shows up in the channel history
    const list = (await (await owner.fetch(`/message/list?channelId=${channelId}&cursor=0&amount=50`)).json()) as any;
    expect(JSON.stringify(list)).toContain(p.attachmentId);
  });

  test('an attachment alone is a valid message, and a message with neither is 400', async () => {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, Buffer.from('x'), 'text/plain');
    expect((await send(owner, channelId, [p.attachmentId], null)).status).toBe(200);
    expect((await send(owner, channelId, [], null)).status).toBe(400);
  });

  test('several attachments, up to the maximum of 5', async () => {
    const { owner, channelId } = await setup();
    const ps = await Promise.all([1, 2, 3, 4, 5].map((i) => uploaded(owner, channelId, Buffer.from(`file ${i}`), 'text/plain')));
    const res = await send(owner, channelId, ps.map((p) => p.attachmentId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).message.attachments).toHaveLength(5);
  });

  test('more than 5 attachment ids is 422', async () => {
    const { owner, channelId } = await setup();
    const ps = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => uploaded(owner, channelId, Buffer.from(`file ${i}`), 'text/plain')));
    expect((await send(owner, channelId, ps.map((p) => p.attachmentId))).status).toBe(422);
  });

  test('duplicate ids in one message are 422', async () => {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, Buffer.from('x'), 'text/plain');
    expect((await send(owner, channelId, [p.attachmentId, p.attachmentId])).status).toBe(422);
  });

  test('an unknown id is 400', async () => {
    const { owner, channelId } = await setup();
    const res = await send(owner, channelId, ['does-not-exist']);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('Invalid attachment');
  });

  test('someone else\'s pending attachment is 400 and stays claimable by its uploader', async () => {
    const { owner, channelId, join } = await setup();
    const member = await join();
    const p = await uploaded(owner, channelId, Buffer.from('mine'), 'text/plain');
    expect((await send(member, channelId, [p.attachmentId])).status).toBe(400);
    expect((await send(owner, channelId, [p.attachmentId])).status).toBe(200);
  });

  test('an attachment cannot be sent to a different channel than it was presigned for', async () => {
    const { owner, channelId, guildId } = await setup();
    const created = await owner.fetch('/channel/create', {
      method: 'POST',
      body: JSON.stringify({ guildId, name: 'two', type: 'TEXT' }),
    });
    expect(created.status).toBe(200);
    const otherChannel = ((await created.json()) as any).id as string;
    const p = await uploaded(owner, channelId, Buffer.from('x'), 'text/plain');
    expect((await send(owner, otherChannel, [p.attachmentId])).status).toBe(400);
    expect((await send(owner, channelId, [p.attachmentId])).status).toBe(200);
  });

  test('an attachment can only be claimed once', async () => {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, Buffer.from('x'), 'text/plain');
    expect((await send(owner, channelId, [p.attachmentId])).status).toBe(200);
    expect((await send(owner, channelId, [p.attachmentId])).status).toBe(400);
  });

  test('sending before the PUT finished is 400', async () => {
    const { owner, channelId } = await setup();
    const res = await presign(owner, { channelId, filename: 'late.txt', contentType: 'text/plain', size: 5 });
    const p = (await res.json()) as Presigned;
    const sent = await send(owner, channelId, [p.attachmentId]);
    expect(sent.status).toBe(400);
    expect(((await sent.json()) as any).error).toContain('has not finished uploading');
    // uploading afterwards makes it sendable
    expect((await put(p, 'hello')).status).toBe(200);
    expect((await send(owner, channelId, [p.attachmentId])).status).toBe(200);
  });

  test('an uploaded size that differs from the declared size is 400 and the object is discarded', async () => {
    const { owner, channelId } = await setup();
    const res = await presign(owner, { channelId, filename: 'lie.txt', contentType: 'text/plain', size: 5 });
    const p = (await res.json()) as Presigned;
    expect((await put(p, 'this is much longer than five bytes')).status).toBe(200);
    const sent = await send(owner, channelId, [p.attachmentId]);
    expect(sent.status).toBe(400);
    expect(((await sent.json()) as any).error).toContain('invalid size');
    expect((await send(owner, channelId, [p.attachmentId])).status).toBe(400);
  });

  test('a non-member cannot send to the channel even with a valid attachment id', async () => {
    const { owner, channelId } = await setup();
    const stranger = await signup(anchor.url);
    const p = await uploaded(owner, channelId, Buffer.from('x'), 'text/plain');
    expect((await send(stranger, channelId, [p.attachmentId])).status).toBe(403);
  });
});

describe('signed attachment urls', () => {
  async function attached() {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, await png(), 'image/png', 'pic.png');
    const { message } = (await (await send(owner, channelId, [p.attachmentId])).json()) as any;
    return { p, owner, channelId, att: message.attachments[0] as { url: string; previewUrl: string; id: string } };
  }
  const local = (u: string) => {
    const url = new URL(u);
    return { path: url.pathname, params: url.searchParams };
  };
  const get = (path: string, params: URLSearchParams) => fetch(`${anchor.url}${path}?${params}`, { redirect: 'manual' });

  test('a tampered signature, a changed expiry and a past expiry are all 404', async () => {
    const { att } = await attached();
    const { path, params } = local(att.url);
    expect((await get(path, params)).status).toBe(302);

    const badSig = new URLSearchParams(params);
    badSig.set('sig', params.get('sig')!.slice(0, -1) + (params.get('sig')!.endsWith('A') ? 'B' : 'A'));
    expect((await get(path, badSig)).status).toBe(404);

    const otherExp = new URLSearchParams(params);
    otherExp.set('exp', String(Number(params.get('exp')) + 86400));
    expect((await get(path, otherExp)).status).toBe(404);

    const past = new URLSearchParams({ exp: String(Math.floor(Date.now() / 1000) - 60) });
    past.set('sig', createHmac('sha256', 'whatever').update('x').digest('base64url'));
    expect((await get(path, past)).status).toBe(404);

    const short = new URLSearchParams({ exp: params.get('exp')!, sig: 'x' });
    expect((await get(path, short)).status).toBe(404);
  });

  test('a signature for one attachment does not open another', async () => {
    const one = await attached();
    const two = await attached();
    const { params } = local(one.att.url);
    expect((await get(`/attachment/${two.att.id}`, params)).status).toBe(404);
  });

  test('missing query parameters are 422 and an unattached (pending) attachment is 404', async () => {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, Buffer.from('x'), 'text/plain');
    expect((await fetch(`${anchor.url}/attachment/${p.attachmentId}`)).status).toBe(422);
    // signed with the right secret is impossible here, so a made-up signature must not reveal it either
    expect((await get(`/attachment/${p.attachmentId}`, new URLSearchParams({ exp: '9999999999', sig: 'abc' }))).status).toBe(404);
  });

  const previewOf = async (att: { previewUrl: string }) => {
    const { path, params } = local(att.previewUrl);
    return fetch(`${anchor.url}${path}?${params}`);
  };

  test('an image preview is generated as a scaled-down webp', async () => {
    const { att } = await attached();
    expect(local(att.previewUrl).path).toBe(`/attachment/${att.id}/preview`);
    const res = await previewOf(att);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 150 }); // 600px wide source, 1/4 scale
  });

  test('a cached preview is still the same image', async () => {
    const { att } = await attached();
    const first = Buffer.from(await (await previewOf(att)).arrayBuffer());
    const second = await previewOf(att); // save_attachment_thumbnails: served from storage this time
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(first);
  });

  // gap: the cached copy is served with `file.type` from a bare S3 file handle, which comes back as ", application/octet-stream"
  test.failing('a cached preview keeps its image/webp content type', async () => {
    const { att } = await attached();
    await previewOf(att);
    expect((await previewOf(att)).headers.get('content-type')).toBe('image/webp');
  });

  test('previews of non-images are 404, and the preview url needs a valid signature', async () => {
    const { owner, channelId } = await setup();
    const p = await uploaded(owner, channelId, Buffer.from('plain'), 'text/plain');
    const { message } = (await (await send(owner, channelId, [p.attachmentId])).json()) as any;
    const { path, params } = local(message.attachments[0].previewUrl);
    expect((await get(path, params)).status).toBe(404);
    expect((await get(path, new URLSearchParams({ exp: params.get('exp')!, sig: 'bad' }))).status).toBe(404);
  });
});

describe('cdn signing', () => {
  test('presigned upload urls carry a cdn_exp/cdn_sig over the path when cdn_signing_secret is set', async () => {
    const { owner, channelId } = await setup(cdn.url, cdn.databaseUrl);
    const res = await presign(owner, { channelId, filename: 'a.txt', contentType: 'text/plain', size: 5 });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as Presigned).uploadUrl);
    const exp = url.searchParams.get('cdn_exp')!;
    expect(Number(exp)).toBeGreaterThan(Date.now() / 1000);
    expect(Number(exp)).toBeLessThanOrEqual(Date.now() / 1000 + 5 * 60 + 5);
    expect(url.searchParams.get('cdn_sig')).toBe(createHmac('sha256', 'test-cdn-secret').update(`${url.pathname}:${exp}`).digest('hex'));
  });

  test('without the secret the urls have no cdn params', async () => {
    const { owner, channelId } = await setup();
    const url = new URL(((await (await presign(owner, { channelId, filename: 'a.txt', contentType: 'text/plain', size: 5 })).json()) as Presigned).uploadUrl);
    expect(url.searchParams.has('cdn_sig')).toBe(false);
  });
});
