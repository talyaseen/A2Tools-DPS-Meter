//! Permission-scoped HTTPS for plugins. The iframe keeps connect-src 'none':
//! requests cross the same authenticated host boundary as other plugin APIs.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::IpAddr;

pub(super) fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a,b,c,_] = ip.octets();
            !(a == 0 || a == 10 || a == 127 || a >= 224 ||
              (a == 100 && (64..128).contains(&b)) ||
              (a == 169 && b == 254) || (a == 172 && (16..32).contains(&b)) ||
              (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99))) ||
              (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
              (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000 &&
            !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8)) &&
            s[0] != 0x2002 && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

const MAX_REQUEST: usize = 65_536;
const MAX_TOKEN: usize = 4096;

fn default_method() -> String { "GET".into() }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    json: Option<String>,
    #[serde(default)]
    bearer: Option<String>,
}

struct Checked {
    url: tauri::Url,
    permission: String,
    method: String,
    body: Option<Vec<u8>>,
    bearer: Option<String>,
}

fn https_url(raw: &str) -> Result<tauri::Url, String> {
    if raw.len() > 4096 { return Err("HTTPS URL is too long".into()); }
    let url = tauri::Url::parse(raw).map_err(|_| "invalid HTTPS URL")?;
    if url.scheme() != "https" || url.host_str().is_none_or(|host| host.contains('*')) || url.port_or_known_default() != Some(443) ||
       !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("only HTTPS URLs on port 443 without user information or fragments are allowed".into());
    }
    Ok(url)
}

/// Origins are individual permissions, so adding a destination asks again in
/// Settings consent flow. No wildcard or path grants.
pub(super) fn valid_permission(permission: &str) -> bool {
    let Some(origin) = permission.strip_prefix("network:") else { return false };
    https_url(origin).is_ok_and(|url| url.origin().ascii_serialization() == origin)
}

impl Request {
    fn check(self) -> Result<Checked, String> {
        let url = https_url(&self.url)?;
        if self.method != "GET" && self.method != "POST" {
            return Err("only GET and JSON POST requests are allowed".into());
        }
        if self.method == "GET" && self.json.is_some() {
            return Err("GET requests cannot have a JSON body".into());
        }
        let body = if self.method == "POST" {
            let body = self.json.unwrap_or_else(|| "null".into());
            if body.len() > MAX_REQUEST { return Err("JSON request exceeds 64 KiB".into()); }
            serde_json::from_str::<Value>(&body).map_err(|_| "invalid JSON request")?;
            Some(body.into_bytes())
        } else { None };
        if self.bearer.as_ref().is_some_and(|s| s.is_empty() || s.len() > MAX_TOKEN ||
            !s.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._~+/=".contains(&c))) {
            return Err("invalid bearer token".into());
        }
        Ok(Checked {
            permission: format!("network:{}", url.origin().ascii_serialization()),
            url, method: self.method, body, bearer: self.bearer,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    status: u16,
    body: String,
    content_type: Option<String>,
    fetched_at: u64,
}

fn allowed(app: &tauri::AppHandle, window: &tauri::WebviewWindow, plugin: Option<&str>, permission: &str) -> Result<(String, String), String> {
    let id = super::window_plugin(window, plugin)?;
    super::require(app, &id, permission)?;
    if super::host(app)?.off.read().unwrap_or_else(|p| p.into_inner()).contains(&id) {
        return Err("the plugin is disabled".into());
    }
    let source = super::network_permissions::authorize(app, &id, permission)?;
    Ok((id, source))
}

#[tauri::command]
pub async fn plugin_http_request(
    app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>, request: Request,
) -> Result<Reply, String> {
    let request = request.check()?;
    let (id, source) = allowed(&app, &window, plugin.as_deref(), &request.permission)?;
    #[cfg(feature = "online")]
    {
        let authorize = || {
            let current = allowed(&app, &window, plugin.as_deref(), &request.permission)?;
            if current != (id.clone(), source.clone()) { return Err("plugin source changed during the request".into()); }
            Ok(())
        };
        let reply = online::send(&id, &request, &authorize).await?;
        // Revocation or disabling while the request runs also blocks delivery.
        authorize()?;
        Ok(reply)
    }
    #[cfg(not(feature = "online"))]
    {
        let _ = (id, source);
        Err("plugin HTTPS requests need the online build".into())
    }
}

#[cfg(feature = "online")]
mod online {
    use super::{Checked, Reply, public_address};
    use std::collections::{HashSet, VecDeque};
    use std::net::{IpAddr, SocketAddr};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const MAX_BODY: usize = 2_000_000;
    const PERIOD: Duration = Duration::from_secs(60);
    const DEADLINE: Duration = Duration::from_secs(20);
    const GLOBAL_ATTEMPTS: usize = 60;
    const PLUGIN_ATTEMPTS: usize = 20;

    #[derive(Default)]
    struct State {
        attempts: VecDeque<(Instant, String)>,
        active: HashSet<String>,
        cooldowns: VecDeque<(String, Instant)>,
    }

    impl State {
        fn begin(&mut self, id: &str, origin: &str, now: Instant) -> Result<(), String> {
            self.cooldowns.retain(|(_, at)| *at > now);
            if self.cooldowns.iter().any(|(o, _)| o == origin) {
                return Err("HTTPS service is cooling down; retry later".into());
            }
            while self.attempts.front().is_some_and(|(at, _)| now.duration_since(*at) >= PERIOD) {
                self.attempts.pop_front();
            }
            if self.active.contains(id) { return Err("this plugin already has an HTTPS request in progress".into()); }
            if self.attempts.len() >= GLOBAL_ATTEMPTS || self.attempts.iter().filter(|(_, p)| p == id).count() >= PLUGIN_ATTEMPTS {
                return Err("plugin HTTPS request limit reached; retry later".into());
            }
            // Failed DNS/HTTP/timeout attempts consume the same shared budget.
            self.attempts.push_back((now, id.to_string()));
            self.active.insert(id.to_string());
            Ok(())
        }

        fn throttled(&mut self, origin: &str, now: Instant, seconds: u64) {
            self.cooldowns.retain(|(o, at)| o != origin && *at > now);
            self.cooldowns.push_back((origin.to_string(), now + Duration::from_secs(seconds.clamp(60, 1800))));
            while self.cooldowns.len() > 60 { self.cooldowns.pop_front(); }
        }
    }

    fn state() -> &'static Mutex<State> {
        static STATE: OnceLock<Mutex<State>> = OnceLock::new();
        STATE.get_or_init(Mutex::default)
    }

    struct Active {
        id: String,
        _permit: tokio::sync::SemaphorePermit<'static>,
    }
    impl Drop for Active {
        fn drop(&mut self) {
            state().lock().unwrap_or_else(|p| p.into_inner()).active.remove(&self.id);
        }
    }

    fn admit(id: &str, origin: &str) -> Result<Active, String> {
        static ACTIVE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        // No queue of waiting tasks or unbounded per-plugin maps.
        let permit = ACTIVE.try_acquire().map_err(|_| "plugin HTTPS requests are busy; retry later")?;
        state().lock().unwrap_or_else(|p| p.into_inner()).begin(id, origin, Instant::now())?;
        Ok(Active { id: id.to_string(), _permit: permit })
    }

    pub(super) async fn send(id: &str, request: &Checked, authorize: &(impl Fn() -> Result<(), String> + Sync)) -> Result<Reply, String> {
        let origin = request.url.origin().ascii_serialization();
        let _active = admit(id, &origin)?;
        tokio::time::timeout(DEADLINE, request_https(request, &origin, authorize)).await
            .map_err(|_| "plugin HTTPS request timed out".to_string())?
    }

    // Only globally routable unicast destinations. Mapped/transition IPv6 and
    // special-use ranges cannot smuggle a local address into the pinned set.
    fn checked_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
        if addresses.is_empty() || addresses.len() > 32 || addresses.iter().any(|a| a.port() != 443 || !public_address(a.ip())) {
            return Err("HTTPS destination resolved to an unsupported address".into());
        }
        Ok(addresses)
    }

    fn text_response(kind: Option<&str>) -> bool {
        kind.is_some_and(|v| {
            let mime = v.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            mime == "application/json" || mime == "text/plain" || mime == "text/html" ||
                (mime.starts_with("application/") && mime.ends_with("+json"))
        })
    }

    fn append(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
        if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
            return Err("HTTPS response exceeds 2 MB".into());
        }
        body.extend_from_slice(chunk);
        Ok(())
    }

    async fn request_https(request: &Checked, origin: &str, authorize: &(impl Fn() -> Result<(), String> + Sync)) -> Result<Reply, String> {
        let host = request.url.host_str().ok_or("invalid HTTPS host")?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        // IP literals need the same checks. Domain answers are validated and
        // pinned before connecting: no second DNS resolution/rebinding.
        let addresses = match host.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, 443)],
            Err(_) => tokio::net::lookup_host((host, 443)).await
                .map_err(|_| "HTTPS destination could not be resolved")?.take(33).collect(),
        };
        let addresses = checked_addresses(addresses)?;
        let client = reqwest::Client::builder()
            .no_proxy().redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addresses).timeout(DEADLINE)
            .build().map_err(|_| "plugin HTTPS client could not be created")?;
        let method = if request.method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET };
        let mut builder = client.request(method, request.url.as_str());
        if let Some(body) = &request.body {
            builder = builder.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.clone());
        }
        if let Some(token) = &request.bearer { builder = builder.bearer_auth(token); }
        // This dedicated client has no cookie jar, meter credentials or plugin
        // controlled headers. Errors never echo URLs, bodies or bearer tokens.
        authorize()?;
        let mut response = builder.send().await.map_err(|_| "plugin HTTPS request failed")?;
        let status = response.status().as_u16();
        if status == 429 {
            let seconds = response.headers().get(reqwest::header::RETRY_AFTER)
                .and_then(|v|v.to_str().ok()).and_then(|v|v.parse::<u64>().ok()).unwrap_or(60);
            state().lock().unwrap_or_else(|p| p.into_inner()).throttled(origin, Instant::now(), seconds);
        }
        let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|h|h.to_str().ok())
            .filter(|s| s.len() <= 256).map(str::to_string);
        if response.content_length().is_some_and(|n| n > MAX_BODY as u64) {
            return Err("HTTPS response exceeds 2 MB".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "HTTPS response could not be read")? {
            append(&mut body, &chunk)?;
        }
        // Empty responses (e.g. 204) may omit Content-Type. Only bounded text
        // is delivered; this is not a file/binary download API.
        if !body.is_empty() && !text_response(content_type.as_deref()) {
            return Err("HTTPS response must be JSON, plain text or HTML".into());
        }
        let body = String::from_utf8(body).map_err(|_| "HTTPS response is not UTF-8")?;
        Ok(Reply {
            status, body, content_type,
            fetched_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        #[ignore = "explicit live, credential-free HTTPS smoke test"]
        async fn public_https_example_smoke() {
            let request = super::super::Request { url: "https://example.com/".into(), method: "GET".into(), json: None, bearer: None }.check().unwrap();
            let reply = send("http-smoke", &request, &|| Ok(())).await.unwrap();
            assert_eq!(reply.status, 200);
            assert!(reply.body.contains("Example Domain"));
            assert!(reply.fetched_at > 0);
        }

        #[test]
        fn only_public_unicast_addresses() {
            for ip in ["0.0.0.0","10.0.0.1","100.64.0.1","127.0.0.1","169.254.169.254","172.16.1.1",
                "192.168.1.1","192.0.0.1","192.0.2.1","192.88.99.1","198.18.0.1","198.51.100.1",
                "203.0.113.1","224.0.0.1","255.255.255.255","::","::1","::ffff:127.0.0.1","::ffff:8.8.8.8",
                "64:ff9b::7f00:1","fc00::1","fe80::1","ff02::1","2001::1","2001:db8::1","2002:7f00:1::1","3fff::1"] {
                assert!(!public_address(ip.parse().unwrap()), "{ip}");
            }
            for ip in ["1.1.1.1","8.8.8.8","104.21.10.1","2606:4700:4700::1111","2001:4860:4860::8888"] {
                assert!(public_address(ip.parse().unwrap()), "{ip}");
            }
        }

        #[tokio::test]
        async fn revoked_authority_stops_before_transmission() {
            // A public literal avoids DNS; denial occurs after client setup
            // but before send, so this regression test makes no network call.
            let request = super::super::Request {
                url: "https://1.1.1.1/?private-query".into(), method: "POST".into(),
                json: Some(r#"{"private":"body"}"#.into()), bearer: Some("private-token".into()),
            }.check().unwrap();
            let called = std::sync::atomic::AtomicBool::new(false);
            let authorize = || {
                called.store(true, std::sync::atomic::Ordering::Relaxed);
                Err("permission revoked".into())
            };
            let result = request_https(&request, "https://1.1.1.1", &authorize).await;
            assert!(called.load(std::sync::atomic::Ordering::Relaxed));
            assert_eq!(result.err().as_deref(), Some("permission revoked"));
        }

        #[test]
        fn mixed_or_empty_dns_answers_fail_closed() {
            assert!(checked_addresses(vec![]).is_err());
            assert!(checked_addresses(vec!["1.1.1.1:443".parse().unwrap(),"127.0.0.1:443".parse().unwrap()]).is_err());
            assert!(checked_addresses(vec!["1.1.1.1:80".parse().unwrap()]).is_err());
            assert!(checked_addresses(vec!["1.1.1.1:443".parse().unwrap();33]).is_err());
            assert!(checked_addresses(vec!["1.1.1.1:443".parse().unwrap()]).is_ok());
        }

        #[test]
        fn only_documented_text_types_are_delivered() {
            for kind in ["application/json","Application/JSON; charset=utf-8","application/problem+json","text/plain","text/html"] {
                assert!(text_response(Some(kind)), "{kind}");
            }
            for kind in [None,Some("image/png"),Some("application/octet-stream"),Some("text/event-stream")] {
                assert!(!text_response(kind));
            }
        }

        #[test]
        fn streamed_body_is_bounded_without_a_length_header() {
            let mut bytes = vec![0; MAX_BODY - 1];
            assert!(append(&mut bytes,&[1]).is_ok());
            assert!(append(&mut bytes,&[2]).is_err());
            assert_eq!(bytes.len(),MAX_BODY);
        }

        #[test]
        fn per_plugin_and_global_budgets_count_failures_and_expire() {
            let now = Instant::now();
            let mut state = State::default();
            for _ in 0..PLUGIN_ATTEMPTS {
                assert!(state.begin("one","https://example.com",now).is_ok());
                state.active.remove("one");
            }
            assert!(state.begin("one","https://example.com",now).is_err());
            for i in PLUGIN_ATTEMPTS..GLOBAL_ATTEMPTS {
                let id = format!("plugin-{i}");
                assert!(state.begin(&id,"https://example.com",now).is_ok());
                state.active.remove(&id);
            }
            assert!(state.begin("another","https://other.example",now).is_err());
            assert!(state.begin("one","https://example.com",now+PERIOD).is_ok());
        }

        #[test]
        fn parallel_windows_of_one_plugin_do_not_get_extra_slots() {
            let mut state = State::default();
            let now = Instant::now();
            assert!(state.begin("one","https://example.com",now).is_ok());
            assert!(state.begin("one","https://other.example",now).is_err());
            assert!(state.begin("two","https://example.com",now).is_ok());
        }

        #[test]
        fn throttling_is_shared_by_origin_bounded_and_expires() {
            let mut state = State::default();
            let now = Instant::now();
            state.throttled("https://example.com",now,999999);
            assert!(state.begin("one","https://example.com",now).is_err());
            assert!(state.begin("two","https://example.com",now+Duration::from_secs(1799)).is_err());
            assert!(state.begin("one","https://other.example",now).is_ok());
            state.active.remove("one");
            assert!(state.begin("two","https://example.com",now+Duration::from_secs(1800)).is_ok());
            for i in 0..100 { state.throttled(&format!("https://{i}.example"),now,1); }
            assert_eq!(state.cooldowns.len(),60);
        }

        #[tokio::test]
        async fn concurrency_does_not_queue_and_deadline_cancels() {
            let held: Vec<_> = (0..4).map(|i|admit(&format!("gate-{i}"),"https://example.com").unwrap()).collect();
            assert!(admit("gate-extra","https://example.com").is_err());
            assert!(admit("gate-0","https://example.com").is_err());
            drop(held);
            assert!(admit("gate-0","https://example.com").is_ok());
            let pending = async {
                let _active = admit("gate-cancel","https://example.com").unwrap();
                std::future::pending::<()>().await;
            };
            assert!(tokio::time::timeout(Duration::from_millis(1),pending).await.is_err());
            assert!(admit("gate-cancel","https://example.com").is_ok());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(url: &str) -> Request {
        Request { url:url.into(), method:"GET".into(), json:None, bearer:None }
    }

    #[test]
    fn permissions_are_exact_canonical_https_origins() {
        for good in ["network:https://example.com","network:https://api.example.com"] { assert!(valid_permission(good)); }
        for bad in ["network:*","network:https://*.example.com","network:http://example.com","network:https://example.com/path",
            "network:https://example.com/","network:https://example.com:8443","network:https://user@example.com",
            "network:https://example.com?query","network:https://example.com#fragment","network:https://EXAMPLE.com"] {
            assert!(!valid_permission(bad),"{bad}");
        }
        assert_eq!(request("https://api.example.com/check?q=1").check().unwrap().permission,"network:https://api.example.com");
        assert_ne!(request("https://api.example.com.evil.test/").check().unwrap().permission,"network:https://api.example.com");
    }

    #[test]
    fn unsupported_url_forms_methods_headers_and_get_bodies_are_rejected() {
        for bad in ["http://example.com","file:///etc/passwd","https://user:pass@example.com",
            "https://example.com:8443","https://example.com/#fragment"] { assert!(request(bad).check().is_err()); }
        let mut r=request("https://example.com");r.method="DELETE".into();assert!(r.check().is_err());
        let mut r=request("https://example.com");r.json=Some("{}".into());assert!(r.check().is_err());
        assert!(serde_json::from_str::<Request>(r#"{"url":"https://example.com","headers":{"Cookie":"x"}}"#).is_err());
    }

    #[test]
    fn explicit_json_and_bearer_remain_bounded_and_separate_from_the_url() {
        let mut r=request("https://example.com/license");
        r.method="POST".into();r.json=Some(r#"{"license":"demo"}"#.into());r.bearer=Some("dummy-token".into());
        let checked=r.check().unwrap();
        assert_eq!(checked.body.unwrap(),br#"{"license":"demo"}"#);
        assert_eq!(checked.bearer.as_deref(),Some("dummy-token"));
        assert_eq!(checked.url.as_str(),"https://example.com/license");
        for token in ["", "x\r\nCookie: x", "x y", "é"] {
            let mut r=request("https://example.com");r.bearer=Some(token.into());assert!(r.check().is_err());
        }
        let mut r=request("https://example.com");r.bearer=Some("x".repeat(MAX_TOKEN+1));assert!(r.check().is_err());
        let mut r=request("https://example.com");r.method="POST".into();r.json=Some("x".repeat(MAX_REQUEST+1));assert!(r.check().is_err());
    }

    #[test]
    fn status_distinguishes_demo_success_from_denied_or_expired_subscriptions() {
        for status in [200,301,401,403,429,503] {
            let reply=Reply {status,body:"{}".into(),content_type:Some("application/json".into()),fetched_at:123};
            assert_eq!(serde_json::to_value(reply).unwrap()["status"],status);
        }
    }
}
