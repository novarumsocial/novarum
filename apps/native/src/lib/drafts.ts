// Native-only: the half-typed message of each channel survives leaving it, a call or the app being killed.
// The text is stored; picked files only last for this run (their cache copies can be gone after a restart).
import type { PickedFile } from './chat-state';
import { storage } from './storage';

const key = (channelId: string) => `draft:${channelId}`;
const files = new Map<string, PickedFile[]>();

export const drafts = {
  text: (channelId: string) => storage.getString(key(channelId)) ?? '',
  setText: (channelId: string, text: string) =>
    text.trim() ? storage.set(key(channelId), text) : storage.remove(key(channelId)),
  files: (channelId: string) => files.get(channelId) ?? [],
  setFiles: (channelId: string, list: PickedFile[]) =>
    list.length ? files.set(channelId, list) : files.delete(channelId),
};
