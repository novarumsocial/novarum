import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  users: {
    localCredential: r.one.localCredentials({
      from: r.users.id,
      to: r.localCredentials.userId,
    }),
    sessions: r.many.sessions({ from: r.users.id, to: r.sessions.userId }),
    ownedGuilds: r.many.guilds({ from: r.users.id, to: r.guilds.ownerId }),
    guildMemberships: r.many.guildMembers({ from: r.users.id, to: r.guildMembers.userId }),
    messages: r.many.messages({ from: r.users.id, to: r.messages.authorId }),
    messagePings: r.many.messagePings({ from: r.users.id, to: r.messagePings.userId }),
    readStates: r.many.channelReadStates({
      from: r.users.id,
      to: r.channelReadStates.userId,
    }),
    attachments: r.many.attachments({ from: r.users.id, to: r.attachments.uploaderId }),
    guildInvites: r.many.guildInvites({ from: r.users.id, to: r.guildInvites.creatorId }),
  },
  localCredentials: {
    user: r.one.users({
      from: r.localCredentials.userId,
      to: r.users.id,
      optional: false,
    }),
  },
  sessions: {
    user: r.one.users({ from: r.sessions.userId, to: r.users.id, optional: false }),
  },
  guilds: {
    owner: r.one.users({ from: r.guilds.ownerId, to: r.users.id, optional: false }),
    members: r.many.guildMembers({ from: r.guilds.id, to: r.guildMembers.guildId }),
    channels: r.many.channels({ from: r.guilds.id, to: r.channels.guildId }),
    invites: r.many.guildInvites({ from: r.guilds.id, to: r.guildInvites.guildId }),
  },
  guildMembers: {
    guild: r.one.guilds({
      from: r.guildMembers.guildId,
      to: r.guilds.id,
      optional: false,
    }),
    user: r.one.users({
      from: r.guildMembers.userId,
      to: r.users.id,
      optional: false,
    }),
  },
  channels: {
    guild: r.one.guilds({ from: r.channels.guildId, to: r.guilds.id, optional: false }),
    messages: r.many.messages({ from: r.channels.id, to: r.messages.channelId }),
    readStates: r.many.channelReadStates({
      from: r.channels.id,
      to: r.channelReadStates.channelId,
    }),
    attachments: r.many.attachments({ from: r.channels.id, to: r.attachments.channelId }),
  },
  messages: {
    channel: r.one.channels({
      from: r.messages.channelId,
      to: r.channels.id,
      optional: false,
    }),
    author: r.one.users({ from: r.messages.authorId, to: r.users.id, optional: false }),
    replyToMessage: r.one.messages({ from: r.messages.replyTo, to: r.messages.id }),
    replies: r.many.messages({ from: r.messages.id, to: r.messages.replyTo }),
    pings: r.many.messagePings({ from: r.messages.id, to: r.messagePings.messageId }),
    attachments: r.many.attachments({ from: r.messages.id, to: r.attachments.messageId }),
  },
  messagePings: {
    message: r.one.messages({
      from: r.messagePings.messageId,
      to: r.messages.id,
      optional: false,
    }),
    user: r.one.users({ from: r.messagePings.userId, to: r.users.id, optional: false }),
  },
  channelReadStates: {
    user: r.one.users({
      from: r.channelReadStates.userId,
      to: r.users.id,
      optional: false,
    }),
    channel: r.one.channels({
      from: r.channelReadStates.channelId,
      to: r.channels.id,
      optional: false,
    }),
  },
  attachments: {
    uploader: r.one.users({
      from: r.attachments.uploaderId,
      to: r.users.id,
      optional: false,
    }),
    channel: r.one.channels({
      from: r.attachments.channelId,
      to: r.channels.id,
      optional: false,
    }),
    message: r.one.messages({ from: r.attachments.messageId, to: r.messages.id }),
  },
  guildInvites: {
    guild: r.one.guilds({
      from: r.guildInvites.guildId,
      to: r.guilds.id,
      optional: false,
    }),
    creator: r.one.users({
      from: r.guildInvites.creatorId,
      to: r.users.id,
      optional: false,
    }),
  },
}));
