import { expect, test } from 'bun:test';
import { consumeGrant, createGrant, dropGrant, grantFits } from '../../modules/bots/membership';

// a group DM's member homeserver checks a bot's grant while it vets a whole push, and only spends it
// once the push is accepted (modules/dm/groups.ts acceptGroupSync)
test('a grant can be checked without spending it, and is spent only once', () => {
  const grant = createGrant('bot', 'Host.test', 'group');
  expect(grantFits(grant, 'bot', 'host.test', 'group')).toBe(true);
  expect(grantFits(grant, 'bot', 'host.test', 'other')).toBe(false);
  expect(grantFits(grant, 'other-bot', 'host.test', 'group')).toBe(false);
  expect(grantFits(grant, 'bot', 'host.test', 'group')).toBe(true);
  dropGrant(grant);
  expect(grantFits(grant, 'bot', 'host.test', 'group')).toBe(false);

  const again = createGrant('bot', 'host.test', 'group');
  expect(consumeGrant(again, 'bot', 'host.test', 'group')).toBe(true);
  expect(consumeGrant(again, 'bot', 'host.test', 'group')).toBe(false);
  expect(grantFits(undefined, 'bot', 'host.test', 'group')).toBe(false);
});
