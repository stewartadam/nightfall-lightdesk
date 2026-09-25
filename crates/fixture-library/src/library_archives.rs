// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Authorizes client-supplied archive paths against the fixture library index.
//!
//! HTTP media routes receive archive paths from clients. Only archives that the
//! [`FixtureLibraryManager`] currently indexes may be opened, so a client cannot
//! use these routes to read arbitrary files from the host.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, PoisonError, RwLock};

use bevy_ecs::prelude::*;

use crate::manager::FixtureLibraryManager;

/// Canonical paths of the GDTF archives HTTP routes are allowed to open.
///
/// Cloned handles share one allowlist, so axum handlers observe library rescans
/// without holding a reference to the Bevy world.
#[derive(Resource, Clone, Default)]
pub struct LibraryArchives(Arc<RwLock<HashSet<PathBuf>>>);

impl LibraryArchives {
    /// Replaces the allowlist with the canonical path of every archive the manager indexes.
    ///
    /// Archives that cannot be canonicalized (for example, removed since the last scan) are
    /// omitted, so requests for them are rejected rather than resolved later.
    pub fn sync(&self, manager: &FixtureLibraryManager) {
        let archives = manager
            .gdtf_archive_paths()
            .filter_map(|path| path.canonicalize().ok())
            .collect();
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = archives;
    }

    /// Resolves a client-supplied path to an indexed archive.
    ///
    /// The request is canonicalized before lookup so relative segments and symlinks cannot
    /// reach files outside the library. Returns `None` for any path that is not an indexed
    /// archive, including paths that do not exist.
    pub fn resolve(&self, requested: &Path) -> Option<PathBuf> {
        let canonical = requested.canonicalize().ok()?;
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&canonical)
            .then_some(canonical)
    }
}

/// Refreshes the route allowlist whenever the fixture library index changes.
pub(crate) fn sync_library_archives(
    library: Res<FixtureLibraryManager>,
    archives: Res<LibraryArchives>,
) {
    if library.is_changed() {
        archives.sync(&library);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Writes a minimal but indexable GDTF archive so the manager treats it as a library profile.
    pub(crate) fn write_indexed_gdtf(path: &Path) {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("description.xml", options).unwrap();
        zip.write_all(br#"<GDTF DataVersion="1.2"></GDTF>"#)
            .unwrap();
        zip.start_file("wheels/pattern.png", options).unwrap();
        zip.write_all(b"\x89PNG\r\n\x1a\nsource-payload").unwrap();
        zip.finish().unwrap();
    }

    /// Only archives indexed by the manager resolve; siblings, traversal and missing paths do not.
    #[test]
    fn resolves_only_indexed_archives() {
        let library = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let indexed = library.path().join("optic.gdtf");
        write_indexed_gdtf(&indexed);
        let stray = outside.path().join("stray.gdtf");
        write_indexed_gdtf(&stray);

        let manager =
            FixtureLibraryManager::read_from_directories(library.path().to_path_buf(), None)
                .unwrap();
        assert_eq!(manager.gdtf_archive_paths().count(), 1);
        let archives = LibraryArchives::default();
        archives.sync(&manager);

        assert_eq!(
            archives.resolve(&indexed),
            Some(indexed.canonicalize().unwrap())
        );
        let traversal = library
            .path()
            .join("..")
            .join(library.path().file_name().unwrap())
            .join("optic.gdtf");
        assert!(archives.resolve(&traversal).is_some());
        assert!(archives.resolve(&stray).is_none());
        assert!(
            archives
                .resolve(&library.path().join("missing.gdtf"))
                .is_none()
        );
        assert!(archives.resolve(Path::new("/etc/hosts")).is_none());
    }
}
