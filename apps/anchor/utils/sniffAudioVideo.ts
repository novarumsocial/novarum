const imageSignatures = [
  [0x89, 0x50, 0x4e, 0x47], // png
  [0x47, 0x49, 0x46, 0x38], // gif
  [0xff, 0xd8, 0xff], // jpeg
  [0x52, 0x49, 0x46, 0x46], // webp/avif (RIFF)
] as const;

const videoSignatures = [
  [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], // mp4/mov isom
  [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70], // mp4/mov mdat
  [0x1a, 0x45, 0xdf, 0xa3], // webm/mkv
] as const;

// uses magic bytes to sniff the media type. whatever that means.
export function sniffAudioVideo(buffer: ArrayBuffer): 'image' | 'video' | null {
  const bytes = new Uint8Array(buffer);
  const has = (sig: readonly number[]) => sig.every((byte, i) => bytes[i] === byte);

  if (imageSignatures.some(has)) return 'image';
  if (videoSignatures.some(has)) return 'video';
  return null;
}
