//! Jam Mode discovery on Android, Windows and Linux via `mdns-sd` (its own multicast sockets).
//! Apple platforms use the system Bonjour daemon instead (`jam_dnssd.rs`).

use super::DiscoveredHost;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// An active advertisement; dropping it unregisters the service and stops the daemon.
pub struct Advertisement {
    daemon: mdns_sd::ServiceDaemon,
    fullname: String,
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

pub fn advertise(service_type: &str, name: &str, port: u16, has_pin: bool, addresses: &[String]) -> Option<Advertisement> {
    let daemon = mdns_sd::ServiceDaemon::new().ok()?;
    let ips: Vec<std::net::IpAddr> = addresses.iter().filter_map(|a| a.parse().ok()).collect();
    if ips.is_empty() {
        let _ = daemon.shutdown();
        return None;
    }
    let host_label = format!("majestictab-{port}.local.");
    let props = [("pin", if has_pin { "1" } else { "0" })];
    let info = mdns_sd::ServiceInfo::new(service_type, name, &host_label, &ips[..], port, &props[..]).ok()?;
    let fullname = info.get_fullname().to_string();
    daemon.register(info).ok()?;
    Some(Advertisement { daemon, fullname })
}

/// Blocking; call from a blocking task.
pub fn discover(service_type: &str, timeout: Duration) -> Result<Vec<DiscoveredHost>, String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(service_type).map_err(|e| e.to_string())?;
    let mut found: HashMap<String, DiscoveredHost> = HashMap::new();
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                if let Some(ip) = info.get_addresses_v4().iter().next() {
                    let fullname = info.get_fullname().to_string();
                    let label = fullname
                        .strip_suffix(&format!(".{service_type}"))
                        .unwrap_or(&fullname)
                        .to_string();
                    found.insert(fullname, DiscoveredHost { name: label, addr: ip.to_string(), port: info.get_port() });
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}
