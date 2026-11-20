import { z } from 'zod';

// Messages the homeserver writes itself, like "Ana added Leo" or "Missed call". The author is
// whoever did it. Targets are stored by name instead of id so other homeservers can show them
// without knowing those users.
const systemTargetSchema = z.object({
  username: z.string(),
  homeserver: z.string(),
  displayName: z.string().nullable(),
});

export const systemMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['member.added', 'member.removed', 'bot.added', 'bot.removed', 'owner.changed']),
    targets: z.array(systemTargetSchema).min(1).max(100),
  }),
  z.object({ type: z.enum(['group.created', 'member.left', 'group.icon']) }),
  z.object({ type: z.literal('group.renamed'), name: z.string().max(100) }),
  // durationSeconds is null while the call is going on; missed calls never had anyone answer
  z.object({
    type: z.literal('call'),
    durationSeconds: z.number().int().nonnegative().nullable(),
    missed: z.boolean(),
  }),
]);

export type SystemMessage = z.infer<typeof systemMessageSchema>;

export const systemTarget = (user: {
  username: string;
  homeserver: string;
  displayName: string | null;
}) => ({ username: user.username, homeserver: user.homeserver, displayName: user.displayName });
