// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stateless check of a whole GDTF collection.
//!
//! Every archive and mode must end in one of two acceptable outcomes: the
//! importer rejects it with a stage-tagged error, or it converts and the
//! result satisfies every structural invariant. A panic, a timeout, or an
//! accepted mode that breaks an invariant fails the corpus check. The outcome does
//! not depend on previous runs; the per-stage report written to
//! NIGHTFALL_GDTF_CORPUS_REPORT is informational only.
//!
//! Every readable archive is also written back out: a description that
//! cannot be read back, or reads back different, fails the corpus check, and
//! source content the description model drops on write is reported per
//! archive and summed in the report.
//!
//! Run with `pnpm run gdtf:corpus`, setting NIGHTFALL_GDTF_CORPUS_DIR=<dirs>
//! (a platform path list; directories are searched recursively).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use super::gdtf::convert_gdtf_mode;
use crate::GdtfMetadata;
use crate::gdtf_repair::repair_description;
use crate::gdtf_write::{lost_content, read_description_xml};
use crate::testing::invariants::check_invariants;

/// Wall-clock budget for importing every mode of one archive.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(120);

/// Result of checking one archive.
#[derive(Debug, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
enum ArchiveOutcome {
    /// The archive or its description could not be read; an acceptable rejection.
    RejectedArchive {
        /// Parser error.
        error: String,
    },
    /// Metadata was read; per-mode results follow.
    Imported {
        /// Modes that converted and satisfied all invariants.
        accepted: usize,
        /// Modes rejected by conversion, with the error.
        rejected: BTreeMap<String, String>,
        /// Modes whose converted result broke invariants (failures).
        violations: BTreeMap<String, Vec<String>>,
        /// Result of writing the description back out.
        round_trip: RoundTrip,
    },
    /// Import panicked (failure).
    Panicked {
        /// Panic payload.
        message: String,
    },
    /// Import exceeded [`ARCHIVE_TIMEOUT`] (failure).
    TimedOut,
    /// Not started because another archive timed out first. The timed-out
    /// archive already fails the corpus check, and its conversion thread cannot be
    /// stopped, so the corpus check winds down instead of competing with it.
    NotChecked,
}

/// Result of serializing an archive's parsed description and reading it back.
#[derive(Debug, Default, Serialize)]
struct RoundTrip {
    /// Why the written description failed to serialize or read back (failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Whether the description read back differs from the one written (failure).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    changed: bool,
    /// Element and attribute paths of the source description the write dropped.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    lost: Vec<String>,
    /// Why the source description could not be analysed for dropped content (informational).
    #[serde(skip_serializing_if = "Option::is_none")]
    lost_error: Option<String>,
}

impl RoundTrip {
    /// Returns whether the round trip fails the corpus check.
    fn is_failure(&self) -> bool {
        self.error.is_some() || self.changed
    }
}

impl ArchiveOutcome {
    /// Returns whether this outcome fails the corpus check.
    fn is_failure(&self) -> bool {
        match self {
            Self::RejectedArchive { .. } | Self::NotChecked => false,
            Self::Imported {
                violations,
                round_trip,
                ..
            } => !violations.is_empty() || round_trip.is_failure(),
            Self::Panicked { .. } | Self::TimedOut => true,
        }
    }
}

/// Informational per-stage summary.
#[derive(Debug, Default, Serialize)]
struct CorpusReport {
    archives: usize,
    rejected_archives: usize,
    modes_accepted: usize,
    modes_rejected: usize,
    modes_with_violations: usize,
    /// Archives whose description could not be written and read back unchanged.
    round_trip_failures: usize,
    /// Archives whose source description holds content the write drops.
    lost_archives: usize,
    /// Archives whose source description could not be analysed for dropped content.
    lost_analysis_errors: usize,
    /// Source paths dropped on write with the number of archives that lost them, most common first.
    lost_content: Vec<(String, usize)>,
    panics: usize,
    timeouts: usize,
    /// Archives not started because an earlier archive timed out.
    not_checked: usize,
    /// Directories or entries that could not be read, with the error; their archives were not checked.
    unreadable_paths: Vec<String>,
    /// Rejection reasons with occurrence counts, most common first.
    rejection_reasons: Vec<(String, usize)>,
    /// Per-archive outcomes keyed by file name.
    outcomes: BTreeMap<String, ArchiveOutcome>,
}

/// Imports every mode of one archive and checks invariants.
fn check_archive(path: &Path) -> ArchiveOutcome {
    let metadata = match GdtfMetadata::from_file(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return ArchiveOutcome::RejectedArchive {
                error: error.to_string(),
            };
        }
    };
    let mut accepted = 0;
    let mut rejected = BTreeMap::new();
    let mut violations = BTreeMap::new();
    let mut gdtf = match metadata.reparse() {
        Ok(gdtf) => gdtf,
        Err(error) => {
            return ArchiveOutcome::RejectedArchive {
                error: error.to_string(),
            };
        }
    };
    let round_trip = std::panic::catch_unwind(|| round_trip(path, &gdtf.description))
        .unwrap_or_else(|panic| RoundTrip {
            error: Some(format!("panicked: {}", panic_message(panic.as_ref()))),
            ..Default::default()
        });
    for mode in &metadata.modes {
        match convert_gdtf_mode(&mut gdtf, &metadata, mode, 1) {
            Ok(converted) => {
                let found = check_invariants(&converted.fixture, converted.geometry.as_ref());
                if found.is_empty() {
                    accepted += 1;
                } else {
                    violations.insert(
                        mode.clone(),
                        found
                            .iter()
                            .map(|violation| format!("{violation:?}"))
                            .collect(),
                    );
                }
            }
            Err(error) => {
                rejected.insert(mode.clone(), error.to_string());
            }
        }
    }
    ArchiveOutcome::Imported {
        accepted,
        rejected,
        violations,
        round_trip,
    }
}

/// Writes `description` out, reads it back, and lists source content the write drops.
///
/// Dropped content is measured on the description as imported: the source as
/// published when it parses strictly, otherwise the repaired source, so
/// content removed by repairs while opening the archive is not reported as lost.
fn round_trip(path: &Path, description: &gdtf::Description) -> RoundTrip {
    let written = match description.to_string() {
        Ok(written) => written,
        Err(error) => {
            return RoundTrip {
                error: Some(format!("serialize: {error}")),
                ..Default::default()
            };
        }
    };
    let (changed, error) = match gdtf::Description::from_str(&written) {
        Ok(reread) => (reread != *description, None),
        Err(error) => (false, Some(format!("read back: {error}"))),
    };
    let (lost, lost_error) = match read_description_xml(path).and_then(|source| {
        let imported = if gdtf::Description::from_str(&source).is_ok() {
            source
        } else {
            repair_description(&source)
                .map(|(repaired, _)| repaired)
                .unwrap_or(source)
        };
        lost_content(&imported)
    }) {
        Ok(lost) => (lost, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    RoundTrip {
        error,
        changed,
        lost,
        lost_error,
    }
}

/// Extracts the text of a panic payload, or an empty string for other payloads.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()))
        .unwrap_or_default()
}

/// Runs [`check_archive`] on a worker thread, converting panics and timeouts into outcomes.
fn check_archive_guarded(path: PathBuf) -> ArchiveOutcome {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(|| check_archive(&path)).unwrap_or_else(|panic| {
            ArchiveOutcome::Panicked {
                message: panic_message(panic.as_ref()),
            }
        });
        let _ = sender.send(outcome);
    });
    receiver
        .recv_timeout(ARCHIVE_TIMEOUT)
        .unwrap_or(ArchiveOutcome::TimedOut)
}

/// Recursively collects `.gdtf` files under a directory in a stable order.
///
/// A directory or entry that cannot be read is logged as a warning and
/// recorded in `unreadable` so the corpus check reports what it skipped, and the
/// walk continues with the rest of the collection.
fn collect_archives(dir: &Path, archives: &mut Vec<PathBuf>, unreadable: &mut Vec<String>) {
    let mut skip = |path: &Path, error: std::io::Error| {
        tracing::warn!(path = %path.display(), %error, "gdtf_corpus_path_unreadable");
        eprintln!("warning: skipping unreadable {}: {error}", path.display());
        unreadable.push(format!("{}: {error}", path.display()));
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            skip(dir, error);
            return;
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(error) => skip(dir, error),
        }
    }
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect_archives(&path, archives, unreadable);
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gdtf"))
        {
            archives.push(path);
        }
    }
}

/// Checks every archive under NIGHTFALL_GDTF_CORPUS_DIR.
#[test]
#[ignore = "requires NIGHTFALL_GDTF_CORPUS_DIR"]
fn gdtf_corpus() {
    let dirs = std::env::var_os("NIGHTFALL_GDTF_CORPUS_DIR")
        .expect("NIGHTFALL_GDTF_CORPUS_DIR must list GDTF collection directories");
    let mut archives = Vec::new();
    let mut unreadable_paths = Vec::new();
    for dir in std::env::split_paths(&dirs) {
        collect_archives(&dir, &mut archives, &mut unreadable_paths);
    }
    assert!(!archives.is_empty(), "no .gdtf archives found");

    // Silence the default panic hook: panics are recorded as outcomes.
    std::panic::set_hook(Box::new(|_| {}));
    let workers = std::thread::available_parallelism().map_or(4, |count| count.get());
    let chunk = archives.len().div_ceil(workers);
    // Set by the first timeout: that archive's conversion thread cannot be
    // stopped, so workers stop starting archives rather than pile more work
    // on top of it. Archives already in progress still finish.
    let timed_out = AtomicBool::new(false);
    let results: Vec<(PathBuf, ArchiveOutcome)> = std::thread::scope(|scope| {
        archives
            .chunks(chunk)
            .map(|paths| {
                let timed_out = &timed_out;
                scope.spawn(move || {
                    paths
                        .iter()
                        .map(|path| {
                            if timed_out.load(Ordering::Relaxed) {
                                return (path.clone(), ArchiveOutcome::NotChecked);
                            }
                            let outcome = check_archive_guarded(path.clone());
                            if matches!(outcome, ArchiveOutcome::TimedOut) {
                                timed_out.store(true, Ordering::Relaxed);
                            }
                            (path.clone(), outcome)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|handle| handle.join().expect("corpus worker"))
            .collect()
    });
    let _ = std::panic::take_hook();

    let mut report = CorpusReport {
        archives: results.len(),
        unreadable_paths,
        ..Default::default()
    };
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    let mut lost: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures = Vec::new();
    for (path, outcome) in results {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        match &outcome {
            ArchiveOutcome::RejectedArchive { error } => {
                report.rejected_archives += 1;
                *reasons.entry(reason_key(error)).or_default() += 1;
            }
            ArchiveOutcome::Imported {
                accepted,
                rejected,
                violations,
                round_trip,
            } => {
                report.modes_accepted += accepted;
                report.round_trip_failures += usize::from(round_trip.is_failure());
                report.lost_archives += usize::from(!round_trip.lost.is_empty());
                report.lost_analysis_errors += usize::from(round_trip.lost_error.is_some());
                for path in &round_trip.lost {
                    *lost.entry(path.clone()).or_default() += 1;
                }
                report.modes_rejected += rejected.len();
                report.modes_with_violations += violations.len();
                for error in rejected.values() {
                    *reasons.entry(reason_key(error)).or_default() += 1;
                }
            }
            ArchiveOutcome::Panicked { .. } => report.panics += 1,
            ArchiveOutcome::TimedOut => report.timeouts += 1,
            ArchiveOutcome::NotChecked => report.not_checked += 1,
        }
        if outcome.is_failure() {
            failures.push(format!("{name}: {outcome:?}"));
        }
        report.outcomes.insert(name, outcome);
    }
    report.rejection_reasons = reasons.into_iter().collect();
    report
        .rejection_reasons
        .sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    report.lost_content = lost.into_iter().collect();
    report
        .lost_content
        .sort_by_key(|(_, count)| std::cmp::Reverse(*count));

    if let Some(path) = std::env::var_os("NIGHTFALL_GDTF_CORPUS_REPORT") {
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap())
            .expect("write corpus report");
    }
    println!(
        "GDTF corpus: {} archives, {} rejected archives, {} modes accepted, {} modes rejected, {} modes with violations, {} round-trip failures, {} archives losing content on write, {} archives not analysed for lost content, {} panics, {} timeouts, {} not checked after a timeout, {} unreadable paths skipped",
        report.archives,
        report.rejected_archives,
        report.modes_accepted,
        report.modes_rejected,
        report.modes_with_violations,
        report.round_trip_failures,
        report.lost_archives,
        report.lost_analysis_errors,
        report.panics,
        report.timeouts,
        report.not_checked,
        report.unreadable_paths.len()
    );
    assert!(
        failures.is_empty(),
        "{} archives failed the corpus check:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Groups similar error messages by dropping positions and quoted names.
fn reason_key(error: &str) -> String {
    let mut key: String = error.chars().take(120).collect();
    if let Some(index) = key.find(" at line") {
        key.truncate(index);
    }
    key
}

/// Verifies an unreadable subdirectory is recorded and skipped while archives
/// elsewhere in the collection are still collected.
#[cfg(unix)]
#[test]
fn collect_archives_skips_unreadable_directories() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let locked = root.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("hidden.gdtf"), b"").unwrap();
    std::fs::write(root.path().join("visible.gdtf"), b"").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&locked).is_ok() {
        // Privileged users (e.g. root in CI containers) ignore directory permissions.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }

    let mut archives = Vec::new();
    let mut unreadable = Vec::new();
    collect_archives(root.path(), &mut archives, &mut unreadable);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(archives, [root.path().join("visible.gdtf")]);
    assert_eq!(unreadable.len(), 1, "{unreadable:?}");
    assert!(unreadable[0].starts_with(&locked.display().to_string()));
}
