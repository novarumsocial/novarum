// Servers without a picture get a steady colour of their own, picked from their id.
const TILES = [
  'oklch(0.55 0.16 292)',
  'oklch(0.58 0.15 8)',
  'oklch(0.58 0.11 200)',
  'oklch(0.6 0.13 65)',
  'oklch(0.56 0.13 150)',
  'oklch(0.55 0.15 255)',
];

export const serverColor = (id: string) =>
  TILES[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TILES.length];
