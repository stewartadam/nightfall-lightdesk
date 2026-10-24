// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use app_runtime::{monitor_bevy_session, run_bevy_session};
use nightfall::constants::APP_LOG_FILE_NAME;
use nightfall_config::RuntimeConfig;
use nightfall_desk::resources::log_config::LogConfig;
use nightfall_engine::prelude::request_graceful_exit;
use tauri::{
    Emitter, EventTarget, Manager, Runtime, WebviewWindow, WebviewWindowBuilder,
    menu::{HELP_SUBMENU_ID, MenuItem, SubmenuBuilder, WINDOW_SUBMENU_ID},
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
/// Project destinations shared with the browser build through configuration data.
struct ProjectLinks {
    documentation: String,
    feedback: String,
    bug_report: String,
}

/// Loads the bundled project links without depending on the working directory.
fn project_links() -> Result<ProjectLinks, String> {
    serde_json::from_str(include_str!("../../../config/project-links.json"))
        .map_err(|error| format!("invalid project link configuration: {error}"))
}

const MENU_ID_APP_FEEDBACK: &str = "app.feedback";
const MENU_ID_APP_REPORT_BUG: &str = "app.report_bug";
const MENU_ID_APP_DIAGNOSTICS: &str = "app.diagnostics";
const MENU_ACTION_EVENT: &str = "nightfall:menu-action";
const MENU_ID_APP_ABOUT: &str = "app.about";
const MENU_ID_APP_SETTINGS: &str = "app.settings";
const MENU_ID_APP_DOCUMENTATION: &str = "app.documentation";
const MENU_ID_APP_QUIT: &str = "app.quit";
const MENU_ID_WINDOW_NEW: &str = "window.new";
const MENU_ID_WINDOW_CLOSE: &str = "window.close";
const MENU_ID_SHOWFILE_NEW: &str = "showfile.new";
const MENU_ID_SHOWFILE_LOAD: &str = "showfile.load";
const MENU_ID_SHOWFILE_SAVE: &str = "showfile.save";
const MENU_ID_SHOWFILE_EXPORT: &str = "showfile.export";
const MENU_ID_EDIT_UNDO: &str = "edit.undo";
const MENU_ID_EDIT_REDO: &str = "edit.redo";
const MENU_ID_VIEW_COMMAND_PALETTE: &str = "view.command_palette";
const MENU_ID_VIEW_OPEN_LOG: &str = "view.open_log";
const MENU_ID_VIEW_KEYBOARD_SHORTCUTS: &str = "view.keyboard_shortcuts";

#[tauri::command]
/// Resolve and reveal the application data directory in the platform file explorer.
pub(super) fn open_data_dir() -> Result<(), String> {
    let data_dir = resolve_open_data_dir_path()?;
    open_path_in_file_explorer(&data_dir)
}

#[tauri::command]
/// Executes a native menu action on behalf of the webview.
pub(super) fn perform_menu_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    action_id: String,
) -> Result<(), String> {
    dispatch_menu_action(&app, &action_id)
}

/// Restricts prefilled issue links to the configured bug-report destination.
fn validate_bug_report_url(url: &str) -> Result<(), String> {
    let expected = tauri::Url::parse(&project_links()?.bug_report)
        .map_err(|error| format!("invalid bug report configuration: {error}"))?;
    let actual =
        tauri::Url::parse(url).map_err(|error| format!("invalid bug report URL: {error}"))?;
    if url.len() > 6000
        || actual.origin() != expected.origin()
        || actual.path() != expected.path()
        || !actual.username().is_empty()
        || actual.password().is_some()
    {
        return Err("invalid bug report destination or oversized summary".to_string());
    }
    Ok(())
}

#[tauri::command]
/// Opens a reviewed diagnostic summary in the configured bug report form.
pub(super) fn open_bug_report(url: String) -> Result<(), String> {
    validate_bug_report_url(&url)?;
    open_url_in_browser(&url)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
/// Reports the exported show directory and any missing supporting assets.
pub(super) struct ShowfileExportResult {
    path: String,
    warnings: Vec<String>,
}

#[tauri::command]
/// Chooses an export folder and writes an independent copy of the current show and selected references.
pub(super) async fn export_showfile(
    app: tauri::AppHandle,
    window: WebviewWindow,
    name: String,
    policy: app_runtime::ShowfileExportPolicy,
) -> Result<Option<ShowfileExportResult>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose Export Folder")
        .pick_folder(move |path| {
            let _ = sender.send(path);
        });
    let Some(parent) = receiver.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let parent = parent.into_path().map_err(|error| error.to_string())?;
    let capture = app_runtime::capture_showfile().await?;
    let app_data =
        nightfall::nightfall_data_dir().ok_or("Application data directory unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut prepared = app_runtime::prepare_showfile_export(
            capture.snapshot,
            &capture.asset_root,
            &app_data,
            policy,
        )?;
        if capture.source != "current engine state" {
            prepared.warnings.push(
                "The engine did not respond; the latest stored showfile was exported.".to_string(),
            );
        }
        let destination = prepared.write_to(&parent, &name)?;
        Ok(Some(ShowfileExportResult {
            path: destination.display().to_string(),
            warnings: prepared.warnings,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
/// Collects selected native files into a ZIP without passing full logs or showfile data through the webview.
pub(super) async fn export_diagnostics<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    options: app_runtime::BundleOptions,
) -> Result<Option<app_runtime::BundleResult>, String> {
    use app_runtime::ShowfileMode;
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save Diagnostics")
        .set_file_name(format!(
            "nightfall-diagnostics-{}.zip",
            jiff::Timestamp::now().strftime("%Y%m%dT%H%M%SZ")
        ))
        .add_filter("ZIP archive", &["zip"]);
    if let Ok(directory) = app.path().download_dir() {
        dialog = dialog.set_directory(directory);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = sender.send(path);
    });
    let Some(destination) = receiver.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let destination = destination.into_path().map_err(|error| error.to_string())?;
    let data_dir =
        nightfall::nightfall_data_dir().ok_or("Application data directory unavailable")?;
    let showfile = if options.showfile_mode == ShowfileMode::None {
        None
    } else {
        Some(app_runtime::capture_showfile().await?)
    };
    tauri::async_runtime::spawn_blocking(move || {
        app_runtime::write_bundle(&destination, &data_dir, options, showfile).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Resolve the application data directory and create it when it does not exist.
pub(super) fn resolve_open_data_dir_path() -> Result<std::path::PathBuf, String> {
    let data_dir = nightfall::nightfall_data_dir()
        .ok_or_else(|| "could not determine Nightfall data directory".to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "failed to create Nightfall data directory {}: {}",
            data_dir.display(),
            error
        )
    })?;
    Ok(data_dir)
}

/// Resolve the application log file path and ensure its parent directory exists.
pub(super) fn resolve_open_log_file_path() -> Result<std::path::PathBuf, String> {
    Ok(resolve_open_data_dir_path()?.join(APP_LOG_FILE_NAME))
}

/// Opens a directory in the platform's file explorer.
pub(super) fn open_path_in_file_explorer(path: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))
}

/// Open the application log file with the platform's default file handler.
pub(super) fn open_log_file() -> Result<(), String> {
    let log_path = resolve_open_log_file_path()?;
    tauri_plugin_opener::open_path(&log_path, None::<&str>)
        .map_err(|error| format!("failed to open {}: {error}", log_path.display()))
}

/// Open an external URL with the current platform's default browser.
pub(super) fn open_url_in_browser(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|error| format!("failed to open browser for {url}: {error}"))
}

/// Build one native menu item with a stable action identifier and accelerator.
pub(super) fn menu_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    id: &'static str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(manager, id, text, true, accelerator)
}

/// Build the native File menu and its showfile actions.
pub(super) fn build_file_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    include_settings: bool,
    quit_label: Option<&str>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, "File")
        .item(&menu_item(
            app,
            MENU_ID_WINDOW_NEW,
            "New Window",
            Some("CmdOrCtrl+N"),
        )?)
        .separator()
        .item(&menu_item(
            app,
            MENU_ID_SHOWFILE_NEW,
            "New Showfile",
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .item(&menu_item(
            app,
            MENU_ID_SHOWFILE_LOAD,
            "Open Showfile...",
            Some("CmdOrCtrl+O"),
        )?)
        .item(&menu_item(
            app,
            MENU_ID_SHOWFILE_SAVE,
            "Save Showfile",
            Some("CmdOrCtrl+S"),
        )?)
        .item(&menu_item(
            app,
            MENU_ID_SHOWFILE_EXPORT,
            "Export Showfile...",
            None,
        )?)
        .separator();

    if include_settings {
        builder = builder
            .item(&menu_item(
                app,
                MENU_ID_APP_SETTINGS,
                "Settings...",
                Some("CmdOrCtrl+,"),
            )?)
            .separator();
    }

    builder = builder.item(&menu_item(
        app,
        MENU_ID_WINDOW_CLOSE,
        "Close Window",
        Some("CmdOrCtrl+Shift+W"),
    )?);

    if let Some(label) = quit_label {
        builder = builder
            .separator()
            .item(&menu_item(app, MENU_ID_APP_QUIT, label, None)?);
    }

    builder.build()
}

/// Build the native Edit menu and its undo and redo actions.
pub(super) fn build_edit_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    redo_accelerator: &str,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    SubmenuBuilder::new(app, "Edit")
        .item(&menu_item(
            app,
            MENU_ID_EDIT_UNDO,
            "Undo",
            Some("CmdOrCtrl+Z"),
        )?)
        .item(&menu_item(
            app,
            MENU_ID_EDIT_REDO,
            "Redo",
            Some(redo_accelerator),
        )?)
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()
}

/// Build the native View menu and its panel-navigation actions.
pub(super) fn build_view_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    SubmenuBuilder::new(app, "View")
        .item(&menu_item(
            app,
            MENU_ID_VIEW_COMMAND_PALETTE,
            "Open Command Palette...",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .build()
}

/// Build the native troubleshooting submenu for logs, bug reports, and diagnostics.
pub(super) fn build_troubleshooting_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    SubmenuBuilder::new(app, "Troubleshooting")
        .item(&menu_item(app, MENU_ID_VIEW_OPEN_LOG, "Open Log", None)?)
        .item(&menu_item(
            app,
            MENU_ID_APP_REPORT_BUG,
            "Report a Bug",
            None,
        )?)
        .item(&menu_item(
            app,
            MENU_ID_APP_DIAGNOSTICS,
            "Collect Diagnostics",
            None,
        )?)
        .build()
}

/// Build the native Help menu with documentation, feedback, and troubleshooting.
pub(super) fn build_help_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
    use_platform_id: bool,
    include_about: bool,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut builder = if use_platform_id {
        SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
    } else {
        SubmenuBuilder::new(app, "Help")
    }
    .item(&menu_item(
        app,
        MENU_ID_APP_DOCUMENTATION,
        "Documentation",
        None,
    )?)
    .item(&menu_item(
        app,
        MENU_ID_APP_FEEDBACK,
        "Give Feedback",
        None,
    )?)
    .item(&build_troubleshooting_menu(app)?);

    if include_about {
        builder = builder.separator();
    }

    // The web UI binds this to a bare `?`, which a native accelerator would steal from
    // text fields, so the item carries no accelerator rather than a key that differs.
    builder = builder.item(&menu_item(
        app,
        MENU_ID_VIEW_KEYBOARD_SHORTCUTS,
        "Keyboard Shortcuts",
        None,
    )?);

    if include_about {
        builder =
            builder
                .separator()
                .item(&menu_item(app, MENU_ID_APP_ABOUT, "About Nightfall", None)?);
    }

    builder.build()
}

/// Build the macOS application menu with standard settings, about, and quit items.
pub(super) fn build_macos_app_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    SubmenuBuilder::new(app, "Nightfall")
        .item(&menu_item(app, MENU_ID_APP_ABOUT, "About Nightfall", None)?)
        .separator()
        .item(&menu_item(
            app,
            MENU_ID_APP_SETTINGS,
            "Settings...",
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&menu_item(
            app,
            MENU_ID_APP_QUIT,
            "Quit Nightfall",
            Some("CmdOrCtrl+Q"),
        )?)
        .build()
}

/// Build the macOS Window menu with standard window-management items.
pub(super) fn build_macos_window_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize_with_text("Zoom")
        .separator()
        .item(&menu_item(
            app,
            MENU_ID_WINDOW_CLOSE,
            "Close Window",
            Some("CmdOrCtrl+Shift+W"),
        )?)
        .build()
}

/// Assemble the complete platform-native menu bar for the Tauri application.
pub(super) fn build_tauri_menu<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let is_macos = cfg!(target_os = "macos");
    let is_windows = cfg!(target_os = "windows");

    let file_menu = build_file_menu(
        app,
        !is_macos,
        if is_macos {
            None
        } else if is_windows {
            Some("Exit")
        } else {
            Some("Quit")
        },
    )?;
    let edit_menu = build_edit_menu(
        app,
        if is_macos {
            "CmdOrCtrl+Shift+Z"
        } else {
            "CmdOrCtrl+Y"
        },
    )?;
    let view_menu = build_view_menu(app)?;
    let help_menu = build_help_menu(app, is_macos, !is_macos)?;

    if is_macos {
        let app_menu = build_macos_app_menu(app)?;
        let window_menu = build_macos_window_menu(app)?;

        return tauri::menu::MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build();
    }

    tauri::menu::MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()
}

/// Emit a menu action to the focused webview so the frontend can execute it.
pub(super) fn emit_menu_action_to_focused_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    action_id: &str,
) -> tauri::Result<()> {
    let Some(window) = target_webview_window(app) else {
        return Ok(());
    };

    app.emit_to(
        EventTarget::webview_window(window.label()),
        MENU_ACTION_EVENT,
        action_id.to_string(),
    )
}

/// Select the focused webview window, falling back to any available window.
pub(super) fn target_webview_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<WebviewWindow<R>> {
    let webview_windows = app.webview_windows();

    webview_windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| webview_windows.get("main").cloned())
        .or_else(|| webview_windows.values().next().cloned())
}

/// Close the currently targeted webview window when one is available.
pub(super) fn close_focused_window<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = target_webview_window(app) {
        window.close()?;
    }

    Ok(())
}

/// Generate a unique label for a newly created desktop window.
pub(super) fn next_window_label<R: Runtime>(app: &tauri::AppHandle<R>) -> String {
    let existing_labels: HashSet<String> = app.webview_windows().keys().cloned().collect();
    let mut counter = 2usize;

    loop {
        let label = format!("main-{counter}");
        if !existing_labels.contains(&label) {
            return label;
        }
        counter += 1;
    }
}

/// Returns the window template from the Tauri config that every app window is built from.
fn template_window_config<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::utils::config::WindowConfig, String> {
    app.config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "tauri config does not define a template window".to_string())
}

/// Reports whether a popup target should be handed to the system instead of being dropped.
///
/// Only web pages and mail links leave the app; other schemes (`about:`, `file:`,
/// `javascript:` and the app's own asset protocols) could expose local content or
/// run outside the webview's sandbox.
fn is_external_link(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Builds an app window from `config` that sends popup requests to the system browser.
///
/// The webview never opens its own child windows: `target="_blank"` links and
/// `window.open` calls are denied in-app, and http(s)/mailto targets are passed to
/// the platform's default handler instead. Without this, WKWebView and WebKitGTK
/// silently ignore those requests.
fn build_app_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    config: &tauri::utils::config::WindowConfig,
) -> Result<WebviewWindow<R>, String> {
    WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("failed to create window builder: {error}"))?
        .on_new_window(|url, _features| {
            if !is_external_link(&url) {
                tracing::warn!(%url, "Blocked a popup with a non-web URL");
            } else if let Err(error) = open_url_in_browser(url.as_str()) {
                tracing::error!(%url, "Failed to open link in the system browser: {error}");
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| format!("failed to create window: {error}"))
}

/// Creates the first app window, which the Tauri config leaves to the shell so it gets the popup handler.
fn create_main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    build_app_window(app, &template_window_config(app)?)?;
    Ok(())
}

/// Create a desktop window using the configured frontend entry point and dimensions.
pub(super) fn create_new_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let mut window_config = template_window_config(app)?;
    window_config.label = next_window_label(app);

    let window = build_app_window(app, &window_config)?;

    window
        .set_focus()
        .map_err(|error| format!("failed to focus new window: {error}"))?;

    Ok(())
}

/// Schedule creation of a new desktop window on Tauri's asynchronous runtime.
pub(super) fn spawn_new_window<R: Runtime + 'static>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        if let Err(error) = create_new_window(&app) {
            tracing::error!("{error}");
        }
    });
}

/// Dispatch a native menu event through the shared desktop action router.
pub(super) fn handle_tauri_menu_event<R: Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    if let Err(error) = dispatch_menu_action(app, event.id().as_ref()) {
        tracing::error!(
            menu_item = %event.id().as_ref(),
            "Failed to handle Tauri menu event: {error}"
        );
    }
}

/// Routes a menu action id to the corresponding native or webview-side behavior.
pub(super) fn dispatch_menu_action<R: Runtime + 'static>(
    app: &tauri::AppHandle<R>,
    action_id: &str,
) -> Result<(), String> {
    match action_id {
        MENU_ID_WINDOW_NEW => {
            spawn_new_window(app.clone());
            Ok(())
        }
        MENU_ID_WINDOW_CLOSE => close_focused_window(app).map_err(|error| error.to_string()),
        MENU_ID_APP_DOCUMENTATION => open_url_in_browser(&project_links()?.documentation),
        MENU_ID_APP_FEEDBACK => open_url_in_browser(&project_links()?.feedback),
        MENU_ID_APP_QUIT => {
            app.exit(0);
            Ok(())
        }
        MENU_ID_APP_ABOUT
        | MENU_ID_APP_REPORT_BUG
        | MENU_ID_APP_DIAGNOSTICS
        | MENU_ID_APP_SETTINGS
        | MENU_ID_SHOWFILE_NEW
        | MENU_ID_SHOWFILE_LOAD
        | MENU_ID_SHOWFILE_SAVE
        | MENU_ID_SHOWFILE_EXPORT
        | MENU_ID_EDIT_UNDO
        | MENU_ID_EDIT_REDO
        | MENU_ID_VIEW_COMMAND_PALETTE
        | MENU_ID_VIEW_KEYBOARD_SHORTCUTS => {
            emit_menu_action_to_focused_window(app, action_id).map_err(|error| error.to_string())
        }
        MENU_ID_VIEW_OPEN_LOG => open_log_file().map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

/// How long quitting waits for the backend to save the draft and stop before closing anyway.
const BACKEND_EXIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Holds a quit, or the last window closing, until the backend has saved and stopped.
///
/// The first exit request asks the backend to save the draft and stop; the backend thread
/// then exits the app itself. If the backend does not stop in time, the app exits anyway. Once
/// the backend has stopped the deadline no longer applies, so installing an update, which may
/// wait on a system password prompt, is never cut short.
///
/// Tauri ends the process right after the final exit event without returning to `main`, so
/// reports still in memory are written to disk then.
fn defer_exit_until_backend_stops(event: tauri::RunEvent, backend_stopped: &Arc<AtomicBool>) {
    if matches!(event, tauri::RunEvent::Exit) {
        app_runtime::flush_reports();
        return;
    }
    let tauri::RunEvent::ExitRequested { api, .. } = event else {
        return;
    };
    if backend_stopped.load(Ordering::Acquire) {
        return;
    }
    api.prevent_exit();
    if request_graceful_exit("desktop app quit") {
        let backend_stopped = backend_stopped.clone();
        std::thread::spawn(move || {
            std::thread::sleep(BACKEND_EXIT_TIMEOUT);
            if backend_stopped.load(Ordering::Acquire) {
                return;
            }
            tracing::error!("Backend did not stop in time after quit; exiting anyway");
            std::process::exit(1);
        });
    }
}

/// Launch the Tauri shell and run the Bevy backend on a dedicated worker thread.
pub fn run_tauri(log_config: LogConfig, mut runtime_config: RuntimeConfig) {
    let backend_stopped = Arc::new(AtomicBool::new(false));
    let backend_stopped_for_setup = backend_stopped.clone();
    let update_controller = Arc::new(crate::updates::UpdateController::load());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().skip_logger().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(crate::updates::plugin())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("backend-config")
                .js_init_script(format!(
                    "window.__NIGHTFALL_BACKEND_PORT__ = {};",
                    runtime_config.server_port
                ))
                .build(),
        );
    #[cfg(debug_assertions)]
    let builder = builder.plugin(crate::updates::debug::plugin());
    builder
        .menu(build_tauri_menu)
        .on_menu_event(handle_tauri_menu_event)
        .invoke_handler(tauri::generate_handler![
            open_data_dir,
            perform_menu_action,
            export_diagnostics,
            export_showfile,
            open_bug_report,
            collect_diagnostic_logs,
            crate::updates::update_state,
            crate::updates::set_update_checks,
            crate::updates::set_update_mode,
            crate::updates::check_for_updates,
            crate::updates::download_update,
            crate::updates::restart_to_update,
            #[cfg(debug_assertions)]
            crate::updates::debug::debug_update_state,
            #[cfg(debug_assertions)]
            crate::updates::debug::debug_update_preset,
            #[cfg(debug_assertions)]
            crate::updates::debug::debug_update_presets,
            #[cfg(debug_assertions)]
            crate::updates::debug::debug_reset_update_state
        ])
        .manage(update_controller.clone())
        .setup(move |app| {
            crate::updates::start(app.handle(), update_controller);
            runtime_config.resource_dir = if tauri::is_dev() {
                None
            } else {
                Some(app.path().resource_dir().map_err(|error| {
                    std::io::Error::other(format!(
                        "Failed to resolve application resource directory: {error}"
                    ))
                })?)
            };
            create_main_window(app.handle()).map_err(std::io::Error::other)?;
            let web_ui = (!tauri::is_dev())
                .then(|| crate::web_ui::embedded_web_ui(app))
                .flatten();
            let app_handle = app.handle().clone();
            // Start the rest of the system (Bevy, Axum, terminal) in background tasks
            std::thread::spawn(move || {
                // Start a Tokio runtime for the backend threads
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("Failed to create tokio runtime");

                let exit_code = rt.block_on(async {
                    let cycle_log_config = log_config.clone();
                    let cycle_runtime_config = runtime_config.clone();
                    let bevy_task = tokio::task::spawn_blocking(move || {
                        run_bevy_session(
                            "tauri-bevy-session",
                            cycle_log_config,
                            cycle_runtime_config,
                            None,
                            web_ui,
                        )
                    });
                    monitor_bevy_session(bevy_task).await
                });

                backend_stopped_for_setup.store(true, Ordering::Release);
                // After a clean exit, a downloaded update installs if the operator chose to restart
                // into it, or on any quit when automatic installs are on. Only a restart returns true.
                if exit_code == 0 && crate::updates::install_pending_update(&app_handle) {
                    return;
                }
                app_handle.exit(exit_code);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error building the tauri application")
        .run(move |_app, event| defer_exit_until_backend_stops(event, &backend_stopped));
}

#[cfg(test)]
mod diagnostics_tests {
    /// Prefill URLs remain constrained to the configured issue form and a bounded query size.
    #[test]
    fn bug_report_urls_validate_destination_and_size() {
        let base = super::project_links().unwrap().bug_report;
        assert!(super::validate_bug_report_url(&format!("{base}&diagnostics=example")).is_ok());
        assert!(super::validate_bug_report_url("https://example.com/issues/new").is_err());
        assert!(
            super::validate_bug_report_url(&format!("{base}&diagnostics={}", "x".repeat(6000)))
                .is_err()
        );
        assert!(super::validate_bug_report_url("file:///tmp/report").is_err());
    }

    /// Popups to web pages and mail links reach the system, while local or script URLs stay blocked.
    #[test]
    fn only_web_and_mail_popups_leave_the_app() {
        let external = |url: &str| super::is_external_link(&tauri::Url::parse(url).unwrap());
        assert!(external("https://nightfall.live/privacy"));
        assert!(external("http://192.168.1.20:3030/"));
        assert!(external("mailto:hello@nightfall.live"));
        assert!(!external("about:blank"));
        assert!(!external("file:///etc/passwd"));
        assert!(!external("javascript:alert(1)"));
        assert!(!external("tauri://localhost/index.html"));
    }
}

#[tauri::command]
/// Reads persisted log pages through native IPC while keeping the reader in the runtime.
async fn collect_diagnostic_logs(
    mode: app_runtime::DiagnosticLogMode,
    offset: Option<u64>,
    file_length: Option<u64>,
) -> Result<app_runtime::DiagnosticLogPage, String> {
    app_runtime::collect_diagnostic_logs(mode, offset, file_length).await
}

#[cfg(test)]
mod platform_tests {
    use super::*;
    static PROCESS_CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    /// Verifies the open-data helper creates the typed configured directory.
    #[test]
    fn resolve_open_data_dir_path_creates_configured_directory() {
        let _guard = PROCESS_CONFIG_LOCK.lock().expect("process config lock");
        let temp_root = std::env::temp_dir().join(format!(
            "nightfall-open-data-dir-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let override_dir = temp_root.join("data-root");

        nightfall::set_nightfall_data_dir(Some(override_dir.clone()));

        let resolved = resolve_open_data_dir_path().expect("resolve open data dir path");
        assert_eq!(resolved, override_dir);
        assert!(
            resolved.is_dir(),
            "expected created directory at {}",
            resolved.display()
        );

        nightfall::set_nightfall_data_dir(None);
        std::fs::remove_dir_all(&temp_root).expect("cleanup temp root");
    }

    /// Verifies the open-log helper uses the application log filename.
    #[test]
    fn resolve_open_log_file_path_uses_application_log_name() {
        let _guard = PROCESS_CONFIG_LOCK.lock().expect("process config lock");
        let temp_root = std::env::temp_dir().join(format!(
            "nightfall-open-log-path-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let override_dir = temp_root.join("data-root");

        nightfall::set_nightfall_data_dir(Some(override_dir.clone()));

        let resolved = resolve_open_log_file_path().expect("resolve open log file path");
        assert_eq!(resolved, override_dir.join("nightfall.log"));
        assert!(
            override_dir.is_dir(),
            "expected log parent directory to exist"
        );

        nightfall::set_nightfall_data_dir(None);
        std::fs::remove_dir_all(&temp_root).expect("cleanup temp root");
    }
}

#[cfg(test)]
mod logging_tests {
    use std::fs::File;

    use tracing_subscriber::prelude::*;
    /// The plugin's log facade feeds the existing tracing bridge exactly once at the original level.
    #[test]
    fn plugin_log_records_reach_the_tracing_file_once() {
        tracing_subscriber::registry().try_init().unwrap();
        let _plugin = tauri_plugin_log::Builder::new()
            .skip_logger()
            .build::<tauri::Wry>();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nightfall.log");
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(std::sync::Mutex::new(File::create(&path).unwrap())),
        );
        tracing::subscriber::with_default(subscriber, || {
            tauri_plugin_log::log::logger().log(
                &tauri_plugin_log::log::Record::builder()
                    .level(tauri_plugin_log::log::Level::Warn)
                    .target("webview")
                    .args(format_args!("browser warning"))
                    .build(),
            );
        });
        let logs: Vec<serde_json::Value> = std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0]["level"], "WARN");
        assert_eq!(logs[0]["target"], "webview");
        assert_eq!(logs[0]["fields"]["message"], "browser warning");
    }
}
