import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { fromBase64, toBase64 } from 'lib0/buffer';
import type { RealtimeEvent } from 'anchor';

type CanvasEvent = Extract<RealtimeEvent, { type: `canvas.${string}` }>;
export type CanvasMessage =
  | { type: 'canvas.join' | 'canvas.leave'; channelId: string }
  | { type: 'canvas.update'; channelId: string; update: string }
  | { type: 'canvas.awareness'; channelId: string; update: string; hello?: boolean };

// the canvases open right now, so the realtime socket can route events to them and rejoin after reconnecting
export const openCanvases = new Map<string, CanvasSession>();

// one open canvas: a Yjs document and everyone's cursors, kept in sync through the realtime socket
export class CanvasSession {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  synced = $state(false);
  writable = $state(false);
  private pending: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly channelId: string,
    private send: (message: CanvasMessage) => void
  ) {
    // local edits are batched, so fast typing sends a few messages a second instead of one per key
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      this.pending.push(update);
      this.flushTimer ??= setTimeout(() => this.flush(), 50);
    });
    this.awareness.on(
      'update',
      ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
        if (origin === 'local') this.sendAwareness([...added, ...updated, ...removed]);
      }
    );
    openCanvases.set(channelId, this);
    this.join();
  }

  join() {
    this.send({ type: 'canvas.join', channelId: this.channelId });
  }

  handle(event: CanvasEvent) {
    if (event.type === 'canvas.sync') {
      const state = fromBase64(event.data.state);
      Y.applyUpdate(this.doc, state, this);
      this.writable = event.data.writable;
      this.synced = true;
      // whatever we typed while offline (or before this sync) and the server doesn't have yet
      this.pending = [];
      const missing = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVectorFromUpdate(state));
      if (this.writable && missing.length > 2) this.sendUpdate(missing);
      this.sendAwareness([this.doc.clientID], true);
    }
    if (event.type === 'canvas.update') {
      Y.applyUpdate(this.doc, fromBase64(event.data.update), this);
    }
    if (event.type === 'canvas.awareness') {
      applyAwarenessUpdate(this.awareness, fromBase64(event.data.update), 'remote');
      // someone just opened the canvas; tell them we're here too
      if (event.data.hello) this.sendAwareness([this.doc.clientID]);
    }
  }

  private flush() {
    this.flushTimer = null;
    if (!this.synced || !this.pending.length) return;
    this.sendUpdate(Y.mergeUpdates(this.pending));
    this.pending = [];
  }

  private sendUpdate(update: Uint8Array) {
    this.send({ type: 'canvas.update', channelId: this.channelId, update: toBase64(update) });
  }

  private sendAwareness(clients: number[], hello?: boolean) {
    const update = toBase64(encodeAwarenessUpdate(this.awareness, clients));
    this.send({ type: 'canvas.awareness', channelId: this.channelId, update, hello });
  }

  destroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.send({ type: 'canvas.leave', channelId: this.channelId });
    openCanvases.delete(this.channelId);
    this.awareness.destroy();
    this.doc.destroy();
  }
}
