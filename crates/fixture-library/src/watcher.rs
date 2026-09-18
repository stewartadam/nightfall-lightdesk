// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! File system watcher for fixture library hot-reloading

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use bevy_ecs::prelude::*;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};

use crate::Result;

/// Events emitted when the fixture library changes
#[derive(Message, Debug, Clone)]
pub enum FixtureLibraryEvent {
    /// A fixture file was added or modified
    FileChanged {
        /// Path to the changed file
        path: PathBuf,
    },
    /// A fixture file was removed
    FileRemoved {
        /// Path to the removed file
        path: PathBuf,
    },
    /// Library scan completed after changes detected
    ScanCompleted {
        /// Number of fixtures found
        fixture_count: usize,
    },
}

/// Resource that manages file system watching for the fixture library
#[derive(Resource)]
pub struct FixtureLibraryWatcher {
    /// The notify watcher instance
    fs_watcher: RecommendedWatcher,
    /// Channel receiver for file system events
    event_receiver: Mutex<std::sync::mpsc::Receiver<notify::Result<Event>>>,
}

impl FixtureLibraryWatcher {
    /// Create a new watcher for the given directory path
    pub fn new(library_path: PathBuf) -> Result<Self> {
        let (tx, rx) = std::sync::mpsc::channel();

        // Create watcher with debounce to avoid multiple events for same file
        let mut fs_watcher = notify::recommended_watcher(tx).map_err(|e| {
            crate::FixtureLibraryError::Io(std::io::Error::other(format!(
                "Failed to create file watcher: {}",
                e
            )))
        })?;

        // Watch the library directory recursively
        fs_watcher
            .watch(&library_path, RecursiveMode::Recursive)
            .map_err(|e| {
                crate::FixtureLibraryError::Io(std::io::Error::other(format!(
                    "Failed to watch directory: {}",
                    e
                )))
            })?;

        tracing::info!(
            library_path = %library_path.display(),
            "Started watching fixture library"
        );

        Ok(Self {
            fs_watcher,
            event_receiver: Mutex::new(rx),
        })
    }

    /// Get a reference to the underlying file system watcher
    pub fn fs_watcher(&self) -> &RecommendedWatcher {
        &self.fs_watcher
    }

    /// Process pending file system events and emit Bevy events
    ///
    /// This should be called regularly (e.g., in a Bevy system) to handle
    /// file system changes. Returns true if any events were processed.
    ///
    /// Note: The notify crate can emit multiple events for a single file operation
    /// (e.g., create + modify for a new file). This method deduplicates events
    /// within a single processing batch to avoid redundant notifications.
    pub fn process_events(&self, event_writer: &mut MessageWriter<FixtureLibraryEvent>) -> bool {
        let mut processed_any = false;

        // Lock the receiver to process events
        let Ok(receiver) = self.event_receiver.lock() else {
            tracing::warn!("Failed to lock event receiver");
            return false;
        };

        // Track paths we've already emitted events for in this batch
        // to deduplicate multiple OS events for the same file operation
        let mut changed_paths: HashSet<PathBuf> = HashSet::new();
        let mut removed_paths: HashSet<PathBuf> = HashSet::new();

        // Collect all pending events without blocking
        while let Ok(result) = receiver.try_recv() {
            match result {
                Ok(event) => {
                    self.collect_event(event, &mut changed_paths, &mut removed_paths);
                }
                Err(e) => {
                    tracing::warn!("File watcher error: {}", e);
                }
            }
        }

        // Emit deduplicated events
        // If a path was both changed and removed, only emit removed
        for path in &removed_paths {
            changed_paths.remove(path);
        }

        for path in changed_paths {
            tracing::debug!(path = %path.display(), "Fixture file changed");
            event_writer.write(FixtureLibraryEvent::FileChanged { path });
            processed_any = true;
        }

        for path in removed_paths {
            tracing::debug!(path = %path.display(), "Fixture file removed");
            event_writer.write(FixtureLibraryEvent::FileRemoved { path });
            processed_any = true;
        }

        processed_any
    }

    /// Collect a single file system event into the deduplicated sets
    fn collect_event(
        &self,
        event: Event,
        changed_paths: &mut HashSet<PathBuf>,
        removed_paths: &mut HashSet<PathBuf>,
    ) {
        // Only process events for .gdtf and .json files
        let is_fixture_file = |path: &PathBuf| -> bool {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|ext| ext == "gdtf" || ext == "json")
                .unwrap_or(false)
        };

        match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) => {
                for path in event.paths {
                    if is_fixture_file(&path) {
                        changed_paths.insert(path);
                    }
                }
            }
            EventKind::Remove(_) => {
                for path in event.paths {
                    if is_fixture_file(&path) {
                        removed_paths.insert(path);
                    }
                }
            }
            _ => {
                // Ignore other event types (access, etc.)
            }
        }
    }
}

/// Bevy system that processes file system events
pub fn process_watcher_events(
    watcher: Option<Res<FixtureLibraryWatcher>>,
    mut event_writer: MessageWriter<FixtureLibraryEvent>,
) {
    if let Some(watcher) = watcher {
        watcher.process_events(&mut event_writer);
    }
}

/// Bevy system that responds to file changes by rescanning the library
pub fn handle_library_changes(
    mut event_params: ParamSet<(
        MessageReader<FixtureLibraryEvent>,
        MessageWriter<FixtureLibraryEvent>,
    )>,
    mut manager: ResMut<crate::manager::FixtureLibraryManager>,
) {
    let mut needs_scan = false;

    // First, read all events (exclusive access to reader)
    for event in event_params.p0().read() {
        match event {
            FixtureLibraryEvent::FileChanged { path } => {
                tracing::info!(path = %path.display(), "Fixture library file changed");
                needs_scan = true;
            }
            FixtureLibraryEvent::FileRemoved { path } => {
                tracing::info!(path = %path.display(), "Fixture library file removed");
                needs_scan = true;
            }
            FixtureLibraryEvent::ScanCompleted { fixture_count } => {
                tracing::info!("Fixture library scan completed: {} fixtures", fixture_count);
            }
        }
    }

    // Now we can write (exclusive access to writer)
    if needs_scan {
        match manager.scan() {
            Ok(()) => {
                let count = manager.fixture_count();
                tracing::info!("Rescanned fixture library: {} fixtures", count);

                // Emit ScanCompleted event for other systems to react to
                event_params.p1().write(FixtureLibraryEvent::ScanCompleted {
                    fixture_count: count,
                });
            }
            Err(e) => {
                tracing::error!("Failed to rescan fixture library: {}", e);
            }
        }
    }
}
