//! Compatibilidade byte a byte com a implementação TypeScript: os valores esperados vêm de
//! tests/fixtures/crypto.json, gerado por `npm run rust:fixtures` A PARTIR DO CÓDIGO TS.
use serde_json::Value;
use urna_server::crypto::{self, ballot, hpke_ballot, merkle, shamir, signing, tokens, voter_id};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/crypto.json")).expect("fixtures válidas")
}

fn s<'a>(v: &'a Value, path: &str) -> &'a str {
    v.pointer(path)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("fixture {path}"))
}

#[test]
fn token_hash_and_nullifier() {
    let f = fixtures();
    let token = s(&f, "/token");
    assert_eq!(hex::encode(tokens::hash_token(token)), s(&f, "/tokenHash"));
    assert_eq!(
        hex::encode(ballot::nullifier_for(token)),
        s(&f, "/nullifier")
    );
}

#[test]
fn idempotency_keys() {
    let f = fixtures();
    let token = s(&f, "/token");
    let e = s(&f, "/electionId");
    assert_eq!(
        hex::encode(ballot::idempotency_scope_key(token, "key-0123456789abcdef")),
        s(&f, "/idempotencyScope")
    );
    assert_eq!(
        hex::encode(ballot::request_fingerprint(
            token,
            &format!("{e}|candidate:13")
        )),
        s(&f, "/fingerprints/candidate")
    );
    assert_eq!(
        hex::encode(ballot::request_fingerprint(token, &format!("{e}|blank"))),
        s(&f, "/fingerprints/blank")
    );
    assert_eq!(
        hex::encode(ballot::request_fingerprint(token, &format!("{e}|null"))),
        s(&f, "/fingerprints/null")
    );
}

#[test]
fn commitments() {
    let f = fixtures();
    let (b, e, c) = (
        s(&f, "/ballotId"),
        s(&f, "/electionId"),
        s(&f, "/candidateId"),
    );
    assert_eq!(
        hex::encode(ballot::ballot_commitment(b, e, "CANDIDATE", Some(c))),
        s(&f, "/commitmentV1")
    );
    assert_eq!(
        hex::encode(ballot::ballot_commitment(b, e, "BLANK", None)),
        s(&f, "/commitmentV1Blank")
    );
    let enc = crypto::from_b64url(s(&f, "/hpke/encapsulatedKey")).unwrap();
    let ct = crypto::from_b64url(s(&f, "/hpke/ciphertext")).unwrap();
    assert_eq!(
        hex::encode(ballot::encrypted_ballot_commitment(b, e, &enc, &ct)),
        s(&f, "/commitmentV2")
    );
}

#[test]
fn voter_identifier_hmac_and_cpf() {
    let f = fixtures();
    let pepper = crypto::from_b64url(s(&f, "/voterHmac/pepper")).unwrap();
    let got =
        voter_id::voter_identifier_hmac(&pepper, s(&f, "/electionId"), s(&f, "/voterHmac/cpf"));
    assert_eq!(hex::encode(got), s(&f, "/voterHmac/hmac"));
    assert_eq!(
        voter_id::normalize_cpf("529.982.247-25").as_deref(),
        Some("52998224725")
    );
    assert_eq!(
        voter_id::normalize_cpf("52998224725").as_deref(),
        Some("52998224725")
    );
    for bad in [
        "529.982.247-24",
        "111.111.111-11",
        "529982247-25",
        "5299822472",
        " 529.982.247-25",
        "",
    ] {
        assert_eq!(voter_id::normalize_cpf(bad), None, "{bad}");
    }
}

#[test]
fn merkle_ct_vectors() {
    let f = fixtures();
    let leaves: Vec<Vec<u8>> = f["merkle"]["leaves"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| hex::decode(l.as_str().unwrap()).unwrap())
        .collect();
    for (n, root) in f["merkle"]["roots"].as_array().unwrap().iter().enumerate() {
        let refs: Vec<&[u8]> = leaves[..n].iter().map(Vec::as_slice).collect();
        assert_eq!(
            hex::encode(merkle::merkle_root(&refs)),
            root.as_str().unwrap(),
            "{n} folhas"
        );
    }
}

#[test]
fn canonical_json() {
    let f = fixtures();
    assert_eq!(crypto::canonical(&f["jcs"]["value"]), s(&f, "/jcs/text"));
}

#[test]
fn ed25519_is_deterministic_and_interoperable() {
    let f = fixtures();
    let signer = signing::Signer::from_pkcs8_b64url(s(&f, "/signing/privateKeyPkcs8"))
        .expect("chave PKCS#8 do Node");
    assert_eq!(signer.public_key, s(&f, "/signing/publicKeySpki"));
    assert_eq!(signer.key_id, s(&f, "/signing/keyId"));
    // Ed25519 é determinística: mesma chave e mesma mensagem => mesma assinatura do Node.
    assert_eq!(
        signer.sign(s(&f, "/signing/statement")),
        s(&f, "/signing/signature")
    );
    assert!(signing::verify_signature(
        s(&f, "/signing/publicKeySpki"),
        s(&f, "/signing/statement"),
        s(&f, "/signing/signature")
    ));
    assert!(!signing::verify_signature(
        s(&f, "/signing/publicKeySpki"),
        "outra coisa",
        s(&f, "/signing/signature")
    ));
}

#[test]
fn shamir_combines_shares_from_the_typescript_library() {
    let f = fixtures();
    let shares: Vec<Vec<u8>> = f["shamir"]["shares"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| crypto::from_b64url(s.as_str().unwrap()).unwrap())
        .collect();
    let secret = s(&f, "/shamir/secret");
    for subset in [[0, 1, 2], [0, 2, 4], [1, 3, 4], [2, 3, 4]] {
        let picked: Vec<Vec<u8>> = subset.iter().map(|i| shares[*i].clone()).collect();
        assert_eq!(hex::encode(shamir::combine(&picked).unwrap()), secret);
    }
    // Abaixo do limiar: valor errado, não erro (igual à biblioteca original).
    assert_ne!(hex::encode(shamir::combine(&shares[..2]).unwrap()), secret);
    assert_eq!(
        shamir::combine(&shares[..1]),
        Err(shamir::CombineError::Count)
    );
    assert_eq!(
        shamir::combine(&[shares[0].clone(), shares[0].clone()]),
        Err(shamir::CombineError::Duplicate)
    );
}

#[test]
fn hpke_decrypts_typescript_ciphertext_and_round_trips() {
    let f = fixtures();
    let (e, b) = (s(&f, "/electionId"), s(&f, "/ballotId"));
    let sk = crypto::from_b64url(s(&f, "/hpke/privateKey")).unwrap();
    let pk = crypto::from_b64url(s(&f, "/hpke/publicKey")).unwrap();
    let enc = crypto::from_b64url(s(&f, "/hpke/encapsulatedKey")).unwrap();
    let ct = crypto::from_b64url(s(&f, "/hpke/ciphertext")).unwrap();
    let candidate = uuid::Uuid::parse_str(s(&f, "/candidateId")).unwrap();

    assert_eq!(
        hpke_ballot::decrypt_choice(&sk, e, b, &enc, &ct),
        Some(hpke_ballot::PlainChoice::Candidate(candidate))
    );
    assert_eq!(
        hex::encode(hpke_ballot::encode_choice(
            &hpke_ballot::PlainChoice::Candidate(candidate)
        )),
        s(&f, "/encodedChoice")
    );
    // AAD amarra ao voto e à eleição.
    assert_eq!(
        hpke_ballot::decrypt_choice(&sk, e, "outro-voto", &enc, &ct),
        None
    );
    assert!(hpke_ballot::key_pair_matches(&pk, &sk));

    let (enc2, ct2) =
        hpke_ballot::encrypt_choice(&pk, e, b, &hpke_ballot::PlainChoice::Blank).unwrap();
    assert_eq!((enc2.len(), ct2.len()), (32, 33));
    assert_eq!(
        hpke_ballot::decrypt_choice(&sk, e, b, &enc2, &ct2),
        Some(hpke_ballot::PlainChoice::Blank)
    );
}
