use crate::config::Config;
use crate::http::rate_limit::RateLimiter;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub pool: PgPool,
    pub config: Config,
    pub rate_limiter: RateLimiter,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}
