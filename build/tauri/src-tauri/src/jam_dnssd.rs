//! Jam Mode discovery on Apple platforms through the system Bonjour daemon (`dns_sd`).
//!
//! iOS blocks raw multicast sockets (which `mdns-sd` uses) unless the app holds Apple's
//! multicast entitlement. `dns_sd` goes through mDNSResponder instead and only needs
//! `NSLocalNetworkUsageDescription` plus the service type in `NSBonjourServices`. The same
//! code runs on macOS. All functions are in libSystem, so nothing extra is linked.

use super::DiscoveredHost;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;
use std::time::{Duration, Instant};

type DNSServiceRef = *mut c_void;

const K_DNS_SERVICE_FLAGS_ADD: u32 = 0x2;
const K_DNS_SERVICE_PROTOCOL_IPV4: u32 = 0x1;
const AF_INET: u8 = 2;
const POLLIN: i16 = 0x1;

type BrowseReply = extern "C" fn(DNSServiceRef, u32, u32, i32, *const c_char, *const c_char, *const c_char, *mut c_void);
type ResolveReply = extern "C" fn(DNSServiceRef, u32, u32, i32, *const c_char, *const c_char, u16, u16, *const u8, *mut c_void);
type AddrInfoReply = extern "C" fn(DNSServiceRef, u32, u32, i32, *const c_char, *const u8, u32, *mut c_void);

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: i16,
    revents: i16,
}

extern "C" {
    fn DNSServiceRegister(
        sd: *mut DNSServiceRef,
        flags: u32,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt_record: *const c_void,
        callback: *const c_void,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceBrowse(
        sd: *mut DNSServiceRef,
        flags: u32,
        interface_index: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: BrowseReply,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceResolve(
        sd: *mut DNSServiceRef,
        flags: u32,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: ResolveReply,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceGetAddrInfo(
        sd: *mut DNSServiceRef,
        flags: u32,
        interface_index: u32,
        protocol: u32,
        hostname: *const c_char,
        callback: AddrInfoReply,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceRefSockFD(sd: DNSServiceRef) -> c_int;
    fn DNSServiceProcessResult(sd: DNSServiceRef) -> i32;
    fn DNSServiceRefDeallocate(sd: DNSServiceRef);
    fn poll(fds: *mut PollFd, nfds: u32, timeout: c_int) -> c_int;
}

/// Bonjour wants the service type without the trailing `local.` domain.
fn regtype(service_type: &str) -> String {
    service_type.trim_end_matches("local.").trim_end_matches('.').to_string()
}

fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

/// Owns a DNSServiceRef; deallocating it ends the registration or query.
struct ServiceRef(DNSServiceRef);

// The ref is only used from one thread at a time (moved into the host handle).
unsafe impl Send for ServiceRef {}

impl Drop for ServiceRef {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { DNSServiceRefDeallocate(self.0) };
        }
    }
}

/// Process replies for `sd` until `done()` or the deadline passes.
fn pump(sd: DNSServiceRef, deadline: Instant, mut done: impl FnMut() -> bool) {
    let fd = unsafe { DNSServiceRefSockFD(sd) };
    if fd < 0 {
        return;
    }
    while !done() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut pfd = PollFd { fd, events: POLLIN, revents: 0 };
        let ready = unsafe { poll(&mut pfd, 1, remaining.as_millis().min(i32::MAX as u128) as c_int) };
        if ready <= 0 {
            break;
        }
        if unsafe { DNSServiceProcessResult(sd) } != 0 {
            break;
        }
    }
}

/// An active Bonjour advertisement; dropping it unregisters the service.
pub struct Advertisement {
    _sd: ServiceRef,
}

pub fn advertise(service_type: &str, name: &str, port: u16, has_pin: bool) -> Option<Advertisement> {
    let name = CString::new(name).ok()?;
    let regtype = CString::new(regtype(service_type)).ok()?;
    // TXT record: length-prefixed "key=value" strings.
    let entry = format!("pin={}", if has_pin { 1 } else { 0 });
    let mut txt = vec![entry.len() as u8];
    txt.extend_from_slice(entry.as_bytes());
    let mut sd: DNSServiceRef = ptr::null_mut();
    let err = unsafe {
        DNSServiceRegister(
            &mut sd,
            0,
            0,
            name.as_ptr(),
            regtype.as_ptr(),
            ptr::null(),
            ptr::null(),
            port.to_be(),
            txt.len() as u16,
            txt.as_ptr() as *const c_void,
            ptr::null(),
            ptr::null_mut(),
        )
    };
    if err != 0 || sd.is_null() {
        eprintln!("[Jam] DNSServiceRegister failed: {err}");
        return None;
    }
    Some(Advertisement { _sd: ServiceRef(sd) })
}

struct Found {
    name: String,
    regtype: String,
    domain: String,
    interface: u32,
}

extern "C" fn on_browse(
    _sd: DNSServiceRef,
    flags: u32,
    interface: u32,
    err: i32,
    name: *const c_char,
    regtype: *const c_char,
    domain: *const c_char,
    ctx: *mut c_void,
) {
    if err != 0 || flags & K_DNS_SERVICE_FLAGS_ADD == 0 {
        return;
    }
    let found = unsafe { &mut *(ctx as *mut Vec<Found>) };
    found.push(Found {
        name: cstr(name),
        regtype: cstr(regtype),
        domain: cstr(domain),
        interface,
    });
}

#[derive(Default)]
struct Resolved {
    host: Option<String>,
    port: u16,
}

extern "C" fn on_resolve(
    _sd: DNSServiceRef,
    _flags: u32,
    _interface: u32,
    err: i32,
    _fullname: *const c_char,
    host: *const c_char,
    port: u16,
    _txt_len: u16,
    _txt: *const u8,
    ctx: *mut c_void,
) {
    let out = unsafe { &mut *(ctx as *mut Resolved) };
    if err == 0 {
        out.host = Some(cstr(host));
        out.port = u16::from_be(port);
    }
}

extern "C" fn on_addr(
    _sd: DNSServiceRef,
    _flags: u32,
    _interface: u32,
    err: i32,
    _host: *const c_char,
    addr: *const u8,
    _ttl: u32,
    ctx: *mut c_void,
) {
    let out = unsafe { &mut *(ctx as *mut Option<String>) };
    if err != 0 || addr.is_null() || out.is_some() {
        return;
    }
    // struct sockaddr_in on Apple: sin_len, sin_family, sin_port[2], sin_addr[4]
    let bytes = unsafe { std::slice::from_raw_parts(addr, 8) };
    if bytes[1] == AF_INET {
        *out = Some(format!("{}.{}.{}.{}", bytes[4], bytes[5], bytes[6], bytes[7]));
    }
}

fn resolve(found: &Found, deadline: Instant) -> Option<DiscoveredHost> {
    let name = CString::new(found.name.as_str()).ok()?;
    let regtype = CString::new(found.regtype.as_str()).ok()?;
    let domain = CString::new(found.domain.as_str()).ok()?;
    let mut resolved = Resolved::default();
    let mut sd: DNSServiceRef = ptr::null_mut();
    let err = unsafe {
        DNSServiceResolve(
            &mut sd,
            0,
            found.interface,
            name.as_ptr(),
            regtype.as_ptr(),
            domain.as_ptr(),
            on_resolve,
            &mut resolved as *mut Resolved as *mut c_void,
        )
    };
    if err != 0 {
        return None;
    }
    let sd = ServiceRef(sd);
    pump(sd.0, deadline, || resolved.host.is_some());
    drop(sd);
    let host = CString::new(resolved.host?).ok()?;

    let mut ip: Option<String> = None;
    let mut sd: DNSServiceRef = ptr::null_mut();
    let err = unsafe {
        DNSServiceGetAddrInfo(
            &mut sd,
            0,
            found.interface,
            K_DNS_SERVICE_PROTOCOL_IPV4,
            host.as_ptr(),
            on_addr,
            &mut ip as *mut Option<String> as *mut c_void,
        )
    };
    if err != 0 {
        return None;
    }
    let sd = ServiceRef(sd);
    pump(sd.0, deadline, || ip.is_some());
    drop(sd);
    Some(DiscoveredHost {
        name: found.name.clone(),
        addr: ip?,
        port: resolved.port,
    })
}

/// Browse for `timeout`, then resolve each found service to an IPv4 address and port.
/// Blocking; call from a blocking task.
pub fn discover(service_type: &str, timeout: Duration) -> Result<Vec<DiscoveredHost>, String> {
    let regtype = CString::new(regtype(service_type)).map_err(|e| e.to_string())?;
    let mut found: Vec<Found> = Vec::new();
    let mut sd: DNSServiceRef = ptr::null_mut();
    let err = unsafe {
        DNSServiceBrowse(
            &mut sd,
            0,
            0,
            regtype.as_ptr(),
            ptr::null(),
            on_browse,
            &mut found as *mut Vec<Found> as *mut c_void,
        )
    };
    if err != 0 {
        // -65570 (kDNSServiceErr_PolicyDenied) means the local network permission was refused.
        return Err(format!("Bonjour browse failed ({err})"));
    }
    let browse = ServiceRef(sd);
    pump(browse.0, Instant::now() + timeout, || false);
    drop(browse);

    // The same service is reported once per interface; resolve each name once.
    let mut by_name: HashMap<String, DiscoveredHost> = HashMap::new();
    for f in &found {
        if by_name.contains_key(&f.name) {
            continue;
        }
        if let Some(host) = resolve(f, Instant::now() + Duration::from_millis(1500)) {
            by_name.insert(f.name.clone(), host);
        }
    }
    Ok(by_name.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertises_and_discovers_through_bonjour() {
        let service = "_majestictab-jam._tcp.local.";
        let name = format!("Jam Test {}", std::process::id());
        let _ad = advertise(service, &name, 47999, false).expect("register");
        let hosts = discover(service, Duration::from_millis(1500)).expect("browse");
        let me = hosts.iter().find(|h| h.name == name).expect("own service found");
        assert_eq!(me.port, 47999);
        assert!(me.addr.parse::<std::net::Ipv4Addr>().is_ok(), "addr {}", me.addr);
    }
}
