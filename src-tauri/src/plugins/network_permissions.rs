//! Every plugin needs an explicit host-owned grant for each HTTPS origin.
//! A manifest edit alone must not silently widen an already running plugin.
use std::collections::BTreeMap;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::Manager;
use super::{host, network, view, Loaded, PluginHost, PluginsView};
use crate::{app::AppState, config::settings::Settings};

const KEY: &str = "dpsMeter.pluginNetworkGrants";
const MAX_SOURCES: usize = 128;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    // Host-read registration path also identifies removed/missing folders.
    folder: String,
    origins: Vec<String>,
}
type Grants = BTreeMap<String, Grant>;

// Serialize the whole settings read/modify/write transaction, not only set().
static MUTATION: Mutex<()> = Mutex::new(());
fn mutation<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = MUTATION.lock().unwrap_or_else(|p| p.into_inner());
    operation()
}

fn granted(grants: &Grants, source: &str, permission: &str) -> bool {
    grants.get(source).is_some_and(|g| g.origins.iter().any(|p| p == permission))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    source: String,
    approved: Vec<String>,
    pending: Vec<String>,
}

fn source_key(id: &str, path: &str) -> String {
    let mut hash = sha2::Sha256::new();
    hash.update(id.as_bytes());
    hash.update([0]);
    hash.update(path.as_bytes());
    let digest: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{id}:{digest}")
}

fn source(plugin: &Loaded) -> Result<String, String> {
    let path = plugin.dir.canonicalize().map_err(|_| "plugin source folder is unavailable")?;
    let path = path.to_str().ok_or("plugin source path is not UTF-8")?;
    Ok(source_key(&plugin.manifest.id, path))
}

fn parse_grants(raw: Option<String>) -> Grants {
    raw.filter(|s| s.len() <= 65_536)
        .and_then(|s| serde_json::from_str::<Grants>(&s).ok())
        .filter(|g| g.len() <= MAX_SOURCES && g.values().all(|g|
            g.folder.len() <= 32_768 && g.origins.len() <= 32 && g.origins.iter().all(|p| network::valid_permission(p))))
        .unwrap_or_default()
}

fn read_grants(app: &tauri::AppHandle) -> Grants {
    parse_grants(app.try_state::<AppState>().and_then(|s| s.settings.get(KEY)))
}

fn declared(plugin: &Loaded) -> Vec<String> {
    plugin.manifest.permissions.iter().filter(|p| p.starts_with("network:")).cloned().collect()
}

fn permissions(plugin: &Loaded, grants: &Grants) -> Result<Permissions, String> {
    let source = source(plugin)?;
    let (approved, pending) = declared(plugin).into_iter().partition(|p| granted(grants, &source, p));
    Ok(Permissions { source, approved, pending })
}

pub(super) fn list(app: &tauri::AppHandle, host: &PluginHost) -> BTreeMap<String, Permissions> {
    let grants = read_grants(app);
    host.loaded.read().unwrap_or_else(|p| p.into_inner()).iter()
        .filter(|p| !declared(p).is_empty())
        .filter_map(|p| permissions(p, &grants).ok().map(|info|(p.manifest.id.clone(), info))).collect()
}

/// The canonical source identity also follows the request, so an old response
/// cannot be delivered after another folder replaces a plugin with the same id.
pub(super) fn authorize(app: &tauri::AppHandle, id: &str, permission: &str) -> Result<String, String> {
    let host = host(app)?;
    let grants = read_grants(app);
    host.with(id, |plugin| {
        // Check the declaration under the same loaded-plugin read lock as the
        // source and grant, even if a reload raced the caller's initial check.
        if !plugin.manifest.permissions.iter().any(|p| p == permission) {
            return Err("the plugin no longer declares this HTTPS origin".into());
        }
        let source = source(plugin)?;
        if !granted(&grants, &source, permission) {
            return Err("approve this plugin's internet access in Settings > Plugins".into());
        }
        Ok(source)
    }).ok_or("plugin is no longer loaded")?
}

fn settings_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" { return Err("only Settings can change plugin network approvals".into()); }
    Ok(())
}

fn approve(grants: &mut Grants, source: &str, folder: &str, declared: &[String], requested: &[String]) -> Result<(), String> {
    if requested.is_empty() || requested.len() > 32 || folder.len() > 32_768 ||
       requested.iter().any(|p| !network::valid_permission(p) || !declared.contains(p)) {
        return Err("plugin network permissions changed; review them again".into());
    }
    if !grants.contains_key(source) && grants.len() >= MAX_SOURCES {
        return Err("too many saved plugin network approvals".into());
    }
    let mut origins = grants.get(source).map(|g| g.origins.clone()).unwrap_or_default();
    for permission in requested {
        if !origins.contains(permission) { origins.push(permission.clone()); }
    }
    if origins.len() > 32 { return Err("at most 32 approved origins per plugin".into()); }
    grants.insert(source.into(), Grant { folder: folder.into(), origins });
    Ok(())
}

fn save_settings(settings: &Settings, grants: &Grants) -> Result<(), String> {
    let json = serde_json::to_string(grants).map_err(|_| "could not save plugin network approvals")?;
    if json.len() > 65_536 { return Err("plugin network approvals exceed their storage limit".into()); }
    settings.set(KEY, &json);
    settings.flush().map_err(|_| "could not persist plugin network approvals; retry before closing the meter".into())
}

fn save(app: &tauri::AppHandle, grants: &Grants) -> Result<(), String> {
    save_settings(&app.try_state::<AppState>().ok_or("no app state")?.settings, grants)
}

/// Called only after the Settings consent card showed these exact additions.
/// Not in PLUGIN_SURFACE_COMMANDS: neither a plugin nor its widget can grant it.
#[tauri::command]
pub async fn plugin_approve_network(app: tauri::AppHandle, window: tauri::WebviewWindow,
    id: String, source: String, permissions: Vec<String>) -> Result<PluginsView, String> {
    settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
    let host = host(&app)?;
    mutation(|| {
        let (current, folder) = host.with(&id, |p| {
            if self::source(p)? != source { return Err("plugin source changed; review it again".to_string()); }
            Ok((declared(p), p.dir.to_string_lossy().into_owned()))
        }).ok_or("plugin is no longer loaded")??;
        let mut grants = read_grants(&app);
        approve(&mut grants, &source, &folder, &current, &permissions)?;
        save(&app, &grants)
    })?;
    Ok(view(&app, &host))
    }).await.map_err(|_| "plugin network approval task failed".to_string())?
}

#[tauri::command]
pub async fn plugin_revoke_network(app: tauri::AppHandle, window: tauri::WebviewWindow,
    id: String, source: String) -> Result<PluginsView, String> {
    settings_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
    let host = host(&app)?;
    mutation(|| {
        let current = host.with(&id, self::source).ok_or("plugin is no longer loaded")??;
        if current != source { return Err("plugin source changed; review it again".into()); }
        let mut grants = read_grants(&app);
        grants.remove(&source);
        save(&app, &grants)
    })?;
    Ok(view(&app, &host))
    }).await.map_err(|_| "plugin network revocation task failed".to_string())?
}

fn remove(grants: &mut Grants, id: Option<&str>, folder: Option<&str>) {
    grants.retain(|source, grant| {
        !id.is_some_and(|id| source.starts_with(&format!("{id}:"))) &&
        !folder.is_some_and(|folder| grant.folder == folder)
    });
}

/// Called after unloading. Registration-path metadata also revokes a removed
/// developer folder whose directory or manifest is missing.
pub(super) fn forget(app: &tauri::AppHandle, id: Option<&str>, folder: Option<&str>) -> Result<(), String> {
    mutation(|| {
        let mut grants = read_grants(app);
        let before = grants.len();
        remove(&mut grants, id, folder);
        // A failed earlier flush may already have removed the in-memory grant.
        // Retrying cleanup must still persist that revocation.
        if grants.len() == before && app.try_state::<AppState>().and_then(|s| s.settings.get(KEY)).is_none() {
            return Ok(());
        }
        save(app, &grants)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn permission(host: &str) -> String { format!("network:https://{host}") }

    #[test]
    fn same_id_in_another_source_cannot_inherit_grants() {
        assert_ne!(source_key("market","/one"),source_key("market","/two"));
        assert_ne!(source_key("market","/one"),source_key("other","/one"));
        assert_eq!(source_key("market","/one"),source_key("market","/one"));
    }

    #[test]
    fn additions_need_the_exact_approved_list_and_survive_serialization() {
        let mut grants = Grants::new();
        let a=permission("example.com");let b=permission("aion2.exchange");
        approve(&mut grants,"source","/one",&[a.clone(),b.clone()],std::slice::from_ref(&a)).unwrap();
        assert_eq!(grants["source"].origins,[a.clone()]);
        let mut restored=parse_grants(Some(serde_json::to_string(&grants).unwrap()));
        assert!(!granted(&restored,"source",&b));
        approve(&mut restored,"source","/one",&[a.clone(),b.clone()],std::slice::from_ref(&b)).unwrap();
        assert_eq!(restored["source"].origins,[a,b]);
        restored.remove("source");assert!(restored.is_empty());
    }

    #[test]
    fn stale_or_wildcard_approvals_and_unbounded_sources_are_refused() {
        let mut grants=Grants::new();let a=permission("example.com");
        assert!(approve(&mut grants,"source","/one",std::slice::from_ref(&a),&[permission("other.example")]).is_err());
        assert!(approve(&mut grants,"source","/one",&[permission("*.example.com")],&[permission("*.example.com")]).is_err());
        for i in 0..MAX_SOURCES { grants.insert(i.to_string(),Grant { folder:"/one".into(),origins:vec![] }); }
        assert!(approve(&mut grants,"new","/one",std::slice::from_ref(&a),&[a.clone()]).is_err());
        assert!(parse_grants(Some(r#"{"x":{"folder":"/one","origins":["network:*"]}}"#.into())).is_empty());
        assert!(parse_grants(Some("x".repeat(65_537))).is_empty());
    }

    #[test]
    fn manifest_declaration_and_another_source_cannot_mint_authority() {
        let a=permission("example.com");let b=permission("aion2.exchange");
        let one=source_key("market","/one");let two=source_key("market","/two");
        let mut grants=Grants::new();
        assert!(!granted(&grants,&one,&a));
        approve(&mut grants,&one,"/one",&[a.clone(),b.clone()],std::slice::from_ref(&a)).unwrap();
        assert!(granted(&grants,&one,&a));
        assert!(!granted(&grants,&one,&b));
        assert!(!granted(&grants,&two,&a));
        grants.remove(&one);
        assert!(!granted(&grants,&one,&a));
    }

    #[test]
    fn removed_or_missing_sources_need_fresh_approval() {
        let a=permission("example.com");let mut grants=Grants::new();
        let one=source_key("market","/one");let two=source_key("market","/two");
        let other=source_key("other","/other");
        for (key,folder) in [(&one,"/one"),(&two,"/two"),(&other,"/other")] {
            approve(&mut grants,key,folder,std::slice::from_ref(&a),std::slice::from_ref(&a)).unwrap();
        }
        remove(&mut grants,None,Some("/one")); // no filesystem or manifest needed
        assert!(!granted(&grants,&one,&a));
        assert!(granted(&grants,&two,&a));
        remove(&mut grants,Some("market"),None);
        assert!(!granted(&grants,&two,&a));
        assert!(granted(&grants,&other,&a));
    }

    #[test]
    fn approvals_preserve_existing_settings_and_plugins_on_disk() {
        let dir=std::env::temp_dir().join(format!("a2-network-grants-{}-{}",std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&dir).unwrap();
        let fixture=std::collections::HashMap::from([
            ("dpsMeter.theme".to_string(),"custom-purple".to_string()),
            ("dpsMeter.pluginFolders".to_string(),r#"["C:\\plugins\\market"]"#.to_string()),
            ("dpsMeter.pluginWindows".to_string(),r#"{"cooldowns":"shown"}"#.to_string()),
            ("dpsMeter.hideWhenUnfocused".to_string(),"true".to_string())
        ]);
        // A nonempty seed prevents the existing first-run Kotlin migration.
        std::fs::write(dir.join("settings.json"),serde_json::to_vec(&fixture).unwrap()).unwrap();
        let settings=Settings::new(dir.clone());
        let a=permission("example.com");let mut grants=Grants::new();
        approve(&mut grants,"source","/one",std::slice::from_ref(&a),std::slice::from_ref(&a)).unwrap();
        save_settings(&settings,&grants).unwrap();settings.flush().unwrap();
        let reopened=Settings::new(dir.clone());
        assert!(granted(&parse_grants(reopened.get(KEY)),"source",&a));
        grants.clear();save_settings(&reopened,&grants).unwrap();reopened.flush().unwrap();
        let disk:std::collections::HashMap<String,String>=serde_json::from_slice(&std::fs::read(dir.join("settings.json")).unwrap()).unwrap();
        for (key,value) in fixture { assert_eq!(disk.get(&key),Some(&value)); }
        assert_eq!(disk.len(),5);assert!(parse_grants(disk.get(KEY).cloned()).is_empty());
        approve(&mut grants,"source","/one",std::slice::from_ref(&a),std::slice::from_ref(&a)).unwrap();
        save_settings(&reopened,&grants).unwrap();
        // A failed durable revoke must be reported, not silently resurrected
        // from an older settings file on the next launch.
        std::fs::remove_file(dir.join("settings.json")).unwrap();
        std::fs::create_dir(dir.join("settings.json")).unwrap();
        grants.clear();
        assert!(save_settings(&reopened,&grants).is_err());
        std::fs::remove_dir(dir.join("settings.json")).unwrap();
        grants.clear();save_settings(&reopened,&grants).unwrap();
        drop(settings);drop(reopened);
        std::fs::remove_file(dir.join("settings.json")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn read_modify_write_transactions_cannot_overlap() {
        let (entered_tx,entered_rx)=std::sync::mpsc::channel();
        let (release_tx,release_rx)=std::sync::mpsc::channel();
        let worker=std::thread::spawn(move || mutation(|| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        }));
        entered_rx.recv().unwrap();
        assert!(MUTATION.try_lock().is_err());
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        mutation(|| Ok(())).unwrap();
    }

    #[test]
    fn plugin_surfaces_cannot_change_or_mint_network_grants() {
        for label in ["plugin-market","plugins-dock","pw_market_main"] {
            assert!(!super::super::allowed_from(label,"plugin_approve_network"));
            assert!(!super::super::allowed_from(label,"plugin_revoke_network"));
        }
    }
}
