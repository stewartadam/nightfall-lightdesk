// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! File system watcher for object library hot-reloading

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use bevy_ecs::prelude::*;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};

use crate::Result;

/// Events emitted when the object library changes
#[derive(Message, Debug, Clone)]
pub enum ObjectLibraryEvent {
    /// An object file was added or modified
    FileChanged {
        /// Path to the changed file
        path: PathBuf,
    },
    /// An object file was removed
    FileRemoved {
        /// Path to the removed file
        path: PathBuf,
    },
    /// Library scan completed after changes detected
    ScanCompleted {
        /// Number of objects found
        object_count: usize,
    },
}

/// Resource that manages file system watching for the object library
#[derive(Resource)]
pub struct ObjectLibraryWatcher {
    /// The notify watcher instance
    fs_watcher: RecommendedWatcher,
    /// Channel receiver for file system events
    event_receiver: Mutex<std::sync::mpsc::Receiver<notify::Result<Event>>>,
}

impl ObjectLibraryWatcher {
    /// Create a new watcher for the given directory path
    pub fn new(library_path: PathBuf) -> Result<Self> {
        let (tx, rx) = std::sync::mpsc::channel();

        // Create watcher with debounce to avoid multiple events for same file
        let mut fs_watcher = notify::recommended_watcher(tx).map_err(|e| {
            crate::ObjectLibraryError::Io(std::io::Error::other(format!(
                "Failed to create file watcher: {}",
                e
            )))
        })?;

        // Watch the library directory recursively
        fs_watcher
            .watch(&library_path, RecursiveMode::Recursive)
            .map_err(|e| {
                crate::ObjectLibraryError::Io(std::io::Error::other(format!(
                    "Failed to watch directory: {}",
                    e
                )))
            })?;

        tracing::info!(
            library_path = %library_path.display(),
            "Started watching object library"
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
    pub fn process_events(&self, event_writer: &mut MessageWriter<ObjectLibraryEvent>) -> bool {
        let mut processed_any = false;

        // Lock the receiver to process events
        let Ok(receiver) = self.event_receiver.lock() else {
            tracing::warn!("Failed to lock event receiver");
            return false;
        };

        // Track paths we've already emitted events for in this batch
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
            tracing::debug!(path = %path.display(), "Object file changed");
            event_writer.write(ObjectLibraryEvent::FileChanged { path });
            processed_any = true;
        }

        for path in removed_paths {
            tracing::debug!(path = %path.display(), "Object file removed");
            event_writer.write(ObjectLibraryEvent::FileRemoved { path });
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
        // Only process events for .robj files
        match event.kind {
            EventKind::Create(_) | EventKind::Modify(_) => {
                for path in event.paths {
                    if is_object_file(&path) {
                        changed_paths.insert(path);
                    }
                }
            }
            EventKind::Remove(_) => {
                for path in event.paths {
                    if is_object_file(&path) {
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

fn is_object_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("robj"))
}

/// Bevy system that processes file system events
pub fn process_watcher_events(
    watcher: Option<Res<ObjectLibraryWatcher>>,
    mut event_writer: MessageWriter<ObjectLibraryEvent>,
) {
    if let Some(watcher) = watcher {
        watcher.process_events(&mut event_writer);
    }
}

/// Bevy system that responds to file changes by rescanning the library
pub fn handle_library_changes(
    mut event_params: ParamSet<(
        MessageReader<ObjectLibraryEvent>,
        MessageWriter<ObjectLibraryEvent>,
    )>,
    mut manager: ResMut<crate::manager::ObjectLibraryManager>,
) {
    let mut needs_scan = false;

    // First, read all events (exclusive access to reader)
    for event in event_params.p0().read() {
        match event {
            ObjectLibraryEvent::FileChanged { path } => {
                tracing::info!(path = %path.display(), "Object library file changed");
                needs_scan = true;
            }
            ObjectLibraryEvent::FileRemoved { path } => {
                tracing::info!(path = %path.display(), "Object library file removed");
                needs_scan = true;
            }
            ObjectLibraryEvent::ScanCompleted { object_count } => {
                tracing::info!("Object library scan completed: {} objects", object_count);
            }
        }
    }

    // Now we can write (exclusive access to writer)
    if needs_scan {
        match manager.scan() {
            Ok(()) => {
                let count = manager.object_count();
                tracing::info!("Rescanned object library: {} objects", count);

                // Emit ScanCompleted event for other systems to react to
                event_params.p1().write(ObjectLibraryEvent::ScanCompleted {
                    object_count: count,
                });
            }
            Err(e) => {
                tracing::error!("Failed to rescan object library: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::is_object_file;

    #[test]
    fn object_file_extension_check_is_case_insensitive() {
        assert!(is_object_file(Path::new("lowercase.robj")));
        assert!(is_object_file(Path::new("uppercase.ROBJ")));
        assert!(is_object_file(Path::new("mixed.RoBj")));
    }

    #[test]
    fn object_file_extension_check_rejects_non_robj() {
        assert!(!is_object_file(Path::new("wrong.glb")));
        assert!(!is_object_file(Path::new("missing_extension")));
    }
}
