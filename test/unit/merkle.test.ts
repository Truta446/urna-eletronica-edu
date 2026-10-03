import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { merkleRoot, sortLeaves } from '../../src/security/merkle.js';

/** Vetores do Certificate Transparency (RFC 6962): mesmas folhas, mesmas raízes, em qualquer implementação. */
const CT_LEAVES = [
  '',
  '00',
  '10',
  '2021',
  '3031',
  '40414243',
  '5051525354555657',
  '606162636465666768696a6b6c6d6e6f',
].map((hex) => Buffer.from(hex, 'hex'));
const CT_ROOTS = [
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

describe('merkleRoot (RFC 6962)', () => {
  it.each(CT_ROOTS.map((root, n) => [n, root] as const))(
    'matches the CT test vector for %i leaves',
    (n, root) => {
      expect(merkleRoot(CT_LEAVES.slice(0, n)).toString('hex')).toBe(root);
    },
  );

  it('changes when any leaf changes, is added or is removed', () => {
    const leaves = Array.from({ length: 13 }, () => randomBytes(32));
    const root = merkleRoot(leaves).toString('hex');
    const changed = [...leaves];
    changed[7] = randomBytes(32);
    expect(merkleRoot(changed).toString('hex')).not.toBe(root);
    expect(merkleRoot([...leaves, randomBytes(32)]).toString('hex')).not.toBe(root);
    expect(merkleRoot(leaves.slice(1)).toString('hex')).not.toBe(root);
  });

  it('with sortLeaves, does not depend on arrival order', () => {
    const leaves = Array.from({ length: 20 }, () => randomBytes(32));
    const shuffled = [...leaves].reverse();
    expect(merkleRoot(sortLeaves(shuffled))).toEqual(merkleRoot(sortLeaves(leaves)));
  });
});
