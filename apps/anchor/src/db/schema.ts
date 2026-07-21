// schema kindly made by 5.6 sol medium effort.
// there are a few interesting modifications i wanted to make, which are referenced wherever they are made.
import {
  type AnyPgColumn,
  bigint,
  boolean,
  bytea,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const date = (name: string) =>
  timestamp(name, {
    withTimezone: true,
    mode: 'date',
    precision: 3,
  });

export const users = pgTable(
  'user',
  {
    // anything stored here may be publicly visible to other users
    // and federated homeservers, so be very much careful!
    // this is why we store the email as a LocalCredential, for example.
    id: text('id').primaryKey(),

    username: text('username').notNull(),

    // this was weirdly the same as prisma:
    // homeserver String @map("homeserverName")
    homeserver: text('homeserverName').notNull(),

    displayName: text('displayName'),
    avatarUrl: text('avatarUrl'),

    isBot: boolean('isBot').notNull(),

    createdAt: date('createdAt').notNull(),
    updatedAt: date('updatedAt')
      .notNull()
      .$onUpdate(() => new Date()),

    status: text('status').notNull().default('OFFLINE'),
  },
  (table) => [unique('user_username_homeserver_unique').on(table.username, table.homeserver)]
);

export const localCredentials = pgTable('local_credential', {
  userId: text('userId')
    .primaryKey()
    .references(() => users.id, {
      onDelete: 'cascade',
    }),

  email: text('email').notNull().unique(),
  passwordHash: text('passwordHash').notNull(),
});

export const sessions = pgTable(
  'session',
  {
    id: text('id').primaryKey(),

    userId: text('userId')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),

    secretHash: bytea('secretHash').notNull(),

    createdAt: date('createdAt').notNull(),

    // new! must set explicitly after a session is created.
    // though i think i might set this to a year every time, logouts are VERY annoying.
    // hopefully i can make the user choose session expirations in the near future.
    expiresAt: date('expiresAt').notNull(),
  },
  (table) => [
    // prisma did not explicitly define this, but it is useful for
    // listing/revoking all sessions belonging to a user.
    index('session_userId_idx').on(table.userId),

    // useful for removing expired sessions.
    index('session_expiresAt_idx').on(table.expiresAt),
  ]
);

export const guilds = pgTable(
  'guild',
  {
    id: text('id').primaryKey(),

    name: text('name').notNull(),
    description: text('description'),
    avatarUrl: text('avatarUrl'),

    ownerId: text('ownerId')
      .notNull()
      .references(() => users.id),

    createdAt: date('createdAt').notNull().defaultNow(),

    updatedAt: date('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    extAnchorDown: boolean('extAnchorDown'),
  },
  (table) => [index('guild_ownerId_idx').on(table.ownerId)]
);

export const guildMembers = pgTable(
  'guild_member',
  {
    guildId: text('guildId')
      .notNull()
      .references(() => guilds.id, {
        onDelete: 'cascade',
      }),

    userId: text('userId')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),

    role: text('role').notNull().default('MEMBER'),

    joinedAt: date('joinedAt').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'guild_member_pkey',
      columns: [table.guildId, table.userId],
    }),

    index('guild_member_userId_idx').on(table.userId),
  ]
);

export const channels = pgTable(
  'channel',
  {
    id: text('id').primaryKey(),

    guildId: text('guildId')
      .notNull()
      .references(() => guilds.id, {
        onDelete: 'cascade',
      }),

    name: text('name').notNull(),
    type: text('type').notNull().default('TEXT'),
    position: integer('position').notNull(),

    createdAt: date('createdAt').notNull().defaultNow(),

    updatedAt: date('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('channel_guildId_name_unique').on(table.guildId, table.name),

    index('channel_guildId_position_idx').on(table.guildId, table.position),
  ]
);

export const messages = pgTable(
  'message',
  {
    id: text('id').primaryKey(),

    channelId: text('channelId')
      .notNull()
      .references(() => channels.id, {
        onDelete: 'cascade',
      }),

    authorId: text('authorId')
      .notNull()
      .references(() => users.id),

    content: text('content').notNull(),
    nonce: text('nonce').notNull(),

    // this is now a self-referencing foreign key.
    // chatgpt note: explicit AnyPgColumn return type is needed because the table
    // references itself.
    replyTo: text('replyTo').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),

    createdAt: date('createdAt').notNull().defaultNow(),

    updatedAt: date('updatedAt')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    deletedAt: date('deletedAt'),
  },
  (table) => [
    unique('message_authorId_nonce_unique').on(table.authorId, table.nonce),

    index('message_channelId_createdAt_id_idx').on(table.channelId, table.createdAt, table.id),

    // added because replyTo is now a foreign key and will commonly
    // be used when resolving replies.
    index('message_replyTo_idx').on(table.replyTo),
  ]
);

export const messagePings = pgTable(
  'message_ping',
  {
    messageId: text('messageId')
      .notNull()
      .references(() => messages.id, {
        onDelete: 'cascade',
      }),

    userId: text('userId')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),
  },
  (table) => [
    primaryKey({
      name: 'message_ping_pkey',
      columns: [table.messageId, table.userId],
    }),

    index('message_ping_userId_idx').on(table.userId),
  ]
);

export const channelReadStates = pgTable(
  'channel_read_state',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),

    channelId: text('channelId')
      .notNull()
      .references(() => channels.id, {
        onDelete: 'cascade',
      }),

    lastReadCreatedAt: date('lastReadCreatedAt').notNull(),
    lastReadMessageId: text('lastReadMessageId').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'channel_read_state_pkey',
      columns: [table.userId, table.channelId],
    }),
  ]
);

export const attachments = pgTable(
  'attachment',
  {
    id: text('id').primaryKey(),

    objectKey: text('objectKey').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('contentType').notNull(),

    // fixed: moving this to bigint instead of int because
    // the file size limit on the database would be about 2GiB.
    size: bigint('size', {
      mode: 'number',
    }).notNull(),

    status: text('status').notNull().default('PENDING'),

    uploaderId: text('uploaderId')
      .notNull()
      .references(() => users.id),

    channelId: text('channelId')
      .notNull()
      .references(() => channels.id, {
        onDelete: 'cascade',
      }),

    messageId: text('messageId').references(() => messages.id, {
      onDelete: 'cascade',
    }),

    createdAt: date('createdAt').notNull().defaultNow(),
  },
  (table) => [
    index('attachment_uploaderId_status_idx').on(table.uploaderId, table.status),

    index('attachment_channelId_idx').on(table.channelId),
    index('attachment_messageId_idx').on(table.messageId),
  ]
);

export const guildInvites = pgTable(
  'guild_invite',
  {
    id: text('id').primaryKey(),

    guildId: text('guildId')
      .notNull()
      .references(() => guilds.id, {
        onDelete: 'cascade',
      }),

    code: text('code').notNull().unique(),

    createdAt: date('createdAt').notNull().defaultNow(),
    expiresAt: date('expiresAt'),

    creatorId: text('creatorId')
      .notNull()
      .references(() => users.id),
  },
  (table) => [index('guild_invite_guildId_idx').on(table.guildId)]
);

export const homeserverKeys = pgTable('homeserver_keys', {
  id: text('id').primaryKey(),

  homeserver: text('homeserver').notNull(),
  publicKey: text('publicKey').notNull(),
  privateKeyFilename: text('privateKeyFilename').notNull(),

  active: boolean('active').notNull().default(true),

  createdAt: date('createdAt').notNull().defaultNow(),

  updatedAt: date('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const federationNonces = pgTable(
  'federation_nonce',
  {
    id: text('id').primaryKey(),

    nonce: text('nonce').notNull(),
    homeserver: text('homeserver').notNull(),

    createdAt: date('createdAt').notNull().defaultNow(),
  },
  (table) => [
    // fixed: nonce uniqueness is scoped to the homeserver that sent it.
    unique('federation_nonce_homeserver_nonce_unique').on(table.homeserver, table.nonce),

    index('federation_nonce_createdAt_idx').on(table.createdAt),
  ]
);

export const emojis = pgTable('emojis', {
  id: serial('id').primaryKey(),

  name: text('name').notNull(),
  unicode: text('unicode').notNull().unique(),
  url: text('url').notNull(),

  createdAt: date('createdAt').notNull().defaultNow(),

  updatedAt: date('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
