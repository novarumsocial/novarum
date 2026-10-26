import { anchor } from './anchor.svelte';
import type { RealtimeEvent } from 'anchor';

export type Canvas = Extract<RealtimeEvent, { type: 'channel.canvas.updated' }>['data'];

// the shared markdown document of each channel, kept fresh by `channel.canvas.updated` events
class CanvasState {
  byChannel = $state<Record<string, Canvas>>({});

  // canvases only live on our own homeserver's text and DM channels for now
  supports(channel: { id: string; type: string }) {
    return channel.type !== 'VOICE' && !channel.id.startsWith('fed:');
  }

  async load(channelId: string) {
    const result = await anchor.client.channel({ id: channelId }).canvas.get();
    if (result.error) throw new Error('Failed to load the canvas');
    this.apply(result.data);
  }

  // false when someone else saved first; the canvas then holds their version
  async save(channelId: string, content: string, version: number) {
    const result = await anchor.client.channel({ id: channelId }).canvas.put({ content, version });
    if (result.error?.status === 409) {
      this.apply(result.error.value);
      return false;
    }
    if (result.error) throw new Error('Failed to save the canvas');
    this.apply(result.data);
    return true;
  }

  apply(canvas: Canvas) {
    const current = this.byChannel[canvas.channelId];
    if (!current || canvas.version >= current.version) this.byChannel[canvas.channelId] = canvas;
  }
}

export const canvases = new CanvasState();
