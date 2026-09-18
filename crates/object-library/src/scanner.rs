// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! File system scanner for object files

use std::io::Read;
use std::path::{Path, PathBuf};

use crate::Result;
use crate::manager::ObjectProfile;
use crate::metadata::ObjectMetadata;

/// Object file scanner
pub struct ObjectScanner {
    library_path: PathBuf,
}

impl ObjectScanner {
    /// Create a new scanner for the given library path
    pub fn new(library_path: &Path) -> Self {
        Self {
            library_path: library_path.to_path_buf(),
        }
    }

    /// Scan the library directory for object files
    pub fn scan(&self) -> Result<Vec<ObjectProfile>> {
        let mut profiles = Vec::new();

        if !self.library_path.exists() {
            return Ok(profiles);
        }

        for entry in std::fs::read_dir(&self.library_path)? {
            let entry = entry?;
            let path = entry.path();

            if !path.is_file() {
                continue;
            }

            match self.try_parse_file(&path) {
                Ok(Some(profile)) => {
                    tracing::trace!(
                        name = %profile.name(),
                        file_path = ?profile.file_path,
                        "Found object"
                    );
                    profiles.push(profile)
                }
                Ok(None) => {} // Not an object file, skip silently
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %e,
                        "Failed to parse object file"
                    );
                }
            }
        }

        Ok(profiles)
    }

    /// Try to parse a file as an object definition
    /// Returns Ok(None) if the file is not a recognized object format
    /// Returns Err on parsing errors
    fn try_parse_file(&self, path: &Path) -> Result<Option<ObjectProfile>> {
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        match extension.as_deref() {
            Some("robj") => self.parse_robj(path).map(Some),
            _ => Ok(None),
        }
    }

    /// Parse a .robj bundle file
    fn parse_robj(&self, path: &Path) -> Result<ObjectProfile> {
        let file = std::fs::File::open(path)?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| {
            crate::ObjectLibraryError::Archive(format!("Failed to open archive: {}", e))
        })?;

        // Read object.json in a block to release the borrow
        let metadata: ObjectMetadata = {
            let mut metadata_file = archive.by_name("object.json").map_err(|_| {
                crate::ObjectLibraryError::Metadata("Missing object.json in bundle".to_string())
            })?;

            let mut metadata_json = String::new();
            metadata_file.read_to_string(&mut metadata_json)?;

            serde_json::from_str(&metadata_json)?
        };

        // Verify model.glb exists
        archive
            .by_name("model.glb")
            .map_err(|_| crate::ObjectLibraryError::ModelNotFound("model.glb".to_string()))?;

        Ok(ObjectProfile {
            metadata,
            file_path: path.to_path_buf(),
        })
    }
}
