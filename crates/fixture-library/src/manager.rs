// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture library manager

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use bevy_ecs::prelude::*;
use nightfall_fixtures::library::catalog;
use nightfall_fixtures::prelude::{Fixture, FixtureGeometry};

use crate::gdtf_metadata::GdtfMetadata;
use crate::{FixtureLibraryError, Result};

/// Source of a fixture definition
#[derive(Debug, Clone)]
pub enum FixtureSource {
    /// GDTF fixture (metadata only - re-parse file for conversion)
    Gdtf(GdtfMetadata),
    /// OFL fixture (boxed to reduce enum size - OflFixture is ~752 bytes vs ~96 for GdtfMetadata)
    Ofl(Box<open_fixture_library::OflFixture>),
    /// Built-in nightfall fixture definition.
    BuiltIn {
        /// User-facing mode name exposed through the patch wizard.
        mode: String,
        /// Deterministic version string for the built-in definition.
        asset_etag: String,
    },
}

/// A fixture profile from the library
#[derive(Debug, Clone)]
pub struct FixtureProfile {
    /// Source format backing this profile.
    pub source: FixtureSource,
    /// Manufacturer name
    pub make: String,
    /// Model name
    pub model: String,
    /// File path for file-backed profiles, empty for built-ins.
    pub file_path: PathBuf,
}

impl FixtureProfile {
    /// Get available mode names
    pub fn mode_names(&self) -> Vec<String> {
        match &self.source {
            FixtureSource::Gdtf(metadata) => metadata.modes.clone(),
            FixtureSource::Ofl(ofl) => ofl.modes().iter().map(|m| m.name.clone()).collect(),
            FixtureSource::BuiltIn { mode, .. } => vec![mode.clone()],
        }
    }

    /// Get the default mode name (first mode)
    pub fn default_mode(&self) -> Option<String> {
        self.mode_names().into_iter().next()
    }
}

/// Fixture library manager
///
/// Manages a collection of fixture definitions from GDTF and OFL files.
#[derive(Resource, Clone)]
pub struct FixtureLibraryManager {
    /// Indexed fixtures by "make:model" key
    fixtures: HashMap<String, FixtureProfile>,
    /// Library directory path
    library_path: PathBuf,
    /// Optional package library overlaid on installed profiles.
    showfile_directory: Option<PathBuf>,
}

impl FixtureLibraryManager {
    /// Create a new fixture library manager with the default library path
    pub fn new() -> Result<Self> {
        let library_path = Self::get_library_path()?;
        Self::with_path(library_path)
    }

    /// Create a new fixture library manager with a custom library path
    pub fn with_path(library_path: PathBuf) -> Result<Self> {
        let mut manager = Self {
            fixtures: HashMap::new(),
            library_path,
            showfile_directory: None,
        };

        // Create library directory if it doesn't exist
        if !manager.library_path.exists() {
            std::fs::create_dir_all(&manager.library_path)?;
            tracing::info!(
                library_path = %manager.library_path.display(),
                "Created fixture library directory"
            );
        }

        // Scan for fixtures
        manager.scan()?;

        Ok(manager)
    }

    /// Reads installed and packaged profiles without creating or modifying either directory.
    pub fn read_from_directories(
        library_path: PathBuf,
        showfile_directory: Option<PathBuf>,
    ) -> Result<Self> {
        let mut manager = Self {
            fixtures: HashMap::new(),
            library_path,
            showfile_directory,
        };
        manager.scan()?;
        Ok(manager)
    }

    /// Selects package-local definitions, rebuilding the index so a previous show's assets cannot leak.
    pub fn set_showfile_directory(&mut self, directory: Option<PathBuf>) -> Result<()> {
        self.showfile_directory = directory;
        self.scan()
    }

    /// Get the platform-specific library path
    pub fn get_library_path() -> Result<PathBuf> {
        let data_dir = nightfall::nightfall_data_dir().ok_or_else(|| {
            FixtureLibraryError::InvalidDataDirectory(
                "Could not determine project directories".to_string(),
            )
        })?;

        Ok(data_dir.join("fixtures"))
    }

    /// Get the library directory path
    pub fn library_path(&self) -> &Path {
        &self.library_path
    }

    /// Scan the library directory for fixtures
    pub fn scan(&mut self) -> Result<()> {
        self.fixtures.clear();
        self.insert_builtin_profiles();

        let scanner = crate::scanner::FixtureScanner::new(&self.library_path);
        let mut profiles = scanner.scan()?;
        if let Some(directory) = &self.showfile_directory {
            profiles
                .extend(crate::scanner::FixtureScanner::new(&directory.join("fixtures")).scan()?);
        }

        for profile in profiles {
            let key = format!("{}:{}", profile.make, profile.model);
            self.fixtures.insert(key, profile);
        }

        tracing::info!(
            "Loaded {} fixtures from fixture library and built-ins",
            self.fixtures.len()
        );

        Ok(())
    }

    /// List all available fixtures
    pub fn list_fixtures(&self) -> Vec<&FixtureProfile> {
        self.fixtures.values().collect()
    }

    /// Find a fixture by manufacturer and model
    pub fn find_fixture(&self, make: &str, model: &str) -> Option<&FixtureProfile> {
        let key = format!("{}:{}", make, model);
        self.fixtures.get(&key)
    }

    /// Create a fixture instance from the library.
    ///
    /// Returns a tuple of user-configurable `Fixture` data and optionally
    /// runtime-derived geometry (for GDTF sources).
    pub fn create_fixture(
        &self,
        make: &str,
        model: &str,
        mode: &str,
        id: u32,
    ) -> Result<(Fixture, Option<FixtureGeometry>)> {
        let profile =
            self.find_fixture(make, model)
                .ok_or_else(|| FixtureLibraryError::NotFound {
                    make: make.to_string(),
                    model: model.to_string(),
                })?;

        match &profile.source {
            FixtureSource::Gdtf(metadata) => {
                crate::converters::gdtf::convert_gdtf_to_fixture(metadata, mode, id)
            }
            FixtureSource::Ofl(ofl) => {
                crate::converters::ofl::convert_ofl_to_fixture(ofl, mode, id)
            }
            FixtureSource::BuiltIn { .. } => {
                if !profile.mode_names().iter().any(|name| name == mode) {
                    return Err(FixtureLibraryError::ModeNotFound {
                        make: make.to_string(),
                        model: model.to_string(),
                        mode: mode.to_string(),
                    });
                }

                catalog::find_builtin_fixture_profile(make, model)
                    .and_then(|builtin| builtin.create_fixture(id, mode))
                    .map(|fixture| (fixture, None))
                    .ok_or_else(|| FixtureLibraryError::NotFound {
                        make: make.to_string(),
                        model: model.to_string(),
                    })
            }
        }
    }

    /// Get geometry for a fixture from the library.
    ///
    /// This is used to materialize fixtures at runtime without recreating the full fixture.
    /// Returns `None` if the fixture source doesn't have geometry (e.g., OFL) or if not found.
    pub fn get_geometry(&self, make: &str, model: &str, mode: &str) -> Option<FixtureGeometry> {
        let profile = self.find_fixture(make, model)?;

        match &profile.source {
            FixtureSource::Gdtf(metadata) => {
                crate::converters::gdtf::get_gdtf_geometry(metadata, mode).ok()
            }
            FixtureSource::Ofl(_) => None, // OFL doesn't have geometry
            FixtureSource::BuiltIn { .. } => None,
        }
    }

    /// Get the number of fixtures in the library
    pub fn fixture_count(&self) -> usize {
        self.fixtures.len()
    }

    /// Upload a fixture file to the library.
    ///
    /// Writes the file content to the library directory with the given filename.
    /// The file watcher will automatically detect the new file and trigger a rescan.
    pub fn upload_fixture(&self, filename: &str, content: &[u8]) -> Result<PathBuf> {
        // Validate filename extension
        let extension = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());

        match extension.as_deref() {
            Some("gdtf") | Some("json") => {}
            _ => {
                return Err(FixtureLibraryError::InvalidDataDirectory(format!(
                    "Unsupported file format: {}. Only .gdtf and .json (OFL) files are supported.",
                    filename
                )));
            }
        }

        // Sanitize filename to prevent path traversal
        let safe_filename = Path::new(filename)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| {
                FixtureLibraryError::InvalidDataDirectory(format!("Invalid filename: {}", filename))
            })?;

        let dest_path = self.library_path.join(safe_filename);

        // Write the file
        std::fs::write(&dest_path, content)?;

        tracing::info!(path = %dest_path.display(), "Uploaded fixture file");

        Ok(dest_path)
    }

    /// Delete a fixture from the library by make and model.
    ///
    /// Removes the fixture file from disk. The file watcher will automatically
    /// detect the removal and trigger a rescan.
    pub fn delete_fixture(&mut self, make: &str, model: &str) -> Result<()> {
        let key = format!("{}:{}", make, model);

        let profile = self
            .fixtures
            .get(&key)
            .ok_or_else(|| FixtureLibraryError::NotFound {
                make: make.to_string(),
                model: model.to_string(),
            })?;

        let file_path = profile.file_path.clone();

        if matches!(&profile.source, FixtureSource::BuiltIn { .. }) {
            return Err(FixtureLibraryError::InvalidDataDirectory(format!(
                "Cannot delete built-in fixture: {} {}",
                make, model
            )));
        }

        // Remove from our cache first
        self.fixtures.remove(&key);

        // Delete the file
        if file_path.exists() {
            std::fs::remove_file(&file_path)?;
            tracing::info!(
                path = %file_path.display(),
                make,
                model,
                "Deleted fixture file"
            );
        } else {
            tracing::warn!(
                path = %file_path.display(),
                make,
                model,
                "Fixture file was already removed"
            );
        }

        Ok(())
    }

    /// Insert built-in fixture profiles, preserving any file-backed duplicates added later.
    fn insert_builtin_profiles(&mut self) {
        for profile in builtin_fixture_profiles() {
            let key = format!("{}:{}", profile.make, profile.model);
            self.fixtures.insert(key, profile);
        }
    }
}

/// Compute a deterministic content fingerprint for a fixture source file.
pub fn fixture_source_version(source_path: &Path) -> Result<String> {
    let bytes = std::fs::read(source_path)?;
    Ok(fnv1a64_hex(&bytes))
}

/// Return built-in profiles that should be available even when no fixture files are installed.
fn builtin_fixture_profiles() -> impl Iterator<Item = FixtureProfile> {
    catalog::builtin_fixture_profiles()
        .iter()
        .map(|profile| FixtureProfile {
            source: FixtureSource::BuiltIn {
                mode: profile.mode.to_string(),
                asset_etag: profile.asset_etag.to_string(),
            },
            make: profile.make.to_string(),
            model: profile.model.to_string(),
            file_path: PathBuf::new(),
        })
}

/// Format bytes as a stable FNV-1a hex fingerprint.
fn fnv1a64_hex(bytes: &[u8]) -> String {
    // Stable, dependency-free fingerprint for version comparisons.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

impl Default for FixtureLibraryManager {
    fn default() -> Self {
        Self::new().expect("Failed to create fixture library manager")
    }
}
