/**
 * Vetores de teste gerados PELA IMPLEMENTAÇÃO TYPESCRIPT, consumidos pelos testes do Rust
 * (rust/tests/crypto_compat.rs). Garante compatibilidade byte a byte entre as duas.
 * Uso: npm run rust:fixtures
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import {
  computeEventHash,
  GENESIS_HASH,
  type AuditEventData,
} from '../src/modules/audit/domain/audit-chain.js';
import { canonicalRequest } from '../src/modules/ballot-box/domain/ballot.js';
import {
  authorizationStatement,
  resultHash,
  resultStatement,
  sealStatement,
} from '../src/modules/tally/domain/statements.js';
import {
  ballotCommitment,
  encryptedBallotCommitment,
  idempotencyScopeKey,
  nullifierFor,
  requestFingerprint,
} from '../src/security/ballot-crypto.js';
import {
  encodeChoice,
  encryptChoice,
  generateElectionKeyPair,
} from '../src/security/ballot-encryption.js';
import { merkleRoot } from '../src/security/merkle.js';
import { createSigner } from '../src/security/signing.js';
import { hashToken } from '../src/security/tokens.js';
import { splitKey } from '../src/security/trustees.js';
import { createVoterIdentifierHasher } from '../src/security/voter-identifier.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');

const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const electionId = '6f1c1c1e-4b7a-4c1e-9b0a-2f6f3d0c9a11';
const ballotId = '0c9a2f6f-3d0c-4a11-8b7a-6f1c1c1e4b7a';
const candidateId = '11111111-2222-4333-8444-555555555555';
const pepper = Buffer.alloc(32, 7);

const signingKey = generateKeyPairSync('ed25519').privateKey;
const signer = createSigner(signingKey);
const statement = sealStatement({
  electionId,
  ballots: 3,
  merkleRoot: 'ab'.repeat(32),
  auditHeadSeq: 9,
  auditHeadHash: 'cd'.repeat(32),
  sealedAt: '2030-01-01T17:00:00.000Z',
});
const result = {
  candidates: [{ candidateId, number: 13, name: 'Ana Grêmio', votes: 2 }],
  blank: 1,
  null: 0,
  totalBallots: 3,
};
const resultText = resultStatement({
  electionId,
  merkleRoot: 'ab'.repeat(32),
  result,
  sealSignature: 'sig',
});

const keys = await generateElectionKeyPair();
const shares = await splitKey(keys.privateKey, 5, 3);
const encrypted = await encryptChoice(
  keys.publicKey,
  { electionId, ballotId },
  { kind: 'CANDIDATE', candidateId },
);

const ctLeaves = [
  '',
  '00',
  '10',
  '2021',
  '3031',
  '40414243',
  '5051525354555657',
  '606162636465666768696a6b6c6d6e6f',
];

const event = (format: 1 | 2): AuditEventData => ({
  format,
  chainKey: format === 1 ? 'global' : electionId,
  seq: 3,
  eventType: 'CANDIDATE_CREATED',
  actorType: 'ADMIN',
  actorIdentifier: 'dev-admin',
  electionId,
  payload: { candidateId, number: 13, name: 'Ana Grêmio', ok: true, nothing: null },
  createdAt: new Date('2030-01-01T12:00:00.123Z'),
});

const fixtures = {
  token,
  electionId,
  ballotId,
  candidateId,
  tokenHash: hex(hashToken(token)),
  nullifier: hex(nullifierFor(token)),
  idempotencyScope: hex(idempotencyScopeKey(token, 'key-0123456789abcdef')),
  fingerprints: {
    candidate: hex(
      requestFingerprint(token, canonicalRequest(electionId, { type: 'candidate', number: 13 })),
    ),
    blank: hex(requestFingerprint(token, canonicalRequest(electionId, { type: 'blank' }))),
    null: hex(requestFingerprint(token, canonicalRequest(electionId, { type: 'null' }))),
  },
  commitmentV1: hex(ballotCommitment({ ballotId, electionId, kind: 'CANDIDATE', candidateId })),
  commitmentV1Blank: hex(
    ballotCommitment({ ballotId, electionId, kind: 'BLANK', candidateId: null }),
  ),
  commitmentV2: hex(
    encryptedBallotCommitment({
      ballotId,
      electionId,
      encapsulatedKey: encrypted.encapsulatedKey,
      ciphertext: encrypted.ciphertext,
    }),
  ),
  voterHmac: {
    pepper: b64(pepper),
    cpf: '52998224725',
    hmac: hex(createVoterIdentifierHasher(pepper)(electionId, '52998224725')),
  },
  encodedChoice: hex(encodeChoice({ kind: 'CANDIDATE', candidateId })),
  merkle: {
    leaves: ctLeaves,
    roots: Array.from({ length: 9 }, (_, n) =>
      hex(merkleRoot(ctLeaves.slice(0, n).map((l) => Buffer.from(l, 'hex')))),
    ),
  },
  jcs: {
    value: { b: 1, a: [2, 'é', null], c: { z: true, y: 'x' } },
    text: canonicalize({ b: 1, a: [2, 'é', null], c: { z: true, y: 'x' } }),
  },
  audit: {
    format1: hex(computeEventHash(event(1), GENESIS_HASH)),
    format2: hex(computeEventHash(event(2), Buffer.alloc(32, 9))),
    previousForFormat2: hex(Buffer.alloc(32, 9)),
  },
  signing: {
    privateKeyPkcs8: signingKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKeySpki: signer.publicKey,
    keyId: signer.keyId,
    statement,
    signature: signer.sign(statement),
  },
  statements: {
    authorization: authorizationStatement({
      electionId,
      nonce: 'ab'.repeat(16),
      issuedAt: '2030-01-01T12:00:00.123Z',
    }),
    result: resultText,
    resultHash: hex(resultHash(resultText)),
    resultValue: result,
  },
  shamir: { secret: hex(keys.privateKey), shares },
  hpke: {
    publicKey: b64(keys.publicKey),
    privateKey: b64(keys.privateKey),
    encapsulatedKey: b64(encrypted.encapsulatedKey),
    ciphertext: b64(encrypted.ciphertext),
  },
};

writeFileSync('rust/tests/fixtures/crypto.json', `${JSON.stringify(fixtures, null, 2)}\n`);
process.stdout.write('rust/tests/fixtures/crypto.json\n');
