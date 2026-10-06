import { describe, expect, test } from 'bun:test';
import {
  maxIdsPerSubscribe,
  sharedEventFrame,
  sharedRefusedFrame,
  sharedSocketTopic,
  subscribeMessages,
  subscribeMessageSchema,
} from '../../utils/federationSharedSocket';
import { publishRealtime } from '../../utils/publishRealtime';
import { remoteSupports } from '../../utils/federationFeatures';

describe('subscribe messages', () => {
  test('ids go out in chunks the host accepts', () => {
    const guilds = Array.from({ length: maxIdsPerSubscribe * 2 + 1 }, (_, i) => `g${i}`);
    const messages = subscribeMessages(guilds, ['dm1']).map((m) =>
      subscribeMessageSchema.parse(JSON.parse(m))
    );

    expect(messages).toHaveLength(3);
    expect(messages.flatMap((m) => m.guilds)).toEqual(guilds);
    expect(messages.flatMap((m) => m.dms)).toEqual(['dm1']);
    for (const message of messages)
      expect(message.guilds.length).toBeLessThanOrEqual(maxIdsPerSubscribe);
  });

  test('nothing to follow means nothing to send', () => {
    expect(subscribeMessages([], [])).toEqual([]);
  });

  test('the host only accepts well-formed subscriptions', () => {
    expect(subscribeMessageSchema.parse({ type: 'subscribe' })).toEqual({
      type: 'subscribe',
      guilds: [],
      dms: [],
    });
    for (const bad of [
      null,
      'subscribe',
      { type: 'unsubscribe' },
      { type: 'subscribe', guilds: 'g1' },
      { type: 'subscribe', guilds: [1] },
      { type: 'subscribe', dms: Array.from({ length: maxIdsPerSubscribe + 1 }, String) },
    ]) {
      expect(subscribeMessageSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('frames', () => {
  test('an event is wrapped without being serialized again', () => {
    const event = JSON.stringify({
      type: 'user.status.changed',
      data: { userId: 'u', status: 'ONLINE' },
    });
    expect(JSON.parse(sharedEventFrame('guild', 'g"1', event))).toEqual({
      type: 'event',
      kind: 'guild',
      id: 'g"1',
      event: { type: 'user.status.changed', data: { userId: 'u', status: 'ONLINE' } },
    });
  });

  test('a refusal says which guild or DM it is about', () => {
    expect(JSON.parse(sharedRefusedFrame('dm', 'd1'))).toEqual({
      type: 'refused',
      kind: 'dm',
      id: 'd1',
    });
  });
});

describe('publishRealtime', () => {
  const event = { type: 'user.status.changed', data: { userId: 'u', status: 'ONLINE' } } as const;
  const publishTo = (topic: string) => {
    const published: [string, string][] = [];
    publishRealtime({ publish: (t, data) => published.push([t, data]) }, topic, event);
    return published;
  };

  test('a guild event also goes to the sockets following that guild, wrapped', () => {
    const [plain, shared, ...rest] = publishTo('guildEvents:g1');
    expect(rest).toEqual([]);
    expect(plain).toEqual(['guildEvents:g1', JSON.stringify(event)]);
    expect(shared![0]).toBe(sharedSocketTopic('guild', 'g1'));
    expect(JSON.parse(shared![1])).toEqual({ type: 'event', kind: 'guild', id: 'g1', event });
  });

  test('so does a DM event', () => {
    const [, shared] = publishTo('dmEvents:d1');
    expect(shared![0]).toBe(sharedSocketTopic('dm', 'd1'));
    expect(JSON.parse(shared![1])).toMatchObject({ kind: 'dm', id: 'd1' });
  });

  test('ids that look like topics or contain separators survive', () => {
    const id = 'fed:guild:b.test:g:1';
    const [, shared] = publishTo(`guildEvents:${id}`);
    expect(JSON.parse(shared![1])).toMatchObject({ kind: 'guild', id });
  });

  test('personal topics are not shared with other homeservers', () => {
    expect(publishTo('userEvents:u1')).toEqual([['userEvents:u1', JSON.stringify(event)]]);
  });
});

describe('features', () => {
  test('a feature is used only when the remote lists it', () => {
    expect(remoteSupports({ features: ['realtime-mux'] }, 'realtime-mux')).toBe(true);
    expect(remoteSupports({ features: ['realtime-mux'] }, 'status-batch')).toBe(false);
    expect(remoteSupports({ features: [] }, 'realtime-mux')).toBe(false);
  });
});
