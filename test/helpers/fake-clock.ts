import type { Clock } from '../../src/shared/clock.js';

export interface FakeClock extends Clock {
  set(date: Date): void;
  advance(ms: number): void;
}

export function createFakeClock(start = new Date('2030-01-01T12:00:00Z')): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set: (date) => {
      current = date.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export const HOUR = 60 * 60 * 1000;
