use crate::audit;
use crate::crypto::{b64url, from_b64url, hpke_ballot, merkle};
use crate::error::{AppError, AppResult};
use crate::http::auth::Admin;
use crate::http::extract::{ElectionId, JsonBody, display_name};
use crate::state::AppState;
use crate::statements::{SealData, seal_statement};
use crate::time_util::{iso, now_ms, parse_iso_with_offset};
use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json, response::IntoResponse};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub struct Election {
    pub id: Uuid,
    pub name: String,
    pub status: String,
    pub starts_at: OffsetDateTime,
    pub ends_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub encryption_public_key: Option<Vec<u8>>,
}

/// Colunas como macro: o SQL fica uma string FIXA em tempo de compilação (o sqlx 0.9 recusa
/// SQL montado em tempo de execução, uma proteção contra SQL injection).
#[macro_export]
macro_rules! election_columns {
    () => {
        "id, name, status::text AS status, starts_at, ends_at, created_at, encryption_public_key"
    };
}

impl Election {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "startsAt": iso(self.starts_at),
            "endsAt": iso(self.ends_at),
            "createdAt": iso(self.created_at),
            "ballotEncryption": if self.encryption_public_key.is_some() { "HPKE-X25519-HKDFSHA256-AES256GCM" } else { "NONE" },
            "encryptionPublicKey": self.encryption_public_key.as_deref().map(b64url),
        })
    }
}

pub async fn find(conn: &mut PgConnection, id: Uuid) -> AppResult<Election> {
    sqlx::query_as::<_, Election>(concat!(
        "SELECT ",
        election_columns!(),
        " FROM elections WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound("Election"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateElection {
    name: String,
    starts_at: String,
    ends_at: String,
    encryption_public_key: Option<String>,
}

const MAX_DURATION: Duration = Duration::days(30);

pub async fn create(
    State(state): State<AppState>,
    Admin(actor): Admin,
    JsonBody(body): JsonBody<CreateElection>,
) -> AppResult<impl IntoResponse> {
    let name = display_name("name", &body.name)?;
    let starts = parse_iso_with_offset(&body.starts_at)
        .ok_or_else(|| AppError::invalid("startsAt", "Invalid datetime"))?;
    let ends = parse_iso_with_offset(&body.ends_at)
        .ok_or_else(|| AppError::invalid("endsAt", "Invalid datetime"))?;
    let key = match &body.encryption_public_key {
        Some(k) if k.len() == 43 => {
            Some(from_b64url(k).filter(|b| b.len() == 32).ok_or_else(|| {
                AppError::invalid("encryptionPublicKey", "Must be a 32-byte key in base64url")
            })?)
        }
        Some(_) => {
            return Err(AppError::invalid(
                "encryptionPublicKey",
                "Must be a 32-byte key in base64url",
            ));
        }
        None => None,
    };
    let now = now_ms();
    if ends <= starts {
        return Err(AppError::BusinessRule(
            "endsAt must be after startsAt".into(),
        ));
    }
    if starts < now {
        return Err(AppError::BusinessRule(
            "startsAt must not be in the past".into(),
        ));
    }
    if ends - starts > MAX_DURATION {
        return Err(AppError::BusinessRule(
            "Election cannot last more than 30 days".into(),
        ));
    }
    if key
        .as_deref()
        .is_some_and(|k| !hpke_ballot::is_valid_public_key(k))
    {
        return Err(AppError::BusinessRule(
            "encryptionPublicKey is not a valid X25519 public key".into(),
        ));
    }

    let mut tx = state.pool.begin().await?;
    let election: Election = sqlx::query_as(concat!(
        "INSERT INTO elections (name, starts_at, ends_at, encryption_public_key) VALUES ($1, $2, $3, $4) RETURNING ",
        election_columns!()
    ))
    .bind(&name)
    .bind(starts)
    .bind(ends)
    .bind(key.as_deref())
    .fetch_one(&mut *tx)
    .await?;
    let payload = json!({
        "name": election.name,
        "startsAt": iso(election.starts_at),
        "endsAt": iso(election.ends_at),
        "encryptionPublicKey": election.encryption_public_key.as_deref().map(hex::encode),
    });
    audit::append(
        &mut tx,
        "ELECTION_CREATED",
        (actor.kind, &actor.id),
        Some(election.id),
        payload,
        now,
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(election.to_json())))
}

pub async fn list(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let rows: Vec<Election> = sqlx::query_as(concat!(
        "SELECT ",
        election_columns!(),
        " FROM elections ORDER BY created_at DESC LIMIT 100"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        json!({ "elections": rows.iter().map(Election::to_json).collect::<Vec<_>>() }),
    ))
}

pub async fn get(
    State(state): State<AppState>,
    ElectionId(id): ElectionId,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    Ok(Json(find(&mut conn, id).await?.to_json()))
}

fn wrong_status(actual: &str, expected: &str) -> AppError {
    AppError::Conflict(format!("Election is {actual}, expected {expected}"))
}

/// Transição por UPDATE condicional: verificar e alterar no mesmo comando.
pub async fn open(
    State(state): State<AppState>,
    Admin(actor): Admin,
    ElectionId(id): ElectionId,
) -> AppResult<Json<Value>> {
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let opened: Option<Election> = sqlx::query_as(concat!(
        "UPDATE elections SET status = 'OPEN'
          WHERE id = $1 AND status = 'DRAFT' AND ends_at > $2
            AND EXISTS (SELECT 1 FROM candidates WHERE election_id = $1)
            AND EXISTS (SELECT 1 FROM voters WHERE election_id = $1)
        RETURNING ",
        election_columns!()
    ))
    .bind(id)
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(election) = opened {
        audit::append(
            &mut tx,
            "ELECTION_OPENED",
            (actor.kind, &actor.id),
            Some(id),
            json!({}),
            now,
        )
        .await?;
        tx.commit().await?;
        return Ok(Json(election.to_json()));
    }
    tx.rollback().await?;
    let current = find(&mut *state.pool.acquire().await?, id).await?;
    if current.status != "DRAFT" {
        return Err(wrong_status(&current.status, "DRAFT"));
    }
    if current.ends_at <= now {
        return Err(AppError::BusinessRule(
            "Election window has already ended".into(),
        ));
    }
    Err(AppError::BusinessRule(
        "Election needs at least one candidate and one voter to open".into(),
    ))
}

/// Só depois de endsAt. Na mesma transação: apaga idempotência, lacra (Merkle + checkpoint, assinado).
pub async fn close(
    State(state): State<AppState>,
    Admin(actor): Admin,
    ElectionId(id): ElectionId,
) -> AppResult<Json<Value>> {
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let closed: Option<Election> = sqlx::query_as(concat!(
        "UPDATE elections SET status = 'CLOSED' WHERE id = $1 AND status = 'OPEN' AND ends_at <= $2 RETURNING ",
        election_columns!()
    ))
    .bind(id)
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(election) = closed else {
        tx.rollback().await?;
        let current = find(&mut *state.pool.acquire().await?, id).await?;
        if current.status != "OPEN" {
            return Err(wrong_status(&current.status, "OPEN"));
        }
        return Err(AppError::BusinessRule(
            "Election can only be closed after endsAt".into(),
        ));
    };

    let purged = sqlx::query("DELETE FROM idempotency_records WHERE election_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let (ballots, consumed, authorized, registered): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM ballots WHERE election_id = $1),
                (SELECT count(*) FROM voting_sessions WHERE election_id = $1 AND consumed),
                (SELECT count(*) FROM voters WHERE election_id = $1 AND has_voted),
                (SELECT count(*) FROM voters WHERE election_id = $1)",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    let head = audit::append(
        &mut tx,
        "ELECTION_CLOSED",
        (actor.kind, &actor.id),
        Some(id),
        json!({}),
        now,
    )
    .await?;
    let commitments: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT commitment FROM ballots WHERE election_id = $1 ORDER BY commitment")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let leaves: Vec<&[u8]> = commitments.iter().map(|(c,)| c.as_slice()).collect();
    let root = hex::encode(merkle::merkle_root(&leaves));
    let election_id = id.to_string();
    let sealed_at = iso(now);
    let signature = state.config.signer.sign(&seal_statement(&SealData {
        election_id: &election_id,
        ballots: commitments.len() as i64,
        merkle_root: &root,
        audit_head_seq: i64::from(head.seq),
        audit_head_hash: &head.hash,
        sealed_at: &sealed_at,
    }));
    let payload = json!({
        "ballots": ballots,
        "consumedSessions": consumed,
        "authorizedVoters": authorized,
        "registeredVoters": registered,
        "authorizedWithoutBallot": authorized - ballots,
        "idempotencyRecordsPurged": purged,
        "merkleRoot": root,
        "auditHeadSeq": head.seq,
        "auditHeadHash": head.hash,
        "sealedAt": sealed_at,
        "signature": signature,
        "keyId": state.config.signer.key_id,
    });
    audit::append(
        &mut tx,
        "BALLOT_BOX_SEALED",
        ("SYSTEM", "urna-edu"),
        Some(id),
        payload,
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(election.to_json()))
}
