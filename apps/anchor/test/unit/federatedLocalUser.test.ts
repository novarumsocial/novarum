import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mockDb, restoreDb } from '../harness/mockDb';
import type { RealtimeEvent } from '../../utils/types';

// test/config.toml names this homeserver "localhost". alice is a local member of the bridged guild,
// bob is a local user who isn't.
const localUsers = [
  { id: 'local-alice', username: 'alice', homeserver: 'localhost', displayName: 'Alice' },
  { id: 'local-bob', username: 'bob', homeserver: 'localhost', displayName: 'Bob' },
].map((user) => ({
  ...user,
  avatarUrl: null,
  avatarColor: null,
  speakingRingColor: null,
  bannerUrl: null,
  about: null,
  isBot: false,
}));
const guildId = 'fed:guild:evil.test:g1';
const bridge = { id: guildId, kind: 'guild' as const };

let vetBridgedEvent: typeof import('../../utils/federationRealtime').vetBridgedEvent;
beforeAll(async () => {
  mockDb({
    query: {
      users: {
        findFirst: async ({ where }: any) =>
          localUsers.find(
            (u) => u.username === where.username && u.homeserver === where.homeserver
          ),
        findMany: async ({ where }: any) => localUsers.filter((u) => where.id.in.includes(u.id)),
      },
      guildMembers: {
        findFirst: async ({ where }: any) =>
          where.guildId === guildId && where.userId === 'local-alice' ? { ...where } : undefined,
      },
      channelMembers: { findFirst: async () => undefined },
    },
  });
  ({ vetBridgedEvent } = await import('../../utils/federationRealtime'));
});
afterAll(restoreDb);

const author = (username: string, homeserver: string) => ({
  ...localUsers[0]!,
  userId: 'host-id',
  username,
  homeserver,
  displayName: 'Forged Name',
  avatarUrl: 'https://tracker.example/pixel.png',
});
const message = (user: ReturnType<typeof author>): RealtimeEvent =>
  ({
    type: 'message.created',
    data: {
      id: 'm1',
      channelId: 'fed:channel:evil.test:c1',
      guildId,
      content: 'hi',
      nonce: null,
      replyTo: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      edited: false,
      pingedHandles: [],
      attachments: [],
      author: user,
    },
  }) as never;

const withInteraction = (user: ReturnType<typeof author>): RealtimeEvent => {
  const event = message(author('somebot', 'evil.test')) as any;
  return { ...event, data: { ...event.data, interaction: { id: 'i1', name: 'ping', user } } };
};

describe('vetBridgedEvent', () => {
  test('"<someone> used /command" keeps a remote invoker and a local member, but not a local outsider', async () => {
    const remote = (await vetBridgedEvent(
      bridge,
      withInteraction(author('mallory', 'evil.test'))
    )) as any;
    expect(remote.data.interaction.user.username).toBe('mallory');
    const member = (await vetBridgedEvent(
      bridge,
      withInteraction(author('alice', 'localhost'))
    )) as any;
    expect(member.data.interaction.user.displayName).toBe('Alice');
    // the message survives, the claim that bob used the command does not
    const forged = (await vetBridgedEvent(
      bridge,
      withInteraction(author('bob', 'localhost'))
    )) as any;
    expect(forged.data.interaction).toBeNull();
    expect(forged.data.content).toBe('hi');
  });

  test("a remote author is the host's to describe", async () => {
    const event = message(author('mallory', 'evil.test'));
    expect(await vetBridgedEvent(bridge, event)).toEqual(event);
  });

  test('a local non-member or unknown local user is dropped', async () => {
    expect(await vetBridgedEvent(bridge, message(author('bob', 'localhost')))).toBeNull();
    expect(await vetBridgedEvent(bridge, message(author('nobody', 'LOCALHOST')))).toBeNull();
  });

  test("a local member keeps the host's id but gets our profile", async () => {
    const vetted = (await vetBridgedEvent(bridge, message(author('alice', 'localhost')))) as any;
    expect(vetted.data.author).toMatchObject({
      userId: 'host-id',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
    });
  });

  test('typing, joins and rings are vetted the same way', async () => {
    const typing = (username: string) =>
      ({
        type: 'channel.typing',
        data: {
          channelId: 'c',
          userId: 'host-id',
          username,
          displayName: 'Forged Name',
          homeserver: 'localhost',
          time: '',
        },
      }) as RealtimeEvent;
    expect(await vetBridgedEvent(bridge, typing('bob'))).toBeNull();
    expect(((await vetBridgedEvent(bridge, typing('alice'))) as any).data.displayName).toBe(
      'Alice'
    );
    const joined = {
      type: 'member.joined',
      data: { guildId, user: { ...author('bob', 'localhost'), status: 'ONLINE' } },
    } as RealtimeEvent;
    expect(await vetBridgedEvent(bridge, joined)).toBeNull();
    const ring = {
      type: 'call.ringing',
      data: { channelId: 'c', user: author('bob', 'localhost'), ringing: true },
    } as RealtimeEvent;
    expect(await vetBridgedEvent(bridge, ring)).toBeNull();
  });

  test('events naming one of our own user ids are forged and dropped', async () => {
    const status = (userId: string) =>
      ({ type: 'user.status.changed', data: { userId, status: 'ONLINE' } }) as RealtimeEvent;
    expect(await vetBridgedEvent(bridge, status('local-alice'))).toBeNull();
    expect(await vetBridgedEvent(bridge, status('host-id'))).toEqual(status('host-id'));

    const state = (userId: string) => ({ guildId, channelId: 'c', userId, name: null });
    const snapshot = {
      type: 'voice.states.snapshot',
      data: { guildIds: [guildId], states: [state('local-bob'), state('host-id')] },
    } as RealtimeEvent;
    expect(((await vetBridgedEvent(bridge, snapshot)) as any).data.states).toEqual([
      state('host-id'),
    ]);
  });
});
