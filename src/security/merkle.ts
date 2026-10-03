import { createHash } from 'node:crypto';

/**
 * Merkle Tree Hash da RFC 6962 (Certificate Transparency), sem variações:
 *   MTH({})      = SHA-256()
 *   MTH({d0})    = SHA-256(0x00 ‖ d0)
 *   MTH(D[n])    = SHA-256(0x01 ‖ MTH(D[0:k]) ‖ MTH(D[k:n])), k = maior potência de 2 < n
 * Os prefixos 0x00/0x01 impedem que um nó interno seja apresentado como folha.
 */
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Uint8Array[]): Buffer<ArrayBuffer> {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function treeHash(leaves: readonly Uint8Array[]): Buffer<ArrayBuffer> {
  const [first] = leaves;
  if (leaves.length === 1 && first) return sha256(LEAF_PREFIX, first);
  const k = largestPowerOfTwoBelow(leaves.length);
  return sha256(NODE_PREFIX, treeHash(leaves.slice(0, k)), treeHash(leaves.slice(k)));
}

export function merkleRoot(leaves: readonly Uint8Array[]): Buffer<ArrayBuffer> {
  return leaves.length === 0 ? sha256() : treeHash(leaves);
}

/** Ordem canônica das folhas: bytes crescentes. Independe da ordem de chegada dos votos. */
export function sortLeaves(leaves: readonly Uint8Array[]): Uint8Array[] {
  return [...leaves].sort((a, b) => Buffer.compare(a, b));
}
