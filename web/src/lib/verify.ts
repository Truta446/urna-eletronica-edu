import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import canonicalize from 'canonicalize';
import { fromBase64Url, toHex } from './encoding.js';

/**
 * Verificação INDEPENDENTE de um resultado publicado, reimplementada do zero com WebCrypto.
 * Não importa nada do backend: só segue a especificação (docs/voting-flow.md, docs/security.md).
 * Duas implementações que concordam (esta e a de src/verifier) dão mais confiança que uma.
 * Funciona no navegador e no Node (crypto.subtle, TextEncoder e atob são globais nos dois).
 */
export interface PublishedTally {
  electionId: string;
  result: {
    candidates: { candidateId: string; number: number; name: string; votes: number }[];
    blank: number;
    null: number;
    totalBallots: number;
  };
  merkleRoot: string;
  resultHash: string;
  signature: string;
  keyId: string;
  publicKey: string;
  seal: {
    electionId: string;
    ballots: number;
    merkleRoot: string;
    auditHeadSeq: number;
    auditHeadHash: string;
    sealedAt: string;
    signature: string;
    keyId: string;
  };
  decryptionKey?: string | undefined;
}

export interface PublishedBallot {
  id: string;
  commitment: string;
  kind: 'CANDIDATE' | 'BLANK' | 'NULL_VOTE' | null;
  candidateId: string | null;
  encapsulatedKey?: string | null | undefined;
  ciphertext?: string | null | undefined;
}

export interface Check {
  label: string;
  ok: boolean;
}

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Separação de domínio da especificação: partes unidas por \0, em UTF-8. */
const sha256Parts = (...parts: string[]) => sha256(encoder.encode(parts.join('\0')));

function concat(...arrays: Uint8Array[]): Bytes {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** RFC 6962: folha = H(0x00 ‖ d), nó = H(0x01 ‖ esq ‖ dir), divisão na maior potência de 2 < n. */
export async function merkleRoot(leaves: Uint8Array[]): Promise<Bytes> {
  if (leaves.length === 0) return sha256(new Uint8Array());
  if (leaves.length === 1) return sha256(concat(Uint8Array.of(0), leaves[0] ?? new Uint8Array()));
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(
    concat(
      Uint8Array.of(1),
      await merkleRoot(leaves.slice(0, k)),
      await merkleRoot(leaves.slice(k)),
    ),
  );
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function commitmentOf(electionId: string, b: PublishedBallot): Promise<Bytes> {
  if (b.ciphertext && b.encapsulatedKey) {
    return sha256Parts(
      'urna-edu/ballot/v2',
      b.id,
      electionId,
      toHex(fromBase64Url(b.encapsulatedKey)),
      toHex(fromBase64Url(b.ciphertext)),
    );
  }
  return sha256Parts('urna-edu/ballot/v1', b.id, electionId, b.kind ?? '', b.candidateId ?? '');
}

function canonical(value: object): string {
  const text = canonicalize(value);
  if (text === undefined) throw new Error('not serializable');
  return text;
}

async function verifyEd25519(
  publicKeySpki: string,
  statement: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      fromBase64Url(publicKeySpki),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64Url(signature),
      encoder.encode(statement),
    );
  } catch {
    return false;
  }
}

async function keyIdOf(publicKeySpki: string): Promise<string> {
  return toHex(await sha256(fromBase64Url(publicKeySpki))).slice(0, 16);
}

type Decoded =
  { kind: 'CANDIDATE'; candidateId: string } | { kind: 'BLANK' } | { kind: 'NULL_VOTE' };

function decodePlaintext(bytes: Uint8Array): Decoded {
  const rest = bytes.subarray(1);
  const zero = rest.every((b) => b === 0);
  if (bytes.length !== 17) throw new Error('length');
  if (bytes[0] === 2 && zero) return { kind: 'BLANK' };
  if (bytes[0] === 3 && zero) return { kind: 'NULL_VOTE' };
  if (bytes[0] !== 1 || zero) throw new Error('kind');
  const h = toHex(rest);
  return {
    kind: 'CANDIDATE',
    candidateId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
  };
}

async function decodeBallots(
  electionId: string,
  ballots: PublishedBallot[],
  decryptionKey?: string,
): Promise<Decoded[]> {
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  const recipientKey = decryptionKey
    ? await suite.kem.importKey('raw', fromBase64Url(decryptionKey).buffer, false)
    : undefined;
  return Promise.all(
    ballots.map(async (b): Promise<Decoded> => {
      if (!b.ciphertext || !b.encapsulatedKey) {
        if (b.kind === 'CANDIDATE' && b.candidateId)
          return { kind: 'CANDIDATE', candidateId: b.candidateId };
        if (b.kind === 'BLANK') return { kind: 'BLANK' };
        if (b.kind === 'NULL_VOTE') return { kind: 'NULL_VOTE' };
        throw new Error('undecodable');
      }
      if (!recipientKey) throw new Error('missing decryption key');
      const plaintext = await suite.open(
        {
          recipientKey,
          enc: fromBase64Url(b.encapsulatedKey),
          info: encoder.encode('urna-edu/ballot/v2'),
        },
        fromBase64Url(b.ciphertext),
        encoder.encode(`urna-edu/ballot/v2|${electionId}|${b.id}`),
      );
      return decodePlaintext(new Uint8Array(plaintext));
    }),
  );
}

function recount(decoded: Decoded[], tally: PublishedTally): PublishedTally['result'] | undefined {
  const votes = new Map(tally.result.candidates.map((c) => [c.candidateId, 0]));
  let blank = 0;
  let nul = 0;
  for (const d of decoded) {
    if (d.kind === 'BLANK') blank += 1;
    else if (d.kind === 'NULL_VOTE') nul += 1;
    else {
      const current = votes.get(d.candidateId);
      if (current === undefined) return undefined;
      votes.set(d.candidateId, current + 1);
    }
  }
  return {
    candidates: [...tally.result.candidates]
      .sort((a, b) => a.number - b.number)
      .map((c) => ({ ...c, votes: votes.get(c.candidateId) ?? 0 })),
    blank,
    null: nul,
    totalBallots: decoded.length,
  };
}

export async function verifyPublished(
  tally: PublishedTally,
  ballots: PublishedBallot[],
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean) => checks.push({ label, ok });

  const keyId = await keyIdOf(tally.publicKey);
  add('Chave pública corresponde ao keyId', keyId === tally.keyId && keyId === tally.seal.keyId);

  const sealStatement = canonical({
    type: 'urna-edu/seal/v1',
    electionId: tally.seal.electionId,
    ballots: tally.seal.ballots,
    merkleRoot: tally.seal.merkleRoot,
    auditHeadSeq: tally.seal.auditHeadSeq,
    auditHeadHash: tally.seal.auditHeadHash,
    sealedAt: tally.seal.sealedAt,
  });
  add(
    'Assinatura do lacre da urna',
    await verifyEd25519(tally.publicKey, sealStatement, tally.seal.signature),
  );
  add('Lacre pertence a esta eleição', tally.seal.electionId === tally.electionId);

  const commitments: Bytes[] = [];
  let allMatch = true;
  for (const b of ballots) {
    const c = await commitmentOf(tally.electionId, b);
    commitments.push(c);
    if (toHex(c) !== b.commitment) allMatch = false;
  }
  add('Cada voto publicado reproduz o próprio commitment', allMatch);
  const root = toHex(await merkleRoot([...commitments].sort(compareBytes)));
  add(
    'Raiz de Merkle dos votos igual à do lacre',
    root === tally.seal.merkleRoot && root === tally.merkleRoot,
  );
  add('Número de votos igual ao lacrado', ballots.length === tally.seal.ballots);

  let recounted: PublishedTally['result'] | undefined;
  try {
    recounted = recount(await decodeBallots(tally.electionId, ballots, tally.decryptionKey), tally);
  } catch {
    recounted = undefined;
  }
  add(
    'Recontagem neste navegador igual ao resultado',
    canonical(recounted ?? {}) === canonical(tally.result),
  );

  const resultStatement = canonical({
    type: 'urna-edu/result/v1',
    electionId: tally.electionId,
    merkleRoot: tally.merkleRoot,
    result: tally.result,
    sealSignature: tally.seal.signature,
  });
  add(
    'Hash do resultado',
    toHex(await sha256(encoder.encode(resultStatement))) === tally.resultHash,
  );
  add(
    'Assinatura do resultado',
    await verifyEd25519(tally.publicKey, resultStatement, tally.signature),
  );
  return checks;
}
