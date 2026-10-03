import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalEventData,
  computeEventHash,
  GENESIS_HASH,
  verifyAuditChain,
  type AuditEventData,
  type StoredAuditEvent,
} from '../../src/modules/audit/domain/audit-chain.js';

const electionId = randomUUID();

function buildChain(length: number): StoredAuditEvent[] {
  const events: StoredAuditEvent[] = [];
  let previousHash: Uint8Array = GENESIS_HASH;
  for (let seq = 1; seq <= length; seq++) {
    const data: AuditEventData = {
      seq,
      eventType: 'CANDIDATE_CREATED',
      actorType: 'ADMIN',
      actorIdentifier: 'alice',
      electionId,
      payload: { number: seq, name: `C${seq}` },
      createdAt: new Date(Date.UTC(2030, 0, 1, 12, 0, seq)),
    };
    const eventHash = computeEventHash(data, previousHash);
    events.push({ ...data, previousHash, eventHash });
    previousHash = eventHash;
  }
  return events;
}

function at(chain: StoredAuditEvent[], index: number): StoredAuditEvent {
  const event = chain[index];
  if (!event) throw new Error(`no event at ${index}`);
  return event;
}

/** Clona o evento alterando campos, SEM recalcular hashes (o que um adulterador ingênuo faz). */
const tamper = (event: StoredAuditEvent, change: Partial<StoredAuditEvent>): StoredAuditEvent => ({
  ...event,
  ...change,
});

describe('canonicalEventData (RFC 8785)', () => {
  it('does not depend on payload key order', () => {
    const [event] = buildChain(1);
    if (!event) throw new Error('chain');
    const reordered = {
      ...event,
      payload: { name: event.payload.name ?? null, number: event.payload.number ?? null },
    };
    expect(canonicalEventData(reordered)).toBe(canonicalEventData(event));
  });

  it('includes seq, so moving an event changes its hash', () => {
    const [event] = buildChain(1);
    if (!event) throw new Error('chain');
    expect(computeEventHash({ ...event, seq: 2 }, GENESIS_HASH)).not.toEqual(
      computeEventHash(event, GENESIS_HASH),
    );
  });
});

describe('verifyAuditChain', () => {
  it('accepts an intact chain and reports its head', () => {
    const chain = buildChain(10);
    const result = verifyAuditChain(chain);
    expect(result).toEqual({
      valid: true,
      eventCount: 10,
      head: { seq: 10, hash: Buffer.from(chain[9]?.eventHash ?? []).toString('hex') },
    });
  });

  it('accepts an empty chain', () => {
    expect(verifyAuditChain([])).toEqual({ valid: true, eventCount: 0, head: null });
  });

  it('starts from the genesis hash', () => {
    const chain = buildChain(2);
    const [first, second] = chain;
    if (!first || !second) throw new Error('chain');
    const forgedFirst = tamper(first, { previousHash: Buffer.alloc(32, 1) });
    expect(verifyAuditChain([forgedFirst, second])).toMatchObject({
      valid: false,
      failure: { seq: 1, reason: 'BROKEN_LINK' },
    });
  });

  describe('detects a modified event', () => {
    it.each([
      ['payload', { payload: { number: 3, name: 'Hijacked' } }],
      ['actor', { actorIdentifier: 'mallory' }],
      ['event type', { eventType: 'ELECTION_OPENED' as const }],
      ['timestamp', { createdAt: new Date(Date.UTC(2031, 0, 1)) }],
      ['election', { electionId: randomUUID() }],
    ])('%s changed', (_label, change) => {
      const chain = buildChain(5);
      chain[2] = tamper(at(chain, 2), change);
      expect(verifyAuditChain(chain)).toMatchObject({
        valid: false,
        failure: { seq: 3, reason: 'HASH_MISMATCH' },
      });
    });

    it('even when the attacker recomputes that event hash (the next link breaks)', () => {
      const chain = buildChain(5);
      const target = at(chain, 2);
      const forged = { ...target, payload: { number: 3, name: 'Hijacked' } };
      chain[2] = { ...forged, eventHash: computeEventHash(forged, forged.previousHash) };
      expect(verifyAuditChain(chain)).toMatchObject({
        valid: false,
        failure: { seq: 4, reason: 'BROKEN_LINK' },
      });
    });
  });

  it('detects a removed event in the middle', () => {
    const chain = buildChain(5);
    chain.splice(2, 1);
    expect(verifyAuditChain(chain)).toMatchObject({
      valid: false,
      failure: { seq: 4, reason: 'SEQUENCE_GAP' },
    });
  });

  it('detects the first event removed', () => {
    const chain = buildChain(3).slice(1);
    expect(verifyAuditChain(chain)).toMatchObject({
      valid: false,
      failure: { seq: 2, reason: 'SEQUENCE_GAP' },
    });
  });

  it('detects modified order (two events swapped)', () => {
    const chain = buildChain(5);
    const [a, b] = [at(chain, 1), at(chain, 2)];
    chain[1] = b;
    chain[2] = a;
    expect(verifyAuditChain(chain)).toMatchObject({ valid: false, failure: { seq: 3 } });
  });

  it('detects modified order (seq numbers swapped in place)', () => {
    const chain = buildChain(5);
    const [a, b] = [at(chain, 1), at(chain, 2)];
    chain[1] = tamper(b, { seq: 2 });
    chain[2] = tamper(a, { seq: 3 });
    expect(verifyAuditChain(chain)).toMatchObject({ valid: false, failure: { seq: 2 } });
  });

  describe('LIMITATION: tail truncation', () => {
    it('is NOT detected by the chain alone', () => {
      const truncated = buildChain(10).slice(0, 7);
      expect(verifyAuditChain(truncated)).toMatchObject({ valid: true, eventCount: 7 });
    });

    it('IS detected with an anchor published outside the database', () => {
      const chain = buildChain(10);
      const anchor = { seq: 10, hash: Buffer.from(chain[9]?.eventHash ?? []).toString('hex') };
      expect(verifyAuditChain(chain, { anchor })).toMatchObject({ valid: true });
      expect(verifyAuditChain(chain.slice(0, 7), { anchor })).toMatchObject({
        valid: false,
        failure: { seq: 10, reason: 'ANCHOR_NOT_FOUND' },
      });
    });

    it('detects a fully rewritten chain that no longer matches the anchor', () => {
      const original = buildChain(5);
      const anchor = { seq: 5, hash: Buffer.from(original[4]?.eventHash ?? []).toString('hex') };
      // Um atacante com acesso total reescreve tudo de forma consistente...
      const rewritten = buildChain(5).map((e) => e);
      rewritten[0] = { ...at(rewritten, 0), actorIdentifier: 'mallory' };
      let previous: Uint8Array = GENESIS_HASH;
      for (const [i, event] of rewritten.entries()) {
        const eventHash = computeEventHash(event, previous);
        rewritten[i] = { ...event, previousHash: previous, eventHash };
        previous = eventHash;
      }
      // ...a cadeia é internamente válida, mas não bate com a âncora publicada.
      expect(verifyAuditChain(rewritten)).toMatchObject({ valid: true });
      expect(verifyAuditChain(rewritten, { anchor })).toMatchObject({
        valid: false,
        failure: { seq: 5, reason: 'ANCHOR_MISMATCH' },
      });
    });
  });
});
