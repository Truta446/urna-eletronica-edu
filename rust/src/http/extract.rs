//! Entrada externa: corpo JSON estrito (deny_unknown_fields), limite de 16 KiB, só JSON,
//! ids em UUID. Mensagens de validação não repetem o valor recebido.
use crate::error::AppError;
use axum::body::Body;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::header::CONTENT_TYPE;
use axum::http::request::Parts;
use serde::de::DeserializeOwned;

pub const BODY_LIMIT_BYTES: usize = 16 * 1024;

pub struct JsonBody<T>(pub T);

/// Corpo opcional (ex.: apuração sem partes de trustees).
pub struct OptionalJsonBody<T>(pub Option<T>);

async fn read_json<T: DeserializeOwned>(
    req: Request<Body>,
    optional: bool,
) -> Result<Option<T>, AppError> {
    let is_json = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    let bytes = axum::body::to_bytes(req.into_body(), BODY_LIMIT_BYTES)
        .await
        .map_err(|_| AppError::PayloadTooLarge)?;
    if bytes.is_empty() && optional {
        return Ok(None);
    }
    match is_json {
        Some(true) => {}
        Some(false) => return Err(AppError::UnsupportedMediaType),
        None if bytes.is_empty() => return Err(AppError::BadRequest("Body is required")),
        None => return Err(AppError::UnsupportedMediaType),
    }
    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    let value = serde_path_to_error::deserialize(&mut deserializer).map_err(|e| {
        let path = e.path().to_string();
        match e.inner().classify() {
            serde_json::error::Category::Data => AppError::invalid(
                if path == "." { String::new() } else { path },
                "Invalid value",
            ),
            _ => AppError::BadRequest("Body is not valid JSON"),
        }
    })?;
    deserializer
        .end()
        .map_err(|_| AppError::BadRequest("Body is not valid JSON"))?;
    Ok(Some(value))
}

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for JsonBody<T> {
    type Rejection = AppError;
    async fn from_request(req: Request<Body>, _: &S) -> Result<Self, AppError> {
        read_json(req, false)
            .await?
            .map(Self)
            .ok_or(AppError::BadRequest("Body is required"))
    }
}

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for OptionalJsonBody<T> {
    type Rejection = AppError;
    async fn from_request(req: Request<Body>, _: &S) -> Result<Self, AppError> {
        Ok(Self(read_json(req, true).await?))
    }
}

/// `:id` da rota, obrigatoriamente um UUID.
pub struct ElectionId(pub uuid::Uuid);

impl<S: Send + Sync> FromRequestParts<S> for ElectionId {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let axum::extract::Path(id) =
            axum::extract::Path::<String>::from_request_parts(parts, state)
                .await
                .map_err(|_| AppError::invalid("id", "Invalid UUID"))?;
        uuid::Uuid::parse_str(&id)
            .ok()
            .filter(|_| id.len() == 36)
            .map(Self)
            .ok_or_else(|| AppError::invalid("id", "Invalid UUID"))
    }
}

/// Nome exibível: aparado, 1..=200 caracteres, sem caracteres de controle.
pub fn display_name(path: &str, value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > 200 || trimmed.chars().any(char::is_control) {
        return Err(AppError::invalid(path, "Invalid name"));
    }
    Ok(trimmed.to_owned())
}
