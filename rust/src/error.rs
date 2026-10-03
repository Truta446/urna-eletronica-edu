//! Erros com o MESMO formato JSON da versão TS: { error: { code, message, issues? } }.
//! Mensagens nunca incluem o valor recebido; erros 500 nunca expõem detalhes.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    Validation(Vec<(String, &'static str)>),
    BadRequest(&'static str),
    UnsupportedMediaType,
    PayloadTooLarge,
    Unauthorized(&'static str),
    NotFound(&'static str),
    Conflict(String),
    BusinessRule(String),
    Integrity(&'static str),
    RouteNotFound,
    Internal,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn invalid(path: impl Into<String>, message: &'static str) -> Self {
        Self::Validation(vec![(path.into(), message)])
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, issues) = match self {
            Self::Validation(issues) => (
                StatusCode::BAD_REQUEST,
                "VALIDATION_ERROR",
                "Invalid request".to_owned(),
                Some(issues),
            ),
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, "BAD_REQUEST", m.to_owned(), None),
            Self::UnsupportedMediaType => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "BAD_REQUEST",
                "Unsupported Media Type".to_owned(),
                None,
            ),
            Self::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "BAD_REQUEST",
                "Request body is too large".to_owned(),
                None,
            ),
            Self::Unauthorized(m) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", m.to_owned(), None),
            Self::NotFound(resource) => (
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                format!("{resource} not found"),
                None,
            ),
            Self::Conflict(m) => (StatusCode::CONFLICT, "CONFLICT", m, None),
            Self::BusinessRule(m) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "BUSINESS_RULE_VIOLATION",
                m,
                None,
            ),
            Self::Integrity(reason) => (
                StatusCode::CONFLICT,
                "INTEGRITY_FAILURE",
                format!("Integrity check failed: {reason}"),
                None,
            ),
            Self::RouteNotFound => (
                StatusCode::NOT_FOUND,
                "ROUTE_NOT_FOUND",
                "Route not found".to_owned(),
                None,
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "Internal server error".to_owned(),
                None,
            ),
        };
        let mut error = json!({ "code": code, "message": message });
        if let Some(issues) = issues {
            error["issues"] = issues
                .into_iter()
                .map(|(path, message)| json!({ "path": path, "message": message }))
                .collect();
        }
        (status, axum::Json(json!({ "error": error }))).into_response()
    }
}

/// SQLSTATE de um erro do banco (os da classe "UE" vêm dos triggers das migrations).
pub fn sql_state(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(db) => db.code().map(|c| c.into_owned()),
        _ => None,
    }
}

pub fn constraint(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(db) => db.constraint().map(str::to_owned),
        _ => None,
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        match sql_state(&error).as_deref() {
            Some("UE001" | "UE002" | "UE003" | "UE005") => {
                Self::Conflict("Election state does not allow this operation".into())
            }
            Some("UE004") => Self::Conflict("Voter record cannot be changed this way".into()),
            Some("UE006") => Self::Conflict("Voting session cannot be changed this way".into()),
            Some("UE008") => Self::Conflict("Ballots cannot be changed".into()),
            state => {
                // Só códigos: a mensagem do PostgreSQL pode conter a linha inteira (o próprio voto).
                tracing::error!(
                    sql_state = state.unwrap_or("-"),
                    kind = error_kind(&error),
                    "unhandled database error"
                );
                Self::Internal
            }
        }
    }
}

fn error_kind(error: &sqlx::Error) -> &'static str {
    match error {
        sqlx::Error::Database(_) => "database",
        sqlx::Error::PoolTimedOut => "pool_timeout",
        sqlx::Error::Io(_) => "io",
        sqlx::Error::RowNotFound => "row_not_found",
        _ => "other",
    }
}
