//! Autenticação de operadores e do token de votação. São extractors de CABEÇALHO: o axum os
//! executa antes de ler o corpo, então quem não se autenticou não faz o servidor processar body.
use crate::config::OperatorCredential;
use crate::crypto::{constant_time_eq, tokens};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;

#[derive(Clone, Debug)]
pub struct Operator {
    pub kind: &'static str,
    pub id: String,
}

fn bearer(parts: &Parts) -> Option<&str> {
    let value = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = value.strip_prefix("Bearer ")?;
    tokens::is_token_format(token).then_some(token)
}

/// Compara contra TODAS as credenciais, sem sair no primeiro acerto (tempo não revela posição).
fn find(credentials: &[OperatorCredential], token: &str) -> Option<String> {
    let presented = tokens::hash_token(token);
    let mut matched = None;
    for credential in credentials {
        if constant_time_eq(&credential.token_hash, &presented) {
            matched = Some(credential.label.clone());
        }
    }
    matched
}

pub struct Admin(pub Operator);
pub struct PollWorker(pub Operator);

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        bearer(parts)
            .and_then(|t| find(&state.config.admin_credentials, t))
            .map(|id| Self(Operator { kind: "ADMIN", id }))
            .ok_or(AppError::Unauthorized("Unauthorized"))
    }
}

impl FromRequestParts<AppState> for PollWorker {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        bearer(parts)
            .and_then(|t| find(&state.config.poll_worker_credentials, t))
            .map(|id| {
                Self(Operator {
                    kind: "POLL_WORKER",
                    id,
                })
            })
            .ok_or(AppError::Unauthorized("Unauthorized"))
    }
}

pub struct VotingToken(pub String);

impl FromRequestParts<AppState> for VotingToken {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, _: &AppState) -> Result<Self, AppError> {
        bearer(parts)
            .map(|t| Self(t.to_owned()))
            .ok_or(AppError::Unauthorized("Invalid or expired voting token"))
    }
}
