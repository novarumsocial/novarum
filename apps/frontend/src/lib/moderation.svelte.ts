import { z } from 'zod';
import { toast } from 'svelte-sonner';
import { anchor } from '$lib/anchor.svelte';
import { chat } from '$lib/chat-state.svelte';
import { useSession } from '$lib/session.svelte';
import type { Author, Server } from '$lib/types/chat';
import type { PublicUser } from 'anchor/public-user';

// Leaving guilds, kicking and banning members.

const apiErrorSchema = z.object({ error: z.string() });
const errorMessage = (error: { value?: unknown } | null | undefined, fallback: string) =>
  apiErrorSchema.safeParse(error?.value).data?.error ?? fallback;

export type GuildBan = {
  user: PublicUser;
  reason: string | null;
  bannedBy: PublicUser | null;
  createdAt: string;
};

/** Whether the signed-in user may kick or ban `member`: owners anyone, admins plain members. */
export function canModerate(server: Server, member: Author) {
  const myId = useSession().user?.id;
  const myRole = chat.members.find((item) => item.userId === myId)?.role;
  if (!server.canManageChannels || !myRole || member.userId === myId) return false;
  if (member.role === 'OWNER') return false;
  return myRole === 'OWNER' || member.role !== 'ADMIN';
}

/** The guild is gone for us: we left it, or were kicked or banned (then we say so). */
export function guildRemoved(guildId: string, reason?: 'kicked' | 'banned') {
  const name = chat.servers.find((server) => server.id === guildId)?.name;
  // app-shell hangs up when we were in a call there
  moderation.removedChannelIds = (chat.channelsByServer[guildId] ?? []).flatMap((category) =>
    category.channels.map((channel) => channel.id)
  );
  chat.removeGuild(guildId);
  if (reason && name) {
    toast.error(
      reason === 'banned' ? `You were banned from ${name}` : `You were removed from ${name}`
    );
  }
}

type Pending =
  | { kind: 'leave'; server: Server }
  | { kind: 'kick' | 'ban'; server: Server; member: Author };

/** The one confirm dialog for leaving, kicking and banning (see moderation-dialog.svelte). */
class ModerationState {
  pending = $state<Pending | null>(null);
  removedChannelIds = $state<string[]>([]);
  busy = $state(false);
  error = $state<string | null>(null);

  ask(pending: Pending) {
    this.error = null;
    this.pending = pending;
  }

  async confirm(reason: string) {
    const pending = this.pending;
    if (!pending) return;
    this.busy = true;
    const guild = anchor.client.guilds({ id: pending.server.id });
    const { error } =
      pending.kind === 'leave'
        ? await guild.leave.post()
        : pending.kind === 'kick'
          ? await guild.members({ userId: pending.member.userId }).delete()
          : await guild
              .bans({ userId: pending.member.userId })
              .put({ reason: reason || undefined });
    this.busy = false;

    if (error) {
      this.error = errorMessage(error, 'Something went wrong, try again.');
      return;
    }
    this.pending = null;
    if (pending.kind === 'leave') {
      guildRemoved(pending.server.id);
      toast.success(`You left ${pending.server.name}`);
    } else {
      chat.removeMember(pending.server.id, pending.member.userId);
      const name = pending.member.displayName || pending.member.username;
      toast.success(`${name} was ${pending.kind === 'ban' ? 'banned' : 'kicked'}`);
    }
  }
}

export const moderation = new ModerationState();

export async function listBans(guildId: string): Promise<GuildBan[] | string> {
  const { data, error } = await anchor.client.guilds({ id: guildId }).bans.get();
  if (error || !data) return errorMessage(error, 'Could not load the bans.');
  return data.bans;
}

export async function unban(guildId: string, userId: string) {
  const { error } = await anchor.client.guilds({ id: guildId }).bans({ userId }).delete();
  return error ? errorMessage(error, 'Could not lift the ban.') : null;
}
