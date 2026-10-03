import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  tallyBallots,
  UnknownCandidateError,
  type DecodedChoice,
} from '../../src/modules/tally/domain/tally.js';

const a = { id: randomUUID(), number: 20, name: 'Ana' };
const b = { id: randomUUID(), number: 10, name: 'Bia' };
const c = { id: randomUUID(), number: 30, name: 'Caio' };

const vote = (id: string): DecodedChoice => ({ kind: 'CANDIDATE', candidateId: id });
const choices: DecodedChoice[] = [
  vote(a.id),
  vote(a.id),
  vote(b.id),
  { kind: 'BLANK' },
  { kind: 'NULL_VOTE' },
  vote(a.id),
];

describe('tallyBallots', () => {
  it('counts votes, blanks and nulls; lists every candidate ordered by number', () => {
    expect(tallyBallots(choices, [a, b, c])).toEqual({
      candidates: [
        { candidateId: b.id, number: 10, name: 'Bia', votes: 1 },
        { candidateId: a.id, number: 20, name: 'Ana', votes: 3 },
        { candidateId: c.id, number: 30, name: 'Caio', votes: 0 },
      ],
      blank: 1,
      null: 1,
      totalBallots: 6,
    });
  });

  it('INV-4: counted ballots == valid ballots', () => {
    const result = tallyBallots(choices, [a, b, c]);
    const counted =
      result.candidates.reduce((sum, x) => sum + x.votes, 0) + result.blank + result.null;
    expect(counted).toBe(choices.length);
    expect(result.totalBallots).toBe(choices.length);
  });

  it('is deterministic: same ballots in any order give the same result', () => {
    const expected = tallyBallots(choices, [a, b, c]);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...choices].sort(() => (i % 2 ? 1 : -1));
      expect(tallyBallots(shuffled, [c, a, b])).toEqual(expected);
    }
  });

  it('handles an election with no ballots', () => {
    expect(tallyBallots([], [a])).toEqual({
      candidates: [{ candidateId: a.id, number: 20, name: 'Ana', votes: 0 }],
      blank: 0,
      null: 0,
      totalBallots: 0,
    });
  });

  it('refuses a vote for a candidate outside the election', () => {
    expect(() => tallyBallots([vote(randomUUID())], [a])).toThrow(UnknownCandidateError);
  });
});
