// ported from @oslo/otp (https://github.com/oslo-project/otp)
// uses node:crypto and bun stuff instead!
import { createHmac, timingSafeEqual } from 'node:crypto';

export function encodeBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  let value = 0;
  let bits = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 31];
  }
  return result;
}

export function decodeBase32(base32: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;

  for (const char of base32) {
    const index = alphabet.indexOf(char.toUpperCase());
    if (index === -1) {
      throw new TypeError(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function generateHOTP(key: Uint8Array, counter: bigint, digits: number): string {
  if (digits < 6 || digits > 8) {
    throw new TypeError('Digits must be between 6 and 8');
  }
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const hash = createHmac('sha1', key).update(counterBytes).digest();
  const offset = hash.at(-1)! & 0x0f;
  const value = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return value.toString().padStart(digits, '0');
}

export function verifyHOTP(key: Uint8Array, counter: bigint, digits: number, otp: string): boolean {
  if (digits < 6 || digits > 8) {
    throw new TypeError('Digits must be between 6 and 8');
  }
  const actual = Buffer.from(otp);
  const expected = Buffer.from(generateHOTP(key, counter, digits));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateTOTP(key: Uint8Array, intervalInSeconds: number, digits: number): string {
  const counter = BigInt(Math.floor(Date.now() / (intervalInSeconds * 1000)));
  return generateHOTP(key, counter, digits);
}

export function verifyTOTP(
  key: Uint8Array,
  intervalInSeconds: number,
  digits: number,
  otp: string
): boolean {
  const counter = BigInt(Math.floor(Date.now() / (intervalInSeconds * 1000)));
  return verifyHOTP(key, counter, digits, otp);
}

export function verifyTOTPWithGracePeriod(
  key: Uint8Array,
  intervalInSeconds: number,
  digits: number,
  otp: string,
  gracePeriodInSeconds: number
): boolean {
  if (gracePeriodInSeconds < 0) {
    throw new TypeError('Grace period must be a positive number');
  }
  const now = Date.now();
  let counter = BigInt(
    Math.floor((now - gracePeriodInSeconds * 1000) / (intervalInSeconds * 1000))
  );
  const maxCounter = BigInt(
    Math.floor((now + gracePeriodInSeconds * 1000) / (intervalInSeconds * 1000))
  );
  while (counter <= maxCounter) {
    if (verifyHOTP(key, counter, digits, otp)) {
      return true;
    }
    counter++;
  }
  return false;
}

export function createHOTPKeyURI(
  issuer: string,
  accountName: string,
  key: Uint8Array,
  counter: bigint,
  digits: number
): string {
  const base = `otpauth://hotp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    issuer,
    algorithm: 'SHA1',
    secret: encodeBase32(key),
    counter: counter.toString(),
    digits: digits.toString(),
  });
  return `${base}?${params}`;
}

export function createTOTPKeyURI(
  issuer: string,
  accountName: string,
  key: Uint8Array,
  periodInSeconds: number,
  digits: number
): string {
  const base = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    issuer,
    algorithm: 'SHA1',
    secret: encodeBase32(key),
    period: periodInSeconds.toString(),
    digits: digits.toString(),
  });
  return `${base}?${params}`;
}

export function generateRandomKey(length: number): Uint8Array {
  if (length <= 0) {
    throw new TypeError('Length must be a positive number');
  }

  const key = new Uint8Array(length);
  crypto.getRandomValues(key);
  return key;
}
