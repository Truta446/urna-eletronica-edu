use super::{b64url, random_bytes, sha256};

/// 32 bytes = 256 bits; em base64url, sempre 43 caracteres.
pub fn generate_token() -> String {
    b64url(&random_bytes::<32>())
}

pub fn is_token_format(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// SHA-256 do token (como string UTF-8, igual ao TS).
pub fn hash_token(token: &str) -> [u8; 32] {
    sha256(token.as_bytes())
}
