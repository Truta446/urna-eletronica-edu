use crate::state::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;

/// Headers defensivos para uma API JSON (os mesmos da versão TS).
pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    h.entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    res
}

pub async fn rate_limit(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if state.rate_limiter.check(addr.ip()) {
        next.run(req).await
    } else {
        let body = serde_json::json!({ "error": { "code": "RATE_LIMITED", "message": "Too many requests" } });
        (axum::http::StatusCode::TOO_MANY_REQUESTS, axum::Json(body)).into_response()
    }
}

/// Log de acesso em whitelist: método, caminho SEM query string e status. Sem IP, sem headers.
/// Habilitação e voto não geram log de acesso (horários permitiriam correlação, T16).
pub async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let sensitive = path == "/ballots" || path.ends_with("/voting-sessions");
    let res = next.run(req).await;
    if !sensitive || res.status().is_server_error() {
        tracing::info!(%method, path, status = res.status().as_u16(), "request");
    }
    res
}
