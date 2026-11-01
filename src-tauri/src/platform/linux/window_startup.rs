//! WebKitGTK can load a window hidden, so the main meter and Settings are
//! shown only once their page is ready, and Settings is kept when closed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

static MAIN_REVEALED: AtomicBool = AtomicBool::new(false);
static SETTINGS_READY: AtomicBool = AtomicBool::new(false);
static SETTINGS_OPEN_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn loads_hidden() -> bool {
    true
}

pub fn reuses_settings() -> bool {
    true
}

pub fn main_ready(window: &tauri::WebviewWindow) {
    if window.label() == "main" && !MAIN_REVEALED.swap(true, Ordering::SeqCst) {
        let _ = window.show();
    }
}

pub fn arm_main_fallback(window: tauri::WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let target = window.clone();
        let _ = window.run_on_main_thread(move || main_ready(&target));
    });
}

/// Whether an existing Settings window can be shown now. Until its page is
/// ready, the request is remembered and the page shows it.
pub fn request_settings_open() -> bool {
    SETTINGS_OPEN_REQUESTED.store(true, Ordering::SeqCst);
    SETTINGS_READY.load(Ordering::SeqCst)
}

/// The page is ready. Whether it should be shown: not after a Close.
pub fn settings_ready() -> bool {
    SETTINGS_READY.store(true, Ordering::SeqCst);
    SETTINGS_OPEN_REQUESTED.load(Ordering::SeqCst)
}

pub fn begin_settings_load() {
    SETTINGS_READY.store(false, Ordering::SeqCst);
}

pub fn hide_settings(window: &tauri::WebviewWindow) {
    SETTINGS_OPEN_REQUESTED.store(false, Ordering::SeqCst);
    let _ = window.hide();
}

pub fn prepare_settings(window: &tauri::WebviewWindow) {
    let closing_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            // Hiding does not fire pagehide: pause polling and flush input.
            // The page's own Close announces this itself.
            let _ = closing_window.emit_to(closing_window.label(), "settings-hidden", ());
            hide_settings(&closing_window);
        }
    });
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            // Recover from a page that never got ready, but never undo a Close.
            if !SETTINGS_READY.swap(true, Ordering::SeqCst)
                && SETTINGS_OPEN_REQUESTED.load(Ordering::SeqCst)
                && crate::app::reveal_settings(&target)
            {
                // The bridge may already be waiting for a slow form startup.
                // A fallback reveal is also an activation, so resume its work.
                let _ = target.emit_to(target.label(), "settings-shown", ());
            }
        });
    });
}

pub fn center_before_show(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    size: tauri::LogicalSize<f64>,
) {
    // Before GTK maps a window, outer_size can be 0x0. Use its requested
    // size so the top-left corner does not land at the screen center.
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let origin = monitor.position();
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        let x = origin.x + ((screen.width as i32 - (size.width * scale).round() as i32) / 2).max(0);
        let y = origin.y + ((screen.height as i32 - (size.height * scale).round() as i32) / 2).max(0);
        let _ = window.set_position(tauri::PhysicalPosition { x, y });
    } else {
        let _ = window.center();
    }
}
