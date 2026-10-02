import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createTOTPKeyURI,
  decodeBase32,
  encodeBase32,
  generateHOTP,
  generateTOTP,
  verifyHOTP,
  verifyTOTP,
  verifyTOTPWithGracePeriod,
} from '../../utils/otp';

const key = new TextEncoder().encode('12345678901234567890'); // RFC 6238 SHA1 secret
let nowSpy: ReturnType<typeof spyOn> | undefined;
const at = (seconds: number) => (nowSpy = spyOn(Date, 'now').mockReturnValue(seconds * 1000));
afterEach(() => nowSpy?.mockRestore());

describe('TOTP (RFC 6238 appendix B, SHA1, 8 digits)', () => {
  test.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('t=%d -> %s', (time, code) => {
    at(time);
    expect(generateTOTP(key, 30, 8)).toBe(code);
    expect(verifyTOTP(key, 30, 8, code)).toBe(true);
    expect(verifyTOTP(key, 30, 8, '00000000')).toBe(false);
  });

  test('HOTP vectors (RFC 4226 appendix D)', () => {
    const codes = ['755224', '287082', '359152', '969429', '338314', '254676'];
    codes.forEach((code, i) => {
      expect(generateHOTP(key, BigInt(i), 6)).toBe(code);
      expect(verifyHOTP(key, BigInt(i), 6, code)).toBe(true);
    });
  });

  test('digits outside 6..8 throw', () => {
    expect(() => generateHOTP(key, 0n, 5)).toThrow();
    expect(() => generateHOTP(key, 0n, 9)).toThrow();
    expect(() => verifyHOTP(key, 0n, 9, '1')).toThrow();
  });

  test('wrong-length code is rejected, not thrown', () => {
    expect(verifyHOTP(key, 0n, 6, '75522')).toBe(false);
    expect(verifyHOTP(key, 0n, 6, '')).toBe(false);
  });
});

describe('verifyTOTPWithGracePeriod', () => {
  const codeAt = (t: number) => {
    at(t);
    return generateTOTP(key, 30, 6);
  };

  test('accepts the previous, current and next step with a 30s grace', () => {
    const now = 1_700_000_010; // inside a step
    const [prev, cur, next] = [codeAt(now - 30), codeAt(now), codeAt(now + 30)];
    at(now);
    for (const code of [prev, cur, next])
      expect(verifyTOTPWithGracePeriod(key, 30, 6, code, 30)).toBe(true);
  });

  test('rejects two steps away', () => {
    const now = 1_700_000_010;
    const [far1, far2] = [codeAt(now - 90), codeAt(now + 90)];
    at(now);
    expect(verifyTOTPWithGracePeriod(key, 30, 6, far1, 30)).toBe(false);
    expect(verifyTOTPWithGracePeriod(key, 30, 6, far2, 30)).toBe(false);
  });

  test('zero grace only accepts the current step', () => {
    const now = 1_700_000_010;
    const [prev, cur] = [codeAt(now - 30), codeAt(now)];
    at(now);
    expect(verifyTOTPWithGracePeriod(key, 30, 6, cur, 0)).toBe(true);
    expect(verifyTOTPWithGracePeriod(key, 30, 6, prev, 0)).toBe(false);
  });

  test('negative grace throws', () => {
    expect(() => verifyTOTPWithGracePeriod(key, 30, 6, '123456', -1)).toThrow();
  });
});

describe('base32', () => {
  test('RFC 4648 vectors (no padding)', () => {
    const enc = (s: string) => encodeBase32(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('MY');
    expect(enc('fo')).toBe('MZXQ');
    expect(enc('foo')).toBe('MZXW6');
    expect(enc('foob')).toBe('MZXW6YQ');
    expect(enc('fooba')).toBe('MZXW6YTB');
    expect(enc('foobar')).toBe('MZXW6YTBOI');
    expect(enc('12345678901234567890')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  test('round-trips random bytes of every length', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });

  test('decode is case-insensitive and rejects bad characters', () => {
    expect(decodeBase32('mzxw6')).toEqual(decodeBase32('MZXW6'));
    expect(() => decodeBase32('MZXW1')).toThrow(TypeError);
    expect(() => decodeBase32('MZ=W6')).toThrow(TypeError);
  });

  test('key URI carries the base32 secret', () => {
    const uri = createTOTPKeyURI('Novarum', 'a@b.c', key, 30, 6);
    expect(uri).toStartWith('otpauth://totp/Novarum:a%40b.c?');
    expect(new URL(uri).searchParams.get('secret')).toBe(encodeBase32(key));
  });
});

// the "pepper effect" in the plan lives in modules/auth/services.tsx hashOtp (an HMAC keyed by
// misc.otp_pepper). it is module-private and importing that module pulls in the mailer, so it's
// covered at L2 (stored email_otps hashes differ per pepper) rather than here.
