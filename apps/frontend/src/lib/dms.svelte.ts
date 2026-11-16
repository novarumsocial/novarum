import { anchor } from '$lib/anchor.svelte';
import { goto } from '$app/navigation';
import type { PublicUser } from 'anchor/public-user';
import { z } from 'zod';

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
  const path = `/guilds/dms/${encodeURIComponent(channelId)}`;
  return messageId ? `${path}/${encodeURIComponent(messageId)}` : path;
}

class DmsState {
  list = $state<DmEntry[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  // homeservers whose DMs are still on their way; each one fills in on its own.
  pending = $state<string[]>([]);
  #generation = 0;
  incomingCall = $state<{ channelId: string; user: PublicUser } | null>(null);
  outgoingCall = $state<string | null>(null);

  get(channelId: string) {
    return this.list.find((dm) => dm.id === channelId) ?? null;
  }

  // the DM that already exists with this friend, if any — used to avoid opening duplicates.
  withUser(userId: string) {
    return (
      this.list.find(
        (dm) => dm.type === 'DM' && dm.participants.some((user) => user.userId === userId)
      ) ?? null
    );
  }

  async load() {
    this.loading = true;
    this.error = null;

    const generation = ++this.#generation;
    try {
      const result = await anchor.client.dm.get();
      if (generation !== this.#generation) return;
      if (result.error || !result.data) {
        this.error = 'Could not load your direct messages.';
        return;
      }

      const { dms, pending } = result.data;
      // keep showing federated DMs until their homeserver's fetch replaces them.
      this.list = [
        ...dms,
        ...this.list.filter((dm) =>
          pending.some((homeserver: string) => isFromHomeserver(dm, homeserver))
        ),
      ];
      this.pending = pending;
      for (const homeserver of result.data.pending)
        void this.#loadHomeserver(homeserver, generation);
    } catch {
      this.error = 'Could not load your direct messages.';
    } finally {
      this.loading = false;
    }
  }

  async #loadHomeserver(homeserver: string, generation: number) {
    const result = await anchor.client.dm
      .homeserver({ homeserver })
      .get()
      .catch(() => null);
    if (generation !== this.#generation) return;

    if (result?.data) {
      this.list = this.list.filter((dm) => !isFromHomeserver(dm, homeserver));
      for (const dm of result.data.dms) this.upsert(dm);
    }
    this.pending = this.pending.filter((item) => item !== homeserver);
  }

  // resolves the DM channel with a friend, creating it if needed, without navigating.
  async ensure(userId: string) {
    const existing = this.withUser(userId);
    if (existing) return existing.id;

    const result = await anchor.client.dm.post({ userId });
    if (result.error || !result.data || 'error' in result.data) return null;

    this.upsert(result.data);
    return result.data.id;
  }

  async open(userId: string) {
    const channelId = await this.ensure(userId);
    if (channelId) void goto(dmPath(channelId));
    return channelId;
  }

  async close(channelId: string) {
    const closed = this.get(channelId);
    this.list = this.list.filter((dm) => dm.id !== channelId);

    const result = await anchor.client.dm({ id: channelId }).close.post();
    if (result.error && closed) this.upsert(closed);
  }

  // a group with these friends; any number of them, so adding people to a 1:1 makes a new group
  async createGroup(userIds: string[], name = '') {
    const { data, error } = await anchor.client.dm.group.post({ userIds, name });
    if (error || !data || 'error' in data)
      return { error: errorMessage(error, 'Could not create the group.') };
    this.upsert(data);
    void goto(dmPath(data.id));
    return { id: data.id };
  }

  async addMembers(channelId: string, userIds: string[]) {
    const { error } = await anchor.client.dm({ id: channelId }).members.post({ userIds });
    return error ? errorMessage(error, 'Could not add them.') : null;
  }

  async kick(channelId: string, userId: string) {
    const { error } = await anchor.client.dm({ id: channelId }).members({ userId }).delete();
    return error ? errorMessage(error, 'Could not remove them.') : null;
  }

  async transferOwner(channelId: string, userId: string) {
    const { error } = await anchor.client.dm({ id: channelId }).owner.post({ userId });
    return error ? errorMessage(error, 'Could not transfer the group.') : null;
  }

  async rename(channelId: string, name: string) {
    const { error } = await anchor.client.dm({ id: channelId }).patch({ name });
    return error ? errorMessage(error, 'Could not rename the group.') : null;
  }

  async uploadIcon(channelId: string, icon: File) {
    const { error } = await anchor.client.dm({ id: channelId }).icon.post({ icon });
    return error ? errorMessage(error, 'Could not upload the icon.') : null;
  }

  async addBot(channelId: string, bot: { username: string; homeserver: string }) {
    const { error } = await anchor.client.dm({ id: channelId }).bots.post(bot);
    return error ? errorMessage(error, 'Could not add the bot.') : null;
  }

  async leave(channelId: string) {
    const { error } = await anchor.client.dm({ id: channelId }).leave.post();
    if (error) return errorMessage(error, 'Could not leave the group.');
    this.remove(channelId);
    return null;
  }

  remove(channelId: string) {
    this.list = this.list.filter((dm) => dm.id !== channelId);
    if (this.incomingCall?.channelId === channelId) this.incomingCall = null;
    if (this.outgoingCall === channelId) this.outgoingCall = null;
  }

  update(change: Partial<DmEntry> & { id: string }) {
    this.list = this.list.map((dm) => (dm.id === change.id ? { ...dm, ...change } : dm));
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
