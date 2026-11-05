import { describe, expect, test } from 'bun:test';
import { autoAttenuation, rmsDb } from './noise-floor';

const room = (floorDb: number) => [
  ...Array(20).fill(floorDb),
  ...Array(60).fill(-20), // talking
];

describe('autoAttenuation', () => {
  test('suppresses noisy rooms harder than quiet ones', () => {
    expect(autoAttenuation(room(-65))).toBe(25);
    expect(autoAttenuation(room(-45))).toBe(45);
  });

  test('ignores speech when estimating the floor', () => {
    expect(autoAttenuation(room(-65))).toBe(autoAttenuation(Array(80).fill(-65)));
  });

  test('stays within a safe range', () => {
    expect(autoAttenuation(room(-120))).toBe(12);
    expect(autoAttenuation(room(-10))).toBe(50);
    expect(autoAttenuation([])).toBe(12);
  });
});

test('rmsDb measures a full scale square wave as 0 dB', () => {
  expect(rmsDb(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(0);
  expect(rmsDb(new Float32Array(4))).toBe(-120);
});
