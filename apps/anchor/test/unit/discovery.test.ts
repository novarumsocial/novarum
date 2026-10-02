import { describe, expect, test } from 'bun:test';
import { isLocalHostname, isPrivateIp, normalizeFederationHomeserver } from '../../utils/discovery';

describe('normalizeFederationHomeserver', () => {
  test('lower-cases, trims and strips trailing slashes', () => {
    expect(normalizeFederationHomeserver('Example.COM')).toBe('example.com');
    expect(normalizeFederationHomeserver('  example.com  ')).toBe('example.com');
    expect(normalizeFederationHomeserver('example.com/')).toBe('example.com');
    expect(normalizeFederationHomeserver('example.com///')).toBe('example.com');
    expect(normalizeFederationHomeserver('10.0.0.5')).toBe('10.0.0.5');
    expect(normalizeFederationHomeserver('a-b.c-d.test')).toBe('a-b.c-d.test');
  });

  test.each([
    ['scheme', 'https://example.com'],
    ['path', 'example.com/path'],
    ['leading slash', '/example.com'],
    ['backslash', 'example.com\\evil'],
    ['userinfo', 'user@example.com'],
    ['port', 'example.com:8080'],
    ['underscore', 'exa_mple.com'],
    ['unicode', 'exämple.com'],
    ['emoji', '😀.test'],
    ['leading dot', '.example.com'],
    ['trailing dot', 'example.com.'],
    ['double dot', 'a..b.com'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['slash only', '/'],
    ['space inside', 'exa mple.com'],
    ['newline inside', 'example.com\nevil.com'],
    ['ipv6', '[::1]'],
    ['query', 'example.com?x=1'],
  ])('rejects %s', (_name, input) => {
    expect(() => normalizeFederationHomeserver(input)).toThrow('Invalid homeserver name');
  });

  test.each([[undefined], [null], [42], [{}], [[]], [true]])('rejects non-string %p', (input) => {
    expect(() => normalizeFederationHomeserver(input)).toThrow('Invalid homeserver name');
  });
});

describe('isPrivateIp', () => {
  const priv = [
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '127.255.255.255',
    '100.64.0.0',
    '100.127.255.255',
    '169.254.0.1',
    '169.254.169.254',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fdff::1',
    'fe80::1',
    'febf::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::FFFF:192.168.1.1',
  ];
  const pub = [
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '192.1.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2001:4860:4860::8888',
    '2606:4700::1111',
    'fbff::1',
    'fec0::1',
    '::ffff:8.8.8.8',
  ];

  test.each(priv)('%s is private', (ip) => expect(isPrivateIp(ip)).toBe(true));
  test.each(pub)('%s is public', (ip) => expect(isPrivateIp(ip)).toBe(false));

  test('hostnames and garbage are not IPs, so not "private"', () => {
    for (const s of ['example.com', 'localhost', '', '1.2.3', '256.1.1.1', '[::1]']) {
      expect(isPrivateIp(s)).toBe(false);
    }
  });

  // known gap (TESTING_PLAN §0, §5.4 A): these forms of private addresses are classified public
  test.failing.each(['::127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1'])(
    'known gap: %s should be private',
    (ip) => expect(isPrivateIp(ip)).toBe(true)
  );
});

describe('isLocalHostname', () => {
  test('localhost and *.localhost only', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('a.localhost')).toBe(true);
    expect(isLocalHostname('a.b.localhost')).toBe(true);
  });

  test('counter-examples', () => {
    for (const h of [
      'example.com',
      'localhost.com',
      'notlocalhost',
      'localhostx',
      '',
      '127.0.0.1',
    ]) {
      expect(isLocalHostname(h)).toBe(false);
    }
  });

  test('is case-sensitive (callers lower-case first)', () => {
    expect(isLocalHostname('LOCALHOST')).toBe(false);
  });
});
