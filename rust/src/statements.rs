//! Textos canônicos (RFC 8785) ASSINADOS. Idênticos aos da versão TS (testado).
use crate::crypto::{canonical, sha256};
use serde_json::{Value, json};

pub struct SealData<'a> {
    pub election_id: &'a str,
    pub ballots: i64,
    pub merkle_root: &'a str,
    pub audit_head_seq: i64,
    pub audit_head_hash: &'a str,
    pub sealed_at: &'a str,
}

pub fn seal_statement(s: &SealData) -> String {
    canonical(&json!({
        "type": "urna-edu/seal/v1",
        "electionId": s.election_id,
        "ballots": s.ballots,
        "merkleRoot": s.merkle_root,
        "auditHeadSeq": s.audit_head_seq,
        "auditHeadHash": s.audit_head_hash,
        "sealedAt": s.sealed_at,
    }))
}

pub fn result_statement(
    election_id: &str,
    merkle_root: &str,
    result: &Value,
    seal_signature: &str,
) -> String {
    canonical(&json!({
        "type": "urna-edu/result/v1",
        "electionId": election_id,
        "merkleRoot": merkle_root,
        "result": result,
        "sealSignature": seal_signature,
    }))
}

pub fn result_hash(statement: &str) -> [u8; 32] {
    sha256(statement.as_bytes())
}

pub fn authorization_statement(election_id: &str, nonce: &str, issued_at: &str) -> String {
    canonical(&json!({
        "type": "urna-edu/authorization/v1",
        "electionId": election_id,
        "nonce": nonce,
        "issuedAt": issued_at,
    }))
}
