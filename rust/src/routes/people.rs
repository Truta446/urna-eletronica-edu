//! Candidatos e eleitores (só em DRAFT; a garantia real são os triggers do banco).
use crate::audit;
use crate::crypto::voter_id::{normalize_cpf, voter_identifier_hmac};
use crate::error::{AppError, AppResult, constraint};
use crate::http::auth::Admin;
use crate::http::extract::{ElectionId, JsonBody, display_name};
use crate::routes::elections::find;
use crate::state::AppState;
use crate::time_util::now_ms;
use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json, response::IntoResponse};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

fn unique_violation(error: &sqlx::Error, name: &str) -> bool {
    crate::error::sql_state(error).as_deref() == Some("23505")
        && constraint(error).as_deref() == Some(name)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCandidate {
    number: u32,
    name: String,
}

pub async fn create_candidate(
    State(state): State<AppState>,
    Admin(actor): Admin,
    ElectionId(election_id): ElectionId,
    JsonBody(body): JsonBody<CreateCandidate>,
) -> AppResult<impl IntoResponse> {
    if !(1..=99_999).contains(&body.number) {
        return Err(AppError::invalid("number", "Must be between 1 and 99999"));
    }
    let name = display_name("name", &body.name)?;
    let election = find(&mut *state.pool.acquire().await?, election_id).await?;
    if election.status != "DRAFT" {
        return Err(AppError::Conflict(format!(
            "Election is {}, candidates can only be added in DRAFT",
            election.status
        )));
    }
    let mut tx = state.pool.begin().await?;
    let inserted: Result<(Uuid,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO candidates (election_id, number, name) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(election_id)
    .bind(body.number as i32)
    .bind(&name)
    .fetch_one(&mut *tx)
    .await;
    let (id,) = match inserted {
        Ok(row) => row,
        Err(e) if unique_violation(&e, "candidates_election_id_number_key") => {
            return Err(AppError::Conflict(format!(
                "Candidate number {} is already taken",
                body.number
            )));
        }
        Err(e) => return Err(e.into()),
    };
    let payload = json!({ "candidateId": id, "number": body.number, "name": name });
    audit::append(
        &mut tx,
        "CANDIDATE_CREATED",
        (actor.kind, &actor.id),
        Some(election_id),
        payload,
        now_ms(),
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "electionId": election_id, "number": body.number, "name": name })),
    ))
}

pub async fn list_candidates(
    State(state): State<AppState>,
    ElectionId(election_id): ElectionId,
) -> AppResult<Json<Value>> {
    find(&mut *state.pool.acquire().await?, election_id).await?;
    let rows: Vec<(Uuid, i32, String)> = sqlx::query_as(
        "SELECT id, number, name FROM candidates WHERE election_id = $1 ORDER BY number",
    )
    .bind(election_id)
    .fetch_all(&state.pool)
    .await?;
    let candidates: Vec<Value> =
        rows.into_iter().map(|(id, number, name)| json!({ "id": id, "electionId": election_id, "number": number, "name": name })).collect();
    Ok(Json(json!({ "candidates": candidates })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoterIdentifierBody {
    pub voter_identifier: String,
}

/// CPF validado e normalizado. A mensagem nunca repete o valor (é dado pessoal).
pub fn parse_voter_identifier(body: &VoterIdentifierBody) -> AppResult<String> {
    if body.voter_identifier.len() > 32 {
        return Err(AppError::invalid("voterIdentifier", "Invalid CPF"));
    }
    normalize_cpf(&body.voter_identifier)
        .ok_or_else(|| AppError::invalid("voterIdentifier", "Invalid CPF"))
}

pub async fn register_voter(
    State(state): State<AppState>,
    Admin(actor): Admin,
    ElectionId(election_id): ElectionId,
    JsonBody(body): JsonBody<VoterIdentifierBody>,
) -> AppResult<impl IntoResponse> {
    let cpf = parse_voter_identifier(&body)?;
    let election = find(&mut *state.pool.acquire().await?, election_id).await?;
    if election.status != "DRAFT" {
        return Err(AppError::Conflict(format!(
            "Election is {}, voters can only be registered in DRAFT",
            election.status
        )));
    }
    let hmac = voter_identifier_hmac(
        &state.config.voter_id_pepper,
        &election_id.to_string(),
        &cpf,
    );
    let mut tx = state.pool.begin().await?;
    let inserted: Result<(Uuid,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO voters (election_id, identifier_hmac) VALUES ($1, $2) RETURNING id",
    )
    .bind(election_id)
    .bind(hmac.as_slice())
    .fetch_one(&mut *tx)
    .await;
    let (id,) = match inserted {
        Ok(row) => row,
        Err(e) if unique_violation(&e, "voters_election_id_identifier_hmac_key") => {
            return Err(AppError::Conflict(
                "Voter already registered in this election".into(),
            ));
        }
        Err(e) => return Err(e.into()),
    };
    audit::append(
        &mut tx,
        "VOTER_REGISTERED",
        (actor.kind, &actor.id),
        Some(election_id),
        json!({ "voterId": id }),
        now_ms(),
    )
    .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "electionId": election_id })),
    ))
}
