// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! On-demand diagnostic snapshots of the persisted tracing log.

use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const RECENT_PROBLEM_LIMIT: usize = 20;

/// Selects either the complete stored log or its most recent warnings and errors.
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLogMode {
    All,
    Recent,
}

/// Reads a fixed file snapshot, retaining structured fields and ignoring an unfinished final line.
#[cfg(test)]
fn read_diagnostic_logs(path: &Path, mode: DiagnosticLogMode) -> Result<Vec<Value>, String> {
    read_diagnostic_logs_until(path, mode, u64::MAX)
}

/// Reads selected JSON records through a fixed byte boundary for consistent preview and export.
pub(crate) fn read_diagnostic_logs_until(
    path: &Path,
    mode: DiagnosticLogMode,
    maximum: u64,
) -> Result<Vec<Value>, String> {
    let file = File::open(path).map_err(|error| format!("could not open log file: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("could not inspect log file: {error}"))?
        .len()
        .min(maximum);
    let mut reader = BufReader::new(file.take(length));
    let mut logs = Vec::new();
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| format!("could not read log file: {error}"))?
            == 0
        {
            break;
        }
        if !line.ends_with('\n') {
            break;
        }
        let entry: Value = serde_json::from_str(&line)
            .map_err(|error| format!("could not parse stored log entry: {error}"))?;
        if matches!(mode, DiagnosticLogMode::Recent) {
            if !matches!(
                entry.get("level").and_then(Value::as_str),
                Some("WARN" | "ERROR")
            ) {
                continue;
            }
            if logs.len() == RECENT_PROBLEM_LIMIT {
                logs.remove(0);
            }
        }
        logs.push(entry);
    }
    Ok(logs)
}

/// A small formatted log page with a stable file boundary reused by the archive export.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogPage {
    entries: Vec<DiagnosticLogEntry>,
    next_offset: Option<u64>,
    file_length: u64,
}

/// Finds the last complete JSON line without reading the entire log into memory.
pub(crate) fn complete_log_length(path: &Path) -> Result<u64, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut end = file.metadata().map_err(|error| error.to_string())?.len();
    let mut buffer = [0; 8192];
    while end > 0 {
        let start = end.saturating_sub(buffer.len() as u64);
        let count = (end - start) as usize;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        file.read_exact(&mut buffer[..count])
            .map_err(|error| error.to_string())?;
        if let Some(index) = buffer[..count].iter().rposition(|byte| *byte == b'\n') {
            return Ok(start + index as u64 + 1);
        }
        end = start;
    }
    Ok(0)
}

/// A bounded display record retaining tracing metadata for CLI-style syntax coloring.
#[derive(Serialize)]
pub(crate) struct DiagnosticLogEntry {
    timestamp: String,
    level: String,
    target: String,
    message: String,
    fields: Vec<DiagnosticLogField>,
    shortened: bool,
}

/// A named tracing field rendered inline after the event message.
#[derive(Serialize)]
pub(crate) struct DiagnosticLogField {
    name: String,
    value: String,
}

/// Bounds preview text on Unicode boundaries while leaving the stored log untouched.
fn preview_text(value: &str, remaining: &mut usize, shortened: &mut bool) -> String {
    let text: String = value.chars().take(*remaining).collect();
    *remaining = remaining.saturating_sub(text.chars().count());
    if text.len() < value.len() {
        *shortened = true;
        format!("{text}…")
    } else {
        text
    }
}

/// Extracts display fields directly from the stored JSON without reparsing formatted log text.
fn preview_log_entry(entry: &Value) -> DiagnosticLogEntry {
    let mut remaining = 4096;
    let mut shortened = false;
    let mut text = |value: &str| preview_text(value, &mut remaining, &mut shortened);
    let timestamp = text(entry["timestamp"].as_str().unwrap_or(""));
    let level = text(entry["level"].as_str().unwrap_or(""));
    let target = text(entry["target"].as_str().unwrap_or(""));
    let message = &entry["fields"]["message"];
    let message = if message.is_null() {
        String::new()
    } else {
        text(message.as_str().unwrap_or(&message.to_string()))
    };
    let mut fields = Vec::new();
    if let Some(values) = entry["fields"].as_object() {
        for (name, value) in values {
            if name == "message" {
                continue;
            }
            if remaining == 0 {
                shortened = true;
                break;
            }
            let name = preview_text(name, &mut remaining, &mut shortened);
            let value = preview_text(
                value.as_str().unwrap_or(&value.to_string()),
                &mut remaining,
                &mut shortened,
            );
            fields.push(DiagnosticLogField { name, value });
        }
    }
    DiagnosticLogEntry {
        timestamp,
        level,
        target,
        message,
        fields,
        shortened,
    }
}

/// Reads a bounded page of formatted messages, keeping All out of a single large IPC response.
pub(crate) fn read_log_page(
    path: &Path,
    mode: DiagnosticLogMode,
    offset: u64,
    length: Option<u64>,
) -> Result<DiagnosticLogPage, String> {
    let file_length = match length {
        Some(length) => length.min(complete_log_length(path)?),
        None => complete_log_length(path)?,
    };
    if matches!(mode, DiagnosticLogMode::Recent) {
        let entries = read_diagnostic_logs_until(path, mode, file_length)?;
        return Ok(DiagnosticLogPage {
            entries: entries.iter().map(preview_log_entry).collect(),
            next_offset: None,
            file_length,
        });
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let start = offset.min(file_length);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file.take(file_length - start));
    let mut position = start;
    let mut entries = Vec::new();
    let mut size = 0;
    let mut line = String::new();
    for _ in 0..100 {
        line.clear();
        let count = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        position += count as u64;
        let entry: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        let entry = preview_log_entry(&entry);
        size += serde_json::to_vec(&entry)
            .map_err(|error| error.to_string())?
            .len();
        entries.push(entry);
        if size >= 32 * 1024 {
            break;
        }
    }
    Ok(DiagnosticLogPage {
        entries,
        next_offset: (position < file_length).then_some(position),
        file_length,
    })
}

/// Reads formatted log pages through native IPC even when the WebSocket is unavailable.
pub async fn collect_diagnostic_logs(
    mode: DiagnosticLogMode,
    offset: Option<u64>,
    file_length: Option<u64>,
) -> Result<DiagnosticLogPage, String> {
    let path = nightfall::nightfall_data_dir()
        .ok_or("Application data directory unavailable")?
        .join(nightfall::constants::APP_LOG_FILE_NAME);
    tokio::task::spawn_blocking(move || {
        read_log_page(&path, mode, offset.unwrap_or(0), file_length)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tracing_subscriber::prelude::*;

    use super::*;

    /// Structured tracing fields survive persistence, with no runtime event-history collector.
    #[test]
    fn tracing_file_preserves_event_metadata_and_fields() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nightfall.log");
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(std::sync::Mutex::new(File::create(&path).unwrap())),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(target: "fixture_scanner", code = 42, "fixture warning");
            tracing::info!(target: "webview", "browser info");
        });
        let logs = read_diagnostic_logs(&path, DiagnosticLogMode::All).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0]["level"], "WARN");
        assert_eq!(logs[0]["target"], "fixture_scanner");
        assert_eq!(logs[0]["fields"]["code"], 42);
        assert_eq!(logs[1]["target"], "webview");
        let recent = read_diagnostic_logs(&path, DiagnosticLogMode::Recent).unwrap();
        assert_eq!(recent, logs[..1]);
    }

    /// All reads beyond the old count and size limits while Recent selects the last 20 problems.
    #[test]
    fn modes_read_the_stored_file_without_history_limits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nightfall.log");
        let mut file = File::create(&path).unwrap();
        for index in 0..500 {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "level": if index % 10 == 0 { "ERROR" } else { "INFO" },
                    "fields": { "message": "large message ".repeat(300), "index": index },
                })
            )
            .unwrap();
        }
        let all = read_diagnostic_logs(&path, DiagnosticLogMode::All).unwrap();
        assert_eq!(all.len(), 500);
        assert!(serde_json::to_vec(&all).unwrap().len() > 256 * 1024);
        let recent = read_diagnostic_logs(&path, DiagnosticLogMode::Recent).unwrap();
        assert_eq!(recent.len(), 20);
        assert_eq!(recent[0]["fields"]["index"], 300);
        assert_eq!(recent[19]["fields"]["index"], 490);
    }

    /// A concurrent partial write is excluded until its newline is persisted.
    #[test]
    fn ignores_only_the_incomplete_final_entry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nightfall.log");
        std::fs::write(&path, "{\"level\":\"WARN\"}\n{\"level\":").unwrap();
        assert_eq!(
            read_diagnostic_logs(&path, DiagnosticLogMode::All)
                .unwrap()
                .len(),
            1
        );
        std::fs::write(&path, "invalid entry\n").unwrap();
        assert!(read_diagnostic_logs(&path, DiagnosticLogMode::All).is_err());
        assert!(
            read_diagnostic_logs(&directory.path().join("missing"), DiagnosticLogMode::All)
                .is_err()
        );
    }

    /// Pagination uses byte offsets for Unicode and ignores records appended after preview collection.
    #[test]
    fn formatted_pages_keep_a_stable_complete_file_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nightfall.log");
        let mut file = File::create(&path).unwrap();
        for index in 0..230 {
            writeln!(file, "{}", serde_json::json!({"timestamp": "2026-09-05T03:42:43Z", "level": "WARN", "target": "scanner", "fields": {"message": format!("💡 entry {index}"), "code": index}})).unwrap();
        }
        let first = read_log_page(&path, DiagnosticLogMode::All, 0, None).unwrap();
        assert_eq!(first.entries.len(), 100);
        assert_eq!(first.entries[0].timestamp, "2026-09-05T03:42:43Z");
        assert_eq!(first.entries[0].level, "WARN");
        assert_eq!(first.entries[0].target, "scanner");
        assert_eq!(first.entries[0].message, "💡 entry 0");
        assert_eq!(first.entries[0].fields[0].name, "code");
        assert_eq!(first.entries[0].fields[0].value, "0");
        write!(file, "{{\"level\":").unwrap();
        assert_eq!(complete_log_length(&path).unwrap(), first.file_length);
        writeln!(file, "\"WARN\",\"fields\":{{\"message\":\"later\"}}}}").unwrap();
        let second = read_log_page(
            &path,
            DiagnosticLogMode::All,
            first.next_offset.unwrap(),
            Some(first.file_length),
        )
        .unwrap();
        let third = read_log_page(
            &path,
            DiagnosticLogMode::All,
            second.next_offset.unwrap(),
            Some(first.file_length),
        )
        .unwrap();
        assert_eq!(second.entries.len(), 100);
        assert_eq!(third.entries.len(), 30);
        assert!(third.next_offset.is_none());
        assert!(!third.entries.iter().any(|entry| entry.message == "later"));
        let recent =
            read_log_page(&path, DiagnosticLogMode::Recent, 0, Some(first.file_length)).unwrap();
        assert_eq!(recent.entries.len(), 20);
        assert!(!recent.entries.iter().any(|entry| entry.message == "later"));
        assert!(recent.next_offset.is_none());
        let long =
            preview_log_entry(&serde_json::json!({"fields": {"message": "💡".repeat(5000)}}));
        assert!(long.shortened);
        assert!(!long.message.contains('\u{fffd}'));
    }
}
