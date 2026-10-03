//! Derivações da urna (docs/security.md, Fase 5). Mesmos prefixos e separadores do TS.
use super::{hmac_parts, sha256_parts};

pub fn nullifier_for(token: &str) -> [u8; 32] {
    sha256_parts(&["urna-edu/nullifier/v1", token])
}

pub fn idempotency_scope_key(token: &str, idempotency_key: &str) -> [u8; 32] {
    hmac_parts(
        token.as_bytes(),
        &["urna-edu/idempotency-scope/v1", idempotency_key],
    )
}

pub fn request_fingerprint(token: &str, canonical_request: &str) -> [u8; 32] {
    hmac_parts(
        token.as_bytes(),
        &["urna-edu/request-fingerprint/v1", canonical_request],
    )
}

pub fn ballot_commitment(
    ballot_id: &str,
    election_id: &str,
    kind: &str,
    candidate_id: Option<&str>,
) -> [u8; 32] {
    sha256_parts(&[
        "urna-edu/ballot/v1",
        ballot_id,
        election_id,
        kind,
        candidate_id.unwrap_or(""),
    ])
}

pub fn encrypted_ballot_commitment(
    ballot_id: &str,
    election_id: &str,
    enc: &[u8],
    ct: &[u8],
) -> [u8; 32] {
    sha256_parts(&[
        "urna-edu/ballot/v2",
        ballot_id,
        election_id,
        &hex::encode(enc),
        &hex::encode(ct),
    ])
}
