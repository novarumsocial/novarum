// Port of apps/frontend/src/lib/dms.svelte.ts
import { create } from 'zustand';
import type { PublicUser } from 'anchor/public-user';
import { z } from 'zod';
import { anchor } from './anchor';
import { goto } from './navigation';

export type DmEntry = {
  id: string;
  type: 'DM' | 'GROUP_DM';
  participants: PublicUser[];
  // group DMs only; an empty name means the members' names are shown instead
  name?: string | null;
  iconUrl?: string | null;
  ownerId?: string | null;
  lastMessageAt: string | null;
  unread: boolean;
  joinedAt: string;
};

export const RING_TIMEOUT = 30_000;

// federated DM ids look like fed:channel:<homeserver>:<id> (see anchor's federationIds.ts)
const isFromHomeserver = (dm: DmEntry, homeserver: string) =>
  dm.id.startsWith(`fed:channel:${encodeURIComponent(homeserver)}:`);

const apiErrorSchema = z.object({ error: z.string() });
// eden puts the error body in `value`; validation errors only have a message
const errorMessage = (error: { value?: unknown } | null | undefined, fallback: string) =>
  apiErrorSchema.safeParse(error?.value).data?.error ?? fallback;

const personName = (user: PublicUser) => user.displayName || user.username;

/** What a DM is called and shown as: the other person, or the group's name and icon. */
export function dmDisplay(dm: DmEntry) {
  if (dm.type !== 'GROUP_DM') {
    const other = dm.participants[0];
    return {
      name: other ? personName(other) : 'Direct Message',
      avatarUrl: other?.avatarUrl ?? null,
      avatarColor: other?.avatarColor ?? null,
      other: other ?? null,
    };
  }
  const people = dm.participants.filter((user) => !user.isBot);
  return {
    name: dm.name || people.map(personName).join(', ') || 'Empty group',
    avatarUrl: dm.iconUrl ?? null,
    avatarColor: null,
    other: null,
  };
}

export function dmPath(channelId: string, messageId?: string) {
  const message = messageId ? `/${encodeURIComponent(messageId)}` : '';
  return `/guilds/dms/${encodeURIComponent(channelId)}${message}`;
}

type IncomingCall = { channelId: string; user: PublicUser };

type DmsState = {
  list: DmEntry[];
  loading: boolean;
  error: string | null;
  // homeservers whose DMs are still on their way; each one fills in on its own.
  pending: string[];
  incomingCall: IncomingCall | null;
  outgoingCall: string | null;
  // the web assigns these two fields directly (`dms.incomingCall = null`)
  setIncomingCall: (call: IncomingCall | null) => void;
  setOutgoingCall: (channelId: string | null) => void;
  get: (channelId: string) => DmEntry | null;
  withUser: (userId: string) => DmEntry | null;
  load: () => Promise<void>;
  open: (userId: string) => Promise<string | null>;
  close: (channelId: string) => Promise<void>;
  createGroup: (userIds: string[], name?: string) => Promise<{ id: string } | { error: string }>;
  addMembers: (channelId: string, userIds: string[]) => Promise<string | null>;
  kick: (channelId: string, userId: string) => Promise<string | null>;
  transferOwner: (channelId: string, userId: string) => Promise<string | null>;
  rename: (channelId: string, name: string) => Promise<string | null>;
  // native takes a picked file's uri, as React Native has no File
  uploadIcon: (
    channelId: string,
    uri: string,
    type: 'image/gif' | 'image/png'
  ) => Promise<string | null>;
  addBot: (
    channelId: string,
    bot: { username: string; homeserver: string }
  ) => Promise<string | null>;
  leave: (channelId: string) => Promise<string | null>;
  remove: (channelId: string) => void;
  update: (change: Partial<DmEntry> & { id: string }) => void;
  upsert: (dm: DmEntry) => void;
  handleMessage: (
    channelId: string,
    createdAt: string,
    options: { active: boolean; fromSelf: boolean }
  ) => void;
  markRead: (channelId: string) => void;
  // native-only: the web reloads the page when the account changes
  reset: () => void;
};

let generation = 0;

export const useDms = create<DmsState>((set, get) => {
  async function loadHomeserver(homeserver: string, loadGeneration: number) {
    const result = await anchor()
      .client.dm.homeserver({ homeserver })
      .get()
      .catch(() => null);
    if (loadGeneration !== generation) return;

    if (result?.data) {
      set({ list: get().list.filter((dm) => !isFromHomeserver(dm, homeserver)) });
      for (const dm of result.data.dms) get().upsert(dm);
    }
    set({ pending: get().pending.filter((item) => item !== homeserver) });
  }

  return {
    list: [],
    loading: false,
    error: null,
    pending: [],
    incomingCall: null,
    outgoingCall: null,

    setIncomingCall: (incomingCall) => set({ incomingCall }),
    setOutgoingCall: (outgoingCall) => set({ outgoingCall }),

    get: (channelId) => get().list.find((dm) => dm.id === channelId) ?? null,

    // the DM that already exists with this friend, if any — used to avoid opening duplicates.
    withUser: (userId) =>
      get().list.find(
        (dm) => dm.type === 'DM' && dm.participants.some((user) => user.userId === userId)
      ) ?? null,

    async load() {
      set({ loading: true, error: null });

      const current = ++generation;
      try {
        const result = await anchor().client.dm.get();
        if (current !== generation) return;
        if (result.error || !result.data) {
          set({ error: 'Could not load your direct messages.' });
          return;
        }

        const { dms, pending } = result.data;
        // keep showing federated DMs until their homeserver's fetch replaces them.
        set({
          list: [
            ...dms,
            ...get().list.filter((dm) =>
              pending.some((homeserver: string) => isFromHomeserver(dm, homeserver))
            ),
          ],
          pending,
        });
        for (const homeserver of pending) void loadHomeserver(homeserver, current);
      } catch {
        set({ error: 'Could not load your direct messages.' });
      } finally {
        set({ loading: false });
      }
    },

    async open(userId) {
      const existing = get().withUser(userId);
      if (existing) {
        void goto(dmPath(existing.id));
        return existing.id;
      }

      const result = await anchor().client.dm.post({ userId });
      if (result.error || !result.data || 'error' in result.data) return null;

      get().upsert(result.data);
      void goto(dmPath(result.data.id));
      return result.data.id;
    },

    async close(channelId) {
      const closed = get().get(channelId);
      set({ list: get().list.filter((dm) => dm.id !== channelId) });

      const result = await anchor().client.dm({ id: channelId }).close.post();
      if (result.error && closed) get().upsert(closed);
    },

    // a group with these friends; any number of them, so adding people to a 1:1 makes a new group
    async createGroup(userIds, name = '') {
      const { data, error } = await anchor().client.dm.group.post({ userIds, name });
      if (error || !data || 'error' in data)
        return { error: errorMessage(error, 'Could not create the group.') };
      get().upsert(data);
      void goto(dmPath(data.id));
      return { id: data.id };
    },

    async addMembers(channelId, userIds) {
      const { error } = await anchor().client.dm({ id: channelId }).members.post({ userIds });
      return error ? errorMessage(error, 'Could not add them.') : null;
    },

    async kick(channelId, userId) {
      const { error } = await anchor().client.dm({ id: channelId }).members({ userId }).delete();
      return error ? errorMessage(error, 'Could not remove them.') : null;
    },

    async transferOwner(channelId, userId) {
      const { error } = await anchor().client.dm({ id: channelId }).owner.post({ userId });
      return error ? errorMessage(error, 'Could not transfer the group.') : null;
    },

    async rename(channelId, name) {
      const { error } = await anchor().client.dm({ id: channelId }).patch({ name });
      return error ? errorMessage(error, 'Could not rename the group.') : null;
    },

    async uploadIcon(channelId, uri, type) {
      const form = new FormData();
      form.append('icon', {
        uri,
        name: `group-icon.${type === 'image/gif' ? 'gif' : 'png'}`,
        type,
      } as unknown as Blob);
      // the phone's cookie store signs the request, like `credentials: 'include'` on the web
      const response = await fetch(`${anchor().baseUrl}/dm/${encodeURIComponent(channelId)}/icon`, {
        method: 'POST',
        body: form,
      }).catch(() => null);
      if (response?.ok) return null;
      return errorMessage(
        { value: await response?.json().catch(() => null) },
        'Could not upload the icon.'
      );
    },

    async addBot(channelId, bot) {
      const { error } = await anchor().client.dm({ id: channelId }).bots.post(bot);
      return error ? errorMessage(error, 'Could not add the bot.') : null;
    },

    async leave(channelId) {
      const { error } = await anchor().client.dm({ id: channelId }).leave.post();
      if (error) return errorMessage(error, 'Could not leave the group.');
      get().remove(channelId);
      return null;
    },

    remove(channelId) {
      const { incomingCall, outgoingCall } = get();
      set({
        list: get().list.filter((dm) => dm.id !== channelId),
        incomingCall: incomingCall?.channelId === channelId ? null : incomingCall,
        outgoingCall: outgoingCall === channelId ? null : outgoingCall,
      });
    },

    update: (change) =>
      set({ list: get().list.map((dm) => (dm.id === change.id ? { ...dm, ...change } : dm)) }),

    upsert(dm) {
      const existing = get().get(dm.id);
      set({
        list: existing
          ? get().list.map((item) => (item.id === dm.id ? { ...item, ...dm } : item))
          : [dm, ...get().list],
      });
    },

    handleMessage(channelId, createdAt, { active, fromSelf }) {
      if (!get().get(channelId)) {
        void get().load();
        return;
      }

      set({
        list: get().list.map((dm) =>
          dm.id === channelId
            ? { ...dm, lastMessageAt: createdAt, unread: active || fromSelf ? false : true }
            : dm
        ),
      });
    },

    markRead: (channelId) =>
      set({ list: get().list.map((dm) => (dm.id === channelId ? { ...dm, unread: false } : dm)) }),

    reset() {
      generation++; // drops any load still in flight
      set({
        list: [],
        loading: false,
        error: null,
        pending: [],
        incomingCall: null,
        outgoingCall: null,
      });
    },
  };
});

// Same name as on the web, for code that runs outside React: `dms().load()`
export const dms = useDms.getState;
