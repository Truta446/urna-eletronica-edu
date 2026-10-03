use crate::audit;
use crate::crypto::voter_id::voter_identifier_hmac;
use crate::crypto::{random_bytes, tokens};
use crate::error::{AppError, AppResult};
use crate::http::auth::PollWorker;
use crate::http::extract::{ElectionId, JsonBody};
use crate::routes::elections::find;
use crate::routes::people::{VoterIdentifierBody, parse_voter_identifier};
use crate::state::AppState;
use crate::statements::authorization_statement;
use crate::time_util::{iso, now_ms};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::{Json, response::IntoResponse};
use serde_json::json;
use time::{Duration, OffsetDateTime};

/// Arredonda PARA CIMA até o minuto cheio (Fase 10, ataque A2: correlação exata por horário).
fn ceil_to_minute(t: OffsetDateTime) -> OffsetDateTime {
    let ms = t.unix_timestamp_nanos() / 1_000_000;
    let ceil = (ms + 59_999).div_euclid(60_000) * 60_000;
    OffsetDateTime::from_unix_timestamp_nanos(ceil * 1_000_000).unwrap_or(t)
}

/// Habilita o eleitor numa ÚNICA instrução SQL (mesma da versão TS): marca has_voted só se
/// ainda for false e cria a sessão SEM voter_id. O evento de auditoria leva só um nonce assinado.
pub async fn authorize(
    State(state): State<AppState>,
    PollWorker(actor): PollWorker,
    ElectionId(election_id): ElectionId,
    JsonBody(body): JsonBody<VoterIdentifierBody>,
) -> AppResult<impl IntoResponse> {
    let cpf = parse_voter_identifier(&body)?;
    let now = now_ms();
    let token = tokens::generate_token();
    let token_hash = tokens::hash_token(&token);
    let hmac = voter_identifier_hmac(
        &state.config.voter_id_pepper,
        &election_id.to_string(),
        &cpf,
    );
    let requested =
        ceil_to_minute(now + Duration::seconds(state.config.voting_session_ttl_seconds));

    let mut tx = state.pool.begin().await?;
    let issued: Option<(OffsetDateTime,)> = sqlx::query_as(
        "WITH election AS (
           SELECT id, ends_at FROM elections
            WHERE id = $1 AND status = 'OPEN' AND starts_at <= $2 AND ends_at > $2
         ), voter AS (
           UPDATE voters v SET has_voted = true
             FROM election e
            WHERE v.election_id = e.id AND v.identifier_hmac = $3 AND NOT v.has_voted
           RETURNING v.election_id, e.ends_at
         )
         INSERT INTO voting_sessions (election_id, token_hash, expires_at)
         SELECT election_id, $4, LEAST($5::timestamptz, ends_at) FROM voter
         RETURNING expires_at",
    )
    .bind(election_id)
    .bind(now)
    .bind(hmac.as_slice())
    .bind(token_hash.as_slice())
    .bind(requested)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((expires_at,)) = issued else {
        tx.rollback().await?;
        return Err(explain_refusal(&state, election_id, &hmac, now).await);
    };
    let nonce = hex::encode(random_bytes::<16>());
    let signature = state.config.signer.sign(&authorization_statement(
        &election_id.to_string(),
        &nonce,
        &iso(now),
    ));
    let payload =
        json!({ "nonce": nonce, "signature": signature, "keyId": state.config.signer.key_id });
    audit::append(
        &mut tx,
        "VOTER_AUTHORIZED",
        (actor.kind, &actor.id),
        Some(election_id),
        payload,
        now,
    )
    .await?;
    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "token": token, "expiresAt": iso(expires_at) })),
    ))
}

async fn explain_refusal(
    state: &AppState,
    election_id: uuid::Uuid,
    hmac: &[u8],
    now: OffsetDateTime,
) -> AppError {
    let Ok(mut conn) = state.pool.acquire().await else {
        return AppError::Internal;
    };
    let election = match find(&mut conn, election_id).await {
        Ok(e) => e,
        Err(e) => return e,
    };
    if election.status != "OPEN" {
        return AppError::Conflict(format!("Election is {}", election.status));
    }
    if now < election.starts_at {
        return AppError::Conflict("Voting has not started yet".into());
    }
    if now >= election.ends_at {
        return AppError::Conflict("Voting has already ended".into());
    }
    let voter: Result<Option<(bool,)>, _> = sqlx::query_as(
        "SELECT has_voted FROM voters WHERE election_id = $1 AND identifier_hmac = $2",
    )
    .bind(election_id)
    .bind(hmac)
    .fetch_optional(&mut *conn)
    .await;
    match voter {
        Ok(None) => AppError::NotFound("Voter"),
        Ok(Some((true,))) => AppError::Conflict("Voter has already been authorized".into()),
        Ok(Some((false,))) => {
            AppError::Conflict("Authorization could not be completed, retry".into())
        }
        Err(e) => e.into(),
    }
}
