use hkdf::Hkdf;
use sha2::Sha256;

const INFO: &[u8] = b"urna-edu/voter-identifier/v1";

/// HMAC-SHA256 com chave derivada POR ELEIÇÃO: HKDF(pepper, salt = id da eleição).
pub fn voter_identifier_hmac(pepper: &[u8], election_id: &str, normalized: &str) -> [u8; 32] {
    let mut key = zeroize::Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(election_id.as_bytes()), pepper)
        .expand(INFO, key.as_mut())
        .expect("32 bytes é um tamanho válido para HKDF-SHA256");
    super::hmac_parts(key.as_ref(), &[normalized])
}

/// Aceita "529.982.247-25" ou "52998224725"; devolve só dígitos se os verificadores conferem.
pub fn normalize_cpf(input: &str) -> Option<String> {
    let b = input.as_bytes();
    let formatted = b.len() == 14
        && b.iter().enumerate().all(|(i, c)| match i {
            3 | 7 => *c == b'.',
            11 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    let plain = b.len() == 11 && b.iter().all(u8::is_ascii_digit);
    if !formatted && !plain {
        return None;
    }
    let digits: Vec<u32> = input
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|c| u32::from(c - b'0'))
        .collect();
    if digits.iter().all(|d| *d == digits[0]) {
        return None;
    }
    let check = |slice: &[u32]| {
        let weight = slice.len() as u32 + 1;
        let sum: u32 = slice
            .iter()
            .enumerate()
            .map(|(i, d)| d * (weight - i as u32))
            .sum();
        let rest = (sum * 10) % 11;
        if rest == 10 { 0 } else { rest }
    };
    (digits[9] == check(&digits[..9]) && digits[10] == check(&digits[..10])).then(|| {
        digits
            .iter()
            .map(|d| char::from_digit(*d, 10).unwrap_or('0'))
            .collect()
    })
}
