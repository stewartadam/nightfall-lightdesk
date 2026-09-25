// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Streaming diagnostic ZIP export containing a separately loadable showfile export.

use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek, Write},
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

use crate::{
    diagnostic_logs::{DiagnosticLogMode, complete_log_length, read_diagnostic_logs_until},
    diagnostic_showfile::DiagnosticShowfile,
};

/// Controls whether the archive contains showfile state and its referenced files.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShowfileMode {
    None,
    ShowfileOnly,
    ShowfileReferences,
    AllReferences,
}

/// Small export request; log bytes and showfile data are collected natively.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleOptions {
    pub system_info: String,
    pub log_mode: Option<DiagnosticLogMode>,
    pub log_length: Option<u64>,
    pub showfile_mode: ShowfileMode,
}

/// Confirms archive completion and describes any unavailable referenced data.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleResult {
    pub path: String,
    pub warnings: Vec<String>,
}

/// Writes named ZIP entries once and records the resulting manifest inventory.
struct Archive<'a> {
    zip: ZipWriter<&'a mut File>,
    files: BTreeSet<String>,
    warnings: Vec<String>,
}
impl Archive<'_> {
    /// Starts a compressed file entry and prevents ambiguous duplicate archive names.
    fn start(&mut self, name: &str) -> Result<bool, String> {
        if !self.files.insert(name.to_string()) {
            return Ok(false);
        }
        self.zip
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
    /// Writes generated metadata or selected log records.
    fn bytes(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if self.start(name)? {
            self.zip
                .write_all(bytes)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    /// Streams a prepared directory using relative names, preserving empty subdirectories.
    fn directory(&mut self, source: &Path, name: &str) -> Result<(), String> {
        self.files
            .extend(crate::systems::showfile_events::export::archive_directory(
                &mut self.zip,
                source,
                name,
            )?);
        Ok(())
    }
}

/// Builds an archive in a temporary file, publishing it only once every entry is finalized.
pub fn write_bundle(
    destination: &Path,
    app_data: &Path,
    options: BundleOptions,
    showfile: Option<DiagnosticShowfile>,
) -> Result<BundleResult, String> {
    let download_dir = destination
        .parent()
        .ok_or("Invalid diagnostic destination")?;
    std::fs::create_dir_all(download_dir).map_err(|error| error.to_string())?;
    let (temporary, warnings) = build_bundle(download_dir, app_data, options, showfile)?;
    // The native save dialog confirms replacement before an existing destination is selected.
    temporary
        .persist(destination)
        .map_err(|error| error.to_string())?;
    Ok(BundleResult {
        path: destination.display().to_string(),
        warnings,
    })
}

/// Finalizes and rewinds a temporary ZIP for native saving or an HTTP download.
pub(crate) fn build_bundle(
    temporary_dir: &Path,
    app_data: &Path,
    options: BundleOptions,
    showfile: Option<DiagnosticShowfile>,
) -> Result<(tempfile::NamedTempFile, Vec<String>), String> {
    let system_info: Value =
        serde_json::from_str(&options.system_info).map_err(|error| error.to_string())?;
    if system_info.get("application").and_then(Value::as_str) != Some("Nightfall") {
        return Err("Invalid Nightfall system information".to_string());
    }
    if options.showfile_mode != ShowfileMode::None && showfile.is_none() {
        return Err("No showfile is available to include".to_string());
    }
    let mut showfile_source = None;
    let prepared_showfile = if options.showfile_mode != ShowfileMode::None {
        use crate::{ShowfileExportPolicy, prepare_showfile_export};
        let showfile = showfile.unwrap();
        showfile_source = Some(showfile.source);
        let policy = match options.showfile_mode {
            ShowfileMode::ShowfileOnly => ShowfileExportPolicy::ShowfileOnly,
            ShowfileMode::ShowfileReferences => ShowfileExportPolicy::ShowfileReferences,
            ShowfileMode::AllReferences => ShowfileExportPolicy::AllReferences,
            ShowfileMode::None => unreachable!(),
        };
        let prepared =
            prepare_showfile_export(showfile.snapshot, &showfile.asset_root, app_data, policy)?;
        Some(prepared)
    } else {
        None
    };
    let mut temporary =
        tempfile::NamedTempFile::new_in(temporary_dir).map_err(|error| error.to_string())?;
    let warnings = {
        let mut archive = Archive {
            zip: ZipWriter::new(temporary.as_file_mut()),
            files: BTreeSet::new(),
            warnings: Vec::new(),
        };
        archive.bytes(
            "system-info.json",
            &serde_json::to_vec_pretty(&system_info).map_err(|error| error.to_string())?,
        )?;
        if let Some(mode) = options.log_mode {
            let path = app_data.join(nightfall::constants::APP_LOG_FILE_NAME);
            match complete_log_length(&path) {
                Ok(length) => {
                    let length = options.log_length.unwrap_or(length).min(length);
                    match mode {
                        DiagnosticLogMode::All => {
                            archive.start("logs/nightfall.log")?;
                            let mut file = File::open(&path)
                                .map_err(|error| error.to_string())?
                                .take(length);
                            std::io::copy(&mut file, &mut archive.zip)
                                .map_err(|error| error.to_string())?;
                        }
                        DiagnosticLogMode::Recent => {
                            let logs = read_diagnostic_logs_until(&path, mode, length)?;
                            archive.start("logs/nightfall.log")?;
                            for entry in logs {
                                serde_json::to_writer(&mut archive.zip, &entry)
                                    .map_err(|error| error.to_string())?;
                                archive
                                    .zip
                                    .write_all(b"\n")
                                    .map_err(|error| error.to_string())?;
                            }
                        }
                    }
                }
                Err(error) => archive
                    .warnings
                    .push(format!("Log file unavailable: {error}")),
            }
        }
        if let Some(prepared) = &prepared_showfile {
            archive.directory(&prepared.path(), "showfile.nightfall-show")?;
            archive.warnings.extend(prepared.warnings.iter().cloned());
        }
        archive.bytes("README.txt", b"Nightfall diagnostics\n\nSystem information: system-info.json\nSelected structured log events: logs/nightfall.log (JSON Lines)\nOptional loadable showfile: showfile.nightfall-show/\nExtract the archive, then open the contained .nightfall-show directory in Nightfall.\nShowfile references includes the show directory; All references additionally embeds external dependencies.\nSee manifest.json for selections, snapshot source, file inventory and unavailable references.\n")?;
        let manifest = json!({ "logMode": options.log_mode, "showfileMode": options.showfile_mode, "showfileSource": showfile_source, "files": archive.files, "warnings": archive.warnings });
        archive.bytes(
            "manifest.json",
            &serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )?;
        let warnings = archive.warnings;
        archive
            .zip
            .finish()
            .map_err(|error| error.to_string())?
            .sync_all()
            .map_err(|error| error.to_string())?;
        warnings
    };
    temporary
        .as_file_mut()
        .rewind()
        .map_err(|error| error.to_string())?;
    Ok((temporary, warnings))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    /// Gives independent archive-selection tests unique destinations inside their temporary directories.
    fn write_test_bundle(
        directory: &Path,
        app_data: &Path,
        options: BundleOptions,
        showfile: Option<DiagnosticShowfile>,
    ) -> Result<BundleResult, String> {
        write_bundle(
            &directory.join(format!("{}.zip", uuid::Uuid::new_v4())),
            app_data,
            options,
            showfile,
        )
    }

    /// Creates a metadata-only request with independently selectable archive contents.
    fn options(log_mode: Option<DiagnosticLogMode>, showfile_mode: ShowfileMode) -> BundleOptions {
        BundleOptions {
            system_info: json!({"application": "Nightfall", "runtime": "Desktop"}).to_string(),
            log_mode,
            log_length: None,
            showfile_mode,
        }
    }

    /// Reads every compressed entry to verify ZIP finalization and exact uncompressed content.
    fn contents(result: &BundleResult) -> BTreeMap<String, Vec<u8>> {
        let mut zip = zip::ZipArchive::new(File::open(&result.path).unwrap()).unwrap();
        (0..zip.len())
            .map(|index| {
                let mut entry = zip.by_index(index).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                (entry.name().to_owned(), bytes)
            })
            .collect()
    }

    /// Large log files are copied intact, Recent keeps only twenty problems, and None excludes logs.
    #[test]
    fn archive_log_modes_preserve_selected_file_content() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let downloads = root.join("downloads");
        let mut raw = String::new();
        for index in 0..500 {
            raw.push_str(&format!("{}\n", json!({"level": if index % 10 == 0 { "WARN" } else { "INFO" }, "fields": {"message": "💡".repeat(500), "index": index}})));
        }
        assert!(raw.len() > 256 * 1024);
        let path = root.join(nightfall::constants::APP_LOG_FILE_NAME);
        std::fs::write(&path, &raw).unwrap();
        let mut request = options(Some(DiagnosticLogMode::All), ShowfileMode::None);
        request.log_length = Some(raw.len() as u64);
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap(),
            "{}",
            json!({"level": "ERROR", "fields": {"message": "after preview"}})
        )
        .unwrap();
        let result = write_test_bundle(&downloads, root, request, None).unwrap();
        let all = contents(&result);
        assert_eq!(all["logs/nightfall.log"], raw.as_bytes());
        assert!(!all.contains_key("showfile.nightfall-show/showfile.json"));
        assert!(result.warnings.is_empty());
        let recent = contents(
            &write_test_bundle(
                &downloads,
                root,
                options(Some(DiagnosticLogMode::Recent), ShowfileMode::None),
                None,
            )
            .unwrap(),
        );
        let entries: Vec<Value> = String::from_utf8_lossy(&recent["logs/nightfall.log"])
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries.len(), 20);
        assert_eq!(entries[0]["fields"]["index"], 310);
        assert_eq!(entries[19]["fields"]["message"], "after preview");
        assert!(entries.iter().all(|entry| entry["level"] != "INFO"));
        let none = contents(
            &write_test_bundle(&downloads, root, options(None, ShowfileMode::None), None).unwrap(),
        );
        assert_eq!(none.len(), 3);
        assert!(none.contains_key("system-info.json"));
        assert!(none.contains_key("manifest.json"));
        assert!(none.contains_key("README.txt"));
        assert_eq!(std::fs::read_dir(downloads).unwrap().count(), 3);
    }

    /// Each selected showfile policy includes a valid live snapshot and its own manifest.
    #[test]
    fn showfile_modes_include_a_loadable_show_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let source = root.join("active-show");
        std::fs::create_dir_all(source.join("arbitrary/nested")).unwrap();
        std::fs::write(source.join("arbitrary/nested/asset.bin"), b"asset").unwrap();
        std::fs::write(source.join("showfile.json"), b"stale snapshot").unwrap();
        for mode in [
            ShowfileMode::None,
            ShowfileMode::ShowfileOnly,
            ShowfileMode::ShowfileReferences,
            ShowfileMode::AllReferences,
        ] {
            let mut snapshot = nightfall_showfile::ShowfileSnapshot {
                metadata: nightfall_showfile::current_showfile_metadata(),
                ..Default::default()
            };
            snapshot.settings.audio_device = Some("unsaved device".to_string());
            let result = write_test_bundle(
                &root.join("downloads"),
                root,
                options(None, mode),
                Some(DiagnosticShowfile {
                    snapshot,
                    asset_root: source.clone(),
                    source: "current engine state",
                }),
            )
            .unwrap();
            let files = contents(&result);
            if mode == ShowfileMode::None {
                assert_eq!(files.len(), 3);
                continue;
            }
            let json =
                std::str::from_utf8(&files["showfile.nightfall-show/showfile.json"]).unwrap();
            let loaded =
                nightfall_showfile::parse_showfile_snapshot_json(json, "exported show").unwrap();
            assert_eq!(
                loaded.settings.audio_device.as_deref(),
                Some("unsaved device")
            );
            assert!(files.contains_key("showfile.nightfall-show/showfile-manifest.json"));
            assert_eq!(
                files.contains_key("showfile.nightfall-show/arbitrary/nested/asset.bin"),
                mode != ShowfileMode::ShowfileOnly
            );
            assert!(result.warnings.is_empty());
        }
        assert_eq!(
            std::fs::read(source.join("showfile.json")).unwrap(),
            b"stale snapshot"
        );
    }

    /// Saving diagnostics inside the show directory does not include the archive being written.
    #[test]
    fn archive_destination_inside_show_directory_is_not_copied() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path();
        let snapshot = nightfall_showfile::ShowfileSnapshot {
            metadata: nightfall_showfile::current_showfile_metadata(),
            ..Default::default()
        };
        let result = write_bundle(
            &source.join("report.zip"),
            source,
            options(None, ShowfileMode::ShowfileReferences),
            Some(DiagnosticShowfile {
                snapshot,
                asset_root: source.to_owned(),
                source: "current engine state",
            }),
        )
        .unwrap();
        let files = contents(&result);
        let show_files: Vec<_> = files
            .keys()
            .filter(|name| name.starts_with("showfile.nightfall-show/") && !name.ends_with('/'))
            .collect();
        assert_eq!(show_files.len(), 2);
    }

    /// Invalid requests leave no partial download, and missing logs are explicitly reported in the manifest.
    #[test]
    fn incomplete_exports_do_not_publish_partial_archives() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let downloads = root.join("downloads");
        assert!(
            write_test_bundle(
                &downloads,
                root,
                options(None, ShowfileMode::AllReferences),
                None
            )
            .is_err()
        );
        let path = root.join(nightfall::constants::APP_LOG_FILE_NAME);
        std::fs::write(&path, b"invalid JSON\n").unwrap();
        assert!(
            write_test_bundle(
                &downloads,
                root,
                options(Some(DiagnosticLogMode::Recent), ShowfileMode::None),
                None
            )
            .is_err()
        );
        assert_eq!(std::fs::read_dir(&downloads).unwrap().count(), 0);
        let missing_root = root.join("missing");
        let result = write_test_bundle(
            &downloads,
            &missing_root,
            options(Some(DiagnosticLogMode::All), ShowfileMode::None),
            None,
        )
        .unwrap();
        assert_eq!(result.warnings.len(), 1);
        let files = contents(&result);
        let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
        assert_eq!(manifest["warnings"], json!(result.warnings));
        assert!(!files.contains_key("logs/nightfall.log"));
    }

    /// Failed exports preserve an existing destination; successful exports atomically replace the chosen file.
    #[test]
    fn chosen_destination_is_replaced_only_after_archive_completion() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("chosen name.zip");
        std::fs::write(&destination, b"existing archive").unwrap();
        std::fs::write(
            directory
                .path()
                .join(nightfall::constants::APP_LOG_FILE_NAME),
            b"invalid JSON\n",
        )
        .unwrap();
        assert!(
            write_bundle(
                &destination,
                directory.path(),
                options(Some(DiagnosticLogMode::Recent), ShowfileMode::None),
                None
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing archive");
        let result = write_bundle(
            &destination,
            directory.path(),
            options(None, ShowfileMode::None),
            None,
        )
        .unwrap();
        assert_eq!(Path::new(&result.path), destination);
        assert!(contents(&result).contains_key("system-info.json"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }
}
