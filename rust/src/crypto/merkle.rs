//! Merkle Tree Hash da RFC 6962, conferido com os vetores do Certificate Transparency.
use sha2::{Digest, Sha256};

fn tree_hash(leaves: &[&[u8]]) -> [u8; 32] {
    if let [single] = leaves {
        let mut h = Sha256::new();
        h.update([0x00]);
        h.update(single);
        return h.finalize().into();
    }
    let mut k = 1;
    while k * 2 < leaves.len() {
        k *= 2;
    }
    let mut h = Sha256::new();
    h.update([0x01]);
    h.update(tree_hash(&leaves[..k]));
    h.update(tree_hash(&leaves[k..]));
    h.finalize().into()
}

pub fn merkle_root(leaves: &[&[u8]]) -> [u8; 32] {
    if leaves.is_empty() {
        Sha256::digest([]).into()
    } else {
        tree_hash(leaves)
    }
}
