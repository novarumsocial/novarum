// Port of apps/frontend/src/lib/friends.svelte.ts
import { create } from 'zustand';
import { z } from 'zod';
import type { PublicUser } from 'anchor/public-user';
import { anchor } from './anchor';
import { dms } from './dms';

export type FriendEntry = {
  user: PublicUser;
  status: 'ONLINE' | 'OFFLINE';
  createdAt: string | Date;
  acceptedAt: string | Date | null;
};

export type FriendStatus = 'FRIEND' | 'INCOMING' | 'OUTGOING' | 'NONE';

const apiErrorSchema = z.object({ error: z.string() });

function errorMessage(error: unknown, fallback: string) {
  return apiErrorSchema.safeParse(error).data?.error ?? fallback;
}

type FriendsState = {
  accepted: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
  loading: boolean;
  busyUserIds: string[];
  error: string | null;
  statusFor: (username: string, homeserver: string) => FriendStatus;
  userIdFor: (username: string, homeserver: string) => string | undefined;
  load: () => Promise<void>;
  isOnline: (userId: string) => boolean;
  updateStatus: (userId: string, status: 'ONLINE' | 'OFFLINE') => void;
  request: (userId: string, username: string, homeserver: string) => Promise<boolean>;
  accept: (userId: string) => Promise<boolean>;
  decline: (userId: string) => Promise<boolean>;
  remove: (userId: string) => Promise<boolean>;
  // native-only: the web reloads the page when the account changes
  reset: () => void;
};

let loadGeneration = 0;

export const useFriends = create<FriendsState>((set, get) => {
  const mutate = async (
    userId: string,
    request: () => Promise<{ error: { value: unknown } | null }>,
    fallback: string
  ) => {
    set((s) => ({ busyUserIds: [...s.busyUserIds, userId], error: null }));

    try {
      const result = await request();
      if (result.error) {
        set({ error: errorMessage(result.error.value, fallback) });
        return false;
      }

      await get().load();
      return true;
    } catch {
      set({ error: fallback });
      return false;
    } finally {
      set((s) => ({ busyUserIds: s.busyUserIds.filter((id) => id !== userId) }));
    }
  };

  const matches = (username: string, homeserver: string) => (friend: FriendEntry) =>
    friend.user.username === username &&
    friend.user.homeserver.toLowerCase() === homeserver.toLowerCase();

  return {
    accepted: [],
    incoming: [],
    outgoing: [],
    loading: false,
    busyUserIds: [],
    error: null,

    statusFor(username, homeserver) {
      const { accepted, incoming, outgoing } = get();
      const is = matches(username, homeserver);
      if (accepted.some(is)) return 'FRIEND';
      if (incoming.some(is)) return 'INCOMING';
      if (outgoing.some(is)) return 'OUTGOING';
      return 'NONE';
    },

    userIdFor(username, homeserver) {
      const { accepted, incoming, outgoing } = get();
      return [...accepted, ...incoming, ...outgoing].find(matches(username, homeserver))?.user
        .userId;
    },

    async load() {
      const generation = ++loadGeneration;
      set({ loading: true, error: null });

      try {
        const result = await anchor().client.friends.get();
        if (result.error) {
          set({ error: errorMessage(result.error.value, 'Could not load your friends.') });
          return;
        }

        if (generation !== loadGeneration) return;
        set({
          accepted: result.data?.accepted ?? [],
          incoming: result.data?.incoming ?? [],
          outgoing: result.data?.outgoing ?? [],
        });
      } catch {
        set({ error: 'Could not load your friends.' });
      } finally {
        if (generation === loadGeneration) set({ loading: false });
      }
    },

    isOnline: (userId) =>
      get().accepted.some((entry) => entry.user.userId === userId && entry.status === 'ONLINE'),

    updateStatus: (userId, status) =>
      set((s) => ({
        accepted: s.accepted.map((entry) =>
          entry.user.userId === userId ? { ...entry, status } : entry
        ),
      })),

    request: (userId, username, homeserver) =>
      mutate(
        userId,
        () => anchor().client.friends.request.post({ username, homeserver }),
        'Could not send the friend request.'
      ),

    async accept(userId) {
      const accepted = await mutate(
        userId,
        () => anchor().client.friends.requests({ userId }).accept.post(),
        'Could not accept the friend request.'
      );
      // jump straight into a conversation with the new friend
      if (accepted) await dms().open(userId);
      return accepted;
    },

    decline: (userId) =>
      mutate(
        userId,
        () => anchor().client.friends.requests({ userId }).decline.post(),
        'Could not decline the friend request.'
      ),

    remove: (userId) =>
      mutate(
        userId,
        () => anchor().client.friends({ userId }).delete(),
        'Could not remove this friend.'
      ),

    reset() {
      loadGeneration++; // drops any load still in flight
      set({
        accepted: [],
        incoming: [],
        outgoing: [],
        loading: false,
        busyUserIds: [],
        error: null,
      });
    },
  };
});

// Same name as on the web, for code that runs outside React: `friends().load()`
export const friends = useFriends.getState;
