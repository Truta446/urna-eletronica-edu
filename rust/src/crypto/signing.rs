//! Ed25519: lacre, resultado e eventos de habilitação. Chave em PKCS#8 DER (base64url).
use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePublicKey};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};

pub struct Signer {
    key: SigningKey,
    /// Chave pública em SPKI DER, base64url.
    pub public_key: String,
    /// Primeiros 8 bytes (hex) do SHA-256 da chave pública SPKI.
    pub key_id: String,
}

impl Signer {
    pub fn from_pkcs8_b64url(value: &str) -> Option<Self> {
        let der = zeroize::Zeroizing::new(super::from_b64url(value)?);
        let key = SigningKey::from_pkcs8_der(&der).ok()?;
        let spki = key.verifying_key().to_public_key_der().ok()?;
        Some(Self {
            key_id: hex::encode(&super::sha256(spki.as_bytes())[..8]),
            public_key: super::b64url(spki.as_bytes()),
            key,
        })
    }

    pub fn sign(&self, statement: &str) -> String {
        super::b64url(&self.key.sign(statement.as_bytes()).to_bytes())
    }
}

pub fn verify_signature(public_key_spki: &str, statement: &str, signature: &str) -> bool {
    let (Some(der), Some(sig)) = (
        super::from_b64url(public_key_spki),
        super::from_b64url(signature),
    ) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_public_key_der(&der) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig) else {
        return false;
    };
    key.verify_strict(statement.as_bytes(), &sig).is_ok()
}
