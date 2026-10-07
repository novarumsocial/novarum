import { anchor } from '$lib/anchor.svelte';
import { dms } from '$lib/dms.svelte';
import type { PublicUser } from 'anchor/public-user';
import { z } from 'zod';

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

class FriendsState {
  accepted = $state<FriendEntry[]>([]);
  incoming = $state<FriendEntry[]>([]);
  outgoing = $state<FriendEntry[]>([]);
  loading = $state(false);
  busyUserIds = $state<string[]>([]);
  error = $state<string | null>(null);
  private loadGeneration = 0;

  statusFor(username: string, homeserver: string): FriendStatus {
    const matches = (friend: FriendEntry) =>
      friend.user.username === username &&
      friend.user.homeserver.toLowerCase() === homeserver.toLowerCase();

    if (this.accepted.some(matches)) return 'FRIEND';
    if (this.incoming.some(matches)) return 'INCOMING';
    if (this.outgoing.some(matches)) return 'OUTGOING';
    return 'NONE';
  }

  userIdFor(username: string, homeserver: string) {
    return [...this.accepted, ...this.incoming, ...this.outgoing].find(
      (friend) =>
        friend.user.username === username &&
        friend.user.homeserver.toLowerCase() === homeserver.toLowerCase()
    )?.user.userId;
  }

  async load() {
    const generation = ++this.loadGeneration;
    this.loading = true;
    this.error = null;

    try {
      const result = await anchor.client.friends.get();
      if (result.error) {
        this.error = errorMessage(result.error.value, 'Could not load your friends.');
        return;
      }

      if (generation !== this.loadGeneration) return;
      this.accepted = result.data?.accepted ?? [];
      this.incoming = result.data?.incoming ?? [];
      this.outgoing = result.data?.outgoing ?? [];
    } catch {
      this.error = 'Could not load your friends.';
    } finally {
      if (generation === this.loadGeneration) this.loading = false;
    }
  }

  isOnline(userId: string) {
    return this.accepted.some((entry) => entry.user.userId === userId && entry.status === 'ONLINE');
  }

  updateStatus(userId: string, status: 'ONLINE' | 'OFFLINE') {
    this.accepted = this.accepted.map((entry) =>
      entry.user.userId === userId ? { ...entry, status } : entry
    );
  }

  request(userId: string, username: string, homeserver: string) {
    return this.mutate(
      userId,
      () => anchor.client.friends.request.post({ username, homeserver }),
      'Could not send the friend request.'
    );
  }

  async accept(userId: string) {
    const accepted = await this.mutate(
      userId,
      () => anchor.client.friends.requests({ userId }).accept.post(),
      'Could not accept the friend request.'
    );
    // jump straight into a conversation with the new friend
    if (accepted) await dms.open(userId);
    return accepted;
  }

  decline(userId: string) {
    return this.mutate(
      userId,
      () => anchor.client.friends.requests({ userId }).decline.post(),
      'Could not decline the friend request.'
    );
  }

  remove(userId: string) {
    return this.mutate(
      userId,
      () => anchor.client.friends({ userId }).delete(),
      'Could not remove this friend.'
    );
  }

  private async mutate(
    userId: string,
    request: () => Promise<{ error: { value: unknown } | null }>,
    fallback: string
  ) {
    this.busyUserIds = [...this.busyUserIds, userId];
    this.error = null;

    try {
      const result = await request();
      if (result.error) {
        this.error = errorMessage(result.error.value, fallback);
        return false;
      }

      await this.load();
      return true;
    } catch {
      this.error = fallback;
      return false;
    } finally {
      this.busyUserIds = this.busyUserIds.filter((id) => id !== userId);
    }
  }
}

export const friends = new FriendsState();
