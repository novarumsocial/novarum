// Port of apps/frontend/src/lib/canvas.svelte.ts
// The Yjs document lives in the canvas WebView (canvas-editor/); this side only routes the socket's canvas events
// to the open canvas and lets the socket join it again after reconnecting.
import type { RealtimeEvent } from 'anchor';

export type CanvasEvent = Extract<RealtimeEvent, { type: `canvas.${string}` }>;
export type CanvasMessage =
  | { type: 'canvas.join' | 'canvas.leave'; channelId: string }
  | { type: 'canvas.update'; channelId: string; update: string }
  | { type: 'canvas.awareness'; channelId: string; update: string; hello?: boolean };

export type OpenCanvas = { join: () => void; handle: (event: CanvasEvent) => void };

// the canvases open right now, so the realtime socket can route events to them and rejoin after reconnecting
export const openCanvases = new Map<string, OpenCanvas>();
