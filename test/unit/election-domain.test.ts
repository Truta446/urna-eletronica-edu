import { describe, expect, it } from 'vitest';
import {
  canTransition,
  MAX_ELECTION_DURATION_MS,
  validateNewSchedule,
  type ElectionStatus,
} from '../../src/modules/election/domain/election.js';
import { BusinessRuleError } from '../../src/shared/errors/app-error.js';

const now = new Date('2030-01-01T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const HOUR = 3_600_000;

describe('validateNewSchedule', () => {
  it('accepts a future window', () => {
    expect(() => {
      validateNewSchedule({ startsAt: at(HOUR), endsAt: at(2 * HOUR) }, now);
    }).not.toThrow();
  });

  it('accepts a window starting exactly now', () => {
    expect(() => {
      validateNewSchedule({ startsAt: now, endsAt: at(HOUR) }, now);
    }).not.toThrow();
  });

  it.each([
    ['ends before it starts', at(2 * HOUR), at(HOUR)],
    ['ends exactly when it starts', at(HOUR), at(HOUR)],
    ['starts in the past', at(-1), at(HOUR)],
    ['lasts longer than the maximum', at(HOUR), at(HOUR + MAX_ELECTION_DURATION_MS + 1)],
  ])('rejects a window that %s', (_label, startsAt, endsAt) => {
    expect(() => {
      validateNewSchedule({ startsAt, endsAt }, now);
    }).toThrow(BusinessRuleError);
  });
});

describe('canTransition', () => {
  const statuses: ElectionStatus[] = ['DRAFT', 'OPEN', 'CLOSED', 'TALLIED'];
  const allowed = new Set(['DRAFT->OPEN', 'OPEN->CLOSED', 'CLOSED->TALLIED']);

  for (const from of statuses) {
    for (const to of statuses) {
      const key = `${from}->${to}`;
      it(`${allowed.has(key) ? 'allows' : 'forbids'} ${key}`, () => {
        expect(canTransition(from, to)).toBe(allowed.has(key));
      });
    }
  }
});
