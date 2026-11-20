// Port of apps/frontend/src/lib/moderation.svelte.ts
import { z } from 'zod';
import { create } from 'zustand';
import type { PublicUser } from 'anchor/public-user';
import { anchor } from './anchor';
import { chat } from './chat-state';
import { session } from './session';
import { toast } from './toast';
import { voice } from './voice';
import type { Author, Server } from './types/chat';

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
  const myId = session().user?.id;
  const myRole = chat().members.find((item) => item.userId === myId)?.role;
  if (!server.canManageChannels || !myRole || member.userId === myId) return false;
  if (member.role === 'OWNER') return false;
  return myRole === 'OWNER' || member.role !== 'ADMIN';
}

/** The guild is gone for us: we left it, or were kicked or banned (then we say so). */
export function guildRemoved(guildId: string, reason?: 'kicked' | 'banned') {
  const name = chat().servers.find((server) => server.id === guildId)?.name;
  const inCall = chat().channelsByServer[guildId]?.some((category) =>
    category.channels.some((channel) => channel.id === voice().channelId)
  );
  if (inCall) void voice().leave();
  chat().removeGuild(guildId);
  if (reason && name) {
    toast(reason === 'banned' ? `You were banned from ${name}` : `You were removed from ${name}`, {
      tone: 'error',
    });
  }
}

type Pending =
  | { kind: 'leave'; server: Server }
  | { kind: 'kick' | 'ban'; server: Server; member: Author };

/** The one confirm sheet for leaving, kicking and banning (see moderation-sheet.tsx). */
export const useModeration = create<{
  pending: Pending | null;
  busy: boolean;
  error: string | null;
  ask: (pending: Pending) => void;
  cancel: () => void;
  confirm: (reason: string) => Promise<void>;
}>((set, get) => ({
  pending: null,
  busy: false,
  error: null,
  ask: (pending) => set({ pending, error: null }),
  cancel: () => set({ pending: null, error: null }),
  async confirm(reason) {
    const { pending } = get();
    if (!pending) return;
    set({ busy: true });
    const guild = anchor().client.guilds({ id: pending.server.id });
    const { error } =
      pending.kind === 'leave'
        ? await guild.leave.post()
        : pending.kind === 'kick'
          ? await guild.members({ userId: pending.member.userId }).delete()
          : await guild
              .bans({ userId: pending.member.userId })
              .put({ reason: reason || undefined });
    set({ busy: false });

    if (error) return set({ error: errorMessage(error, 'Something went wrong, try again.') });
    set({ pending: null });
    if (pending.kind === 'leave') {
      guildRemoved(pending.server.id);
      toast(`You left ${pending.server.name}`);
    } else {
      chat().removeMember(pending.server.id, pending.member.userId);
      const name = pending.member.displayName || pending.member.username;
      toast(`${name} was ${pending.kind === 'ban' ? 'banned' : 'kicked'}`);
    }
  },
}));

export const moderation = useModeration.getState;

export async function listBans(guildId: string): Promise<GuildBan[] | string> {
  const { data, error } = await anchor().client.guilds({ id: guildId }).bans.get();
  if (error || !data) return errorMessage(error, 'Could not load the bans.');
  return data.bans;
}

export async function unban(guildId: string, userId: string) {
  const { error } = await anchor().client.guilds({ id: guildId }).bans({ userId }).delete();
  return error ? errorMessage(error, 'Could not lift the ban.') : null;
}
