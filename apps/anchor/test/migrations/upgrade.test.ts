import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnAnchor } from '../harness/anchor';
import {
  applyMigrations,
  countTables,
  migrationNames,
  query,
  recordedMigrations,
  withDatabase,
} from './helpers';

const seedDir = path.join(import.meta.dir, 'seeds');
const index = (name: string) => migrationNames.indexOf(name);

type Check = (url: string) => Promise<void>;
type Spec = {
  /** rows the migration is allowed to remove, per table */
  deletes?: Record<string, number>;
  check?: Check;
};

const rows = <T>(url: string, sql: string) => query<T>(url, sql);
const fails = (url: string, sql: string) =>
  query(url, sql).then(
    () => false,
    () => true
  );

const specs: Record<string, Spec> = {
  '20260721183541_mute_blindfold': {},
  '20260721184753_new-schema': {
    check: async (url) => {
      const sessions = await rows<{ expiresAt: Date }>(url, `SELECT "expiresAt" FROM session`);
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.expiresAt > new Date())).toBe(true);
      // a dangling replyTo is cleaned up so the new FK can be created; the message itself survives
      expect(
        await rows(url, `SELECT id FROM message WHERE id = 'm7' AND "replyTo" IS NULL`)
      ).toHaveLength(1);
      expect(
        await rows(url, `SELECT id FROM message WHERE id = 'm2' AND "replyTo" = 'm1'`)
      ).toHaveLength(1);
      expect(
        await rows<{ size: string }>(url, `SELECT size FROM attachment WHERE id = 'a1'`)
      ).toEqual([{ size: '1234' }] as never);
    },
  },
  '20260725140444_careless_tag': {
    check: async (url) => {
      expect(
        await rows(url, `SELECT id FROM "user" WHERE "isHomeserverAdmin" IS NOT FALSE`)
      ).toHaveLength(0);
    },
  },
  '20260726153501_plain_stature': {
    check: async (url) =>
      expect(await rows(url, `SELECT id FROM "user" WHERE "bannerUrl" IS NOT NULL`)).toHaveLength(
        0
      ),
  },
  '20260726173228_spooky_nitro': {
    check: async (url) =>
      expect(await rows(url, `SELECT id FROM "user" WHERE "about" IS NOT NULL`)).toHaveLength(0),
  },
  '20260730165038_white_switch': {
    check: async (url) => {
      await query(
        url,
        `INSERT INTO message (id, "channelId", "authorId", content, nonce) VALUES ('mnull', 'c1', 'u1', NULL, 'n-null')`
      );
      expect(await rows(url, `SELECT id FROM message WHERE content = 'hello @bob'`)).toHaveLength(
        1
      );
    },
  },
  '20260730213712_brainy_layla_miller': {
    check: async (url) =>
      expect(await rows(url, `SELECT id FROM "user" WHERE "avatarColor" IS NOT NULL`)).toHaveLength(
        0
      ),
  },
  '20260731212916_long_moondragon': {
    check: async (url) => {
      const pos = await rows<{ userId: string; guildId: string; position: number }>(
        url,
        `SELECT "userId", "guildId", position FROM guild_member ORDER BY "userId", position`
      );
      // ordered by joinedAt, ties broken by guildId, 0-based per user
      expect(pos.filter((p) => p.userId === 'u1').map((p) => [p.guildId, p.position])).toEqual([
        ['g2', 0],
        ['g1', 1],
        ['g3', 2],
      ]);
      expect(pos.filter((p) => p.userId === 'u2').map((p) => [p.guildId, p.position])).toEqual([
        ['g1', 0],
        ['g2', 1],
      ]);
      expect(pos.filter((p) => p.userId === 'u3').map((p) => p.position)).toEqual([0]);
    },
  },
  '20260802145339_sleepy_genesis': {
    check: async (url) =>
      expect(await rows(url, `SELECT 1 FROM friend_relationship`)).toHaveLength(0),
  },
  '20260803103349_curious_scarlet_witch': {
    // the unordered pair and the BLOCKED row are invalid under the new checks and are removed
    deletes: { friend_relationship: 2 },
    check: async (url) => {
      const rel = await rows<{ userOneId: string; syncPending: boolean; version: number }>(
        url,
        `SELECT "userOneId", "syncPending", version FROM friend_relationship ORDER BY "userTwoId"`
      );
      expect(rel).toEqual([
        { userOneId: 'u1', syncPending: false, version: 1 },
        { userOneId: 'u1', syncPending: false, version: 1 },
      ]);
      const bad = `INSERT INTO friend_relationship ("userOneId", "userTwoId", "requestedById", status) VALUES`;
      expect(await fails(url, `${bad} ('u3', 'u2', 'u3', 'PENDING')`)).toBe(true);
      expect(await fails(url, `${bad} ('u2', 'u3', 'u2', 'BLOCKED')`)).toBe(true);
      expect(await fails(url, `${bad} ('u2', 'u3', 'u1', 'PENDING')`)).toBe(true);
    },
  },
  '20260806153815_sad_beyonder': {
    check: async (url) => expect(await rows(url, `SELECT 1 FROM email_otps`)).toHaveLength(0),
  },
  '20260806211613_shocking_nightshade': {
    check: async (url) => {
      const otps = await rows<{ id: string; otp: string }>(
        url,
        `SELECT id, otp FROM email_otps ORDER BY id`
      );
      expect(otps).toEqual([
        { id: 'o1', otp: '123456' },
        { id: 'o2', otp: '7' },
      ]);
    },
  },
  '20260809151942_aspiring_typhoid_mary': {
    check: async (url) => {
      const creds = await rows<{ n: number; totpSecret: unknown }>(
        url,
        `SELECT cardinality("mfaOptions") AS n, "totpSecret" FROM local_credential`
      );
      expect(creds).toHaveLength(3);
      expect(creds.every((c) => c.totpSecret === null && c.n === 0)).toBe(true);
      await query(
        url,
        `UPDATE local_credential SET "mfaOptions" = ARRAY['TOTP','EMAIL']::mfa_method[] WHERE "userId" = 'u1'`
      );
    },
  },
  '20260811001924_exotic_risque': {
    check: async (url) => {
      const users = await rows<{ avatarColor: string; speakingRingColor: string }>(
        url,
        `SELECT "avatarColor", "speakingRingColor" FROM "user"`
      );
      expect(users).toHaveLength(4);
      // existing values are kept; the new column's default is backfilled; new rows get the new avatar default
      expect(
        users.every((u) => u.avatarColor === '#112233' && u.speakingRingColor === '#00d492')
      ).toBe(true);
      await query(
        url,
        `INSERT INTO "user" (id, "createdAt", "homeserverName", "isBot", "updatedAt", username) VALUES ('u9', now(), 'localhost', false, now(), 'zed')`
      );
      expect(
        await rows(url, `SELECT 1 FROM "user" WHERE id = 'u9' AND "avatarColor" = '#005f78'`)
      ).toHaveLength(1);
    },
  },
  '20260927212232_add_dm_channels': {
    check: async (url) => {
      // guild channels keep their guild and have no dmKey
      const ch = await rows<{ id: string; guildId: string | null; dmKey: string | null }>(
        url,
        `SELECT id, "guildId", "dmKey" FROM channel ORDER BY id`
      );
      expect(ch).toHaveLength(4);
      expect(ch.every((c) => c.guildId !== null && c.dmKey === null)).toBe(true);
      expect(ch.find((c) => c.id === 'c1')!.guildId).toBe('g1');
      // the check constraint accepts existing rows and the new shape, and rejects a guildless TEXT channel
      expect(
        await rows(
          url,
          `SELECT 1 FROM pg_constraint WHERE conname = 'channel_guild_or_dm_check' AND convalidated`
        )
      ).toHaveLength(1);
      const dm = (id: string, type: string, key: string) =>
        `INSERT INTO channel (id, name, type, "dmKey") VALUES ('${id}', '', '${type}', '${key}')`;
      expect(await fails(url, dm('x1', 'TEXT', 'u1:u2'))).toBe(true);
      await query(url, dm('d1', 'DM', 'u1:u2'));
      await query(url, dm('d2', 'DM', 'u1:u3'));
      expect(await fails(url, dm('d3', 'DM', 'u1:u2'))).toBe(true);
      await query(
        url,
        `INSERT INTO channel_member ("channelId", "userId") VALUES ('d1','u1'), ('d1','u2'), ('d2','u1'), ('d2','u3')`
      );
      // FKs cascade on user delete and on channel delete
      await query(
        url,
        `DELETE FROM channel_member WHERE "userId" = 'u2'; INSERT INTO channel_member ("channelId", "userId") VALUES ('d1','u2')`
      );
      await query(
        url,
        `DELETE FROM message_ping WHERE "userId" = 'u3'; DELETE FROM friend_relationship WHERE "userOneId" = 'u3' OR "userTwoId" = 'u3'; DELETE FROM guild_member WHERE "userId" = 'u3'; DELETE FROM channel_read_state WHERE "userId" = 'u3'; DELETE FROM message WHERE "authorId" = 'u3'; DELETE FROM "user" WHERE id = 'u3'`
      );
      expect(await rows(url, `SELECT 1 FROM channel_member WHERE "userId" = 'u3'`)).toHaveLength(0);
      await query(url, `DELETE FROM channel WHERE id = 'd1'`);
      expect(await rows(url, `SELECT 1 FROM channel_member WHERE "channelId" = 'd1'`)).toHaveLength(
        0
      );
      expect(await rows(url, `SELECT 1 FROM channel_member WHERE "channelId" = 'd2'`)).toHaveLength(
        1
      );
    },
  },
  '20261004105808_silky_tattoo': {
    check: async (url) => {
      // the new tables start empty and everything cascades from user and session
      await query(
        url,
        `INSERT INTO notification_setting ("userId", "targetId", level) VALUES ('u1', 'g1', 'MENTIONS'), ('u1', 'fed:guild:remote.example:g9', 'NONE');
         INSERT INTO notification_preference ("userId") VALUES ('u1');
         INSERT INTO push_subscription (id, "userId", "sessionId", kind, endpoint, p256dh, auth) VALUES ('p1', 'u1', 's1', 'WEBPUSH', 'https://push.example/1', 'k', 'a')`
      );
      expect(await fails(url, `INSERT INTO notification_setting ("userId", "targetId", level) VALUES ('u1', 'g1', 'ALL')`)).toBe(true);
      expect(await fails(url, `INSERT INTO push_subscription (id, "userId", "sessionId", kind, endpoint, p256dh, auth) VALUES ('p2', 'u1', 's1', 'FCM', 'x', 'k', 'a')`)).toBe(true);
      await query(url, `DELETE FROM session WHERE id = 's1'`);
      expect(await rows(url, `SELECT 1 FROM push_subscription`)).toHaveLength(0);
    },
  },
};

describe('step-wise upgrade with data', () => {
  test('every migration has a spec and every seed belongs to a migration', () => {
    expect(Object.keys(specs).sort()).toEqual(migrationNames);
  });

  test('the first migration applies to an empty database', async () => {
    await withDatabase('mig_first', async (url) => {
      await applyMigrations(url, 1);
      expect(await recordedMigrations(url)).toHaveLength(1);
    });
  });

  for (const name of migrationNames.slice(1)) {
    test(`${name} upgrades a seeded database`, async () => {
      await withDatabase('mig_step', async (url) => {
        const n = index(name);
        await applyMigrations(url, n);
        await query(url, readFileSync(path.join(seedDir, `${name}.sql`), 'utf8'));
        const before = await countTables(url);
        expect(Object.values(before).reduce((a, b) => a + b, 0)).toBeGreaterThan(20);

        await applyMigrations(url, n + 1);

        const after = await countTables(url);
        const { deletes = {}, check } = specs[name]!;
        for (const [table, count] of Object.entries(before)) {
          expect(after[table], `rows in ${table}`).toBe(count - (deletes[table] ?? 0));
        }
        expect(await recordedMigrations(url)).toHaveLength(n + 1);
        await check?.(url);
      });
    }, 30_000);
  }
});

describe('upgrade by booting anchor', () => {
  test('anchor migrates a seeded previous-version database on boot', async () => {
    await withDatabase('mig_boot', async (url) => {
      const last = migrationNames.at(-1)!;
      await applyMigrations(url, migrationNames.length - 1);
      await query(url, readFileSync(path.join(seedDir, `${last}.sql`), 'utf8'));
      const anchor = await spawnAnchor({ name: 'upgrade', db: url });
      try {
        expect(await recordedMigrations(url)).toHaveLength(migrationNames.length);
        expect(await query(url, `SELECT 1 FROM message`)).toHaveLength(6);
      } finally {
        await anchor.destroy();
      }
    });
  });
});
