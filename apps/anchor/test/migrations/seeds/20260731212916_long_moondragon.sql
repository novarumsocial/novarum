-- seed for the schema after the 7 migration(s) before 20260731212916_long_moondragon
-- frozen: do not edit once the migration is merged

INSERT INTO "user" ("id", "avatarUrl", "displayName", "createdAt", "homeserverName", "isBot", "updatedAt", "username", "status", "isHomeserverAdmin", "bannerUrl", "about", "avatarColor") VALUES
  ('u1', NULL, 'ALICE', '2026-07-20 10:00:00+00', 'localhost', false, '2026-07-20 10:00:00+00', 'alice', 'OFFLINE', true, 'https://localhost/banner.png', 'hello', '#112233'),
  ('u2', NULL, 'BOB', '2026-07-20 10:00:00+00', 'localhost', false, '2026-07-20 10:00:00+00', 'bob', 'OFFLINE', false, NULL, NULL, '#112233'),
  ('u3', NULL, 'CAROL', '2026-07-20 10:00:00+00', 'localhost', false, '2026-07-20 10:00:00+00', 'carol', 'OFFLINE', false, NULL, NULL, '#112233'),
  ('u4', NULL, 'DAVE', '2026-07-20 10:00:00+00', 'remote.example', false, '2026-07-20 10:00:00+00', 'dave', 'OFFLINE', false, NULL, NULL, '#112233');

INSERT INTO "local_credential" ("userId", "email", "passwordHash") VALUES
  ('u1', 'u1@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'),
  ('u2', 'u2@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'),
  ('u3', 'u3@example.test', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA');

INSERT INTO "session" ("createdAt", "id", "secretHash", "userId", "expiresAt") VALUES
  ('2026-07-21 10:00:00+00', 's1', '\xdeadbeef', 'u1', '2026-07-21 10:00:00+00'),
  ('2026-07-22 10:00:00+00', 's2', '\xdeadbeef', 'u2', '2026-07-22 10:00:00+00');

INSERT INTO "guild" ("id", "name", "ownerId", "createdAt", "updatedAt", "description") VALUES
  ('g1', 'General', 'u1', '2026-07-20 10:00:00+00', '2026-07-20 10:00:00+00', 'main guild'),
  ('g2', 'Side', 'u2', '2026-07-21 10:00:00+00', '2026-07-21 10:00:00+00', NULL),
  ('g3', 'Remote shadow', 'u4', '2026-07-22 10:00:00+00', '2026-07-22 10:00:00+00', false);

INSERT INTO "guild_member" ("guildId", "userId", "role", "joinedAt") VALUES
  ('g1', 'u1', 'OWNER', '2026-07-20 10:00:00+00'),
  ('g2', 'u1', 'MEMBER', '2026-07-19 10:00:00+00'),
  ('g3', 'u1', 'MEMBER', '2026-07-23 10:00:00+00'),
  ('g1', 'u2', 'MEMBER', '2026-07-21 10:00:00+00'),
  ('g2', 'u2', 'OWNER', '2026-07-21 10:00:00+00'),
  ('g1', 'u3', 'MEMBER', '2026-07-22 10:00:00+00'),
  ('g3', 'u4', 'OWNER', '2026-07-22 10:00:00+00');

INSERT INTO "channel" ("createdAt", "guildId", "id", "name", "position", "type", "updatedAt") VALUES
  ('2026-07-20 10:00:00+00', 'g1', 'c1', 'general', 0, 'TEXT', '2026-07-20 10:00:00+00'),
  ('2026-07-20 10:00:00+00', 'g1', 'c2', 'voice', 1, 'VOICE', '2026-07-20 10:00:00+00'),
  ('2026-07-21 10:00:00+00', 'g2', 'c3', 'general', 0, 'TEXT', '2026-07-21 10:00:00+00'),
  ('2026-07-22 10:00:00+00', 'g3', 'fed:channel:remote.example:c9', 'remote-general', 0, 'TEXT', '2026-07-22 10:00:00+00');

INSERT INTO "message" ("authorId", "channelId", "content", "createdAt", "deletedAt", "id", "nonce", "updatedAt", "replyTo") VALUES
  ('u1', 'c1', 'hello @bob', '2026-07-24 10:00:00+00', NULL, 'm1', 'nonce-m1', '2026-07-24 10:00:00+00', NULL),
  ('u2', 'c1', 'hi alice', '2026-07-24 10:00:00+00', NULL, 'm2', 'nonce-m2', '2026-07-24 10:00:00+00', 'm1'),
  ('u3', 'c1', NULL, '2026-07-25 10:00:00+00', NULL, 'm3', 'nonce-m3', '2026-07-24 10:00:00+00', NULL),
  ('u1', 'c1', 'deleted one', '2026-07-24 10:00:00+00', '2026-07-26 10:00:00+00', 'm4', 'nonce-m4', '2026-07-24 10:00:00+00', NULL),
  ('u2', 'c3', 'side channel', '2026-07-24 10:00:00+00', NULL, 'm5', 'nonce-m5', '2026-07-24 10:00:00+00', NULL),
  ('u4', 'fed:channel:remote.example:c9', 'from the other side', '2026-07-24 10:00:00+00', NULL, 'm6', 'nonce-m6', '2026-07-24 10:00:00+00', NULL);

INSERT INTO "message_ping" ("messageId", "userId") VALUES
  ('m1', 'u2'),
  ('m2', 'u1');

INSERT INTO "attachment" ("channelId", "contentType", "createdAt", "filename", "id", "messageId", "objectKey", "size", "status", "uploaderId") VALUES
  ('c1', 'image/png', '2026-07-24 10:00:00+00', 'cat.png', 'a1', 'm1', 'attachments/a1/cat.png', 1234, 'READY', 'u1'),
  ('c1', 'text/plain', '2026-07-24 10:00:00+00', 'pending.txt', 'a2', NULL, 'attachments/a2/pending.txt', 12, 'PENDING', 'u2');

INSERT INTO "channel_read_state" ("channelId", "lastReadCreatedAt", "lastReadMessageId", "userId") VALUES
  ('c1', '2026-07-24 10:00:00+00', 'm1', 'u2');

INSERT INTO "guild_invite" ("code", "createdAt", "expiresAt", "guildId", "id", "creatorId") VALUES
  ('invitecode1', '2026-07-20 10:00:00+00', NULL, 'g1', 'i1', 'u1');

INSERT INTO "federation_nonce" ("createdAt", "homeserver", "id", "nonce") VALUES
  ('2026-07-24 10:00:00+00', 'remote.example', 'n1', 'nonce-a'),
  ('2026-07-24 10:00:00+00', 'other.example', 'n2', 'nonce-b');

INSERT INTO "emojis" ("name", "unicode", "updatedAt", "url") VALUES
  ('smile', '1f604', '2026-07-20 10:00:00+00', 'https://localhost/emoji/1f604.png');

INSERT INTO "homeserver_keys" ("active", "createdAt", "homeserver", "id", "privateKeyFilename", "publicKey", "updatedAt") VALUES
  (true, '2026-07-20 10:00:00+00', 'localhost', 'k1', 'k1.pem', 'cHVibGljLWtleQ==', '2026-07-20 10:00:00+00');
