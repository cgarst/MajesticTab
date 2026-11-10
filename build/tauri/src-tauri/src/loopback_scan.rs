//! Which ports on this computer have something listening.
//!
//! Backs the Backing tracks tool: the StemDeck desktop app asks for port 8000 and, when that one is taken, takes
//! whatever free port the OS hands out (49152 to 65535 on macOS and Windows, 32768 to 60999 on Linux), so its port
//! cannot be known in advance. A plain connect to each port on 127.0.0.1 answers "is anything there" in well under a
//! millisecond when nothing is (the connection is refused at once), which makes the whole range cheap to look at
//! from here; the page then asks each open port who it is. Desktop builds only, loopback only.

use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

/// Connects in flight at once. Kept low so the default file descriptor limit on macOS (256) is never in reach.
const IN_FLIGHT: usize = 96;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
/// The widest range one call will look at: the unprivileged ports.
const LOWEST_PORT: u16 = 1024;

pub async fn open_ports(from: u16, to: u16) -> Vec<u16> {
    let (from, to) = (from.max(LOWEST_PORT), to);
    if from > to {
        return Vec::new();
    }
    let permits = Arc::new(Semaphore::new(IN_FLIGHT));
    let mut tasks = Vec::with_capacity((to - from) as usize + 1);
    for port in from..=to {
        let permit = match permits.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };
        tasks.push(tokio::spawn(async move {
            let _permit = permit;
            match timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port))).await {
                Ok(Ok(_)) => Some(port),
                _ => None,
            }
        }));
    }
    let mut open = Vec::new();
    for task in tasks {
        if let Ok(Some(port)) = task.await {
            open.push(port);
        }
    }
    open
}

/// Ports in `from..=to` (never below 1024) that accept a connection on 127.0.0.1, lowest first.
#[tauri::command]
pub async fn loopback_open_ports(from: u16, to: u16) -> Result<Vec<u16>, String> {
    Ok(open_ports(from, to).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[tokio::test]
    async fn finds_a_listening_port_and_nothing_else_around_it() {
        let a = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = a.local_addr().unwrap().port();
        let found = open_ports(port.saturating_sub(40).max(LOWEST_PORT), port.saturating_add(40).min(65535)).await;
        assert!(found.contains(&port), "{found:?} should contain {port}");
        assert!(found.windows(2).all(|w| w[0] < w[1]), "lowest first");
    }

    #[tokio::test]
    async fn a_closed_port_is_not_reported() {
        let port = {
            let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(!open_ports(port, port).await.contains(&port));
    }

    #[tokio::test]
    async fn privileged_ports_and_empty_ranges_are_left_alone() {
        assert!(open_ports(80, 80).await.is_empty());
        assert!(open_ports(5000, 4000).await.is_empty());
    }

    #[tokio::test]
    async fn the_whole_unprivileged_range_is_looked_at_quickly() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let started = std::time::Instant::now();
        let found = open_ports(LOWEST_PORT, 65535).await;
        eprintln!("full range scan took {:?}, {} open", started.elapsed(), found.len());
        assert!(found.contains(&port));
        assert!(started.elapsed() < Duration::from_secs(20));
    }
}
