//! Voto cifrado (v2): HPKE RFC 9180, modo Base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
//! AES-256-GCM. info = "urna-edu/ballot/v2"; AAD = eleição + id do voto. Escolha em 17 bytes fixos.
use hpke::aead::AesGcm256;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, OpModeR, OpModeS, Serializable};
use uuid::Uuid;

type Kem = X25519HkdfSha256;
const INFO: &[u8] = b"urna-edu/ballot/v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlainChoice {
    Candidate(Uuid),
    Blank,
    NullVote,
}

pub fn encode_choice(choice: &PlainChoice) -> [u8; 17] {
    let mut out = [0u8; 17];
    match choice {
        PlainChoice::Candidate(id) => {
            out[0] = 1;
            out[1..].copy_from_slice(id.as_bytes());
        }
        PlainChoice::Blank => out[0] = 2,
        PlainChoice::NullVote => out[0] = 3,
    }
    out
}

pub fn decode_choice(bytes: &[u8]) -> Option<PlainChoice> {
    let (kind, rest) = bytes.split_first()?;
    if rest.len() != 16 {
        return None;
    }
    let zero = rest.iter().all(|b| *b == 0);
    match (kind, zero) {
        (1, false) => Some(PlainChoice::Candidate(Uuid::from_slice(rest).ok()?)),
        (2, true) => Some(PlainChoice::Blank),
        (3, true) => Some(PlainChoice::NullVote),
        _ => None,
    }
}

fn aad(election_id: &str, ballot_id: &str) -> Vec<u8> {
    format!("urna-edu/ballot/v2|{election_id}|{ballot_id}").into_bytes()
}

pub fn is_valid_public_key(bytes: &[u8]) -> bool {
    bytes.len() == 32 && <Kem as hpke::Kem>::PublicKey::from_bytes(bytes).is_ok()
}

/// Devolve (chave encapsulada, texto cifrado).
pub fn encrypt_choice(
    public_key: &[u8],
    election_id: &str,
    ballot_id: &str,
    choice: &PlainChoice,
) -> Option<(Vec<u8>, Vec<u8>)> {
    let pk = <Kem as hpke::Kem>::PublicKey::from_bytes(public_key).ok()?;
    let (enc, ct) = hpke::single_shot_seal::<AesGcm256, HkdfSha256, Kem>(
        &OpModeS::Base,
        &pk,
        INFO,
        &encode_choice(choice),
        &aad(election_id, ballot_id),
    )
    .ok()?;
    Some((enc.to_bytes().to_vec(), ct))
}

pub fn decrypt_choice(
    private_key: &[u8],
    election_id: &str,
    ballot_id: &str,
    enc: &[u8],
    ct: &[u8],
) -> Option<PlainChoice> {
    let sk = <Kem as hpke::Kem>::PrivateKey::from_bytes(private_key).ok()?;
    let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(enc).ok()?;
    let plaintext = hpke::single_shot_open::<AesGcm256, HkdfSha256, Kem>(
        &OpModeR::Base,
        &sk,
        &enc,
        INFO,
        ct,
        &aad(election_id, ballot_id),
    )
    .ok()?;
    decode_choice(&plaintext)
}

/// Confere que a chave privada (ex.: reconstruída das partes) corresponde à pública,
/// cifrando e decifrando um valor aleatório. Com partes insuficientes, o Shamir devolve lixo.
pub fn key_pair_matches(public_key: &[u8], private_key: &[u8]) -> bool {
    let Ok(pk) = <Kem as hpke::Kem>::PublicKey::from_bytes(public_key) else {
        return false;
    };
    let Ok(sk) = <Kem as hpke::Kem>::PrivateKey::from_bytes(private_key) else {
        return false;
    };
    let probe = super::random_bytes::<16>();
    let Ok((enc, ct)) = hpke::single_shot_seal::<AesGcm256, HkdfSha256, Kem>(
        &OpModeS::Base,
        &pk,
        INFO,
        &probe,
        b"",
    ) else {
        return false;
    };
    hpke::single_shot_open::<AesGcm256, HkdfSha256, Kem>(&OpModeR::Base, &sk, &enc, INFO, &ct, b"")
        .is_ok_and(|opened| opened == probe)
}
