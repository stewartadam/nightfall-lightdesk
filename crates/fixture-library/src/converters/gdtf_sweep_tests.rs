// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stateless sweep over a whole GDTF collection.
//!
//! Every archive and mode must end in one of two acceptable outcomes: the
//! importer rejects it with a stage-tagged error, or it converts and the
//! result satisfies every structural invariant. A panic, a timeout, or an
//! accepted mode that breaks an invariant fails the sweep. The outcome does
//! not depend on previous runs; the per-stage report written to
//! NIGHTFALL_GDTF_CORPUS_REPORT is informational only.
//!
//! Run with `NIGHTFALL_GDTF_CORPUS_DIR=<dirs> npm run test:gdtf-sweep`
//! (a platform path list; directories are searched recursively).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use super::gdtf::convert_gdtf_mode;
use crate::GdtfMetadata;
use crate::testing::invariants::check_invariants;

/// Wall-clock budget for importing every mode of one archive.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(120);

/// Result of sweeping one archive.
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
    },
    /// Import panicked (failure).
    Panicked {
        /// Panic payload.
        message: String,
    },
    /// Import exceeded [`ARCHIVE_TIMEOUT`] (failure).
    TimedOut,
}

impl ArchiveOutcome {
    /// Returns whether this outcome fails the sweep.
    fn is_failure(&self) -> bool {
        match self {
            Self::RejectedArchive { .. } => false,
            Self::Imported { violations, .. } => !violations.is_empty(),
            Self::Panicked { .. } | Self::TimedOut => true,
        }
    }
}

/// Informational per-stage summary.
#[derive(Debug, Default, Serialize)]
struct SweepReport {
    archives: usize,
    rejected_archives: usize,
    modes_accepted: usize,
    modes_rejected: usize,
    modes_with_violations: usize,
    panics: usize,
    timeouts: usize,
    /// Rejection reasons with occurrence counts, most common first.
    rejection_reasons: Vec<(String, usize)>,
    /// Per-archive outcomes keyed by file name.
    outcomes: BTreeMap<String, ArchiveOutcome>,
}

/// Imports every mode of one archive and checks invariants.
fn sweep_archive(path: &Path) -> ArchiveOutcome {
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
    }
}

/// Runs [`sweep_archive`] on a worker thread, converting panics and timeouts into outcomes.
fn sweep_archive_guarded(path: PathBuf) -> ArchiveOutcome {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(|| sweep_archive(&path)).unwrap_or_else(|panic| {
            ArchiveOutcome::Panicked {
                message: panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()))
                    .unwrap_or_default(),
            }
        });
        let _ = sender.send(outcome);
    });
    receiver
        .recv_timeout(ARCHIVE_TIMEOUT)
        .unwrap_or(ArchiveOutcome::TimedOut)
}

/// Recursively collects `.gdtf` files under a directory in a stable order.
fn collect_archives(dir: &Path, archives: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect_archives(&path, archives);
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gdtf"))
        {
            archives.push(path);
        }
    }
}

/// Sweeps every archive under NIGHTFALL_GDTF_CORPUS_DIR.
#[test]
#[ignore = "requires NIGHTFALL_GDTF_CORPUS_DIR"]
fn gdtf_corpus_sweep() {
    let dirs = std::env::var_os("NIGHTFALL_GDTF_CORPUS_DIR")
        .expect("NIGHTFALL_GDTF_CORPUS_DIR must list GDTF collection directories");
    let mut archives = Vec::new();
    for dir in std::env::split_paths(&dirs) {
        collect_archives(&dir, &mut archives);
    }
    assert!(!archives.is_empty(), "no .gdtf archives found");

    // Silence the default panic hook: panics are recorded as outcomes.
    std::panic::set_hook(Box::new(|_| {}));
    let workers = std::thread::available_parallelism().map_or(4, |count| count.get());
    let chunk = archives.len().div_ceil(workers);
    let results: Vec<(PathBuf, ArchiveOutcome)> = std::thread::scope(|scope| {
        archives
            .chunks(chunk)
            .map(|paths| {
                scope.spawn(move || {
                    paths
                        .iter()
                        .map(|path| (path.clone(), sweep_archive_guarded(path.clone())))
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|handle| handle.join().expect("sweep worker"))
            .collect()
    });
    let _ = std::panic::take_hook();

    let mut report = SweepReport {
        archives: results.len(),
        ..Default::default()
    };
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
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
            } => {
                report.modes_accepted += accepted;
                report.modes_rejected += rejected.len();
                report.modes_with_violations += violations.len();
                for error in rejected.values() {
                    *reasons.entry(reason_key(error)).or_default() += 1;
                }
            }
            ArchiveOutcome::Panicked { .. } => report.panics += 1,
            ArchiveOutcome::TimedOut => report.timeouts += 1,
        }
        if outcome.is_failure() {
            failures.push(format!("{name}: {outcome:?}"));
        }
        report.outcomes.insert(name, outcome);
    }
    report.rejection_reasons = reasons.into_iter().collect();
    report
        .rejection_reasons
        .sort_by(|left, right| right.1.cmp(&left.1));

    if let Some(path) = std::env::var_os("NIGHTFALL_GDTF_CORPUS_REPORT") {
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap())
            .expect("write sweep report");
    }
    println!(
        "GDTF sweep: {} archives, {} rejected archives, {} modes accepted, {} modes rejected, {} modes with violations, {} panics, {} timeouts",
        report.archives,
        report.rejected_archives,
        report.modes_accepted,
        report.modes_rejected,
        report.modes_with_violations,
        report.panics,
        report.timeouts
    );
    assert!(
        failures.is_empty(),
        "{} archives failed the sweep:\n{}",
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
