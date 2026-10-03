//! Urna educacional: backend em Rust, com o mesmo contrato HTTP e o mesmo banco da versão
//! TypeScript. Não use em eleições reais.
#![forbid(unsafe_code)]

pub mod audit;
pub mod config;
pub mod crypto;
pub mod error;
pub mod http;
pub mod routes;
pub mod state;
pub mod statements;
pub mod time_util;

use axum::Router;
use axum::routing::{get, post};
use state::AppState;

pub fn router(state: AppState) -> Router {
    use routes::{audit, authorization, ballots, elections, health, people, tally};
    Router::new()
        .route("/health", get(health::live))
        .route("/health/ready", get(health::ready))
        .route("/admin/elections", post(elections::create))
        .route("/elections", get(elections::list))
        .route("/elections/{id}", get(elections::get))
        .route("/admin/elections/{id}/open", post(elections::open))
        .route("/admin/elections/{id}/close", post(elections::close))
        .route(
            "/admin/elections/{id}/candidates",
            post(people::create_candidate),
        )
        .route("/elections/{id}/candidates", get(people::list_candidates))
        .route("/admin/elections/{id}/voters", post(people::register_voter))
        .route(
            "/elections/{id}/voting-sessions",
            post(authorization::authorize),
        )
        .route("/ballots", post(ballots::cast))
        .route("/admin/audit", get(audit::list))
        .route("/admin/audit/verify", get(audit::verify))
        .route("/admin/elections/{id}/tally", post(tally::tally))
        .route("/elections/{id}/tally", get(tally::get_tally))
        .route("/elections/{id}/ballots", get(tally::get_ballots))
        .fallback(|| async { error::AppError::RouteNotFound })
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            http::middleware::rate_limit,
        ))
        .layer(axum::middleware::from_fn(http::middleware::access_log))
        .layer(axum::middleware::from_fn(
            http::middleware::security_headers,
        ))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            std::time::Duration::from_secs(15),
        ))
        .with_state(state)
}
