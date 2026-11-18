import { anchor } from '$lib/anchor.svelte';
import { goto } from '$app/navigation';
import type { PublicUser } from 'anchor/public-user';
import { useSession } from '$lib/session.svelte';

export type DmEntry = {
  id: string;
  type: 'DM' | 'GROUP_DM';
  participants: PublicUser[];
  lastMessageAt: string | null;
  lastMessage: DmPreview | null;
  unread: boolean;
  joinedAt: string;
};

export type DmPreview = {
  id: string;
  authorId: string;
  content: string | null;
  attachmentCount: number;
};

type PreviewMessage = {
  id: string;
  channelId: string;
  createdAt: string;
  content: string | null;
  attachments: unknown[];
  author: Pick<PublicUser, 'userId' | 'username' | 'homeserver'>;
};

const sameUser = (a: { username: string; homeserver: string }, b: typeof a) =>
  a.username.toLowerCase() === b.username.toLowerCase() &&
  a.homeserver.toLowerCase() === b.homeserver.toLowerCase();

// relayed federated messages carry the host's user ids, so authors are matched by handle to ours
function toPreview(dm: DmEntry, message: PreviewMessage): DmPreview {
  const self = useSession().user;
  const authorId =
    self && sameUser(self, message.author)
      ? self.id
      : (dm.participants.find((user) => sameUser(user, message.author))?.userId ??
        message.author.userId);
  return {
    id: message.id,
    authorId,
    content: message.content,
    attachmentCount: message.attachments.length,
  };
}

export function dmPreviewText({ lastMessage }: DmEntry) {
  if (!lastMessage) return null;
  const { content, attachmentCount } = lastMessage;
  const text =
    content ??
    (attachmentCount > 1
      ? `Sent ${attachmentCount} attachments`
      : attachmentCount
        ? 'Sent an attachment'
        : null);
  if (!text) return null;
  return lastMessage.authorId === useSession().user?.id ? `You: ${text}` : text;
}

export const RING_TIMEOUT = 30_000;

// federated DM ids look like fed:channel:<homeserver>:<id> (see anchor's federationIds.ts)
const isFromHomeserver = (dm: DmEntry, homeserver: string) =>
  dm.id.startsWith(`fed:channel:${encodeURIComponent(homeserver)}:`);

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
    return this.list.find((dm) => dm.participants.some((user) => user.userId === userId)) ?? null;
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

  upsert(dm: DmEntry) {
    const existing = this.get(dm.id);
    this.list = existing
      ? this.list.map((item) => (item.id === dm.id ? { ...item, ...dm } : item))
      : [dm, ...this.list];
  }

  handleMessage(message: PreviewMessage, active: boolean) {
    if (!this.get(message.channelId)) {
      void this.load();
      return;
    }

    this.list = this.list.map((dm) => {
      if (dm.id !== message.channelId) return dm;
      const lastMessage = toPreview(dm, message);
      const fromSelf = lastMessage.authorId === useSession().user?.id;
      return { ...dm, lastMessageAt: message.createdAt, lastMessage, unread: !active && !fromSelf };
    });
  }

  handleMessageEdit(message: PreviewMessage) {
    this.list = this.list.map((dm) =>
      dm.lastMessage?.id === message.id ? { ...dm, lastMessage: toPreview(dm, message) } : dm
    );
  }

  // the preview before a deleted newest message isn't known here, so the server picks it again
  handleMessageDelete(messageId: string) {
    if (this.list.some((dm) => dm.lastMessage?.id === messageId)) void this.load();
  }

  markRead(channelId: string) {
    this.list = this.list.map((dm) => (dm.id === channelId ? { ...dm, unread: false } : dm));
  }
}

export const dms = new DmsState();
