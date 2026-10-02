import { describe, expect, test } from 'bun:test';
import {
  friendAuthority,
  nextFriendshipState,
  type FriendAction,
} from '../../modules/friends/model';

describe('friendAuthority', () => {
  test('order independent', () => {
    expect(friendAuthority('a.test', 'b.test')).toBe(friendAuthority('b.test', 'a.test'));
  });
  test('case insensitive, returns lower-case', () => {
    expect(friendAuthority('B.Test', 'a.TEST')).toBe('a.test');
    expect(friendAuthority('A.test', 'a.TEST')).toBe('a.test');
  });
  test('stable: the lexicographically smaller homeserver wins', () => {
    expect(friendAuthority('b.test', 'a.test')).toBe('a.test');
    expect(friendAuthority('a.test', 'a.test.evil')).toBe('a.test');
    expect(friendAuthority('x', 'x')).toBe('x');
  });
});

// actor "alice" is the requester of a PENDING row, "bob" the recipient
const statuses = ['NONE', 'PENDING', 'ACCEPTED'] as const;
const actions: FriendAction[] = ['REQUEST', 'ACCEPT', 'DECLINE', 'CANCEL', 'REMOVE'];
const actors = ['requester', 'recipient'] as const;

function run(status: (typeof statuses)[number] | 'MISSING', action: FriendAction, actor: string) {
  const existing = status === 'MISSING' ? undefined : { status, requestedById: 'alice' };
  const result = nextFriendshipState(existing, actor === 'requester' ? 'alice' : 'bob', action);
  if (!result.ok) return `error ${result.status}: ${result.error}`;
  return `${result.changed ? 'change' : 'noop'} -> ${result.status}${result.requestedById ? ` (requester=${result.requestedById === 'alice' ? 'actor-requester' : 'actor-recipient'})` : ''}`;
}

describe('nextFriendshipState', () => {
  // the full matrix, written out so a behaviour change has to be a deliberate edit here
  const expected: Record<string, string> = {
    'MISSING REQUEST requester': 'change -> PENDING (requester=actor-requester)',
    'MISSING REQUEST recipient': 'change -> PENDING (requester=actor-recipient)',
    'MISSING ACCEPT requester': 'noop -> NONE',
    'MISSING ACCEPT recipient': 'noop -> NONE',
    'MISSING DECLINE requester': 'noop -> NONE',
    'MISSING DECLINE recipient': 'noop -> NONE',
    'MISSING CANCEL requester': 'noop -> NONE',
    'MISSING CANCEL recipient': 'noop -> NONE',
    'MISSING REMOVE requester': 'noop -> NONE',
    'MISSING REMOVE recipient': 'noop -> NONE',
    'NONE REQUEST requester': 'change -> PENDING (requester=actor-requester)',
    'NONE REQUEST recipient': 'change -> PENDING (requester=actor-recipient)',
    'NONE ACCEPT requester': 'noop -> NONE',
    'NONE ACCEPT recipient': 'noop -> NONE',
    'NONE DECLINE requester': 'noop -> NONE',
    'NONE DECLINE recipient': 'noop -> NONE',
    'NONE CANCEL requester': 'noop -> NONE',
    'NONE CANCEL recipient': 'noop -> NONE',
    'NONE REMOVE requester': 'noop -> NONE',
    'NONE REMOVE recipient': 'noop -> NONE',
    'PENDING REQUEST requester': 'noop -> PENDING',
    'PENDING REQUEST recipient': 'change -> ACCEPTED',
    'PENDING ACCEPT requester': 'error 400: You cannot accept your own friend request.',
    'PENDING ACCEPT recipient': 'change -> ACCEPTED',
    'PENDING DECLINE requester': 'error 400: Only the recipient can decline this request.',
    'PENDING DECLINE recipient': 'change -> NONE',
    'PENDING CANCEL requester': 'change -> NONE',
    'PENDING CANCEL recipient': 'error 400: Only the requester can cancel this request.',
    'PENDING REMOVE requester': 'error 400: No friendship found to remove.',
    'PENDING REMOVE recipient': 'error 400: No friendship found to remove.',
    'ACCEPTED REQUEST requester': 'noop -> ACCEPTED',
    'ACCEPTED REQUEST recipient': 'noop -> ACCEPTED',
    'ACCEPTED ACCEPT requester': 'noop -> ACCEPTED',
    'ACCEPTED ACCEPT recipient': 'noop -> ACCEPTED',
    'ACCEPTED DECLINE requester': 'error 400: Only the recipient can decline this request.',
    'ACCEPTED DECLINE recipient': 'error 400: Only the recipient can decline this request.',
    'ACCEPTED CANCEL requester': 'error 400: Only the requester can cancel this request.',
    'ACCEPTED CANCEL recipient': 'error 400: Only the requester can cancel this request.',
    'ACCEPTED REMOVE requester': 'change -> NONE',
    'ACCEPTED REMOVE recipient': 'change -> NONE',
  };

  test('full state x action x actor matrix', () => {
    const actual: Record<string, string> = {};
    for (const status of ['MISSING', ...statuses] as const)
      for (const action of actions)
        for (const actor of actors)
          actual[`${status} ${action} ${actor}`] = run(status, action, actor);
    expect(actual).toEqual(expected);
  });

  test('matrix is exhaustive', () => {
    expect(Object.keys(expected)).toHaveLength(4 * actions.length * actors.length);
  });

  test('a changed result always changes the status or sets a requester', () => {
    for (const status of statuses)
      for (const action of actions)
        for (const actor of actors) {
          const r = nextFriendshipState(
            { status, requestedById: 'alice' },
            actor === 'requester' ? 'alice' : 'bob',
            action
          );
          if (r.ok && r.changed)
            expect(r.status !== status || r.requestedById !== undefined).toBe(true);
        }
  });
});
