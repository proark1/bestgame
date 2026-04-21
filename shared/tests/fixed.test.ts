import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  add,
  cosTurns,
  div,
  fromFloat,
  fromInt,
  mul,
  sinTurns,
  sqrt,
  sub,
  toFloat,
} from '../src/sim/fixed.js';

describe('fixed-point arithmetic', () => {
  it('round-trips integers', () => {
    for (let i = -100; i <= 100; i++) {
      expect(toFloat(fromInt(i))).toBe(i);
    }
  });

  it('add and sub are exact', () => {
    expect(toFloat(add(fromInt(3), fromInt(4)))).toBe(7);
    expect(toFloat(sub(fromInt(10), fromInt(3)))).toBe(7);
  });

  it('mul matches float within 1 ULP', () => {
    const a = fromFloat(1.25);
    const b = fromFloat(2.5);
    expect(toFloat(mul(a, b))).toBeCloseTo(3.125, 3);
  });

  it('div inverse of mul', () => {
    const a = fromFloat(6.0);
    const b = fromFloat(1.5);
    expect(toFloat(div(a, b))).toBeCloseTo(4.0, 3);
  });

  it('sqrt of 4 is 2', () => {
    expect(toFloat(sqrt(fromInt(4)))).toBeCloseTo(2, 2);
  });

  it('sqrt of 2 is ~1.414', () => {
    expect(toFloat(sqrt(fromInt(2)))).toBeCloseTo(1.414, 2);
  });

  it('sinTurns has period 1', () => {
    expect(sinTurns(fromFloat(0.25))).toBeCloseTo(FIXED_ONE, -2);
    expect(sinTurns(fromFloat(0.5))).toBeCloseTo(0, -2);
    expect(sinTurns(fromFloat(0.75))).toBeCloseTo(-FIXED_ONE, -2);
  });

  it('cosTurns(0) = 1', () => {
    expect(cosTurns(0)).toBeCloseTo(FIXED_ONE, -2);
  });

  it('sin^2 + cos^2 = 1 (Pythagorean identity)', () => {
    for (let i = 0; i < 8; i++) {
      const angle = fromFloat(i / 8);
      const s = sinTurns(angle);
      const c = cosTurns(angle);
      const sum = add(mul(s, s), mul(c, c));
      expect(toFloat(sum)).toBeCloseTo(1, 2);
    }
  });
});
