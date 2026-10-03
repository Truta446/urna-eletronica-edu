import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export type AuditEventType =
  | 'ELECTION_CREATED'
  | 'CANDIDATE_CREATED'
  | 'VOTER_REGISTERED'
  | 'ELECTION_OPENED'
  | 'VOTER_AUTHORIZED'
  | 'ELECTION_CLOSED'
  | 'BALLOT_BOX_SEALED'
  | 'TALLY_STARTED'
  | 'TALLY_COMPLETED';

export type AuditActorType = 'ADMIN' | 'POLL_WORKER' | 'SYSTEM';

export interface AuditActor {
  type: AuditActorType;
  id: string;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'SYSTEM', id: 'urna-edu' };

/** Só valores primitivos: o JSON canônico de números não inteiros tem armadilhas que evitamos. */
export type AuditPayload = Record<string, string | number | boolean | null>;

export interface AuditEventData {
  seq: number;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorIdentifier: string;
  electionId: string | null;
  payload: AuditPayload;
  createdAt: Date;
}

export interface StoredAuditEvent extends AuditEventData {
  previousHash: Uint8Array;
  eventHash: Uint8Array;
}

/** O primeiro evento da cadeia aponta para 32 bytes zero. */
export const GENESIS_HASH: Buffer<ArrayBuffer> = Buffer.alloc(32);

/**
 * JSON canônico (RFC 8785): mesma informação, mesmos bytes, independente da ordem das chaves
 * ou de como o PostgreSQL (jsonb) devolveu o payload. `seq` faz parte dos dados: mudar a
 * posição de um evento muda o hash dele.
 */
export function canonicalEventData(event: AuditEventData): string {
  const canonical = canonicalize({
    seq: event.seq,
    eventType: event.eventType,
    actorType: event.actorType,
    actorIdentifier: event.actorIdentifier,
    electionId: event.electionId,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  });
  if (canonical === undefined) throw new Error('Audit event is not serializable');
  return canonical;
}

/** eventHash = SHA-256(canonicalEventData ‖ previousHash) */
export function computeEventHash(
  event: AuditEventData,
  previousHash: Uint8Array,
): Buffer<ArrayBuffer> {
  return createHash('sha256')
    .update(canonicalEventData(event), 'utf8')
    .update(previousHash)
    .digest();
}

export type ChainFailureReason =
  'SEQUENCE_GAP' | 'BROKEN_LINK' | 'HASH_MISMATCH' | 'ANCHOR_MISMATCH' | 'ANCHOR_NOT_FOUND';

export interface ChainHead {
  seq: number;
  hash: string;
}

export type ChainVerification =
  | { valid: true; eventCount: number; head: ChainHead | null }
  | { valid: false; eventCount: number; failure: { seq: number; reason: ChainFailureReason } };

export interface VerifyOptions {
  /**
   * Hash de um evento publicado FORA do banco (âncora). Sem âncora, apagar os últimos eventos
   * é indetectável: a cadeia restante continua válida. Com âncora, o truncamento aparece.
   */
  anchor?: ChainHead;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * Verificador incremental: recebe os eventos em ordem de `seq`, um por vez, para verificar
 * cadeias grandes sem carregá-las inteiras na memória.
 */
export function createChainVerifier(options: VerifyOptions = {}) {
  let expectedSeq = 1;
  let previousHash: Uint8Array = GENESIS_HASH;
  let head: ChainHead | null = null;
  let anchorSeen = false;
  let failure: { seq: number; reason: ChainFailureReason } | undefined;

  function check(event: StoredAuditEvent, recomputed: string): ChainFailureReason | undefined {
    // Ordem: evento removido, inserido fora de ordem ou com seq alterado.
    if (event.seq !== expectedSeq) return 'SEQUENCE_GAP';
    // Encadeamento: o evento aponta para o hash real do anterior.
    if (toHex(event.previousHash) !== toHex(previousHash)) return 'BROKEN_LINK';
    // Conteúdo: qualquer alteração nos dados muda o hash recalculado.
    if (recomputed !== toHex(event.eventHash)) return 'HASH_MISMATCH';
    if (options.anchor?.seq === event.seq && options.anchor.hash !== recomputed) {
      return 'ANCHOR_MISMATCH';
    }
    return undefined;
  }

  function push(event: StoredAuditEvent): void {
    if (failure) return;
    const recomputed = computeEventHash(event, event.previousHash).toString('hex');
    const reason = check(event, recomputed);
    if (reason) {
      failure = { seq: event.seq, reason };
      return;
    }
    if (options.anchor?.seq === event.seq) anchorSeen = true;
    head = { seq: event.seq, hash: recomputed };
    previousHash = Buffer.from(recomputed, 'hex');
    expectedSeq += 1;
  }

  function result(): ChainVerification {
    const eventCount = expectedSeq - 1;
    if (failure) return { valid: false, eventCount, failure };
    if (options.anchor && !anchorSeen) {
      return {
        valid: false,
        eventCount,
        failure: { seq: options.anchor.seq, reason: 'ANCHOR_NOT_FOUND' },
      };
    }
    return { valid: true, eventCount, head };
  }

  return { push, result };
}

export function verifyAuditChain(
  events: Iterable<StoredAuditEvent>,
  options: VerifyOptions = {},
): ChainVerification {
  const verifier = createChainVerifier(options);
  for (const event of events) verifier.push(event);
  return verifier.result();
}
