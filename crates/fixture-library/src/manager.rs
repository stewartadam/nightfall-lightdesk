// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture library manager

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use bevy_ecs::prelude::*;
use nightfall_fixtures::prelude::{Fixture, FixtureGeometry};
use uuid::Uuid;

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

/// Identifies one converted fixture definition by make, model, and mode.
type ConversionKey = (String, String, String);

/// A file-backed profile converted once for a mode and reused as an instance template.
#[derive(Debug)]
struct ConvertedFixture {
    /// Fixture template whose identifiers are replaced for each created instance.
    fixture: Fixture,
    /// Geometry derived from the source file, when the format provides one.
    geometry: Option<FixtureGeometry>,
}

/// Memoized results derived from the current index's source files.
///
/// Converting a GDTF profile unzips and parses the archive and probes its meshes, and
/// fingerprinting a profile reads the whole file. Patching many copies of one fixture
/// and republishing geometry for every patched fixture would otherwise repeat that work
/// per instance. Clones of the manager share one cache; rescanning replaces it.
#[derive(Default)]
struct DerivedProfileCache {
    /// Successful conversions keyed by make, model, and mode.
    conversions: RwLock<HashMap<ConversionKey, Arc<ConvertedFixture>>>,
    /// Content fingerprints keyed by source file path.
    source_versions: RwLock<HashMap<PathBuf, String>>,
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
    /// Conversions and fingerprints derived from the indexed source files.
    derived: Arc<DerivedProfileCache>,
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
            derived: Arc::default(),
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
            derived: Arc::default(),
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
        // Replace rather than clear so clones holding the previous index keep a consistent cache.
        self.derived = Arc::default();
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

        if matches!(profile.source, FixtureSource::BuiltIn { .. }) {
            if !profile.mode_names().iter().any(|name| name == mode) {
                return Err(FixtureLibraryError::ModeNotFound {
                    make: make.to_string(),
                    model: model.to_string(),
                    mode: mode.to_string(),
                });
            }

            return nightfall_fixtures::library::create_fixture_from_library(id, make, model, mode)
                .map(|mut fixture| {
                    fixture.mode = mode.to_string();
                    (fixture, None)
                })
                .ok_or_else(|| FixtureLibraryError::NotFound {
                    make: make.to_string(),
                    model: model.to_string(),
                });
        }

        let converted = self.converted_fixture(profile, mode)?;
        let mut fixture = converted.fixture.clone();
        fixture.identifiers.id = id;
        fixture.identifiers.uid = Uuid::new_v4();
        Ok((fixture, converted.geometry.clone()))
    }

    /// Returns the cached conversion of a file-backed profile, converting it on first use.
    ///
    /// Only successful conversions are cached so a transient read failure is retried.
    fn converted_fixture(
        &self,
        profile: &FixtureProfile,
        mode: &str,
    ) -> Result<Arc<ConvertedFixture>> {
        let key = (
            profile.make.clone(),
            profile.model.clone(),
            mode.to_string(),
        );
        if let Some(converted) = self
            .derived
            .conversions
            .read()
            .ok()
            .and_then(|conversions| conversions.get(&key).cloned())
        {
            return Ok(converted);
        }

        let (fixture, geometry) = match &profile.source {
            FixtureSource::Gdtf(metadata) => {
                crate::converters::gdtf::convert_gdtf_to_fixture(metadata, mode, 0)?
            }
            FixtureSource::Ofl(ofl) => {
                crate::converters::ofl::convert_ofl_to_fixture(ofl, mode, 0)?
            }
            FixtureSource::BuiltIn { .. } => {
                return Err(FixtureLibraryError::Conversion(format!(
                    "Built-in fixture {} {} has no source file to convert",
                    profile.make, profile.model
                )));
            }
        };
        let converted = Arc::new(ConvertedFixture { fixture, geometry });
        if let Ok(mut conversions) = self.derived.conversions.write() {
            conversions.insert(key, converted.clone());
        }
        Ok(converted)
    }

    /// Get geometry for a fixture from the library.
    ///
    /// This is used to materialize fixtures at runtime without recreating the full fixture.
    /// Returns `None` if the fixture source doesn't have geometry (e.g., OFL) or if not found.
    pub fn get_geometry(&self, make: &str, model: &str, mode: &str) -> Option<FixtureGeometry> {
        let profile = self.find_fixture(make, model)?;
        if !matches!(profile.source, FixtureSource::Gdtf(_)) {
            return None;
        }
        self.converted_fixture(profile, mode)
            .ok()
            .and_then(|converted| converted.geometry.clone())
    }

    /// Returns the deterministic version fingerprint for one fixture profile.
    ///
    /// File-backed fingerprints are computed once per source file until the next rescan.
    pub fn profile_asset_etag(&self, profile: &FixtureProfile) -> Result<String> {
        if let FixtureSource::BuiltIn { asset_etag, .. } = &profile.source {
            return Ok(asset_etag.clone());
        }
        if let Some(version) = self
            .derived
            .source_versions
            .read()
            .ok()
            .and_then(|versions| versions.get(&profile.file_path).cloned())
        {
            return Ok(version);
        }
        let version = fixture_source_version(&profile.file_path)?;
        if let Ok(mut versions) = self.derived.source_versions.write() {
            versions.insert(profile.file_path.clone(), version.clone());
        }
        Ok(version)
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
fn builtin_fixture_profiles() -> Vec<FixtureProfile> {
    [
        (
            "Generic",
            "100-segment LED Bar",
            "RGB",
            "builtin:generic-100-segment-led-bar:v1",
        ),
        (
            "Generic",
            "10-segment Rotating RGBW Bar",
            "RGBW",
            "builtin:generic-10-segment-rotating-rgbw-bar:v1",
        ),
        (
            "Generic",
            "12-segment RGBW Bar",
            "RGBW",
            "builtin:generic-12-segment-rgbw-bar:v1",
        ),
        (
            "Generic",
            "RGBPixelTape 180ch",
            "RGB",
            "builtin:generic-rgb-pixeltape-180ch:v1",
        ),
        (
            "Generic",
            "RGBPixelTape 120ch GRB",
            "GRB",
            "builtin:generic-rgb-pixeltape-120ch-grb:v1",
        ),
        (
            "Generic",
            "RGBPixelTape 120ch RGB",
            "RGB",
            "builtin:generic-rgb-pixeltape-120ch-rgb:v1",
        ),
        (
            "Generic",
            "Strobe Matrix 308ch",
            "Strobe",
            "builtin:generic-strobe-matrix-308ch:v1",
        ),
        (
            "Generic",
            "Strobe Matrix 312ch",
            "Strobe",
            "builtin:generic-strobe-matrix-312ch:v1",
        ),
        (
            "Generic",
            "RGB Strobe Bar 168ch",
            "Strobe",
            "builtin:generic-rgb-strobe-bar-168ch:v1",
        ),
        (
            "Generic",
            "12-segment Rotating Wash Beam",
            "Beam",
            "builtin:generic-12-segment-rotating-wash-beam:v1",
        ),
        (
            "Generic",
            "Moving Head Spot 16ch",
            "Spot",
            "builtin:generic-moving-head-spot-16ch:v1",
        ),
        (
            "Generic",
            "Moving Head RGBW",
            "Spot",
            "builtin:generic-moving-head-rgbw:v1",
        ),
    ]
    .into_iter()
    .map(|(make, model, mode, asset_etag)| FixtureProfile {
        source: FixtureSource::BuiltIn {
            mode: mode.to_string(),
            asset_etag: asset_etag.to_string(),
        },
        make: make.to_string(),
        model: model.to_string(),
        file_path: PathBuf::new(),
    })
    .collect()
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

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::test_support::{TEST_GDTF_MAKE, TEST_GDTF_MODE, TEST_GDTF_MODEL, write_test_gdtf};

    /// Creates a manager indexing one test GDTF archive and returns the archive path.
    fn gdtf_library(temp_dir: &TempDir) -> (FixtureLibraryManager, PathBuf) {
        let path = temp_dir.path().join("test.gdtf");
        write_test_gdtf(&path);
        let manager = FixtureLibraryManager::with_path(temp_dir.path().to_path_buf())
            .expect("fixture library should initialize");
        (manager, path)
    }

    /// Verifies repeated instances reuse one conversion and fingerprint, even once the source
    /// is unreadable, while each instance still receives its own identifiers.
    #[test]
    fn repeated_gdtf_instances_reuse_one_conversion() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let (manager, path) = gdtf_library(&temp_dir);
        let profile = manager
            .find_fixture(TEST_GDTF_MAKE, TEST_GDTF_MODEL)
            .expect("test GDTF should be indexed")
            .clone();

        let (first, first_geometry) = manager
            .create_fixture(TEST_GDTF_MAKE, TEST_GDTF_MODEL, TEST_GDTF_MODE, 1)
            .expect("GDTF fixture should convert");
        let first_etag = manager
            .profile_asset_etag(&profile)
            .expect("GDTF fixture should fingerprint");
        std::fs::remove_file(&path).expect("test GDTF should be removable");

        let (second, second_geometry) = manager
            .create_fixture(TEST_GDTF_MAKE, TEST_GDTF_MODEL, TEST_GDTF_MODE, 2)
            .expect("cached conversion should not reread the source");
        assert_eq!(first.identifiers.id, 1);
        assert_eq!(second.identifiers.id, 2);
        assert_ne!(first.identifiers.uid, second.identifiers.uid);
        assert_eq!(first.elements.len(), second.elements.len());
        assert_eq!(first.elements[0].parameters.len(), 1);
        assert!(first_geometry.is_some());
        assert_eq!(first_geometry, second_geometry);
        assert_eq!(
            manager.get_geometry(TEST_GDTF_MAKE, TEST_GDTF_MODEL, TEST_GDTF_MODE),
            first_geometry
        );
        assert_eq!(
            manager
                .profile_asset_etag(&profile)
                .expect("cached fingerprint should not reread the source"),
            first_etag
        );
    }

    /// Verifies a rescan discards cached conversions without disturbing clones of the old index.
    #[test]
    fn rescan_discards_cached_conversions() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let (mut manager, path) = gdtf_library(&temp_dir);
        manager
            .create_fixture(TEST_GDTF_MAKE, TEST_GDTF_MODEL, TEST_GDTF_MODE, 1)
            .expect("GDTF fixture should convert");
        let previous_index = manager.clone();

        std::fs::remove_file(&path).expect("test GDTF should be removable");
        manager.scan().expect("rescan should succeed");

        assert!(
            manager
                .find_fixture(TEST_GDTF_MAKE, TEST_GDTF_MODEL)
                .is_none()
        );
        assert!(
            previous_index
                .get_geometry(TEST_GDTF_MAKE, TEST_GDTF_MODEL, TEST_GDTF_MODE)
                .is_some(),
            "clones of the previous index keep their own consistent cache"
        );
        assert!(manager.derived.conversions.read().unwrap().is_empty());
    }
}
