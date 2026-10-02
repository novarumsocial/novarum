import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { spawnAnchor, type RunningAnchor } from '../harness/anchor';
import { signup } from '../harness/users';
import { createGuild } from '../harness/realtime';

// needs Garage (test/compose.yml). Abuse of the presign -> PUT -> send flow and of the preview (sharp / node-av) path.
let anchor: RunningAnchor;
let owner: Awaited<ReturnType<typeof signup>>;
let channelId: string;
beforeAll(async () => {
  anchor = await spawnAnchor({ name: 'uploadabuse', s3: true, config: { files: { max_file_size: 1 } } });
  owner = await signup(anchor.url);
  ({ channelId } = await createGuild(owner));
});
afterAll(() => anchor?.destroy());

type Presigned = { attachmentId: string; uploadUrl: string; headers: Record<string, string> };
const presign = async (declared: { contentType: string; size: number; filename?: string }) => {
  const res = await owner.fetch('/upload/presign', { method: 'POST', body: JSON.stringify({ channelId, filename: 'f.bin', ...declared }) });
  expect(res.status).toBe(200);
  return (await res.json()) as Presigned;
};
const send = (ids: string[]) =>
  owner.fetch('/message/send', { method: 'POST', body: JSON.stringify({ channelId, content: null, nonce: crypto.randomUUID(), attachmentIds: ids }) });
const alive = async () => expect((await fetch(`${anchor.url}/`)).status).toBeLessThan(500);

/** presign for `declared`, PUT `data` with `headers` (default: the presigned ones), return the PUT status and the presign */
async function upload(data: Uint8Array | string, declared: { contentType: string; size?: number }, headers?: Record<string, string>) {
  const size = declared.size ?? (typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength);
  const p = await presign({ contentType: declared.contentType, size });
  const put = await fetch(p.uploadUrl, { method: 'PUT', headers: headers ?? p.headers, body: data });
  return { p, put };
}

/** upload, claim in a message and fetch the preview; returns the preview response status */
async function previewOf(data: Uint8Array | string, contentType: string) {
  const { p, put } = await upload(data, { contentType });
  expect(put.status).toBe(200);
  const sent = await send([p.attachmentId]);
  expect(sent.status).toBe(200);
  const att = ((await sent.json()) as any).message.attachments[0] as { previewUrl: string; url: string };
  const url = new URL(att.previewUrl);
  const res = await fetch(`${anchor.url}${url.pathname}${url.search}`);
  await res.arrayBuffer();
  return { res, att };
}

describe('declared vs uploaded', () => {
  test('uploading more than declared passes the PUT but the send rejects it and deletes the object', async () => {
    const { p, put } = await upload('x'.repeat(5000), { contentType: 'text/plain', size: 5 });
    expect(put.status).toBe(200);
    const sent = await send([p.attachmentId]);
    expect(sent.status).toBe(400);
    expect(((await sent.json()) as any).error).toContain('invalid size');
    expect((await send([p.attachmentId])).status).toBe(400);
  });

  test('uploading less than declared is rejected the same way', async () => {
    const { p, put } = await upload('tiny', { contentType: 'text/plain', size: 5000 });
    expect(put.status).toBe(200);
    expect((await send([p.attachmentId])).status).toBe(400);
  });

  test('a body bigger than max_file_size (1MB) can still be PUT to storage, but is never claimable', async () => {
    const { p, put } = await upload(new Uint8Array(2 * 1024 * 1024), { contentType: 'application/octet-stream', size: 10 });
    expect(put.status).toBe(200);
    expect((await send([p.attachmentId])).status).toBe(400);
  });

  // gap: Content-Type is not part of the presigned signature, so the uploader picks the type storage serves the object with
  test.failing('a PUT with a different Content-Type than presigned is refused by storage', async () => {
    const { put } = await upload('<html>hi</html>', { contentType: 'text/plain' }, { 'content-type': 'text/html' });
    expect(put.status).toBeGreaterThanOrEqual(400);
  });

  test('...and the claimed attachment is still reported (and downloaded through the redirect) with a type', async () => {
    const { p, put } = await upload('<html>hi</html>', { contentType: 'text/plain' }, { 'content-type': 'text/html' });
    expect(put.status).toBe(200); // pins the gap above
    const att = ((await (await send([p.attachmentId])).json()) as any).message.attachments[0];
    expect(att.contentType).toBe('text/plain'); // the DB keeps the declared type
    const url = new URL(att.url);
    const redirect = await fetch(`${anchor.url}${url.pathname}${url.search}`, { redirect: 'manual' });
    const stored = await fetch(redirect.headers.get('location')!);
    expect(stored.headers.get('content-type')).toBe('text/html'); // storage serves what the uploader sent
  });

  test('re-using the presigned URL overwrites the object; the claim checks the final size', async () => {
    const { p } = await upload('12345', { contentType: 'text/plain' });
    const again = await fetch(p.uploadUrl, { method: 'PUT', headers: p.headers, body: 'a much longer replacement' });
    expect(again.status).toBe(200);
    expect((await send([p.attachmentId])).status).toBe(400);
  });

  test('a tampered presigned URL is refused by storage', async () => {
    const p = await presign({ contentType: 'text/plain', size: 5 });
    const url = new URL(p.uploadUrl);
    url.pathname = url.pathname.replace(/[^/]+$/, 'someone-elses-object');
    const put = await fetch(url, { method: 'PUT', headers: p.headers, body: 'hello' });
    expect(put.status).toBeGreaterThanOrEqual(400);
  });
});

describe('content posing as something else', () => {
  test('SVG and HTML cannot be declared as an upload type', async () => {
    for (const contentType of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'image/png; charset=utf-8', 'IMAGE/PNG', ' image/png']) {
      const res = await owner.fetch('/upload/presign', { method: 'POST', body: JSON.stringify({ channelId, filename: 'a', contentType, size: 5 }) });
      expect(res.status).toBe(415);
    }
  });

  test('an SVG declared as image/png is stored, but has no preview and the download is a signed redirect to storage', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { res, att } = await previewOf(svg, 'image/png');
    expect(res.status).toBe(404);
    const url = new URL(att.url);
    const redirect = await fetch(`${anchor.url}${url.pathname}${url.search}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    // served from the storage origin, not from the anchor's own origin
    expect(new URL(redirect.headers.get('location')!).origin).not.toBe(new URL(anchor.url).origin);
    await alive();
  });

  test('HTML declared as text/plain or image/jpeg gets no preview', async () => {
    expect((await previewOf('<html><script>1</script></html>', 'text/plain')).res.status).toBe(404);
    expect((await previewOf('<html><script>1</script></html>', 'image/jpeg')).res.status).toBe(404);
  });

  test('a real PNG declared as text/plain still previews (the preview sniffs bytes, not the declared type)', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await previewOf(png, 'text/plain')).res.status).toBe(200);
  });
});

describe('malformed media in the preview path never takes the process down', () => {
  const header = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff, 0xe0],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    riff: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    mp4: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
    mp4b: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70],
    webm: [0x1a, 0x45, 0xdf, 0xa3],
  };
  const junk = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
  const cat = (head: number[], tail: Uint8Array) => Uint8Array.from([...head, ...tail]);
  const cases: [string, string, () => Uint8Array | Promise<Uint8Array>][] = [
    ['png header only', 'image/png', () => Uint8Array.from(header.png)],
    ['png header + junk', 'image/png', () => cat(header.png, junk(2000))],
    ['truncated real png', 'image/png', async () => (await sharp({ create: { width: 200, height: 200, channels: 3, background: '#123456' } }).png().toBuffer()).subarray(0, 60)],
    ['jpeg header + junk', 'image/jpeg', () => cat(header.jpeg, junk(2000))],
    ['gif header + junk', 'image/gif', () => cat(header.gif, junk(500))],
    ['riff/webp header + junk', 'image/webp', () => cat(header.riff, junk(500))],
    ['mp4 ftyp + junk', 'video/mp4', () => cat(header.mp4, junk(5000))],
    ['mp4 ftyp (0x20) only', 'video/mp4', () => Uint8Array.from(header.mp4b)],
    ['webm header + junk', 'video/mp4', () => cat(header.webm, junk(3000))],
    ['webm header only', 'video/mp4', () => Uint8Array.from(header.webm)],
    ['one byte of each magic', 'application/octet-stream', () => Uint8Array.from([0xff])],
  ];

  for (const [name, contentType, make] of cases) {
    test(`${name}: gets an answer (no hang or crash) and the server keeps serving`, async () => {
      const { res } = await previewOf(await make(), contentType);
      expect([200, 404, 500]).toContain(res.status);
      await alive();
    });
  }

  // gap: sharp / node-av errors are not caught in /attachment/:id/preview, so malformed media is a 500 instead of a 404
  test.failing('malformed media gets a 4xx preview answer, not a 500', async () => {
    for (const [, contentType, make] of cases.slice(0, 10)) expect((await previewOf(await make(), contentType)).res.status).toBeLessThan(500);
  });

  test('an image header declaring 60000x60000 pixels (decompression bomb) is refused', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#000' } }).png().toBuffer();
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(60000, 16); // IHDR width
    bomb.writeUInt32BE(60000, 20); // IHDR height
    const { res } = await previewOf(bomb, 'image/png');
    expect([404, 500]).toContain(res.status);
    await alive();
  });

  test('previews of every malformed file in a burst do not crash the process', async () => {
    const bad = [...cases].slice(0, 8);
    await Promise.all(bad.map(async ([, ct, make]) => previewOf(await make(), ct)));
    await alive();
    expect(anchor.logs().includes('Segmentation fault')).toBe(false);
  });
});
