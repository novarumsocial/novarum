import { z } from 'zod';

export const userProfileSchema = z.object({
  displayName: z.string().max(64).nullable(),
  avatarUrl: z.url().nullable(),
  avatarColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable(),
  speakingRingColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable(),
  bannerUrl: z.url().nullable().optional().default(null),
  about: z.string().max(512).nullable().optional().default(null),
  isBot: z.boolean(),
});

export const publicUserSchema = userProfileSchema.extend({
  userId: z.string(),
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9._]+$/),
  homeserver: z.string().min(1).max(255),
});

export type UserProfile = z.infer<typeof userProfileSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;

export function publicUser(user: Omit<PublicUser, 'userId'> & { id: string }): PublicUser {
  return publicUserSchema.parse({ ...user, userId: user.id });
}

export function userProfile(user: UserProfile): UserProfile {
  return userProfileSchema.parse(user);
}

// What a homeserver may change on our copy of one of its users. Whether it is a bot is settled
// when we first see it: flipping it later would let a homeserver dodge "remove bot".
export function remoteProfile(user: UserProfile) {
  const { isBot: _, ...profile } = userProfile(user);
  return profile;
}
