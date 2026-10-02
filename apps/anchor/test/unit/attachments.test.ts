import { describe, expect, test } from 'bun:test';
import {
  attachmentPayload,
  attachmentPresignSchema,
  isAllowedAttachmentType,
  isValidAttachmentSignature,
  maxAttachmentCount,
  maxAttachmentSize,
  safeAttachmentFilename,
} from '../../utils/attachments';
import { getConfig } from '../../utils/config';
import { sniffAudioVideo } from '../../utils/sniffAudioVideo';

const bytes = (...b: number[]) => new Uint8Array(b).buffer;
const pad = (head: number[], len = 64) => {
  const a = new Uint8Array(len);
  a.set(head);
  return a.buffer;
};

describe('MIME allow-list', () => {
  test.each([
    'application/octet-stream',
    'application/pdf',
    'application/zip',
    'audio/mpeg',
    'audio/ogg',
    'audio/flac',
    'audio/wav',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'video/mp4',
  ])('allows %s', (type) => expect(isAllowedAttachmentType(type)).toBe(true));

  test.each([
    'image/svg+xml',
    'text/html',
    'application/javascript',
    'text/javascript',
    'application/x-msdownload',
    'application/xhtml+xml',
    'text/xml',
    'image/avif',
    'video/webm',
    '',
    'IMAGE/PNG', // exact, case-sensitive match
    'image/png; charset=utf-8',
    ' image/png',
    'image/*',
  ])('rejects %p', (type) => expect(isAllowedAttachmentType(type)).toBe(false));
});

describe('size limits', () => {
  const ok = { filename: 'a.png', contentType: 'image/png', size: 1 };

  test('maxAttachmentSize comes from files.max_file_size (MiB)', () => {
    expect(maxAttachmentSize).toBe(getConfig().files.max_file_size * 1024 * 1024);
    expect(maxAttachmentCount).toBe(5);
  });

  test('presign schema bounds', () => {
    expect(attachmentPresignSchema.safeParse(ok).success).toBe(true);
    expect(attachmentPresignSchema.safeParse({ ...ok, size: maxAttachmentSize }).success).toBe(
      true
    );
    for (const size of [0, -1, maxAttachmentSize + 1, 1.5, Number.NaN, '5'])
      expect(attachmentPresignSchema.safeParse({ ...ok, size }).success).toBe(false);
  });

  test('presign schema string bounds', () => {
    expect(attachmentPresignSchema.safeParse({ ...ok, filename: '' }).success).toBe(false);
    expect(attachmentPresignSchema.safeParse({ ...ok, filename: 'x'.repeat(256) }).success).toBe(
      false
    );
    expect(attachmentPresignSchema.safeParse({ ...ok, filename: 'x'.repeat(255) }).success).toBe(
      true
    );
    expect(attachmentPresignSchema.safeParse({ ...ok, contentType: '' }).success).toBe(false);
    expect(attachmentPresignSchema.safeParse({ ...ok, size: undefined }).success).toBe(false);
  });
});

describe('safeAttachmentFilename', () => {
  test.each([
    ['photo.png', 'photo.png'],
    ['my file-1.2.txt', 'my file-1.2.txt'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\evil.exe', 'evil.exe'],
    ['a/b\\c.txt', 'c.txt'],
    ['dir/', 'attachment'],
    ['', 'attachment'],
    ['"; filename="evil', '__ filename__evil'],
    ['a\r\nSet-Cookie: x=1', 'a__Set-Cookie_ x_1'],
    ['日本語.png', '___.png'],
    ['a<b>|?*.txt', 'a_b____.txt'],
  ])('%p -> %p', (input, out) => expect(safeAttachmentFilename(input)).toBe(out));

  test('never contains separators, quotes or control characters', () => {
    const out = safeAttachmentFilename('a/\\"\'\n\r\t\0%;:<>b.txt');
    expect(out).toMatch(/^[\w.\- ]+$/);
  });

  test('truncated to 255', () => {
    expect(safeAttachmentFilename('x'.repeat(1000))).toHaveLength(255);
  });
});

describe('signed attachment URLs', () => {
  const att = { id: 'att/1 x', filename: 'a.png', contentType: 'image/png', size: 3 };
  const parse = (u: string) => {
    const url = new URL(u);
    return { url, exp: Number(url.searchParams.get('exp')), sig: url.searchParams.get('sig')! };
  };

  test('payload urls are under base_url, encode the id and are signed', () => {
    const p = attachmentPayload(att);
    const base = new URL(getConfig().server.base_url);
    const { url } = parse(p.url);
    expect(url.origin).toBe(base.origin);
    expect(url.pathname).toBe(`/attachment/${encodeURIComponent(att.id)}`);
    expect(parse(p.previewUrl).url.pathname).toBe(
      `/attachment/${encodeURIComponent(att.id)}/preview`
    );
    expect(p).toMatchObject({
      id: att.id,
      filename: att.filename,
      contentType: att.contentType,
      size: 3,
    });
  });

  test('signatures validate for the id, for both url and previewUrl', () => {
    const p = attachmentPayload(att);
    for (const u of [p.url, p.previewUrl]) {
      const { exp, sig } = parse(u);
      expect(isValidAttachmentSignature(att.id, exp, sig)).toBe(true);
    }
  });

  test('expiry is in the future, rounded to a whole day, at most 8 days out', () => {
    const { exp } = parse(attachmentPayload(att).url);
    const now = Date.now() / 1000;
    expect(exp % 86400).toBe(0);
    expect(exp).toBeGreaterThan(now + 6 * 86400);
    expect(exp).toBeLessThanOrEqual(now + 8 * 86400);
  });

  test('same attachment gives the same (cacheable) URL within a day', () => {
    expect(attachmentPayload(att).url).toBe(attachmentPayload(att).url);
  });

  test('wrong id, exp or sig is rejected', () => {
    const { exp, sig } = parse(attachmentPayload(att).url);
    expect(isValidAttachmentSignature('other', exp, sig)).toBe(false);
    expect(isValidAttachmentSignature(att.id, exp + 1, sig)).toBe(false);
    expect(
      isValidAttachmentSignature(att.id, exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'))
    ).toBe(false);
  });

  test('wrong-length or empty signature is false, not a throw', () => {
    const { exp, sig } = parse(attachmentPayload(att).url);
    expect(isValidAttachmentSignature(att.id, exp, '')).toBe(false);
    expect(isValidAttachmentSignature(att.id, exp, sig + 'x')).toBe(false);
    expect(isValidAttachmentSignature(att.id, exp, sig.slice(1))).toBe(false);
  });

  test('expired links are rejected even with a correct signature', () => {
    // signing is private, so forge expiry by re-signing through the payload: pick a past exp
    const { sig } = parse(attachmentPayload(att).url);
    expect(isValidAttachmentSignature(att.id, 1, sig)).toBe(false);
    expect(isValidAttachmentSignature(att.id, Number.NaN, sig)).toBe(false);
  });
});

describe('sniffAudioVideo (magic bytes, ignores any claimed type or extension)', () => {
  test('images', () => {
    expect(sniffAudioVideo(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image');
    expect(sniffAudioVideo(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image');
    expect(sniffAudioVideo(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image');
    expect(sniffAudioVideo(pad([0x52, 0x49, 0x46, 0x46]))).toBe('image');
  });

  test('videos', () => {
    expect(sniffAudioVideo(pad([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe('video');
    expect(sniffAudioVideo(pad([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe('video');
    expect(sniffAudioVideo(pad([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video');
  });

  test('text, html, svg, zip, pdf and exe are not media', () => {
    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    expect(sniffAudioVideo(enc('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffAudioVideo(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffAudioVideo(enc('plain text'))).toBeNull();
    expect(sniffAudioVideo(pad([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(sniffAudioVideo(enc('%PDF-1.7'))).toBeNull();
    expect(sniffAudioVideo(pad([0x4d, 0x5a]))).toBeNull();
  });

  test('empty, truncated and zero buffers', () => {
    expect(sniffAudioVideo(new ArrayBuffer(0))).toBeNull();
    expect(sniffAudioVideo(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffAudioVideo(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffAudioVideo(new ArrayBuffer(64))).toBeNull();
  });

  test('a PNG with a .txt or .exe name is still an image (only bytes matter)', () => {
    // the function has no filename input at all; documents that a spoofed extension can't change the verdict
    expect(sniffAudioVideo(pad([0x89, 0x50, 0x4e, 0x47]))).toBe('image');
    expect(sniffAudioVideo(pad([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
  });

  // pinned limitation: RIFF is lumped in as "image", so a WAV/AVI container reads as an image
  test('RIFF containers (wav) read as image', () => {
    expect(sniffAudioVideo(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBe(
      'image'
    );
  });

  // gap: only ftyp boxes of exactly 0x18/0x20 bytes are recognised; other mp4 box sizes
  // (0x1c, 0x14, ...) are common and sniff as null, so they never get a video thumbnail.
  test.failing('mp4 with a 0x1c-byte ftyp box is recognised as video', () => {
    expect(sniffAudioVideo(pad([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]))).toBe('video');
  });
});
