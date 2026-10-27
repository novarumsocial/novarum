import { describe, expect, test } from 'bun:test';
import * as web from './markdown';
import * as native from '../../../native/src/lib/markdown';

const text = (value: string) => ({ type: 'text' as const, text: value });

// the native app has its own copy of the parser, so both run the same cases
describe.each([
  ['frontend', web],
  ['native', native],
])('%s markdown', (_, { parseInline, parseMarkdown }) => {
  test('inline styles, including nesting', () => {
    expect(parseInline('**b** *i* _i_ __u__ ~~s~~ ||spoiler||')).toEqual([
      { type: 'bold', children: [text('b')] },
      text(' '),
      { type: 'italic', children: [text('i')] },
      text(' '),
      { type: 'italic', children: [text('i')] },
      text(' '),
      { type: 'underline', children: [text('u')] },
      text(' '),
      { type: 'strike', children: [text('s')] },
      text(' '),
      { type: 'spoiler', children: [text('spoiler')] },
    ]);
    expect(parseInline('***x***')).toEqual([
      { type: 'bold', children: [{ type: 'italic', children: [text('x')] }] },
    ]);
    expect(parseInline('*a **b** c*')).toEqual([
      {
        type: 'italic',
        children: [text('a '), { type: 'bold', children: [text('b')] }, text(' c')],
      },
    ]);
  });

  test('leaves ordinary punctuation, identifiers, urls and handles alone', () => {
    for (const value of [
      '2 * 3 * 4',
      'a ** b',
      '**unclosed',
      'snake_case_name',
      'see https://x.com/*a*_b_ now',
      '@foo_bar:srv.com',
    ])
      expect(parseInline(value)).toEqual([text(value)]);
  });

  test('backslash escapes and code spans are literal', () => {
    expect(parseInline('\\*no\\*')).toEqual([text('*no*')]);
    expect(parseInline('`a *b* <i>`')).toEqual([{ type: 'code', text: 'a *b* <i>' }]);
    expect(parseInline('``a`b``')).toEqual([{ type: 'code', text: 'a`b' }]);
  });

  test('links only allow http(s), and html stays text', () => {
    expect(parseInline('[hi **there**](https://e.com)')).toEqual([
      {
        type: 'link',
        url: 'https://e.com',
        children: [text('hi '), { type: 'bold', children: [text('there')] }],
      },
    ]);
    for (const value of [
      '[x](javascript:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '<img src=x onerror=alert(1)>',
    ])
      expect(parseInline(value)).toEqual([text(value)]);
  });

  test('blocks: code fences, headings, quotes and lists', () => {
    expect(
      parseMarkdown(
        'hi\n```js\nconst a = **1**;\n```\n# Head\n> quote **b**\n> more\n- one\n* two\n3. a\n4. b\n\nend'
      )
    ).toEqual([
      { type: 'paragraph', children: [text('hi')] },
      { type: 'code', text: 'const a = **1**;' },
      { type: 'heading', level: 1, children: [text('Head')] },
      {
        type: 'quote',
        children: [
          {
            type: 'paragraph',
            children: [text('quote '), { type: 'bold', children: [text('b')] }, text('\nmore')],
          },
        ],
      },
      { type: 'list', ordered: false, start: 1, items: [[text('one')], [text('two')]] },
      { type: 'list', ordered: true, start: 3, items: [[text('a')], [text('b')]] },
      { type: 'paragraph', children: [text('end')] },
    ]);
  });

  test('unclosed fences, #tags and deep headings stay paragraphs', () => {
    expect(parseMarkdown('```\nnot closed\n#tag\n#### four')).toEqual([
      { type: 'paragraph', children: [text('```\nnot closed\n#tag\n#### four')] },
    ]);
  });

  test('parses adversarial input in linear time', () => {
    const start = performance.now();
    for (const value of ['*', 'a_', '**x ', '`', '[a](', '_a ', '||'])
      parseMarkdown(value.repeat(20000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
