//! Configuração validada na inicialização (fail fast), com as mesmas regras da versão TS.
//! Mensagens de erro listam só os NOMES das variáveis: valores podem ser segredos.
use crate::crypto::signing::Signer;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct OperatorCredential {
    pub label: String,
    pub token_hash: [u8; 32],
}

pub struct Config {
    pub production: bool,
    pub host: String,
    pub port: u16,
    pub log_level: String,
    pub database_url: String,
    pub database_pool_size: u32,
    pub admin_credentials: Vec<OperatorCredential>,
    pub poll_worker_credentials: Vec<OperatorCredential>,
    pub voting_session_ttl_seconds: i64,
    pub voter_id_pepper: zeroize::Zeroizing<Vec<u8>>,
    pub signer: Signer,
    pub rate_limit_per_minute: u32,
}

fn parse_credentials(raw: &str) -> Option<Vec<OperatorCredential>> {
    let valid_label = |l: &str| {
        let b = l.as_bytes();
        (1..=32).contains(&b.len())
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
    };
    let mut out = Vec::new();
    for entry in raw.trim().split(',').map(str::trim) {
        let (label, hash) = entry.split_once(':')?;
        if !valid_label(label)
            || hash.len() != 64
            || !hash.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        {
            return None;
        }
        out.push(OperatorCredential {
            label: label.to_owned(),
            token_hash: hex::decode(hash).ok()?.try_into().ok()?,
        });
    }
    let labels: HashSet<_> = out.iter().map(|c| &c.label).collect();
    let hashes: HashSet<_> = out.iter().map(|c| c.token_hash).collect();
    (labels.len() == out.len() && hashes.len() == out.len() && !out.is_empty()).then_some(out)
}

impl Config {
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self, Vec<&'static str>> {
        let mut invalid = Vec::new();
        let mut take = |name: &'static str, ok: bool| {
            if !ok {
                invalid.push(name);
            }
        };

        let node_env = get("NODE_ENV").unwrap_or_else(|| "development".into());
        take(
            "NODE_ENV",
            ["development", "test", "production"].contains(&node_env.as_str()),
        );
        let log_level = get("LOG_LEVEL").unwrap_or_else(|| "info".into());
        take(
            "LOG_LEVEL",
            ["fatal", "error", "warn", "info", "debug", "trace", "silent"]
                .contains(&log_level.as_str()),
        );
        let port = get("RUST_PORT")
            .unwrap_or_else(|| "3010".into())
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0);
        take("RUST_PORT", port.is_some());
        let database_url = get("DATABASE_URL").unwrap_or_default();
        take(
            "DATABASE_URL",
            database_url.starts_with("postgres://") || database_url.starts_with("postgresql://"),
        );
        let pool = get("DATABASE_POOL_SIZE")
            .unwrap_or_else(|| "10".into())
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=200).contains(n));
        take("DATABASE_POOL_SIZE", pool.is_some());
        let admin = get("ADMIN_CREDENTIALS")
            .as_deref()
            .and_then(parse_credentials);
        take("ADMIN_CREDENTIALS", admin.is_some());
        let poll = get("POLL_WORKER_CREDENTIALS")
            .as_deref()
            .and_then(parse_credentials);
        take("POLL_WORKER_CREDENTIALS", poll.is_some());
        let ttl = get("VOTING_SESSION_TTL_SECONDS")
            .unwrap_or_else(|| "300".into())
            .parse::<i64>()
            .ok()
            .filter(|t| (30..=3600).contains(t));
        take("VOTING_SESSION_TTL_SECONDS", ttl.is_some());
        let pepper = get("VOTER_ID_PEPPER")
            .filter(|v| {
                !v.is_empty()
                    && v.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            })
            .and_then(|v| crate::crypto::from_b64url(&v))
            .filter(|b| b.len() >= 32);
        take("VOTER_ID_PEPPER", pepper.is_some());
        let signer = get("SIGNING_PRIVATE_KEY")
            .as_deref()
            .and_then(Signer::from_pkcs8_b64url);
        take("SIGNING_PRIVATE_KEY", signer.is_some());
        let rate = get("RATE_LIMIT_PER_MINUTE")
            .unwrap_or_else(|| "300".into())
            .parse::<u32>()
            .ok()
            .filter(|r| *r <= 100_000);
        take("RATE_LIMIT_PER_MINUTE", rate.is_some());

        // Separação de funções: o mesmo token não pode valer como admin E como mesário.
        if let (Some(a), Some(p)) = (&admin, &poll) {
            take(
                "POLL_WORKER_CREDENTIALS",
                !p.iter()
                    .any(|c| a.iter().any(|x| x.token_hash == c.token_hash)),
            );
        }
        // Produção não aceita configurações de desenvolvimento.
        if node_env == "production" {
            let dev = admin
                .iter()
                .chain(poll.iter())
                .flatten()
                .any(|c| c.label.starts_with("dev-"));
            take("ADMIN_CREDENTIALS", !dev);
            take(
                "LOG_LEVEL",
                !["debug", "trace"].contains(&log_level.as_str()),
            );
            take("RATE_LIMIT_PER_MINUTE", rate != Some(0));
            let user = database_url
                .split("://")
                .nth(1)
                .and_then(|r| r.split([':', '@']).next())
                .unwrap_or("");
            take("DATABASE_URL", user == "urna_app");
        }

        invalid.dedup();
        if !invalid.is_empty() {
            return Err(invalid);
        }
        Ok(Self {
            production: node_env == "production",
            host: get("RUST_HOST").unwrap_or_else(|| "127.0.0.1".into()),
            port: port.unwrap_or_default(),
            log_level,
            database_url,
            database_pool_size: pool.unwrap_or_default(),
            admin_credentials: admin.unwrap_or_default(),
            poll_worker_credentials: poll.unwrap_or_default(),
            voting_session_ttl_seconds: ttl.unwrap_or_default(),
            voter_id_pepper: zeroize::Zeroizing::new(pepper.unwrap_or_default()),
            signer: signer.expect("validado acima"),
            rate_limit_per_minute: rate.unwrap_or_default(),
        })
    }
}
