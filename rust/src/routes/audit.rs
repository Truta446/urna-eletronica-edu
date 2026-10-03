use crate::audit::{self, Anchor, EventRow};
use crate::error::{AppError, AppResult};
use crate::event_columns;
use crate::http::auth::Admin;
use crate::state::AppState;
use axum::Json;
use axum::extract::{Query, State};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

fn only(query: &HashMap<String, String>, allowed: &[&str]) -> AppResult<()> {
    match query.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(AppError::invalid(k.clone(), "Unrecognized key")),
        None => Ok(()),
    }
}

fn uuid_param(query: &HashMap<String, String>, key: &str) -> AppResult<Option<Uuid>> {
    query
        .get(key)
        .map(|v| {
            Uuid::parse_str(v)
                .ok()
                .filter(|_| v.len() == 36)
                .ok_or_else(|| AppError::invalid(key, "Invalid UUID"))
        })
        .transpose()
}

fn int_param(
    query: &HashMap<String, String>,
    key: &str,
    min: i64,
    max: i64,
) -> AppResult<Option<i64>> {
    query
        .get(key)
        .map(|v| {
            v.parse::<i64>()
                .ok()
                .filter(|n| (min..=max).contains(n))
                .ok_or_else(|| AppError::invalid(key, "Invalid number"))
        })
        .transpose()
}

pub async fn list(
    State(state): State<AppState>,
    Admin(_): Admin,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    only(&query, &["electionId", "afterId", "limit"])?;
    let election = uuid_param(&query, "electionId")?;
    let after = int_param(&query, "afterId", 0, i64::from(i32::MAX))?.unwrap_or(0);
    let limit = int_param(&query, "limit", 1, 500)?.unwrap_or(100);
    let rows: Vec<EventRow> = sqlx::query_as(concat!(
        "SELECT ",
        event_columns!(),
        " FROM audit_events WHERE id > $1 AND ($2::uuid IS NULL OR election_id = $2) ORDER BY id LIMIT $3"
    ))
    .bind(after as i32)
    .bind(election)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "events": rows.iter().map(EventRow::to_json).collect::<Vec<_>>(),
        "nextAfterId": rows.last().map(|r| r.id),
    })))
}

pub async fn verify(
    State(state): State<AppState>,
    Admin(_): Admin,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    only(&query, &["electionId", "anchorSeq", "anchorHash"])?;
    let election = uuid_param(&query, "electionId")?;
    let anchor_seq = int_param(&query, "anchorSeq", 1, i64::from(i32::MAX))?;
    let anchor_hash = query.get("anchorHash");
    if anchor_hash.is_some_and(|h| {
        h.len() != 64 || !h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    }) {
        return Err(AppError::invalid("anchorHash", "Invalid hash"));
    }
    if anchor_seq.is_some() != anchor_hash.is_some() {
        return Err(AppError::invalid(
            "",
            "anchorSeq and anchorHash must be given together",
        ));
    }
    let Some(election) = election else {
        if anchor_seq.is_some() {
            return Err(AppError::invalid(
                "",
                "an anchor refers to one election chain: electionId is required",
            ));
        }
        return Ok(Json(audit::verify_all(&state.pool).await?));
    };
    let chain = audit::chain_key_for(&state.pool, election).await?;
    let anchor = anchor_seq.zip(anchor_hash).map(|(seq, hash)| Anchor {
        seq: seq as i32,
        hash: hash.clone(),
    });
    let mut result = audit::verify_chain(&state.pool, &chain, anchor.as_ref()).await?;
    result["chain"] = json!(chain);
    Ok(Json(result))
}
