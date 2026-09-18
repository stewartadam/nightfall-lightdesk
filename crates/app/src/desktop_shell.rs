// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[cfg(any(test, feature = "tauri"))]
use std::path::Path;
#[cfg(feature = "tauri")]
use std::{collections::HashSet, process::Command};

#[cfg(any(test, feature = "tauri"))]
use nightfall::constants::APP_LOG_FILE_NAME;
#[cfg(feature = "tauri")]
use nightfall_config::RuntimeConfig;
#[cfg(feature = "tauri")]
use nightfall_desk::resources::log_config::LogConfig;
#[cfg(feature = "tauri")]
use tauri::{
    Emitter, EventTarget, Manager, Runtime, WebviewWindow, WebviewWindowBuilder,
    menu::{HELP_SUBMENU_ID, MenuItem, SubmenuBuilder, WINDOW_SUBMENU_ID},
};

#[cfg(feature = "tauri")]
use crate::{session::run_bevy_session, shutdown::monitor_bevy_session};

#[cfg(feature = "tauri")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
/// Project destinations shared with the browser build through configuration data.
struct ProjectLinks {
    documentation: String,
    feedback: String,
    bug_report: String,
}

#[cfg(feature = "tauri")]
/// Loads the bundled project links without depending on the working directory.
fn project_links() -> Result<ProjectLinks, String> {
    serde_json::from_str(include_str!("../../../config/project-links.json"))
        .map_err(|error| format!("invalid project link configuration: {error}"))
}

#[cfg(feature = "tauri")]
const MENU_ID_APP_FEEDBACK: &str = "app.feedback";
#[cfg(feature = "tauri")]
const MENU_ID_APP_REPORT_BUG: &str = "app.report_bug";
#[cfg(feature = "tauri")]
const MENU_ID_APP_DIAGNOSTICS: &str = "app.diagnostics";
#[cfg(feature = "tauri")]
const MENU_ACTION_EVENT: &str = "nightfall:menu-action";
#[cfg(feature = "tauri")]
const MENU_ID_APP_ABOUT: &str = "app.about";
#[cfg(feature = "tauri")]
const MENU_ID_APP_SETTINGS: &str = "app.settings";
#[cfg(feature = "tauri")]
const MENU_ID_APP_DOCUMENTATION: &str = "app.documentation";
#[cfg(feature = "tauri")]
const MENU_ID_APP_QUIT: &str = "app.quit";
#[cfg(feature = "tauri")]
const MENU_ID_WINDOW_NEW: &str = "window.new";
#[cfg(feature = "tauri")]
const MENU_ID_WINDOW_CLOSE: &str = "window.close";
#[cfg(feature = "tauri")]
const MENU_ID_SHOWFILE_NEW: &str = "showfile.new";
#[cfg(feature = "tauri")]
const MENU_ID_SHOWFILE_LOAD: &str = "showfile.load";
#[cfg(feature = "tauri")]
const MENU_ID_SHOWFILE_SAVE: &str = "showfile.save";
#[cfg(feature = "tauri")]
const MENU_ID_SHOWFILE_EXPORT: &str = "showfile.export";
#[cfg(feature = "tauri")]
const MENU_ID_EDIT_UNDO: &str = "edit.undo";
#[cfg(feature = "tauri")]
const MENU_ID_EDIT_REDO: &str = "edit.redo";
#[cfg(feature = "tauri")]
const MENU_ID_VIEW_COMMAND_PALETTE: &str = "view.command_palette";
#[cfg(feature = "tauri")]
const MENU_ID_VIEW_OPEN_LOG: &str = "view.open_log";
#[cfg(feature = "tauri")]
const MENU_ID_VIEW_KEYBOARD_SHORTCUTS: &str = "view.keyboard_shortcuts";

#[cfg(feature = "tauri")]
#[tauri::command]
/// Resolve and reveal the application data directory in the platform file explorer.
pub(super) fn open_data_dir() -> Result<(), String> {
    let data_dir = resolve_open_data_dir_path()?;
    open_path_in_file_explorer(&data_dir)
}

#[cfg(feature = "tauri")]
#[tauri::command]
/// Executes a native menu action on behalf of the webview.
pub(super) fn perform_menu_action<R: Runtime>(
    app: tauri::AppHandle<R>,
    action_id: String,
) -> Result<(), String> {
    dispatch_menu_action(&app, &action_id)
}

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
#[tauri::command]
/// Opens a reviewed diagnostic summary in the configured bug report form.
pub(super) fn open_bug_report(url: String) -> Result<(), String> {
    validate_bug_report_url(&url)?;
    open_url_in_browser(&url)
}

#[cfg(feature = "tauri")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
/// Reports the exported show directory and any missing supporting assets.
pub(super) struct ShowfileExportResult {
    path: String,
    warnings: Vec<String>,
}

#[cfg(feature = "tauri")]
#[tauri::command]
/// Chooses an export folder and writes an independent copy of the current show and selected references.
pub(super) async fn export_showfile(
    app: tauri::AppHandle,
    window: WebviewWindow,
    name: String,
    policy: crate::ShowfileExportPolicy,
    save_options: nightfall_desk::prelude::ShowfileSaveOptions,
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
    let mut capture = crate::diagnostic_showfile::capture_showfile().await?;
    if let Some(layout) = save_options.active_panel_layout {
        capture.snapshot.settings.active_panel_layout = Some(layout);
    }
    let app_data =
        nightfall::nightfall_data_dir().ok_or("Application data directory unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut prepared = crate::prepare_showfile_export(
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

#[cfg(feature = "tauri")]
#[tauri::command]
/// Collects selected native files into a ZIP without passing full logs or showfile data through the webview.
pub(super) async fn export_diagnostics<R: Runtime>(
    app: tauri::AppHandle<R>,
    window: WebviewWindow<R>,
    options: crate::diagnostic_bundle::BundleOptions,
) -> Result<Option<crate::diagnostic_bundle::BundleResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    use crate::diagnostic_bundle::ShowfileMode;
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
        Some(crate::diagnostic_showfile::capture_showfile().await?)
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::diagnostic_bundle::write_bundle(&destination, &data_dir, options, showfile).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(any(test, feature = "tauri"))]
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

#[cfg(any(test, feature = "tauri"))]
/// Resolve the application log file path and ensure its parent directory exists.
pub(super) fn resolve_open_log_file_path() -> Result<std::path::PathBuf, String> {
    Ok(resolve_open_data_dir_path()?.join(APP_LOG_FILE_NAME))
}

#[cfg(feature = "tauri")]
/// Reveal a filesystem path with the current platform's file explorer.
pub(super) fn open_path_in_file_explorer(path: &Path) -> Result<(), String> {
    let (program, args) = file_explorer_command(path)?;
    spawn_open_command(
        program,
        args,
        &format!("file explorer for {}", path.display()),
    )
}

#[cfg(feature = "tauri")]
/// Open the application log file with the platform's default file handler.
pub(super) fn open_log_file() -> Result<(), String> {
    let log_path = resolve_open_log_file_path()?;

    #[cfg(target_os = "windows")]
    {
        return open_file_with_shell_execute(&log_path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let (program, args) = file_open_command(&log_path)?;
        return spawn_open_command(
            program,
            args,
            &format!("default application for {}", log_path.display()),
        );
    }
}

#[cfg(all(feature = "tauri", target_os = "windows"))]
/// Open a file through Windows ShellExecute without routing its path through a shell.
fn open_file_with_shell_execute(path: &Path) -> Result<(), String> {
    use std::{ffi::OsStr, iter::once, os::windows::ffi::OsStrExt, ptr::null_mut};

    let operation: Vec<u16> = OsStr::new("open").encode_wide().chain(once(0)).collect();
    let file: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    let result = unsafe {
        shell_execute_w(
            null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };

    if result <= 32 {
        return Err(format!(
            "failed to open {} with its default application (ShellExecuteW returned {result})",
            path.display()
        ));
    }

    Ok(())
}

#[cfg(all(feature = "tauri", target_os = "windows"))]
#[link(name = "shell32")]
unsafe extern "system" {
    #[link_name = "ShellExecuteW"]
    fn shell_execute_w(
        hwnd: *mut std::ffi::c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_command: i32,
    ) -> isize;
}

#[cfg(any(test, feature = "tauri"))]
/// Construct the platform-specific command used to reveal a filesystem path.
pub(super) fn file_explorer_command(
    path: &Path,
) -> Result<(&'static str, Vec<std::ffi::OsString>), String> {
    #[cfg(target_os = "windows")]
    {
        return Ok(("explorer.exe", vec![path.as_os_str().to_owned()]));
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(("open", vec![path.as_os_str().to_owned()]));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(("xdg-open", vec![path.as_os_str().to_owned()]));
    }

    #[allow(unreachable_code)]
    Err(format!(
        "opening the data directory is not supported on this platform: {}",
        std::env::consts::OS
    ))
}

#[cfg(any(test, feature = "tauri"))]
/// Construct the platform-specific command used to open a file with its associated application.
pub(super) fn file_open_command(
    path: &Path,
) -> Result<(&'static str, Vec<std::ffi::OsString>), String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(("open", vec![path.as_os_str().to_owned()]));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(("xdg-open", vec![path.as_os_str().to_owned()]));
    }

    #[allow(unreachable_code)]
    #[cfg(target_os = "windows")]
    let _ = path;

    #[allow(unreachable_code)]
    Err(format!(
        "opening files is not supported on this platform: {}",
        std::env::consts::OS
    ))
}

#[cfg(feature = "tauri")]
/// Open an external URL with the current platform's default browser.
pub(super) fn open_url_in_browser(url: &str) -> Result<(), String> {
    let (program, args) = url_open_command(url)?;
    spawn_open_command(program, args, &format!("browser for {url}"))
}

#[cfg(feature = "tauri")]
/// Spawn a detached platform command and report launch failures with context.
pub(super) fn spawn_open_command(
    program: &str,
    args: Vec<std::ffi::OsString>,
    target_description: &str,
) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .spawn()
        .map_err(|error| format!("failed to launch {target_description}: {error}"))?;
    Ok(())
}

#[cfg(any(test, feature = "tauri"))]
/// Construct the platform-specific command used to open an external URL.
pub(super) fn url_open_command(
    url: &str,
) -> Result<(&'static str, Vec<std::ffi::OsString>), String> {
    #[cfg(target_os = "windows")]
    {
        return Ok(("explorer.exe", vec![std::ffi::OsString::from(url)]));
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(("open", vec![std::ffi::OsString::from(url)]));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(("xdg-open", vec![std::ffi::OsString::from(url)]));
    }

    #[allow(unreachable_code)]
    Err(format!(
        "opening URLs is not supported on this platform: {}",
        std::env::consts::OS
    ))
}

#[cfg(feature = "tauri")]
/// Build one native menu item with a stable action identifier and accelerator.
pub(super) fn menu_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    id: &'static str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(manager, id, text, true, accelerator)
}

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

    builder = builder.item(&menu_item(
        app,
        MENU_ID_VIEW_KEYBOARD_SHORTCUTS,
        "Keyboard Shortcuts",
        Some("CmdOrCtrl+Shift+/"),
    )?);

    if include_about {
        builder =
            builder
                .separator()
                .item(&menu_item(app, MENU_ID_APP_ABOUT, "About Nightfall", None)?);
    }

    builder.build()
}

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
/// Close the currently targeted webview window when one is available.
pub(super) fn close_focused_window<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = target_webview_window(app) {
        window.close()?;
    }

    Ok(())
}

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
/// Create a desktop window using the configured frontend entry point and dimensions.
pub(super) fn create_new_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let Some(window_config) = app.config().app.windows.first() else {
        return Err("tauri config does not define a template window".to_string());
    };

    let mut window_config = window_config.clone();
    window_config.label = next_window_label(app);

    let window = WebviewWindowBuilder::from_config(app, &window_config)
        .map_err(|error| format!("failed to create window builder: {error}"))?
        .build()
        .map_err(|error| format!("failed to create window: {error}"))?;

    window
        .set_focus()
        .map_err(|error| format!("failed to focus new window: {error}"))?;

    Ok(())
}

#[cfg(feature = "tauri")]
/// Schedule creation of a new desktop window on Tauri's asynchronous runtime.
pub(super) fn spawn_new_window<R: Runtime + 'static>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        if let Err(error) = create_new_window(&app) {
            tracing::error!("{error}");
        }
    });
}

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
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

#[cfg(feature = "tauri")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Launch the Tauri shell and run the Bevy backend on a dedicated worker thread.
pub fn run_tauri(log_config: LogConfig, mut runtime_config: RuntimeConfig) {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().skip_logger().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("backend-config")
                .js_init_script(format!(
                    "window.__NIGHTFALL_BACKEND_PORT__ = {};",
                    runtime_config.server_port
                ))
                .build(),
        )
        .menu(build_tauri_menu)
        .on_menu_event(handle_tauri_menu_event)
        .invoke_handler(tauri::generate_handler![
            open_data_dir,
            perform_menu_action,
            export_diagnostics,
            export_showfile,
            open_bug_report,
            crate::diagnostic_logs::collect_diagnostic_logs
        ])
        .setup(move |app| {
            runtime_config.resource_dir = if tauri::is_dev() {
                None
            } else {
                Some(app.path().resource_dir().map_err(|error| {
                    std::io::Error::other(format!(
                        "Failed to resolve application resource directory: {error}"
                    ))
                })?)
            };
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
                        )
                    });
                    monitor_bevy_session(bevy_task).await
                });

                app_handle.exit(exit_code);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error building the tauri application");
}

#[cfg(test)]
mod diagnostics_tests {
    /// Prefill URLs remain constrained to the configured issue form and a bounded query size.
    #[cfg(feature = "tauri")]
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
}
