import type { Author } from '$lib/types/chat';
import type { VoiceState } from '$lib/voice.svelte';

export type VoiceTile = {
  key: string;
  identity: string;
  kind: 'screen' | 'participant';
  state: VoiceState;
  member?: Author;
  name: string;
};

export type TileLayout = {
  cols: number;
  rows: number;
  width: number;
  height: number;
};

const EMPTY: TileLayout = { cols: 1, rows: 1, width: 0, height: 0 };

/**
 * Picks the arrangement that gives every tile the largest possible area inside
 * `width` x `height`.
 *
 * Tiles take their cell's own shape whenever that shape is reasonable, which is
 * what makes the grid fill the stage. Forcing a fixed 16:9 is what left most of
 * the old layout empty: two people in a wide window got two letterboxed tiles
 * with half the stage black. `minAspect`/`maxAspect` only kick in for extreme
 * cells (never taller than square, never wider than 2:1), and camera video is
 * `object-cover`, so off-ratio tiles still look right.
 *
 * When even the best arrangement would be unreadably small we stop trying to fit
 * everyone on screen and return a grid the caller can scroll.
 */
export function fitTiles(
  width: number,
  height: number,
  count: number,
  gap = 8,
  minAspect = 1,
  maxAspect = 2,
  minWidth = 140
): TileLayout {
  if (count < 1 || width < 1 || height < 1) return EMPTY;

  let best = EMPTY;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // Skip arrangements that would leave a whole trailing column empty.
    if ((cols - 1) * rows >= count) continue;

    const cellWidth = (width - gap * (cols - 1)) / cols;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    if (cellWidth < 1 || cellHeight < 1) continue;

    const aspect = Math.min(maxAspect, Math.max(minAspect, cellWidth / cellHeight));
    const tileWidth = Math.min(cellWidth, cellHeight * aspect);
    if (tileWidth * (tileWidth / aspect) <= best.width * best.height) continue;

    best = { cols, rows, width: tileWidth, height: tileWidth / aspect };
  }

  if (best.width < minWidth) {
    const cols = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
    const tileWidth = (width - gap * (cols - 1)) / cols;
    best = { cols, rows: Math.ceil(count / cols), width: tileWidth, height: (tileWidth * 9) / 16 };
  }

  // Floor so sub-pixel rounding can never push a tile onto the next flex row.
  return { ...best, width: Math.floor(best.width), height: Math.floor(best.height) };
}

const AVATAR_COLORS = [
  'bg-rose-600',
  'bg-sky-600',
  'bg-emerald-600',
  'bg-amber-600',
  'bg-purple-600',
  'bg-cyan-600',
  'bg-pink-600',
  'bg-lime-600',
  'bg-indigo-600',
  'bg-teal-600',
  'bg-orange-600',
  'bg-violet-600',
];

export function fallbackAvatarBg(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initialsFor(id: string) {
  return id
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
    .slice(0, 2);
}
