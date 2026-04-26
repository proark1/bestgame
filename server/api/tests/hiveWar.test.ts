import { describe, expect, it } from 'vitest';
import { nextAvailableSlot } from '../src/routes/hiveWar.js';

// nextAvailableSlot is the deterministic slot-allocation rule that
// /hivewar/season/:id/enroll uses to assign clans to the map.
// Pure logic, easy to pin without spinning up the DB.

describe('nextAvailableSlot', () => {
  it('returns (0,0) on a fresh board', () => {
    expect(nextAvailableSlot([], 8, 8)).toEqual({ x: 0, y: 0 });
  });

  it('walks left-to-right, top-to-bottom around occupied slots', () => {
    expect(nextAvailableSlot([{ x: 0, y: 0 }], 8, 8)).toEqual({ x: 1, y: 0 });
    expect(
      nextAvailableSlot([{ x: 0, y: 0 }, { x: 1, y: 0 }], 8, 8),
    ).toEqual({ x: 2, y: 0 });
  });

  it('wraps to the next row when the current row fills up', () => {
    const row0 = Array.from({ length: 4 }, (_, x) => ({ x, y: 0 }));
    expect(nextAvailableSlot(row0, 4, 4)).toEqual({ x: 0, y: 1 });
  });

  it('returns null when every slot is occupied', () => {
    const all: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) all.push({ x, y });
    expect(nextAvailableSlot(all, 3, 3)).toBeNull();
  });

  it('skips occupied slots in the middle', () => {
    expect(
      nextAvailableSlot(
        [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }],
        4,
        4,
      ),
    ).toEqual({ x: 2, y: 0 });
  });

  it('handles a 1×1 board', () => {
    expect(nextAvailableSlot([], 1, 1)).toEqual({ x: 0, y: 0 });
    expect(nextAvailableSlot([{ x: 0, y: 0 }], 1, 1)).toBeNull();
  });
});
