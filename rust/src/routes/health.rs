use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json, response::IntoResponse};
use serde_json::json;

pub async fn live() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query("SELECT 1").execute(&state.pool).await {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "status": "ok", "database": "up" })),
        ),
        Err(_) => {
            tracing::warn!("readiness check failed: database unreachable");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "unavailable", "database": "down" })),
            )
        }
    }
}
