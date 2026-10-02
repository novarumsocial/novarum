import { describe, expect, test } from 'bun:test';
import {
  mapFederatedRealtimeEvent,
  parseRealtimeEvent,
  realtimeEventSchema,
} from '../../utils/federationRealtime';
import { parseFederatedChannelId, parseFederatedGuildId } from '../../utils/federationIds';
import type { RealtimeEvent } from '../../utils/types';

const HS = 'b.test';
const user = {
  userId: 'u1',
  username: 'alice',
  homeserver: HS,
  displayName: null,
  avatarUrl: null,
  avatarColor: null,
  speakingRingColor: null,
  bannerUrl: null,
  about: null,
  isBot: false,
};
const channel = { id: 'c1', guildId: 'g1', name: 'general', type: 'TEXT', position: 0 };
const message = {
  id: 'm1',
  channelId: 'c1',
  guildId: 'g1',
  content: 'hi',
  nonce: 'n1',
  replyTo: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  edited: false,
  pingedHandles: [],
  attachments: [],
  author: user,
};

// one valid fixture per event type, in the remote's own (plain) id space
const fixtures: Record<string, unknown> = {
  'guild.created': {
    id: 'g1',
    name: 'G',
    ownerId: 'u1',
    avatarUrl: null,
    description: null,
    channels: [channel, { ...channel, id: 'c2', position: 1 }],
  },
  'channel.created': channel,
  'message.created': message,
  'message.updated': { ...message, edited: true },
  'message.deleted': { id: 'm1', channelId: 'c1', guildId: 'g1' },
  'user.status.changed': { userId: 'u1', status: 'ONLINE' },
  'member.joined': { guildId: 'g1', user: { ...user, status: 'ONLINE' } },
  'voice.states.snapshot': {
    guildIds: ['g1'],
    states: [{ guildId: 'g1', channelId: 'c1', userId: 'u1', name: null }],
  },
  'voice.state.changed': {
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    name: null,
    connected: true,
  },
  'call.ringing': { channelId: 'c1', user, ringing: true },
  'channel.typing': {
    channelId: 'c1',
    userId: 'u1',
    username: 'alice',
    displayName: null,
    homeserver: HS,
    time: '2026-01-01T00:00:00.000Z',
  },
  'guild.channels.reordered': { guildId: 'g1', channelIds: ['c1', 'c2'] },
};
const parse = (type: string, data: unknown = fixtures[type]) =>
  parseRealtimeEvent(JSON.stringify({ type, data }));

// collects every string leaf with its key, for the "never double-prefixed" sweep
function leaves(value: unknown, key = ''): [string, string][] {
  if (typeof value === 'string') return [[key, value]];
  if (Array.isArray(value)) return value.flatMap((v) => leaves(v, key));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => leaves(v, k));
  return [];
}

const guildOnce = (id: string | null, original: string) =>
  expect(parseFederatedGuildId(id!)).toEqual({ homeserver: HS, id: original });
const channelOnce = (id: string | null, original: string) =>
  expect(parseFederatedChannelId(id!)).toEqual({ homeserver: HS, id: original });

describe('realtimeEventSchema', () => {
  test('there is a fixture for every event type the schema accepts', () => {
    const types = realtimeEventSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(fixtures).sort()).toEqual(types);
  });

  test('every fixture parses', () => {
    for (const type of Object.keys(fixtures)) expect(String(parse(type)?.type)).toBe(type);
  });

  test('defaults are filled for older peers (replyTo, pingedHandles)', () => {
    const { replyTo: _r, pingedHandles: _p, ...old } = message;
    const event = parse('message.created', old);
    expect(event).toMatchObject({ data: { replyTo: null, pingedHandles: [] } });
  });
});

describe('parseRealtimeEvent drops unknown and malformed events', () => {
  test.each([
    ['not json', 'nope{'],
    ['empty string', ''],
    ['json null', 'null'],
    ['json array', '[]'],
    ['unknown type', JSON.stringify({ type: 'guild.exploded', data: {} })],
    ['missing type', JSON.stringify({ data: fixtures['message.deleted'] })],
    ['missing data', JSON.stringify({ type: 'message.deleted' })],
    ['wrong data shape', JSON.stringify({ type: 'message.deleted', data: { id: 1 } })],
    [
      'bad status enum',
      JSON.stringify({ type: 'user.status.changed', data: { userId: 'u', status: 'AWAY' } }),
    ],
    [
      'bad channel type',
      JSON.stringify({ type: 'channel.created', data: { ...channel, type: 'FORUM' } }),
    ],
    [
      'non-url avatar',
      JSON.stringify({
        type: 'guild.created',
        data: { ...(fixtures['guild.created'] as object), avatarUrl: 'nope' },
      }),
    ],
  ])('%s', (_n, raw) => expect(parseRealtimeEvent(raw)).toBeNull());

  test.each([[undefined], [null], [42], [{}], [new Uint8Array([1])], [new ArrayBuffer(4)]])(
    'non-string payload %p',
    (data) => expect(parseRealtimeEvent(data)).toBeNull()
  );
});

describe('mapFederatedRealtimeEvent', () => {
  const map = (type: string) => mapFederatedRealtimeEvent(parse(type)!, HS) as any;

  test('guild.created', () => {
    const { data } = map('guild.created');
    guildOnce(data.id, 'g1');
    expect(data.ownerId).toBe('u1');
    channelOnce(data.channels[0].id, 'c1');
    channelOnce(data.channels[1].id, 'c2');
    for (const c of data.channels) guildOnce(c.guildId, 'g1');
  });

  test('channel.created', () => {
    const { data } = map('channel.created');
    channelOnce(data.id, 'c1');
    guildOnce(data.guildId, 'g1');
  });

  test.each(['message.created', 'message.updated'])('%s', (type) => {
    const { data } = map(type);
    channelOnce(data.channelId, 'c1');
    guildOnce(data.guildId, 'g1');
    expect(data.id).toBe('m1'); // message ids stay plain
  });

  test('message.created in a DM has no guild', () => {
    const event = mapFederatedRealtimeEvent(
      parse('message.created', { ...message, guildId: null })!,
      HS
    ) as any;
    expect(event.data.guildId).toBeNull();
    channelOnce(event.data.channelId, 'c1');
  });

  test('message.deleted', () => {
    const { data } = map('message.deleted');
    channelOnce(data.channelId, 'c1');
    guildOnce(data.guildId, 'g1');
    expect(data.id).toBe('m1');
  });

  test('member.joined', () => {
    guildOnce(map('member.joined').data.guildId, 'g1');
  });

  test('voice.states.snapshot', () => {
    const { data } = map('voice.states.snapshot');
    guildOnce(data.guildIds[0], 'g1');
    guildOnce(data.states[0].guildId, 'g1');
    channelOnce(data.states[0].channelId, 'c1');
  });

  test('voice.state.changed', () => {
    const { data } = map('voice.state.changed');
    guildOnce(data.guildId, 'g1');
    channelOnce(data.channelId, 'c1');
    expect(data.connected).toBe(true);
  });

  test('call.ringing, channel.typing', () => {
    channelOnce(map('call.ringing').data.channelId, 'c1');
    channelOnce(map('channel.typing').data.channelId, 'c1');
  });

  test('guild.channels.reordered', () => {
    const { data } = map('guild.channels.reordered');
    guildOnce(data.guildId, 'g1');
    channelOnce(data.channelIds[0], 'c1');
    channelOnce(data.channelIds[1], 'c2');
  });

  test('user.status.changed has no ids to map and passes through', () => {
    expect(map('user.status.changed')).toEqual(parse('user.status.changed'));
  });

  test('no event type ever produces a double-prefixed id', () => {
    for (const type of Object.keys(fixtures)) {
      for (const [key, value] of leaves(map(type))) {
        expect(value.startsWith('fed:fed:')).toBe(false);
        if (value.startsWith('fed:')) expect(value.split(':')).toHaveLength(4);
        expect([key, value.includes('fed%3A')]).toEqual([key, false]);
      }
    }
  });

  test('mapping does not mutate its input', () => {
    const event = parse('guild.created')!;
    const before = structuredClone(event);
    mapFederatedRealtimeEvent(event, HS);
    expect(event).toEqual(before);
  });

  test('homeserver and ids containing separators survive the round trip', () => {
    const event = mapFederatedRealtimeEvent(
      parse('message.deleted', { id: 'm', channelId: 'c:1/x', guildId: 'g%1' })!,
      'h.test'
    ) as Extract<RealtimeEvent, { type: 'message.deleted' }>;
    expect(parseFederatedChannelId(event.data.channelId)).toEqual({
      homeserver: 'h.test',
      id: 'c:1/x',
    });
    expect(parseFederatedGuildId(event.data.guildId!)).toEqual({ homeserver: 'h.test', id: 'g%1' });
  });
});
