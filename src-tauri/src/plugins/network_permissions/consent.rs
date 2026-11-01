//! Plugin requests may ask; only the meter's Settings page can decide.
//! Tokens and source metadata never cross the plugin SDK boundary.
use super::*;
use std::collections::{HashSet, VecDeque};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::oneshot;

const LIFETIME: Duration = Duration::from_secs(120);
const MAX_DECLINES: usize = MAX_SOURCES * 32;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PermissionStatus {
    origin: String,
    granted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Prompt {
    token: String,
    id: String,
    name: String,
    version: String,
    folder: String,
    origin: String,
    reviewed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Identity {
    id: String,
    name: String,
    version: String,
    source: String,
    folder: String,
    permission: String,
    reviewed: bool,
}

struct Pending {
    prompt: Prompt,
    identity: Identity,
    window: String,
    expires: Instant,
    reply: oneshot::Sender<Result<PermissionStatus, String>>,
}

impl Pending {
    fn validate_identity(&self, now: Instant, current: &Identity) -> Result<(), String> {
        if self.expires <= now { return Err("internet permission request expired".into()); }
        if current != &self.identity { return Err("plugin source changed; request permission again".into()); }
        Ok(())
    }
}

#[derive(Default)]
struct Requests {
    next: u64,
    epoch: u64,
    pending: Option<Pending>,
    declined: HashSet<(String, String)>,
    attempts: VecDeque<Instant>,
}

impl Requests {
    fn begin(&mut self, identity: Identity, window: String, epoch: u64, now: Instant)
        -> Result<Option<(String, oneshot::Receiver<Result<PermissionStatus, String>>)>, String> {
        if epoch != self.epoch { return Err("plugin changed while requesting consent".into()); }
        if self.declined.contains(&(identity.source.clone(), identity.permission.clone())) {
            return Ok(None);
        }
        if self.pending.is_some() { return Err("another internet permission request is pending".into()); }
        while self.attempts.front().is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60)) {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= 3 { return Err("internet permission prompts are cooling down".into()); }
        if self.declined.len() >= MAX_DECLINES { return Err("too many internet permission requests this session".into()); }
        self.next = self.next.checked_add(1).ok_or("internet permission request limit reached")?;
        let token = self.next.to_string();
        let (reply, receiver) = oneshot::channel();
        let origin = identity.permission[8..].to_string();
        let prompt = Prompt { token: token.clone(), id: identity.id.clone(), name: identity.name.clone(),
            version: identity.version.clone(), folder: identity.folder.clone(), origin, reviewed: identity.reviewed };
        self.pending = Some(Pending { prompt, identity, window, expires: now + LIFETIME, reply });
        self.attempts.push_back(now);
        Ok(Some((token, receiver)))
    }

    fn cancel(&mut self, id: Option<&str>, window: Option<&str>, declined: bool) {
        self.epoch = self.epoch.wrapping_add(1);
        if self.pending.as_ref().is_some_and(|p|
            id.is_none_or(|id| p.identity.id == id) && window.is_none_or(|w| p.window == w || w == "settings")) {
            let pending = self.pending.take().unwrap();
            let answer = if declined { Ok(status(&pending.prompt.origin, false)) }
                else { Err("internet permission request was invalidated".into()) };
            self.settle(pending, answer, declined);
        }
    }

    fn take(&mut self, token: &str) -> Result<Pending, String> {
        if self.pending.as_ref().is_none_or(|p| p.prompt.token != token) {
            return Err("internet permission request is no longer pending".into());
        }
        Ok(self.pending.take().unwrap())
    }

    fn settle(&mut self, pending: Pending, result: Result<PermissionStatus, String>, decline: bool) {
        if decline { self.declined.insert((pending.identity.source, pending.identity.permission)); }
        let _ = pending.reply.send(result);
    }
}

fn requests() -> &'static Mutex<Requests> {
    static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();
    REQUESTS.get_or_init(Mutex::default)
}
fn wake(app: &tauri::AppHandle) {
    let _ = app.emit_to("settings", "plugin-network-prompt", ());
}
fn status(origin: &str, granted: bool) -> PermissionStatus {
    PermissionStatus { origin: origin.into(), granted }
}

fn checked_origin(origin: &str) -> Result<String, String> {
    if !cfg!(feature = "online") { return Err("plugin HTTPS permissions need the online build".into()); }
    let permission = format!("network:{origin}");
    if origin.len() > 4096 || !network::valid_permission(&permission) {
        return Err("permission requires a canonical exact HTTPS origin without a path".into());
    }
    let url = tauri::Url::parse(origin).map_err(|_| "invalid HTTPS origin")?;
    let hostname = url.host_str().ok_or("invalid HTTPS origin")?.trim_matches(['[', ']']);
    // DNS is revalidated and pinned by every actual HTTP send. Consent grants
    // no exception to that policy, even if this name later resolves privately.
    if let Ok(ip) = hostname.parse::<std::net::IpAddr>() {
        if !network::public_address(ip) { return Err("internet permissions require a public destination".into()); }
    } else if !hostname.contains('.') || [".localhost", ".local", ".internal", ".lan"].iter().any(|s| hostname.ends_with(s)) {
        return Err("internet permissions require a public destination".into());
    }
    Ok(permission)
}

fn identity(plugin: &Loaded, permission: &str) -> Result<Identity, String> {
    if !plugin.manifest.permissions.iter().any(|p| p == permission) {
        return Err("the plugin does not declare this exact HTTPS origin".into());
    }
    Ok(Identity { id: plugin.manifest.id.clone(), name: plugin.manifest.name.clone(),
        version: plugin.manifest.version.clone(), source: source(plugin)?,
        folder: plugin.dir.canonicalize().map_err(|_| "plugin source folder is unavailable")?.to_string_lossy().into_owned(),
        permission: permission.into(), reviewed: plugin.reviewed })
}
fn current(app: &tauri::AppHandle, id: &str, permission: &str) -> Result<Identity, String> {
    let host = host(app)?;
    let off = host.off.read().unwrap_or_else(|p| p.into_inner());
    if off.contains(id) { return Err("the plugin is disabled".into()); }
    host.with(id, |p| identity(p, permission)).ok_or("plugin is no longer loaded")?
}
fn requester(app: &tauri::AppHandle, window: &tauri::WebviewWindow, plugin: Option<&str>, origin: &str)
    -> Result<(Identity, bool), String> {
    let permission = checked_origin(origin)?;
    let id = super::super::window_plugin(window, plugin)?;
    mutation(|| {
        let identity = current(app, &id, &permission)?;
        let approved = granted(&read_grants(app), &identity.source, &permission);
        Ok((identity, approved))
    })
}

#[tauri::command]
pub fn plugin_network_status(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>, origin: String)
    -> Result<PermissionStatus, String> {
    let (_, approved) = requester(&app, &window, plugin.as_deref(), &origin)?;
    Ok(status(&origin, approved))
}

struct Waiting { app: tauri::AppHandle, token: String }
impl Drop for Waiting {
    fn drop(&mut self) {
        let mut requests = requests().lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(pending) = requests.take(&self.token) {
            requests.settle(pending, Err("internet permission request expired or was cancelled".into()), false);
        }
        drop(requests);
        wake(&self.app);
    }
}

#[tauri::command]
pub async fn plugin_request_network(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>, origin: String)
    -> Result<PermissionStatus, String> {
    let epoch = requests().lock().unwrap_or_else(|p| p.into_inner()).epoch;
    let (identity, approved) = requester(&app, &window, plugin.as_deref(), &origin)?;
    if approved { return Ok(status(&origin, true)); }
    if !window.is_focused().unwrap_or(false) || !window.is_visible().unwrap_or(false)
        || crate::platform::window::is_hidden_in_place(&window) {
        return Err("request internet permission from the focused plugin configuration".into());
    }
    let before = crate::platform::window::front_window();
    let started = requests().lock().unwrap_or_else(|p| p.into_inner())
        .begin(identity, window.label().into(), epoch, Instant::now())?;
    let Some((token, receiver)) = started else { return Ok(status(&origin, false)); };
    let _waiting = Waiting { app: app.clone(), token };
    crate::app::open_settings_for_network_consent(app.clone(), before).await?;
    wake(&app);
    tokio::time::timeout(LIFETIME, receiver).await
        .map_err(|_| "internet permission request expired".to_string())?
        .map_err(|_| "internet permission request was cancelled".to_string())?
}

#[tauri::command]
pub fn plugin_network_prompt(window: tauri::WebviewWindow) -> Result<Option<Prompt>, String> {
    settings_window(&window)?;
    let requests = requests().lock().unwrap_or_else(|p| p.into_inner());
    Ok(requests.pending.as_ref().filter(|p| p.expires > Instant::now()).map(|p| p.prompt.clone()))
}

fn persist(app: &tauri::AppHandle, expected: &Identity) -> Result<(), String> {
    let host = host(app)?;
    // Keep enabled state and loaded source stable until the grant is persisted.
    let off = host.off.read().unwrap_or_else(|p| p.into_inner());
    if off.contains(&expected.id) { return Err("the plugin is disabled".into()); }
    host.with(&expected.id, |plugin| {
        if identity(plugin, &expected.permission)? != *expected {
            return Err("plugin source or declaration changed; request permission again".into());
        }
        let mut grants = read_grants(app);
        // Store the registration spelling for removal, while the prompt displays
        // its canonical identity. A missing alias must still revoke the grant.
        approve(&mut grants, &expected.source, &plugin.dir.to_string_lossy(), &declared(plugin), std::slice::from_ref(&expected.permission))?;
        let settings = &app.try_state::<AppState>().ok_or("no app state")?.settings;
        save_approval(settings, &grants)
    }).ok_or("plugin is no longer loaded")?
}

fn save_approval(settings: &Settings, grants: &Grants) -> Result<(), String> {
    let previous = settings.get(KEY);
    if let Err(error) = save_settings(settings, grants) {
        // A failed flush must not leave a newly approved in-memory grant.
        match previous {
            Some(value) => { settings.set(KEY, &value); }
            None => settings.remove(KEY),
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_answer_network_prompt(app: tauri::AppHandle, window: tauri::WebviewWindow, token: String, allow: bool)
    -> Result<PermissionStatus, String> {
    settings_window(&window)?;
    if token.len() > 20 { return Err("invalid internet permission token".into()); }
    // Query native visibility before locking Requests: a close event needs that
    // mutex on the UI thread. The token then arbitrates concurrent closure.
    if !window.is_visible().unwrap_or(false) || crate::platform::window::is_hidden_in_place(&window) {
        return Err("Settings was closed before the permission decision".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = mutation(|| {
            let mut requests = requests().lock().unwrap_or_else(|p| p.into_inner());
            let pending = requests.take(&token)?;
            let result = (|| {
                let source_window = app.get_webview_window(&pending.window).ok_or("requesting plugin window was closed")?;
                let plugin = (pending.window == super::super::dock::LABEL).then_some(pending.identity.id.as_str());
                if super::super::window_plugin(&source_window, plugin)? != pending.identity.id {
                    return Err("requesting plugin configuration changed".into());
                }
                pending.validate_identity(Instant::now(), &current(&app, &pending.identity.id, &pending.identity.permission)?)?;
                if allow { persist(&app, &pending.identity)?; }
                Ok(status(&pending.prompt.origin, allow))
            })();
            requests.settle(pending, result.clone(), !allow && result.is_ok());
            result
        });
        wake(&app);
        result
    }).await.map_err(|_| "internet permission decision task failed".to_string())?
}

/// Lifecycle invalidation cannot turn a stale prompt into a grant. Declines
/// remain remembered across reload, while explicit Settings revocation rearms.
pub(crate) fn cancel(app: &tauri::AppHandle, id: Option<&str>, window: Option<&str>, declined: bool) {
    let mut requests = requests().lock().unwrap_or_else(|p| p.into_inner());
    requests.cancel(id, window, declined);
    drop(requests);
    wake(app);
}

pub(super) fn rearm(source: &str) {
    requests().lock().unwrap_or_else(|p| p.into_inner()).declined.retain(|(s, _)| s != source);
}

pub(crate) fn pending() -> bool {
    requests().lock().unwrap_or_else(|p| p.into_inner()).pending.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn applicant(origin: &str) -> Identity {
        Identity { id: "market".into(), name: "Market".into(), version: "0.2.1".into(),
            source: "market:source-one".into(), folder: "/plugins/market".into(),
            permission: format!("network:{origin}"), reviewed: false }
    }
    fn begin(book: &mut Requests, identity: Identity, now: Instant)
        -> (String, oneshot::Receiver<Result<PermissionStatus, String>>) {
        book.begin(identity, "plugins-dock".into(), book.epoch, now).unwrap().unwrap()
    }

    #[test]
    fn unlisted_local_or_noncanonical_origins_cannot_request_consent() {
        for origin in ["http://example.com", "https://example.com/", "https://example.com:443",
            "https://example.com/path", "https://example.com?token=secret", "https://u:p@example.com",
            "https://*.example.com", "https://127.0.0.1", "https://[::1]", "https://192.168.1.1",
            "https://100.64.0.1", "https://printer", "https://pc.local", "https://pc.localhost"] {
            assert!(checked_origin(origin).is_err(), "{origin}");
        }
        for origin in ["https://aion2.exchange", "https://www.example.com"] {
            assert_eq!(checked_origin(origin).is_ok(), cfg!(feature = "online"));
        }
    }

    #[test]
    fn opening_prompt_is_not_a_grant_and_only_matching_token_consumes_it() {
        let mut book = Requests::default();
        let (token, mut reply) = begin(&mut book, applicant("https://aion2.exchange"), Instant::now());
        assert!(matches!(reply.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
        assert!(book.take("unrelated").is_err());
        let pending = book.take(&token).unwrap();
        book.settle(pending, Ok(status("https://aion2.exchange", true)), false);
        assert_eq!(reply.try_recv().unwrap().unwrap(), status("https://aion2.exchange", true));
        assert!(book.take(&token).is_err());
    }

    #[test]
    fn denial_is_source_and_origin_specific_and_survives_lifecycle_invalidation() {
        let now = Instant::now();
        let a = applicant("https://aion2.exchange");
        let mut book = Requests::default();
        let (token, mut reply) = begin(&mut book, a.clone(), now);
        let pending = book.take(&token).unwrap();
        book.settle(pending, Ok(status("https://aion2.exchange", false)), true);
        assert!(!reply.try_recv().unwrap().unwrap().granted);
        book.cancel(None, None, false);
        assert!(book.begin(a.clone(), "plugins-dock".into(), book.epoch, now).unwrap().is_none());
        let b = applicant("https://www.example.com");
        let (token, _) = begin(&mut book, b, now);
        let pending = book.take(&token).unwrap();
        book.settle(pending, Err("invalidated".into()), false);
        let mut other = a;
        other.source = "market:different-folder".into();
        assert!(book.begin(other, "plugins-dock".into(), book.epoch, now).unwrap().is_some());
    }

    #[test]
    fn cancellation_matches_requester_and_invalidates_preparation_epoch() {
        let now = Instant::now();
        let mut book = Requests::default();
        let (token, mut reply) = begin(&mut book, applicant("https://aion2.exchange"), now);
        let epoch = book.epoch;
        book.cancel(Some("another-plugin"), None, false);
        assert_eq!(book.pending.as_ref().unwrap().prompt.token, token);
        book.cancel(None, Some("plugins-dock"), false);
        assert!(reply.try_recv().unwrap().is_err());
        assert!(book.begin(applicant("https://aion2.exchange"), "plugins-dock".into(), epoch, now).is_err());
        let (_, mut reply) = begin(&mut book, applicant("https://aion2.exchange"), now);
        book.cancel(None, Some("settings"), true);
        assert_eq!(reply.try_recv().unwrap().unwrap(), status("https://aion2.exchange", false));
        assert!(book.begin(applicant("https://aion2.exchange"), "plugins-dock".into(), book.epoch, now).unwrap().is_none());
    }

    #[test]
    fn prompts_are_bounded_and_busy_requests_cannot_replace_a_decision() {
        let now = Instant::now();
        let mut book = Requests::default();
        let (token, _) = begin(&mut book, applicant("https://aion2.exchange"), now);
        assert!(book.begin(applicant("https://www.example.com"), "plugin-other".into(), book.epoch, now).is_err());
        assert_eq!(book.pending.as_ref().unwrap().prompt.token, token);
        book.cancel(None, None, false);
        for _ in 0..2 {
            begin(&mut book, applicant("https://aion2.exchange"), now);
            book.cancel(None, None, false);
        }
        assert!(book.begin(applicant("https://aion2.exchange"), "plugins-dock".into(), book.epoch, now).is_err());
        begin(&mut book, applicant("https://aion2.exchange"), now + Duration::from_secs(60));
        book.cancel(None, None, false);
        book.declined = (0..MAX_DECLINES).map(|i| (i.to_string(), "network:https://example.com".into())).collect();
        assert!(book.begin(applicant("https://aion2.exchange"), "plugins-dock".into(), book.epoch, now + Duration::from_secs(120)).is_err());
    }

    #[test]
    fn decision_rejects_expiry_source_or_declaration_replacement() {
        let now = Instant::now();
        let mut book = Requests::default();
        let identity = applicant("https://aion2.exchange");
        let (token, _) = begin(&mut book, identity.clone(), now);
        let pending = book.take(&token).unwrap();
        assert!(pending.validate_identity(now, &identity).is_ok());
        assert!(pending.validate_identity(now + LIFETIME, &identity).is_err());
        let mut changed = identity.clone(); changed.source = "same-id-new-path".into();
        assert!(pending.validate_identity(now, &changed).is_err());
        changed = identity.clone(); changed.permission = "network:https://www.example.com".into();
        assert!(pending.validate_identity(now, &changed).is_err());
        changed = identity; changed.version = "0.2.2".into();
        assert!(pending.validate_identity(now, &changed).is_err());
    }

    #[test]
    fn plugin_and_widget_surfaces_cannot_read_or_answer_the_host_prompt() {
        for label in ["plugin-market", "plugins-dock", "pw_market_main"] {
            for command in ["plugin_network_prompt", "plugin_answer_network_prompt"] {
                assert!(!super::super::super::allowed_from(label, command));
            }
        }
        for label in ["plugin-market", "plugins-dock"] {
            assert!(super::super::super::allowed_from(label, "plugin_network_status"));
            assert!(super::super::super::allowed_from(label, "plugin_request_network"));
        }
    }


    #[test]
    fn registration_alias_removal_revokes_canonical_source_grant() {
        let permission = "network:https://aion2.exchange".to_string();
        let mut grants = Grants::new();
        let canonical = source_key("market", "/real/market");
        let registration = "/registered/market-link";
        approve(&mut grants, &canonical, registration, std::slice::from_ref(&permission), std::slice::from_ref(&permission)).unwrap();
        remove(&mut grants, None, Some(registration));
        assert!(!granted(&grants, &canonical, &permission));
    }

    #[test]
    fn failed_permission_save_rolls_back_memory_and_preserves_previous_grants() {
        let dir = std::env::temp_dir().join(format!("a2-consent-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&dir).unwrap();
        // Never run the live-profile migration in this isolated test.
        std::fs::write(dir.join("settings.json"), r#"{"dpsMeter.theme":"unchanged"}"#).unwrap();
        let settings = Settings::new(dir.clone());
        let a = "network:https://aion2.exchange".to_string();
        let b = "network:https://www.example.com".to_string();
        let mut grants = Grants::new();
        approve(&mut grants, "source", "/market", &[a.clone(), b.clone()], std::slice::from_ref(&a)).unwrap();
        save_approval(&settings, &grants).unwrap();
        let before = settings.get(KEY);
        std::fs::remove_file(dir.join("settings.json")).unwrap();
        std::fs::create_dir(dir.join("settings.json")).unwrap();
        approve(&mut grants, "source", "/market", &[a.clone(), b.clone()], std::slice::from_ref(&b)).unwrap();
        assert!(save_approval(&settings, &grants).is_err());
        assert_eq!(settings.get(KEY), before);
        assert!(!granted(&parse_grants(settings.get(KEY)), "source", &b));
        std::fs::remove_dir(dir.join("settings.json")).unwrap();
        settings.flush().unwrap();
        let reopened = Settings::new(dir.clone());
        assert!(granted(&parse_grants(reopened.get(KEY)), "source", &a));
        assert!(!granted(&parse_grants(reopened.get(KEY)), "source", &b));
        assert_eq!(reopened.get("dpsMeter.theme").as_deref(), Some("unchanged"));
        drop(reopened); drop(settings);
        std::fs::remove_file(dir.join("settings.json")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
