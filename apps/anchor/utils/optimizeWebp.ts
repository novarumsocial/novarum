import sharp from 'sharp';

// thank god ai exists for this :sobpray:
export function isAnimatedGif(imageBuffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(imageBuffer);
  if (bytes.length < 14) return false;
  const header = new TextDecoder().decode(bytes.subarray(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') return false;

  let i = 13;
  const gctPacked = bytes[10] ?? 0;
  if (gctPacked & 0x80) i += 3 * (1 << ((gctPacked & 0x07) + 1));
  let frames = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0x3b) break;
    if (bytes[i] === 0x2c) {
      if (++frames >= 2) return true;
      const packed = bytes[i + 9] ?? 0;
      i += 10;
      if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
      i += 1; // LZW minimum code size
      while (i < bytes.length) {
        const size = bytes[i] ?? 0;
        if (size === 0) break;
        i += size + 1;
      }
      i += 1;
    } else if (bytes[i] === 0x21) {
      i += 2; // extension label
      while (i < bytes.length) {
        const size = bytes[i] ?? 0;
        if (size === 0) break;
        i += size + 1;
      }
      i += 1;
    } else {
      break;
    }
  }
  return false;
}

export async function processImage(
  imageBuffer: ArrayBuffer,
  quality = 45
): Promise<{ data: Buffer; animated: boolean }> {
  if (isAnimatedGif(imageBuffer)) {
    const data = await sharp(Buffer.from(imageBuffer), { animated: true })
      .webp({ quality })
      .toBuffer();
    return { data, animated: true };
  }
  const data = await sharp(Buffer.from(imageBuffer)).webp({ quality }).toBuffer();
  return { data, animated: false };
}
