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

/// Default-selection precedence of a profile: source layer, file modification
/// time, then path.
type DefaultRank = (u8, Option<std::time::SystemTime>, PathBuf);

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
    /// Content fingerprint identifying this revision of the definition.
    pub revision: String,
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
    /// Profiles by revision key (make, model, revision); several revisions of
    /// one make/model coexist so patched fixtures keep their definition.
    fixtures: HashMap<(String, String, String), FixtureProfile>,
    /// Revision chosen by default for each (make, model): the one with the
    /// highest [`DefaultRank`], independent of scan order.
    latest: HashMap<(String, String), String>,
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
            latest: HashMap::new(),
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
            latest: HashMap::new(),
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
        self.latest.clear();
        self.insert_builtin_profiles();

        let scanner = crate::scanner::FixtureScanner::new(&self.library_path);
        let mut profiles = scanner.scan()?;
        if let Some(directory) = &self.showfile_directory {
            profiles
                .extend(crate::scanner::FixtureScanner::new(&directory.join("fixtures")).scan()?);
        }

        for profile in profiles {
            self.insert_profile(profile);
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

    /// Indexes a profile under its revision and makes it the default for its
    /// make/model when it outranks the current default.
    fn insert_profile(&mut self, profile: FixtureProfile) {
        let identity = (profile.make.clone(), profile.model.clone());
        let outranks_default = self
            .latest
            .get(&identity)
            .and_then(|revision| {
                self.fixtures
                    .get(&(identity.0.clone(), identity.1.clone(), revision.clone()))
            })
            .is_none_or(|current| self.default_rank(&profile) >= self.default_rank(current));
        if outranks_default {
            self.latest
                .insert(identity.clone(), profile.revision.clone());
        }
        self.fixtures
            .insert((identity.0, identity.1, profile.revision.clone()), profile);
    }

    /// Ranks a profile for default selection: package-local definitions beat
    /// installed ones, which beat built-ins; within a source the most recently
    /// modified file wins, and the path breaks remaining ties.
    fn default_rank(&self, profile: &FixtureProfile) -> DefaultRank {
        let source = if matches!(profile.source, FixtureSource::BuiltIn { .. }) {
            0
        } else if self
            .showfile_directory
            .as_ref()
            .is_some_and(|directory| profile.file_path.starts_with(directory))
        {
            2
        } else {
            1
        };
        let modified = std::fs::metadata(&profile.file_path)
            .and_then(|metadata| metadata.modified())
            .ok();
        (source, modified, profile.file_path.clone())
    }

    /// Find the default (highest-ranked) revision of a fixture by manufacturer and model
    pub fn find_fixture(&self, make: &str, model: &str) -> Option<&FixtureProfile> {
        self.find_revision(make, model, None)
    }

    /// Find a specific revision of a fixture, or the default revision when `revision` is `None`.
    pub fn find_revision(
        &self,
        make: &str,
        model: &str,
        revision: Option<&str>,
    ) -> Option<&FixtureProfile> {
        let revision = match revision {
            Some(revision) => revision.to_string(),
            None => self
                .latest
                .get(&(make.to_string(), model.to_string()))?
                .clone(),
        };
        self.fixtures
            .get(&(make.to_string(), model.to_string(), revision))
    }

    /// Create a fixture instance from the default revision in the library.
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
        self.create_fixture_from_revision(make, model, None, mode, id)
    }

    /// Create a fixture instance from a specific library revision (or the default when `None`).
    ///
    /// The created fixture records the revision in `library_asset_etag`, so
    /// its geometry and parameters stay tied to that definition.
    pub fn create_fixture_from_revision(
        &self,
        make: &str,
        model: &str,
        revision: Option<&str>,
        mode: &str,
        id: u32,
    ) -> Result<(Fixture, Option<FixtureGeometry>)> {
        let profile = self.find_revision(make, model, revision).ok_or_else(|| {
            FixtureLibraryError::NotFound {
                make: make.to_string(),
                model: model.to_string(),
            }
        })?;
        let (mut fixture, geometry) = Self::convert_profile(profile, make, model, mode, id)?;
        if !matches!(profile.source, FixtureSource::BuiltIn { .. }) {
            fixture.library_asset_etag = Some(profile.revision.clone());
        }
        Ok((
            fixture,
            geometry.map(|geometry| with_revision(geometry, profile)),
        ))
    }

    /// Converts one mode of a profile into a fixture and optional geometry.
    fn convert_profile(
        profile: &FixtureProfile,
        make: &str,
        model: &str,
        mode: &str,
        id: u32,
    ) -> Result<(Fixture, Option<FixtureGeometry>)> {
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

                nightfall_fixtures::library::create_fixture_from_library(id, make, model, mode)
                    .map(|mut fixture| {
                        fixture.mode = mode.to_string();
                        (fixture, None)
                    })
                    .ok_or_else(|| FixtureLibraryError::NotFound {
                        make: make.to_string(),
                        model: model.to_string(),
                    })
            }
        }
    }

    /// Get geometry for a patched fixture from the library.
    ///
    /// Uses the definition chosen by [`Self::profile_for_fixture`]. Returns
    /// `None` when no compatible definition exists or its source has no
    /// geometry.
    pub fn geometry_for_fixture(&self, fixture: &Fixture) -> Option<FixtureGeometry> {
        Self::profile_geometry(self.profile_for_fixture(fixture)?, &fixture.mode)
    }

    /// Resolves the library definition that backs a patched fixture.
    ///
    /// Uses the revision the fixture was created from. When that revision is
    /// no longer available, the default revision is used only if converting it
    /// yields the same elements and parameter placement; otherwise `None` is
    /// returned rather than pairing the fixture's controls with a different
    /// definition. Fixtures without a recorded revision use the default
    /// revision. Geometry lookup and showfile export share this so an export
    /// packages the definition the show renders with.
    pub fn profile_for_fixture(&self, fixture: &Fixture) -> Option<&FixtureProfile> {
        let (make, model, mode) = (&fixture.make, &fixture.model, &fixture.mode);
        let recorded = fixture.library_asset_etag.as_deref();
        if let Some(profile) =
            recorded.and_then(|revision| self.find_revision(make, model, Some(revision)))
        {
            return Some(profile);
        }

        let profile = self.find_fixture(make, model)?;
        let Some(recorded) = recorded else {
            return Some(profile);
        };
        if matches!(profile.source, FixtureSource::BuiltIn { .. }) {
            return None;
        }
        let (candidate, _) = Self::convert_profile(profile, make, model, mode, 0).ok()?;
        if same_element_structure(&candidate, fixture) {
            tracing::info!(
                make,
                model,
                recorded,
                available = profile.revision,
                "Using a structurally identical library revision for fixture"
            );
            Some(profile)
        } else {
            tracing::warn!(
                make,
                model,
                recorded,
                available = profile.revision,
                "Fixture's library revision is missing and the available revision differs; \
                 repatch the fixture to use it"
            );
            None
        }
    }

    /// Returns geometry for one mode of a profile, if its source provides geometry.
    fn profile_geometry(profile: &FixtureProfile, mode: &str) -> Option<FixtureGeometry> {
        match &profile.source {
            FixtureSource::Gdtf(metadata) => {
                crate::converters::gdtf::get_gdtf_geometry(metadata, mode)
                    .ok()
                    .map(|geometry| with_revision(geometry, profile))
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
        self.delete_fixture_revision(make, model, None)
    }

    /// Delete one revision of a fixture (the default revision when `revision` is `None`).
    ///
    /// Removes the fixture file from disk. The file watcher will automatically
    /// detect the removal and trigger a rescan.
    pub fn delete_fixture_revision(
        &mut self,
        make: &str,
        model: &str,
        revision: Option<&str>,
    ) -> Result<()> {
        let profile = self.find_revision(make, model, revision).ok_or_else(|| {
            FixtureLibraryError::NotFound {
                make: make.to_string(),
                model: model.to_string(),
            }
        })?;

        let file_path = profile.file_path.clone();

        if matches!(&profile.source, FixtureSource::BuiltIn { .. }) {
            return Err(FixtureLibraryError::InvalidDataDirectory(format!(
                "Cannot delete built-in fixture: {} {}",
                make, model
            )));
        }

        // Remove from our cache first
        let key = (
            make.to_string(),
            model.to_string(),
            profile.revision.clone(),
        );
        self.fixtures.remove(&key);
        let identity = (key.0.clone(), key.1.clone());
        if self.latest.get(&identity) == Some(&key.2) {
            self.latest.remove(&identity);
            if let Some(promoted) = self
                .fixtures
                .values()
                .filter(|profile| profile.make == key.0 && profile.model == key.1)
                .max_by_key(|profile| self.default_rank(profile))
            {
                self.latest.insert(identity, promoted.revision.clone());
            }
        }

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
            self.insert_profile(profile);
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
        revision: asset_etag.to_string(),
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

/// Returns whether two fixtures expose the same elements and parameter placement.
///
/// Programming refers to elements by index and parameters by attribute, and
/// output depends on resolution and slots, so any difference in these means
/// one definition cannot stand in for the other.
fn same_element_structure(left: &Fixture, right: &Fixture) -> bool {
    left.elements.len() == right.elements.len()
        && left
            .elements
            .iter()
            .zip(&right.elements)
            .all(|(left, right)| {
                left.label == right.label
                    && left.parameters.len() == right.parameters.len()
                    && left
                        .parameters
                        .iter()
                        .zip(&right.parameters)
                        .all(|(left, right)| {
                            left.attribute == right.attribute
                                && left.resolution == right.resolution
                                && left.dmx_slots == right.dmx_slots
                        })
            })
}

#[cfg(test)]
mod revision_tests {
    use super::*;
    use crate::testing::{ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec, translation};

    /// Builds a one-channel archive whose root geometry name and offset vary per revision.
    fn revision(root: &str, z: f64, attribute: &str) -> GdtfBuilder {
        GdtfBuilder::new("Rev Test", "Fixture")
            .geometry(GeometrySpec::generic(root).at(translation(0.0, 0.0, z)))
            .mode(ModeSpec::new("Mode", root).channel(ChannelSpec::new(root, attribute, &[1])))
    }

    /// Writes archives to a fresh library directory and scans it.
    fn library(revisions: &[(&str, GdtfBuilder)]) -> (tempfile::TempDir, FixtureLibraryManager) {
        let dir = tempfile::tempdir().unwrap();
        for (file, builder) in revisions {
            builder.write_to(&dir.path().join(file));
        }
        let manager = FixtureLibraryManager::with_path(dir.path().to_path_buf()).unwrap();
        (dir, manager)
    }

    /// Verifies two revisions of one make/model are both listed and individually addressable.
    #[test]
    fn revisions_of_one_model_coexist() {
        let (_dir, manager) = library(&[
            ("a.gdtf", revision("Body", 0.0, "Dimmer")),
            ("b.gdtf", revision("Body", 0.5, "Dimmer")),
        ]);
        let revisions: Vec<&FixtureProfile> = manager
            .list_fixtures()
            .into_iter()
            .filter(|profile| profile.make == "Rev Test")
            .collect();
        assert_eq!(revisions.len(), 2);
        for profile in revisions {
            let found = manager
                .find_revision("Rev Test", "Fixture", Some(&profile.revision))
                .unwrap();
            assert_eq!(found.file_path, profile.file_path);
        }
        assert!(manager.find_fixture("Rev Test", "Fixture").is_some());
    }

    /// Verifies a fixture keeps its own revision's geometry even when another revision is the default.
    #[test]
    fn geometry_follows_the_fixtures_revision() {
        let (_dir, manager) = library(&[
            ("a.gdtf", revision("Body", 0.0, "Dimmer")),
            ("b.gdtf", revision("Body", 0.5, "Dimmer")),
        ]);
        for profile in manager.list_fixtures() {
            if profile.make != "Rev Test" {
                continue;
            }
            let (fixture, geometry) = manager
                .create_fixture_from_revision(
                    "Rev Test",
                    "Fixture",
                    Some(&profile.revision),
                    "Mode",
                    1,
                )
                .unwrap();
            assert_eq!(
                fixture.library_asset_etag.as_deref(),
                Some(profile.revision.as_str())
            );
            assert_eq!(manager.geometry_for_fixture(&fixture), geometry);
        }
    }

    /// Verifies a missing revision falls back only to a structurally identical definition.
    #[test]
    fn missing_revision_falls_back_only_when_structure_matches() {
        let (_dir, manager) = library(&[("b.gdtf", revision("Body", 0.5, "Dimmer"))]);
        let (mut fixture, _) = manager
            .create_fixture("Rev Test", "Fixture", "Mode", 1)
            .unwrap();
        fixture.library_asset_etag = Some("deleted-revision".to_string());
        assert!(manager.geometry_for_fixture(&fixture).is_some());

        let (_dir, changed) = library(&[("c.gdtf", revision("Body", 0.5, "Zoom"))]);
        assert_eq!(changed.geometry_for_fixture(&fixture), None);
    }

    /// Verifies the most recently modified revision is the default regardless
    /// of which file the directory scan yields last.
    #[test]
    fn default_revision_is_the_most_recently_modified() {
        let dir = tempfile::tempdir().unwrap();
        let older = dir.path().join("z-older.gdtf");
        let newer = dir.path().join("a-newer.gdtf");
        revision("Body", 0.0, "Dimmer").write_to(&older);
        revision("Body", 0.5, "Dimmer").write_to(&newer);
        let now = std::time::SystemTime::now();
        for (path, age) in [(&older, 120), (&newer, 60)] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(now - std::time::Duration::from_secs(age))
                .unwrap();
        }
        let manager = FixtureLibraryManager::with_path(dir.path().to_path_buf()).unwrap();
        let default = manager.find_fixture("Rev Test", "Fixture").unwrap();
        assert_eq!(default.file_path, newer);
    }

    /// Verifies a fixture whose recorded revision is gone resolves to the
    /// structurally identical default, so export can package it.
    #[test]
    fn missing_revision_resolves_to_compatible_profile() {
        let (_dir, manager) = library(&[("b.gdtf", revision("Body", 0.5, "Dimmer"))]);
        let (mut fixture, _) = manager
            .create_fixture("Rev Test", "Fixture", "Mode", 1)
            .unwrap();
        fixture.library_asset_etag = Some("deleted-revision".to_string());
        let profile = manager.profile_for_fixture(&fixture).unwrap();
        assert!(profile.file_path.ends_with("b.gdtf"));
    }

    /// Verifies deleting the default revision promotes a remaining one.
    #[test]
    fn deleting_default_revision_promotes_another() {
        let (_dir, mut manager) = library(&[
            ("a.gdtf", revision("Body", 0.0, "Dimmer")),
            ("b.gdtf", revision("Body", 0.5, "Dimmer")),
        ]);
        let default = manager
            .find_fixture("Rev Test", "Fixture")
            .unwrap()
            .revision
            .clone();
        manager
            .delete_fixture_revision("Rev Test", "Fixture", Some(&default))
            .unwrap();
        let remaining = manager.find_fixture("Rev Test", "Fixture").unwrap();
        assert_ne!(remaining.revision, default);
    }
}

/// Tags geometry with the profile revision it was built from, versioning its resource URLs.
fn with_revision(mut geometry: FixtureGeometry, profile: &FixtureProfile) -> FixtureGeometry {
    geometry.gdtf_revision = Some(profile.revision.clone());
    geometry
}
