import { describe, expect, test } from 'bun:test';
import { mentionHandles } from '../../utils/mentions';

const handles = (s: string | null) => [...mentionHandles(s)];

describe('mentionHandles', () => {
  test('matches @user:homeserver', () => {
    expect(handles('hi @alice:a.test!')).toEqual(['@alice:a.test']);
    expect(handles('@a.b_c:sub.example.com')).toEqual(['@a.b_c:sub.example.com']);
  });
  test('plain @user never matches', () => {
    expect(handles('hey @alice and @bob.')).toEqual([]);
    expect(handles('@alice:')).toEqual([]);
  });
  test('lower-cased and de-duplicated', () => {
    expect(handles('@Alice:A.Test @alice:a.test @ALICE:A.TEST')).toEqual(['@alice:a.test']);
  });
  test('multiple distinct handles keep order', () => {
    expect(handles('@a1:x.test then @b1:y.test')).toEqual(['@a1:x.test', '@b1:y.test']);
  });
  test('handles inside URLs are ignored', () => {
    expect(handles('see https://x.test/@alice:a.test now')).toEqual([]);
    expect(handles('http://h/@a:b.c @real:ok.test')).toEqual(['@real:ok.test']);
  });
  test('no match after alnum, dot or underscore (emails and such)', () => {
    expect(handles('mail me at bob@alice:a.test')).toEqual([]);
    expect(handles('x.@alice:a.test')).toEqual([]);
    expect(handles('x_@alice:a.test')).toEqual([]);
    expect(handles('(@alice:a.test)')).toEqual(['@alice:a.test']);
  });
  test('trailing punctuation is not part of the homeserver', () => {
    expect(handles('@alice:a.test.')).toEqual(['@alice:a.test']);
    expect(handles('@alice:a.test-')).toEqual(['@alice:a.test']);
  });
  test('null and empty', () => {
    expect(handles(null)).toEqual([]);
    expect(handles('')).toEqual([]);
  });
});
