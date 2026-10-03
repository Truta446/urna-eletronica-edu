//! Limite de requisições por IP, janela fixa de 1 minuto, em memória (uma instância).
//! Os IPs ficam só na memória durante a janela; nunca vão para os logs.
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    max: u32,
    windows: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(max_per_minute: u32) -> Self {
        Self {
            max: max_per_minute,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// true = pode seguir.
    pub fn check(&self, ip: IpAddr) -> bool {
        if self.max == 0 {
            return true;
        }
        let now = Instant::now();
        let window = Duration::from_secs(60);
        let mut map = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map.len() > 10_000 {
            map.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = map.entry(ip).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}
