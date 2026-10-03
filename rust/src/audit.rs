//! Auditoria em hash chain, compatível com a versão TS: formato 1 (cadeia global legada) e
//! formato 2 (uma cadeia por eleição). eventHash = SHA-256(JCS(evento) ‖ previousHash).
use crate::crypto::canonical;
use crate::error::AppResult;
use crate::time_util::iso;
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

pub const GLOBAL_CHAIN: &str = "global";
const GENESIS: [u8; 32] = [0; 32];

pub struct EventData<'a> {
    pub format: i16,
    pub chain_key: &'a str,
    pub seq: i32,
    pub event_type: &'a str,
    pub actor_type: &'a str,
    pub actor_identifier: &'a str,
    pub election_id: Option<Uuid>,
    pub payload: &'a Value,
    pub created_at: OffsetDateTime,
}

pub fn canonical_event(e: &EventData) -> String {
    let mut value = json!({
        "seq": e.seq,
        "eventType": e.event_type,
        "actorType": e.actor_type,
        "actorIdentifier": e.actor_identifier,
        "electionId": e.election_id.map(|id| id.to_string()),
        "payload": e.payload,
        "createdAt": iso(e.created_at),
    });
    // O formato 1 é exatamente o que era assinado antes; o 2 amarra o evento à cadeia.
    if e.format == 2 {
        value["format"] = json!(2);
        value["chainKey"] = json!(e.chain_key);
    }
    canonical(&value)
}

pub fn event_hash(e: &EventData, previous: &[u8]) -> [u8; 32] {
    let mut h = sha2::Sha256::new();
    h.update(canonical_event(e).as_bytes());
    h.update(previous);
    h.finalize().into()
}

/// Eleição com eventos na cadeia global (anterior à migração) continua nela; as demais usam a própria.
pub async fn chain_for(
    conn: &mut PgConnection,
    election_id: Option<Uuid>,
) -> AppResult<(String, i16)> {
    let Some(id) = election_id else {
        return Ok((GLOBAL_CHAIN.into(), 1));
    };
    let legacy: Option<(i32,)> = sqlx::query_as(
        "SELECT id FROM audit_events WHERE chain_key = 'global' AND election_id = $1 LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(if legacy.is_some() {
        (GLOBAL_CHAIN.into(), 1)
    } else {
        (id.to_string(), 2)
    })
}

pub struct Head {
    pub seq: i32,
    pub hash: String,
}

/// Anexa um evento DENTRO da transação da operação, com advisory lock POR CADEIA.
/// Regra contra deadlock: este é sempre o último lock que a transação adquire.
pub async fn append(
    conn: &mut PgConnection,
    event_type: &str,
    actor: (&str, &str),
    election_id: Option<Uuid>,
    payload: Value,
    now: OffsetDateTime,
) -> AppResult<Head> {
    let (chain_key, format) = chain_for(conn, election_id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&chain_key)
        .execute(&mut *conn)
        .await?;
    let last: Option<(i32, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, event_hash FROM audit_events WHERE chain_key = $1 ORDER BY seq DESC LIMIT 1",
    )
    .bind(&chain_key)
    .fetch_optional(&mut *conn)
    .await?;
    let (seq, previous) = last.map_or((1, GENESIS.to_vec()), |(s, h)| (s + 1, h));
    let data = EventData {
        format,
        chain_key: &chain_key,
        seq,
        event_type,
        actor_type: actor.0,
        actor_identifier: actor.1,
        election_id,
        payload: &payload,
        created_at: now,
    };
    let hash = event_hash(&data, &previous);
    sqlx::query(
        "INSERT INTO audit_events (chain_key, seq, format, event_type, actor_type, actor_identifier,
                                   election_id, payload, previous_hash, event_hash, created_at)
         VALUES ($1, $2, $3, $4::audit_event_type, $5::audit_actor_type, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&chain_key)
    .bind(seq)
    .bind(format)
    .bind(event_type)
    .bind(actor.0)
    .bind(actor.1)
    .bind(election_id)
    .bind(&payload)
    .bind(&previous)
    .bind(hash.as_slice())
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(Head {
        seq,
        hash: hex::encode(hash),
    })
}

#[derive(sqlx::FromRow)]
pub struct EventRow {
    pub id: i32,
    pub chain_key: String,
    pub seq: i32,
    pub format: i16,
    pub event_type: String,
    pub actor_type: String,
    pub actor_identifier: String,
    pub election_id: Option<Uuid>,
    pub payload: Value,
    pub previous_hash: Vec<u8>,
    pub event_hash: Vec<u8>,
    pub created_at: OffsetDateTime,
}

#[macro_export]
macro_rules! event_columns {
    () => {
        "id, chain_key, seq, format, event_type::text AS event_type, actor_type::text AS actor_type, \
         actor_identifier, election_id, payload, previous_hash, event_hash, created_at"
    };
}

impl EventRow {
    fn data(&self) -> EventData<'_> {
        EventData {
            format: self.format,
            chain_key: &self.chain_key,
            seq: self.seq,
            event_type: &self.event_type,
            actor_type: &self.actor_type,
            actor_identifier: &self.actor_identifier,
            election_id: self.election_id,
            payload: &self.payload,
            created_at: self.created_at,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "chainKey": self.chain_key,
            "seq": self.seq,
            "format": self.format,
            "eventType": self.event_type,
            "actorType": self.actor_type,
            "actorIdentifier": self.actor_identifier,
            "electionId": self.election_id,
            "payload": self.payload,
            "createdAt": iso(self.created_at),
            "previousHash": hex::encode(&self.previous_hash),
            "eventHash": hex::encode(&self.event_hash),
        })
    }
}

pub struct Anchor {
    pub seq: i32,
    pub hash: String,
}

/// Verifica UMA cadeia em páginas. Mesmo resultado (e mesmos motivos) da versão TS.
pub async fn verify_chain(
    pool: &sqlx::PgPool,
    chain_key: &str,
    anchor: Option<&Anchor>,
) -> AppResult<Value> {
    let mut expected = 1;
    let mut previous = GENESIS.to_vec();
    let mut head: Option<(i32, String)> = None;
    let mut anchor_seen = false;
    let fail = |seq: i32, reason: &str, count: i32| json!({ "valid": false, "eventCount": count, "failure": { "seq": seq, "reason": reason } });
    loop {
        let page: Vec<EventRow> = sqlx::query_as(concat!(
            "SELECT ",
            event_columns!(),
            " FROM audit_events WHERE chain_key = $1 AND seq >= $2 ORDER BY seq LIMIT 1000"
        ))
        .bind(chain_key)
        .bind(expected)
        .fetch_all(pool)
        .await?;
        for row in &page {
            if chain_key != GLOBAL_CHAIN && row.seq == 1 && row.event_type != "ELECTION_CREATED" {
                return Ok(fail(1, "CHAIN_HEAD_MISMATCH", 0));
            }
            if row.seq != expected {
                return Ok(fail(row.seq, "SEQUENCE_GAP", expected - 1));
            }
            if row.previous_hash != previous {
                return Ok(fail(row.seq, "BROKEN_LINK", expected - 1));
            }
            let recomputed = event_hash(&row.data(), &row.previous_hash);
            if recomputed.as_slice() != row.event_hash.as_slice() {
                return Ok(fail(row.seq, "HASH_MISMATCH", expected - 1));
            }
            let hex_hash = hex::encode(recomputed);
            if let Some(a) = anchor.filter(|a| a.seq == row.seq) {
                anchor_seen = true;
                if a.hash != hex_hash {
                    return Ok(fail(row.seq, "ANCHOR_MISMATCH", expected - 1));
                }
            }
            head = Some((row.seq, hex_hash));
            previous = recomputed.to_vec();
            expected += 1;
        }
        if page.len() < 1000 {
            break;
        }
    }
    if let Some(a) = anchor.filter(|_| !anchor_seen) {
        return Ok(fail(a.seq, "ANCHOR_NOT_FOUND", expected - 1));
    }
    Ok(json!({
        "valid": true,
        "eventCount": expected - 1,
        "head": head.map(|(seq, hash)| json!({ "seq": seq, "hash": hash })),
    }))
}

/// Todas as cadeias + completude (toda eleição precisa do próprio ELECTION_CREATED).
pub async fn verify_all(pool: &sqlx::PgPool) -> AppResult<Value> {
    let chains: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT chain_key FROM audit_events ORDER BY chain_key")
            .fetch_all(pool)
            .await?;
    let mut count = 0;
    for (chain,) in &chains {
        let result = verify_chain(pool, chain, None).await?;
        count += result["eventCount"].as_i64().unwrap_or(0);
        if result["valid"] == json!(false) {
            let mut failure = result["failure"].clone();
            failure["chain"] = json!(chain);
            return Ok(
                json!({ "valid": false, "eventCount": count, "chains": chains.len(), "failure": failure }),
            );
        }
    }
    let orphan: Option<(Uuid,)> = sqlx::query_as(
        "SELECT e.id FROM elections e
          WHERE NOT e.created_before_audit
            AND NOT EXISTS (SELECT 1 FROM audit_events a
                             WHERE a.election_id = e.id AND a.event_type = 'ELECTION_CREATED')
          LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if let Some((id,)) = orphan {
        return Ok(json!({
            "valid": false, "eventCount": count, "chains": chains.len(),
            "failure": { "chain": id, "seq": 1, "reason": "ELECTION_WITHOUT_AUDIT" },
        }));
    }
    Ok(json!({ "valid": true, "eventCount": count, "chains": chains.len() }))
}

pub async fn chain_key_for(pool: &sqlx::PgPool, election_id: Uuid) -> AppResult<String> {
    let mut conn = pool.acquire().await?;
    Ok(chain_for(&mut conn, Some(election_id)).await?.0)
}
