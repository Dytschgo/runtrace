//! Exact Host admission for a loopback service behind a trusted local TLS proxy.
use anyhow::{Result, ensure};
use axum::http::{HeaderMap, header, uri::Authority};
use std::collections::HashSet;
use t3ui_core::config::Server;

pub struct HostPolicy {
    authorities: HashSet<String>,
}

impl HostPolicy {
    pub fn new(server: &Server) -> Result<Self> {
        let mut authorities: HashSet<_> = ["127.0.0.1", "localhost", "[::1]"]
            .into_iter()
            .map(|host| format!("{host}:{}", server.port))
            .collect();
        if server.port == 80 {
            authorities.extend(["127.0.0.1", "localhost", "[::1]"].map(str::to_owned));
        }
        for host in &server.allowed_hosts {
            ensure!(
                !host.contains(['*', '@', '/', '\\', '?', '#'])
                    && !host.chars().any(char::is_whitespace)
                    && host.parse::<Authority>().is_ok(),
                "server.allowed_hosts entries must be exact hosts with an optional port, without a scheme or wildcard"
            );
            authorities.insert(host.to_ascii_lowercase());
        }
        Ok(Self { authorities })
    }

    pub fn check(&self, headers: &HeaderMap) -> Result<(), &'static str> {
        let mut hosts = headers.get_all(header::HOST).iter();
        let host = hosts
            .next()
            .and_then(|h| h.to_str().ok())
            .ok_or("invalid_host")?;
        if hosts.next().is_some() || !self.authorities.contains(&host.to_ascii_lowercase()) {
            return Err("invalid_host");
        }
        // TLS ends at the local proxy. Origin must still name this admitted
        // authority; forwarded headers never grant admission.
        let mut origins = headers.get_all(header::ORIGIN).iter();
        if let Some(origin) = origins.next() {
            let origin = origin.to_str().map_err(|_| "cross_origin_denied")?;
            if origins.next().is_some()
                || !(origin.eq_ignore_ascii_case(&format!("http://{host}"))
                    || origin.eq_ignore_ascii_case(&format!("https://{host}")))
            {
                return Err("cross_origin_denied");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Server {
        Server {
            host: "127.0.0.1".into(),
            port: 4399,
            allowed_hosts: vec![],
        }
    }
    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, host.parse().unwrap());
        if let Some(origin) = origin {
            h.insert(header::ORIGIN, origin.parse().unwrap());
        }
        h
    }
    #[test]
    fn defaults_admit_only_exact_loopback_authorities() {
        let policy = HostPolicy::new(&server()).unwrap();
        for host in ["127.0.0.1:4399", "localhost:4399", "[::1]:4399"] {
            assert!(policy.check(&headers(host, None)).is_ok());
        }
        for host in [
            "dashboard.example.test:12443",
            "localhost:80",
            "localhost:4399.attacker.test",
            "127.0.0.1:4399@attacker.test",
            "",
        ] {
            assert!(policy.check(&headers(host, None)).is_err());
        }
        assert!(policy.check(&HeaderMap::new()).is_err());
    }
    #[test]
    fn opt_in_admits_tls_proxy_and_rejects_other_hosts_and_origins() {
        let mut server = server();
        server.allowed_hosts = vec!["dashboard.example.test:12443".into()];
        let policy = HostPolicy::new(&server).unwrap();
        assert!(
            policy
                .check(&headers(
                    "dashboard.example.test:12443",
                    Some("https://dashboard.example.test:12443")
                ))
                .is_ok()
        );
        assert!(
            policy
                .check(&headers("DASHBOARD.EXAMPLE.TEST:12443", None))
                .is_ok()
        );
        assert!(
            policy
                .check(&headers(
                    "dashboard.example.test:12443",
                    Some("https://attacker.test")
                ))
                .is_err()
        );
        assert!(
            policy
                .check(&headers("dashboard.example.test:12444", None))
                .is_err()
        );
        let mut spoof = headers("attacker.test", None);
        spoof.insert(
            "x-forwarded-host",
            "dashboard.example.test:12443".parse().unwrap(),
        );
        assert!(policy.check(&spoof).is_err());
        let mut duplicate = headers("localhost:4399", None);
        duplicate.append(header::HOST, "attacker.test".parse().unwrap());
        assert!(policy.check(&duplicate).is_err());
        for host in [
            "*",
            "https://dashboard.example.test",
            "user@dashboard.example.test",
            "dashboard.example.test/path",
        ] {
            server.allowed_hosts = vec![host.into()];
            assert!(HostPolicy::new(&server).is_err());
        }
    }
}
