import { describe, expect, test } from 'bun:test';
import {
  makeFederatedChannelId,
  makeFederatedGuildId,
  parseFederatedChannelId,
  parseFederatedGuildId,
} from '../../utils/federationIds';

const nasty = ['plain', 'a:b', 'a%b', 'a/b', 'a%3Ab', 'ünï:cødé/日本', '', ' ', 'a b', '::', '%%'];

describe('federationIds', () => {
  test('guild ids round-trip', () => {
    for (const homeserver of nasty) {
      for (const id of nasty) {
        const made = makeFederatedGuildId(homeserver, id);
        expect(made.split(':')).toHaveLength(4);
        expect(parseFederatedGuildId(made)).toEqual({ homeserver, id });
      }
    }
  });

  test('channel ids round-trip', () => {
    for (const homeserver of nasty) {
      for (const id of nasty) {
        expect(parseFederatedChannelId(makeFederatedChannelId(homeserver, id))).toEqual({
          homeserver,
          id,
        });
      }
    }
  });

  test('exact format', () => {
    expect(makeFederatedGuildId('b.test', 'g1')).toBe('fed:guild:b.test:g1');
    expect(makeFederatedChannelId('b.test', 'c:1')).toBe('fed:channel:b.test:c%3A1');
  });

  test('rejects wrong kind', () => {
    expect(parseFederatedGuildId(makeFederatedChannelId('h', 'x'))).toBeNull();
    expect(parseFederatedChannelId(makeFederatedGuildId('h', 'x'))).toBeNull();
  });

  test('rejects wrong prefix and part count', () => {
    for (const bad of [
      '',
      'guild:h:x',
      'xfed:guild:h:x',
      'FED:guild:h:x',
      'fed:guild:h',
      'fed:guild:h:x:y',
      'fed:guild:h:x:',
      'plain-uuid',
    ]) {
      expect(parseFederatedGuildId(bad)).toBeNull();
    }
    expect(parseFederatedChannelId('fed:channel:h')).toBeNull();
    expect(parseFederatedChannelId('fed:channel:h:x:y')).toBeNull();
  });

  test('malformed % escapes return null instead of throwing', () => {
    for (const bad of [
      'fed:guild:%:x',
      'fed:guild:h:%E0%A4%A',
      'fed:guild:%zz:x',
      'fed:guild:h:%',
    ]) {
      expect(parseFederatedGuildId(bad)).toBeNull();
    }
    expect(parseFederatedChannelId('fed:channel:h:%C0')).toBeNull();
  });

  test('already-federated ids are not confused for plain ids when re-wrapped', () => {
    const once = makeFederatedGuildId('b.test', 'g1');
    const twice = makeFederatedGuildId('c.test', once);
    expect(parseFederatedGuildId(twice)).toEqual({ homeserver: 'c.test', id: once });
  });
});
