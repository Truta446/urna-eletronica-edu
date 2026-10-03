//! Primitivas criptográficas. Nenhum algoritmo novo: SHA-256, HMAC, HKDF (RustCrypto),
//! Ed25519 (dalek), HPKE (rust-hpke), JSON canônico (serde_jcs). Cada função espelha uma da
//! implementação TypeScript e é testada contra vetores gerados por ela
//! (tests/crypto_compat.rs).

pub mod ballot;
pub mod hpke_ballot;
pub mod merkle;
pub mod shamir;
pub mod signing;
pub mod tokens;
pub mod voter_id;

use sha2::{Digest, Sha256};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// SHA-256 com separação de domínio: partes unidas por `\0`, em UTF-8 (igual ao TS).
pub fn sha256_parts(parts: &[&str]) -> [u8; 32] {
    sha256(parts.join("\0").as_bytes())
}

/// HMAC-SHA256 com chave em bytes e partes unidas por `\0`.
pub fn hmac_parts(key: &[u8], parts: &[&str]) -> [u8; 32] {
    use hmac::{Hmac, KeyInit, Mac};
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key)
        .expect("HMAC aceita qualquer tamanho de chave");
    mac.update(parts.join("\0").as_bytes());
    mac.finalize().into_bytes().into()
}

/// JSON canônico (RFC 8785).
pub fn canonical(value: &serde_json::Value) -> String {
    serde_jcs::to_string(value).expect("valores JSON são sempre serializáveis")
}

/// Comparação em tempo constante.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

pub fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_b64url(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .ok()
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("CSPRNG do sistema operacional indisponível");
    buf
}
