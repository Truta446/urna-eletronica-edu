use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

/// Agora, truncado em milissegundos: o banco guarda timestamptz(3) e o hash da auditoria
/// inclui o horário. Com microssegundos, o valor gravado e o valor assinado divergiriam.
pub fn now_ms() -> OffsetDateTime {
    truncate_ms(OffsetDateTime::now_utc())
}

pub fn truncate_ms(t: OffsetDateTime) -> OffsetDateTime {
    let ms = t.millisecond();
    t.replace_nanosecond(u32::from(ms) * 1_000_000).unwrap_or(t)
}

/// Mesmo formato de Date.prototype.toISOString(): 2030-01-01T12:00:00.123Z
pub fn iso(t: OffsetDateTime) -> String {
    let t = t.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

/// Data ISO 8601 COM fuso explícito; sem fuso é ambíguo e rejeitado.
pub fn parse_iso_with_offset(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok().map(truncate_ms)
}
