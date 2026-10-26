import * as Y from 'yjs';
import { channelCanvases, db } from '../src/db';
import { parseFederatedChannelId } from './federationIds';

// past this the canvas stops taking edits; plenty for text, and keeps one row from growing forever
const maxStateBytes = 2 * 1024 * 1024;
// updates to one canvas are merged one at a time, so two people typing at once can't drop each other's edits
const queues = new Map<string, Promise<boolean>>();

export const canvasTopic = (channelId: string) => `canvas:${channelId}`;

// canvases live on our own text and DM channels; federated ones would need their homeserver to host them
export async function findCanvasChannel(channelId: string) {
  if (parseFederatedChannelId(channelId)) return null;
  const channel = await db.query.channels.findFirst({ where: { id: channelId } });
  return channel && channel.type !== 'VOICE' ? channel : null;
}

export async function loadCanvasState(channelId: string) {
  const canvas = await db.query.channelCanvases.findFirst({ where: { channelId } });
  return canvas?.state ?? Y.encodeStateAsUpdate(new Y.Doc());
}

// false when the update is garbage or would make the canvas too big
export function applyCanvasUpdate(channelId: string, update: Uint8Array, userId: string) {
  const applied = (queues.get(channelId) ?? Promise.resolve(true))
    .then(async () => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, await loadCanvasState(channelId));
      Y.applyUpdate(doc, update);
      const state = Y.encodeStateAsUpdate(doc);
      if (state.byteLength > maxStateBytes) return false;

      const values = { state: Buffer.from(state), updatedById: userId, updatedAt: new Date() };
      await db
        .insert(channelCanvases)
        .values({ channelId, ...values })
        .onConflictDoUpdate({ target: channelCanvases.channelId, set: values });
      return true;
    })
    .catch(() => false);

  queues.set(channelId, applied);
  void applied.then(() => queues.get(channelId) === applied && queues.delete(channelId));
  return applied;
}
