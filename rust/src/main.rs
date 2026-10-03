#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use urna_server::config::Config;
use urna_server::http::rate_limit::RateLimiter;
use urna_server::state::{AppState, Inner};

#[tokio::main]
async fn main() {
    // .env do repositório (mesmo arquivo da versão TS). Variáveis já definidas têm precedência.
    let _ = dotenvy::dotenv();
    let config = match Config::from_env(|k| std::env::var(k).ok()) {
        Ok(c) => c,
        Err(invalid) => {
            eprintln!("Invalid environment configuration: {}", invalid.join(", "));
            std::process::exit(1);
        }
    };
    let level = match config.log_level.as_str() {
        "silent" => "off",
        "fatal" => "error",
        other => other,
    };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(format!(
            "urna_server={level}"
        )))
        .compact()
        .init();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(config.database_pool_size)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect_lazy(&config.database_url)
        .expect("DATABASE_URL inválida");
    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("RUST_HOST/RUST_PORT inválidos");
    let state = AppState(Arc::new(Inner {
        pool,
        rate_limiter: RateLimiter::new(config.rate_limit_per_minute),
        config,
    }));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("porta indisponível");
    tracing::info!(%addr, "listening");
    axum::serve(
        listener,
        urna_server::router(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let ctrl_c = tokio::signal::ctrl_c();
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    })
    .await
    .expect("servidor");
    state.pool.close().await;
}
