//! POST /ballots: consome o token e grava o voto numa transação READ COMMITTED, com
//! Idempotency-Key. Mesma lógica (e mesmo SQL) da versão TS.
use crate::crypto::ballot::{
    ballot_commitment, encrypted_ballot_commitment, idempotency_scope_key, nullifier_for,
    request_fingerprint,
};
use crate::crypto::hpke_ballot::{PlainChoice, encrypt_choice};
use crate::crypto::{constant_time_eq, tokens};
use crate::error::{AppError, AppResult};
use crate::http::auth::VotingToken;
use crate::http::extract::JsonBody;
use crate::state::AppState;
use crate::time_util::now_ms;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

pub struct IdempotencyKey(String);

impl<S: Send + Sync> FromRequestParts<S> for IdempotencyKey {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, AppError> {
        let value = parts
            .headers
            .get("idempotency-key")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let ok = (16..=128).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        ok.then(|| Self(value.to_owned()))
            .ok_or_else(|| AppError::invalid("idempotency-key", "Invalid Idempotency-Key"))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CastBody {
    election_id: String,
    choice: Value,
}

enum Choice {
    Candidate(u32),
    Blank,
    Null,
}

/// Objeto estrito por tipo: { type: "candidate", number } | { type: "blank" } | { type: "null" }.
fn parse_choice(value: &Value) -> AppResult<Choice> {
    let invalid = || AppError::invalid("choice", "Invalid choice");
    let object = value.as_object().ok_or_else(invalid)?;
    match (object.get("type").and_then(Value::as_str), object.len()) {
        (Some("candidate"), 2) => {
            let n = object
                .get("number")
                .and_then(Value::as_u64)
                .filter(|n| (1..=99_999).contains(n))
                .ok_or_else(invalid)?;
            Ok(Choice::Candidate(n as u32))
        }
        (Some("blank"), 1) => Ok(Choice::Blank),
        (Some("null"), 1) => Ok(Choice::Null),
        _ => Err(invalid()),
    }
}

fn canonical_request(election_id: &str, choice: &Choice) -> String {
    match choice {
        Choice::Candidate(n) => format!("{election_id}|candidate:{n}"),
        Choice::Blank => format!("{election_id}|blank"),
        Choice::Null => format!("{election_id}|null"),
    }
}

struct Keys {
    token_hash: [u8; 32],
    scope_key: [u8; 32],
    fingerprint: [u8; 32],
}

fn respond(status: u16, body: Value, replayed: bool) -> Response {
    let mut res = (
        StatusCode::from_u16(status).unwrap_or(StatusCode::CREATED),
        axum::Json(body),
    )
        .into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().insert(
        "idempotent-replayed",
        HeaderValue::from_static(if replayed { "true" } else { "false" }),
    );
    res
}

async fn replay_if_known(conn: &mut PgConnection, keys: &Keys) -> AppResult<Option<Response>> {
    let record: Option<(Vec<u8>, i32, Value)> = sqlx::query_as(
        "SELECT request_fingerprint, response_status, response_body FROM idempotency_records WHERE scope_key = $1",
    )
    .bind(keys.scope_key.as_slice())
    .fetch_optional(conn)
    .await?;
    let Some((fingerprint, status, body)) = record else {
        return Ok(None);
    };
    if !constant_time_eq(&fingerprint, &keys.fingerprint) {
        return Err(AppError::BusinessRule(
            "Idempotency-Key was already used with a different request".into(),
        ));
    }
    Ok(Some(respond(status as u16, body, true)))
}

pub async fn cast(
    State(state): State<AppState>,
    VotingToken(token): VotingToken,
    IdempotencyKey(idempotency_key): IdempotencyKey,
    JsonBody(body): JsonBody<CastBody>,
) -> AppResult<Response> {
    let election_id = Uuid::parse_str(&body.election_id)
        .ok()
        .filter(|_| body.election_id.len() == 36)
        .ok_or_else(|| AppError::invalid("electionId", "Invalid UUID"))?;
    let choice = parse_choice(&body.choice)?;
    let now = now_ms();
    let keys = Keys {
        token_hash: tokens::hash_token(&token),
        scope_key: idempotency_scope_key(&token, &idempotency_key),
        fingerprint: request_fingerprint(
            &token,
            &canonical_request(&election_id.to_string(), &choice),
        ),
    };

    let mut tx = state.pool.begin().await?;
    if let Some(replay) = replay_if_known(&mut tx, &keys).await? {
        tx.rollback().await?;
        return Ok(replay);
    }
    // Consumo atômico: a segunda requisição concorrente espera o lock da linha e não consome nada.
    let session: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE voting_sessions SET consumed = true
          WHERE token_hash = $1 AND NOT consumed AND expires_at > $2
        RETURNING election_id",
    )
    .bind(keys.token_hash.as_slice())
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((session_election,)) = session else {
        tx.rollback().await?;
        return explain_unusable_token(&state, &keys, now).await;
    };
    // Qualquer erro daqui em diante faz ROLLBACK (ao sair sem commit): o token volta a valer.
    if session_election != election_id {
        return Err(AppError::BusinessRule(
            "Voting token does not belong to this election".into(),
        ));
    }
    let candidate_id = match choice {
        Choice::Candidate(number) => {
            let found: Option<(Uuid,)> =
                sqlx::query_as("SELECT id FROM candidates WHERE election_id = $1 AND number = $2")
                    .bind(election_id)
                    .bind(number as i32)
                    .fetch_optional(&mut *tx)
                    .await?;
            Some(
                found
                    .ok_or_else(|| {
                        AppError::BusinessRule(format!("Candidate {number} does not exist"))
                    })?
                    .0,
            )
        }
        _ => None,
    };
    let kind = match choice {
        Choice::Candidate(_) => "CANDIDATE",
        Choice::Blank => "BLANK",
        Choice::Null => "NULL_VOTE",
    };
    let (encryption_key,): (Option<Vec<u8>>,) =
        sqlx::query_as("SELECT encryption_public_key FROM elections WHERE id = $1")
            .bind(election_id)
            .fetch_one(&mut *tx)
            .await?;

    let ballot_id = Uuid::new_v4();
    let (b, e) = (ballot_id.to_string(), election_id.to_string());
    let nullifier = nullifier_for(&token);
    if let Some(public_key) = encryption_key {
        // v2: a escolha só existe em claro nesta requisição; no banco ficam enc + ct (tamanho fixo).
        let plain = match candidate_id {
            Some(id) => PlainChoice::Candidate(id),
            None if kind == "BLANK" => PlainChoice::Blank,
            None => PlainChoice::NullVote,
        };
        let (enc, ct) = encrypt_choice(&public_key, &e, &b, &plain).ok_or(AppError::Internal)?;
        sqlx::query(
            "INSERT INTO ballots (id, election_id, nullifier, commitment, encapsulated_key, ciphertext) VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(ballot_id)
        .bind(election_id)
        .bind(nullifier.as_slice())
        .bind(encrypted_ballot_commitment(&b, &e, &enc, &ct).as_slice())
        .bind(&enc)
        .bind(&ct)
        .execute(&mut *tx)
        .await?;
    } else {
        let candidate = candidate_id.map(|c| c.to_string());
        sqlx::query(
            "INSERT INTO ballots (id, election_id, kind, candidate_id, nullifier, commitment) VALUES ($1, $2, $3::ballot_kind, $4, $5, $6)",
        )
        .bind(ballot_id)
        .bind(election_id)
        .bind(kind)
        .bind(candidate_id)
        .bind(nullifier.as_slice())
        .bind(ballot_commitment(&b, &e, kind, candidate.as_deref()).as_slice())
        .execute(&mut *tx)
        .await?;
    }
    let accepted = json!({ "accepted": true });
    sqlx::query(
        "INSERT INTO idempotency_records (scope_key, election_id, request_fingerprint, response_status, response_body)
         VALUES ($1, $2, $3, 201, $4)",
    )
    .bind(keys.scope_key.as_slice())
    .bind(election_id)
    .bind(keys.fingerprint.as_slice())
    .bind(&accepted)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(respond(201, accepted, false))
}

/// Fora da transação: explica por que o token não pôde ser usado (ou devolve o replay).
async fn explain_unusable_token(
    state: &AppState,
    keys: &Keys,
    now: OffsetDateTime,
) -> AppResult<Response> {
    let mut conn = state.pool.acquire().await?;
    if let Some(replay) = replay_if_known(&mut conn, keys).await? {
        return Ok(replay);
    }
    let session: Option<(bool, OffsetDateTime)> =
        sqlx::query_as("SELECT consumed, expires_at FROM voting_sessions WHERE token_hash = $1")
            .bind(keys.token_hash.as_slice())
            .fetch_optional(&mut *conn)
            .await?;
    match session {
        Some((true, _)) => Err(AppError::Conflict(
            "Voting token has already been used".into(),
        )),
        Some((false, expires)) if expires > now => {
            Err(AppError::Conflict("Ballot could not be cast, retry".into()))
        }
        _ => Err(AppError::Unauthorized("Invalid or expired voting token")),
    }
}
