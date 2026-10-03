//! Apuração (Fase 7) com as mesmas verificações de integridade e o mesmo formato publicado.
use crate::audit::{self, Anchor};
use crate::crypto::hpke_ballot::{PlainChoice, decrypt_choice, key_pair_matches};
use crate::crypto::{b64url, from_b64url, merkle, shamir, signing::verify_signature};
use crate::error::{AppError, AppResult};
use crate::http::auth::Admin;
use crate::http::extract::{ElectionId, OptionalJsonBody};
use crate::routes::elections::find;
use crate::state::AppState;
use crate::statements::{
    SealData, authorization_statement, result_hash, result_statement, seal_statement,
};
use crate::time_util::{iso, now_ms};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct BallotRow {
    id: Uuid,
    kind: Option<String>,
    candidate_id: Option<Uuid>,
    commitment: Vec<u8>,
    encapsulated_key: Option<Vec<u8>>,
    ciphertext: Option<Vec<u8>>,
}

struct Seal {
    payload: Value,
}

impl Seal {
    fn int(&self, k: &str) -> i64 {
        self.payload[k].as_i64().unwrap_or(-1)
    }
    fn str(&self, k: &str) -> &str {
        self.payload[k].as_str().unwrap_or("")
    }
}

fn seal_valid(state: &AppState, election_id: &str, seal: &Seal) -> bool {
    let statement = seal_statement(&SealData {
        election_id,
        ballots: seal.int("ballots"),
        merkle_root: seal.str("merkleRoot"),
        audit_head_seq: seal.int("auditHeadSeq"),
        audit_head_hash: seal.str("auditHeadHash"),
        sealed_at: seal.str("sealedAt"),
    });
    seal.str("keyId") == state.config.signer.key_id
        && verify_signature(
            &state.config.signer.public_key,
            &statement,
            seal.str("signature"),
        )
}

/// Exatamente UM lacre por eleição (Fase 10, ataque A3).
async fn load_seal(state: &AppState, election_id: Uuid) -> AppResult<Seal> {
    let rows: Vec<(Value,)> =
        sqlx::query_as("SELECT payload FROM audit_events WHERE election_id = $1 AND event_type = 'BALLOT_BOX_SEALED' LIMIT 2")
            .bind(election_id)
            .fetch_all(&state.pool)
            .await?;
    match rows.as_slice() {
        [(payload,)]
            if payload.get("signature").is_some() && payload.get("merkleRoot").is_some() =>
        {
            Ok(Seal {
                payload: payload.clone(),
            })
        }
        [] | [_] => Err(AppError::Integrity("SEAL_MISSING")),
        _ => Err(AppError::Integrity("SEAL_DUPLICATED")),
    }
}

fn recompute_commitment(election_id: &str, b: &BallotRow) -> [u8; 32] {
    use crate::crypto::ballot::{ballot_commitment, encrypted_ballot_commitment};
    let id = b.id.to_string();
    match (&b.encapsulated_key, &b.ciphertext) {
        (Some(enc), Some(ct)) => encrypted_ballot_commitment(&id, election_id, enc, ct),
        _ => {
            let candidate = b.candidate_id.map(|c| c.to_string());
            ballot_commitment(
                &id,
                election_id,
                b.kind.as_deref().unwrap_or(""),
                candidate.as_deref(),
            )
        }
    }
}

/// Nenhum voto é contado antes de todas as verificações (mesma ordem da versão TS).
async fn verify_integrity(
    state: &AppState,
    election_id: Uuid,
) -> AppResult<(Seal, Vec<BallotRow>, String)> {
    let e = election_id.to_string();
    let seal = load_seal(state, election_id).await?;
    if !seal_valid(state, &e, &seal) {
        return Err(AppError::Integrity("SEAL_SIGNATURE_INVALID"));
    }
    let chain = audit::chain_key_for(&state.pool, election_id).await?;
    let anchor = Anchor {
        seq: seal.int("auditHeadSeq") as i32,
        hash: seal.str("auditHeadHash").to_owned(),
    };
    if audit::verify_chain(&state.pool, &chain, Some(&anchor)).await?["valid"] != json!(true) {
        return Err(AppError::Integrity("AUDIT_CHAIN_INVALID"));
    }
    let ballots: Vec<BallotRow> = sqlx::query_as(
        "SELECT id, kind::text AS kind, candidate_id, commitment, encapsulated_key, ciphertext
           FROM ballots WHERE election_id = $1 ORDER BY commitment",
    )
    .bind(election_id)
    .fetch_all(&state.pool)
    .await?;
    if ballots
        .iter()
        .any(|b| recompute_commitment(&e, b).as_slice() != b.commitment.as_slice())
    {
        return Err(AppError::Integrity("COMMITMENT_MISMATCH"));
    }
    if ballots.len() as i64 != seal.int("ballots") {
        return Err(AppError::Integrity("BALLOT_COUNT_MISMATCH"));
    }
    let leaves: Vec<&[u8]> = ballots.iter().map(|b| b.commitment.as_slice()).collect();
    let root = hex::encode(merkle::merkle_root(&leaves));
    if root != seal.str("merkleRoot") {
        return Err(AppError::Integrity("MERKLE_ROOT_MISMATCH"));
    }
    verify_authorizations(state, election_id).await?;
    let (consumed,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM voting_sessions WHERE election_id = $1 AND consumed")
            .bind(election_id)
            .fetch_one(&state.pool)
            .await?;
    if consumed != ballots.len() as i64 {
        return Err(AppError::Integrity("SESSION_COUNT_MISMATCH"));
    }
    Ok((seal, ballots, root))
}

/// Ataque A1: só o servidor (dono da chave) gera eventos VOTER_AUTHORIZED válidos.
async fn verify_authorizations(state: &AppState, election_id: Uuid) -> AppResult<()> {
    let events: Vec<(Value, OffsetDateTime)> =
        sqlx::query_as("SELECT payload, created_at FROM audit_events WHERE election_id = $1 AND event_type = 'VOTER_AUTHORIZED'")
            .bind(election_id)
            .fetch_all(&state.pool)
            .await?;
    let e = election_id.to_string();
    let mut nonces = HashSet::new();
    for (payload, created_at) in &events {
        let (Some(nonce), Some(signature), Some(key_id)) = (
            payload["nonce"].as_str(),
            payload["signature"].as_str(),
            payload["keyId"].as_str(),
        ) else {
            continue;
        };
        let well_formed = nonce.len() == 32
            && nonce
                .bytes()
                .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
        let statement = authorization_statement(&e, nonce, &iso(*created_at));
        if well_formed
            && key_id == state.config.signer.key_id
            && verify_signature(&state.config.signer.public_key, &statement, signature)
        {
            nonces.insert(nonce.to_owned());
        }
    }
    let (authorized,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM voters WHERE election_id = $1 AND has_voted")
            .bind(election_id)
            .fetch_one(&state.pool)
            .await?;
    if nonces.len() as i64 != authorized || events.len() as i64 != authorized {
        return Err(AppError::Integrity("AUTHORIZATION_EVENTS_MISMATCH"));
    }
    Ok(())
}

fn decode(
    ballot: &BallotRow,
    election_id: &str,
    key: Option<&[u8]>,
) -> Result<PlainChoice, &'static str> {
    if let (Some(enc), Some(ct)) = (&ballot.encapsulated_key, &ballot.ciphertext) {
        let key = key.ok_or("UNDECODABLE_BALLOT")?;
        return decrypt_choice(key, election_id, &ballot.id.to_string(), enc, ct)
            .ok_or("UNDECODABLE_BALLOT");
    }
    match (ballot.kind.as_deref(), ballot.candidate_id) {
        (Some("CANDIDATE"), Some(id)) => Ok(PlainChoice::Candidate(id)),
        (Some("BLANK"), _) => Ok(PlainChoice::Blank),
        (Some("NULL_VOTE"), _) => Ok(PlainChoice::NullVote),
        _ => Err("UNDECODABLE_BALLOT"),
    }
}

/// Contagem como função pura: candidatos ordenados por número, todos listados.
fn tally_ballots(
    choices: &[PlainChoice],
    candidates: &[(Uuid, i32, String)],
) -> Result<Value, &'static str> {
    let mut votes: HashMap<Uuid, i64> = candidates.iter().map(|(id, _, _)| (*id, 0)).collect();
    let (mut blank, mut null_votes) = (0, 0);
    for choice in choices {
        match choice {
            PlainChoice::Blank => blank += 1,
            PlainChoice::NullVote => null_votes += 1,
            PlainChoice::Candidate(id) => *votes.get_mut(id).ok_or("UNKNOWN_CANDIDATE")? += 1,
        }
    }
    let mut sorted = candidates.to_vec();
    sorted.sort_by_key(|(_, number, _)| *number);
    Ok(json!({
        "candidates": sorted.iter().map(|(id, number, name)| json!({ "candidateId": id, "number": number, "name": name, "votes": votes[id] })).collect::<Vec<_>>(),
        "blank": blank,
        // Cuidado: dentro de json!, `null` é o literal JSON, não uma variável.
        "null": null_votes,
        "totalBallots": choices.len(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TallyBody {
    trustee_shares: Option<Vec<String>>,
}

async fn record_failure(
    state: &AppState,
    election_id: Uuid,
    actor: (&str, &str),
    reason: &str,
) -> AppResult<()> {
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    audit::append(
        &mut tx,
        "TALLY_STARTED",
        actor,
        Some(election_id),
        json!({}),
        now,
    )
    .await?;
    audit::append(
        &mut tx,
        "TALLY_FAILED",
        actor,
        Some(election_id),
        json!({ "reason": reason }),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn tally(
    State(state): State<AppState>,
    Admin(actor): Admin,
    ElectionId(election_id): ElectionId,
    OptionalJsonBody(body): OptionalJsonBody<TallyBody>,
) -> AppResult<impl IntoResponse> {
    let shares = body.and_then(|b| b.trustee_shares);
    if let Some(list) = &shares
        && (list.len() > 255
            || list
                .iter()
                .any(|s| !(2..=200).contains(&s.len()) || from_b64url(s).is_none()))
    {
        return Err(AppError::invalid("trusteeShares", "Invalid share"));
    }
    let election = find(&mut *state.pool.acquire().await?, election_id).await?;
    if election.status != "CLOSED" {
        return Err(AppError::Conflict(format!(
            "Election is {}, expected CLOSED",
            election.status
        )));
    }
    // v2: reconstrói e CONFERE a chave antes de abrir qualquer voto.
    let private_key = match (&election.encryption_public_key, &shares) {
        (None, Some(list)) if !list.is_empty() => {
            return Err(AppError::BusinessRule(
                "This election has no encrypted ballots".into(),
            ));
        }
        (None, _) => None,
        (Some(_), None) => {
            return Err(AppError::BusinessRule(
                "Encrypted election: provide at least the threshold of trustee shares".into(),
            ));
        }
        (Some(_), Some(list)) if list.len() < 2 => {
            return Err(AppError::BusinessRule(
                "Encrypted election: provide at least the threshold of trustee shares".into(),
            ));
        }
        (Some(public_key), Some(list)) => {
            let parts: Vec<Vec<u8>> = list.iter().filter_map(|s| from_b64url(s)).collect();
            let key = zeroize::Zeroizing::new(
                shamir::combine(&parts)
                    .map_err(|_| AppError::BusinessRule("Trustee shares are malformed".into()))?,
            );
            if !key_pair_matches(public_key, &key) {
                return Err(AppError::BusinessRule(
                    "Trustee shares do not reconstruct the election key".into(),
                ));
            }
            Some(key)
        }
    };

    let e = election_id.to_string();
    let actor_ref = (actor.kind, actor.id.as_str());
    let checked = verify_integrity(&state, election_id).await;
    let (seal, ballots, root) = match checked {
        Ok(v) => v,
        Err(AppError::Integrity(reason)) => {
            record_failure(&state, election_id, actor_ref, reason).await?;
            return Err(AppError::Integrity(reason));
        }
        Err(other) => return Err(other),
    };
    let candidates: Vec<(Uuid, i32, String)> =
        sqlx::query_as("SELECT id, number, name FROM candidates WHERE election_id = $1")
            .bind(election_id)
            .fetch_all(&state.pool)
            .await?;
    let counted = ballots
        .iter()
        .map(|b| decode(b, &e, private_key.as_deref().map(Vec::as_slice)))
        .collect::<Result<Vec<_>, _>>()
        .and_then(|choices| tally_ballots(&choices, &candidates));
    let result = match counted {
        Ok(r) => r,
        Err(reason) => {
            record_failure(&state, election_id, actor_ref, reason).await?;
            return Err(AppError::Integrity(reason));
        }
    };

    let statement = result_statement(&e, &root, &result, seal.str("signature"));
    let hash = result_hash(&statement);
    let signature = state.config.signer.sign(&statement);
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let updated =
        sqlx::query("UPDATE elections SET status = 'TALLIED' WHERE id = $1 AND status = 'CLOSED'")
            .bind(election_id)
            .execute(&mut *tx)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "Election was tallied concurrently".into(),
        ));
    }
    audit::append(
        &mut tx,
        "TALLY_STARTED",
        actor_ref,
        Some(election_id),
        json!({}),
        now,
    )
    .await?;
    sqlx::query(
        "INSERT INTO tally_results (election_id, result, merkle_root, result_hash, signature, key_id, decryption_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(election_id)
    .bind(&result)
    .bind(hex::decode(&root).unwrap_or_default())
    .bind(hash.as_slice())
    .bind(&signature)
    .bind(&state.config.signer.key_id)
    .bind(private_key.as_deref().map(Vec::as_slice))
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let payload = json!({
        "totalBallots": result["totalBallots"],
        "merkleRoot": root,
        "resultHash": hex::encode(hash),
        "signature": signature,
        "keyId": state.config.signer.key_id,
    });
    audit::append(
        &mut tx,
        "TALLY_COMPLETED",
        actor_ref,
        Some(election_id),
        payload,
        now,
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(published_tally(&state, election_id).await?),
    ))
}

#[derive(sqlx::FromRow)]
struct StoredResult {
    result: Value,
    merkle_root: Vec<u8>,
    result_hash: Vec<u8>,
    signature: String,
    key_id: String,
    decryption_key: Option<Vec<u8>>,
    created_at: OffsetDateTime,
}

/// Sem resultado parcial; e o servidor confere a assinatura ANTES de publicar (ataque A4).
async fn published_tally(state: &AppState, election_id: Uuid) -> AppResult<Value> {
    let election = find(&mut *state.pool.acquire().await?, election_id).await?;
    if election.status != "TALLIED" {
        return Err(AppError::Conflict(
            "Results are only published after the tally".into(),
        ));
    }
    let e = election_id.to_string();
    let stored: Option<StoredResult> = sqlx::query_as(
        "SELECT result, merkle_root, result_hash, signature, key_id, decryption_key, created_at FROM tally_results WHERE election_id = $1",
    )
    .bind(election_id)
    .fetch_optional(&state.pool)
    .await?;
    let seal = load_seal(state, election_id)
        .await
        .map_err(|_| AppError::Integrity("RESULT_SIGNATURE_INVALID"))?;
    let Some(stored) = stored.filter(|_| seal_valid(state, &e, &seal)) else {
        return Err(AppError::Integrity("RESULT_SIGNATURE_INVALID"));
    };
    let root = hex::encode(&stored.merkle_root);
    let statement = result_statement(&e, &root, &stored.result, seal.str("signature"));
    let valid = stored.key_id == state.config.signer.key_id
        && result_hash(&statement).as_slice() == stored.result_hash.as_slice()
        && verify_signature(
            &state.config.signer.public_key,
            &statement,
            &stored.signature,
        );
    if !valid {
        return Err(AppError::Integrity("RESULT_SIGNATURE_INVALID"));
    }
    let mut out = json!({
        "electionId": election_id,
        "electionName": election.name,
        "result": stored.result,
        "merkleRoot": root,
        "resultHash": hex::encode(&stored.result_hash),
        "signature": stored.signature,
        "keyId": stored.key_id,
        "publicKey": state.config.signer.public_key,
        "seal": {
            "electionId": e,
            "ballots": seal.int("ballots"),
            "merkleRoot": seal.str("merkleRoot"),
            "auditHeadSeq": seal.int("auditHeadSeq"),
            "auditHeadHash": seal.str("auditHeadHash"),
            "sealedAt": seal.str("sealedAt"),
            "signature": seal.str("signature"),
            "keyId": seal.str("keyId"),
        },
        "turnout": {
            "registeredVoters": seal.int("registeredVoters"),
            "authorizedVoters": seal.int("authorizedVoters"),
            "authorizedWithoutBallot": seal.int("authorizedWithoutBallot"),
        },
        "talliedAt": iso(stored.created_at),
    });
    if let Some(key) = stored.decryption_key {
        out["decryptionKey"] = json!(b64url(&key));
    }
    Ok(out)
}

pub async fn get_tally(
    State(state): State<AppState>,
    ElectionId(id): ElectionId,
) -> AppResult<Json<Value>> {
    Ok(Json(published_tally(&state, id).await?))
}

pub async fn get_ballots(
    State(state): State<AppState>,
    ElectionId(id): ElectionId,
) -> AppResult<Json<Value>> {
    published_tally(&state, id).await?;
    let rows: Vec<BallotRow> = sqlx::query_as(
        "SELECT id, kind::text AS kind, candidate_id, commitment, encapsulated_key, ciphertext
           FROM ballots WHERE election_id = $1 ORDER BY commitment",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    let ballots: Vec<Value> = rows
        .iter()
        .map(|b| {
            let mut v = json!({ "id": b.id, "commitment": hex::encode(&b.commitment), "kind": b.kind, "candidateId": b.candidate_id });
            if let (Some(enc), Some(ct)) = (&b.encapsulated_key, &b.ciphertext) {
                v["encapsulatedKey"] = json!(b64url(enc));
                v["ciphertext"] = json!(b64url(ct));
            }
            v
        })
        .collect();
    Ok(Json(json!({ "ballots": ballots })))
}
