import { anchor } from '$lib/anchor.svelte';
import { goto } from '$app/navigation';
import type { PublicUser } from 'anchor/public-user';

export type DmEntry = {
  id: string;
  type: 'DM' | 'GROUP_DM';
  participants: PublicUser[];
  lastMessageAt: string | null;
  unread: boolean;
  joinedAt: string;
};

export const RING_TIMEOUT = 30_000;

export function dmPath(channelId: string) {
  return `/guilds/dms/${encodeURIComponent(channelId)}`;
}

class DmsState {
  list = $state<DmEntry[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  incomingCall = $state<{ channelId: string; user: PublicUser } | null>(null);
  outgoingCall = $state<string | null>(null);

  get(channelId: string) {
    return this.list.find((dm) => dm.id === channelId) ?? null;
  }

  // the DM that already exists with this friend, if any — used to avoid opening duplicates.
  withUser(userId: string) {
    return this.list.find((dm) => dm.participants.some((user) => user.userId === userId)) ?? null;
  }

  async load() {
    this.loading = true;
    this.error = null;

    try {
      const result = await anchor.client.dm.get();
      if (result.error || !result.data) {
        this.error = 'Could not load your direct messages.';
        return;
      }

      this.list = result.data.dms;
    } catch {
      this.error = 'Could not load your direct messages.';
    } finally {
      this.loading = false;
    }
  }

  async open(userId: string) {
    const existing = this.withUser(userId);
    if (existing) {
      void goto(dmPath(existing.id));
      return existing.id;
    }

    const result = await anchor.client.dm.post({ userId });
    if (result.error || !result.data || 'error' in result.data) return null;

    this.upsert(result.data);
    void goto(dmPath(result.data.id));
    return result.data.id;
  }

  async close(channelId: string) {
    const closed = this.get(channelId);
    this.list = this.list.filter((dm) => dm.id !== channelId);

    const result = await anchor.client.dm({ id: channelId }).close.post();
    if (result.error && closed) this.upsert(closed);
  }

  upsert(dm: DmEntry) {
    const existing = this.get(dm.id);
    this.list = existing
      ? this.list.map((item) => (item.id === dm.id ? { ...item, ...dm } : item))
      : [dm, ...this.list];
  }

  handleMessage(
    channelId: string,
    createdAt: string,
    { active, fromSelf }: { active: boolean; fromSelf: boolean }
  ) {
    if (!this.get(channelId)) {
      void this.load();
      return;
    }

    this.list = this.list.map((dm) =>
      dm.id === channelId
        ? { ...dm, lastMessageAt: createdAt, unread: active || fromSelf ? false : true }
        : dm
    );
  }

  markRead(channelId: string) {
    this.list = this.list.map((dm) => (dm.id === channelId ? { ...dm, unread: false } : dm));
  }
}

export const dms = new DmsState();
