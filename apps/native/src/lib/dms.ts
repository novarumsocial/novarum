// Port of apps/frontend/src/lib/dms.svelte.ts
import { create } from 'zustand';
import type { PublicUser } from 'anchor/public-user';
import { anchor } from './anchor';
import { goto } from './navigation';

export type DmEntry = {
  id: string;
  type: 'DM' | 'GROUP_DM';
  participants: PublicUser[];
  lastMessageAt: string | null;
  unread: boolean;
  joinedAt: string;
};

export const RING_TIMEOUT = 30_000;

// federated DM ids look like fed:channel:<homeserver>:<id> (see anchor's federationIds.ts)
const isFromHomeserver = (dm: DmEntry, homeserver: string) =>
  dm.id.startsWith(`fed:channel:${encodeURIComponent(homeserver)}:`);

export function dmPath(channelId: string) {
  return `/guilds/dms/${encodeURIComponent(channelId)}`;
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
  upsert: (dm: DmEntry) => void;
  handleMessage: (
    channelId: string,
    createdAt: string,
    options: { active: boolean; fromSelf: boolean }
  ) => void;
  markRead: (channelId: string) => void;
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
      get().list.find((dm) => dm.participants.some((user) => user.userId === userId)) ?? null,

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
  };
});

// Same name as on the web, for code that runs outside React: `dms().load()`
export const dms = useDms.getState;
