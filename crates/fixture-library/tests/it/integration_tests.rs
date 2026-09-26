// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests for fixture library

use nightfall_fixture_library::prelude::*;
use tempfile::TempDir;

/// Number of built-in fixture profiles registered for empty libraries.
const BUILT_IN_FIXTURE_COUNT: usize = 12;

/// Helper to create a temporary library directory.
fn create_temp_library() -> TempDir {
    tempfile::tempdir().expect("Failed to create temp directory")
}

/// Verifies manager creation registers built-in fixtures for empty directories.
#[test]
fn test_fixture_library_manager_creation() {
    let temp_dir = create_temp_library();
    let manager = FixtureLibraryManager::with_path(temp_dir.path().to_path_buf());

    assert!(manager.is_ok());
    let manager = manager.unwrap();
    assert_eq!(manager.fixture_count(), BUILT_IN_FIXTURE_COUNT);
    assert_eq!(manager.library_path(), temp_dir.path());
}

/// Verifies creating a manager creates the fixture library directory.
#[test]
fn test_fixture_library_creates_directory() {
    let temp_dir = create_temp_library();
    let lib_path = temp_dir.path().join("fixtures");

    // Directory doesn't exist yet
    assert!(!lib_path.exists());

    // Create manager - should create directory
    let manager = FixtureLibraryManager::with_path(lib_path.clone());
    assert!(manager.is_ok());

    // Directory should now exist
    assert!(lib_path.exists());
}

/// Verifies an empty fixture directory still exposes built-in fixtures.
#[test]
fn test_empty_library() {
    let temp_dir = create_temp_library();
    let manager = FixtureLibraryManager::with_path(temp_dir.path().to_path_buf()).unwrap();

    assert_eq!(manager.fixture_count(), BUILT_IN_FIXTURE_COUNT);
    assert!(!manager.list_fixtures().is_empty());
    assert!(
        manager
            .find_fixture("Generic", "RGBPixelTape 120ch GRB")
            .is_some()
    );
    assert!(
        manager
            .find_fixture("Generic", "RGBPixelTape 120ch RGB")
            .is_some()
    );
    assert!(
        manager
            .find_fixture("Generic", "Strobe Matrix 312ch")
            .is_some()
    );
    assert!(manager.find_fixture("NonExistent", "Fixture").is_none());
}

/// Verifies unknown fixtures still fail with NotFound.
#[test]
fn test_create_fixture_not_found() {
    let temp_dir = create_temp_library();
    let manager = FixtureLibraryManager::with_path(temp_dir.path().to_path_buf()).unwrap();

    let result = manager.create_fixture("NonExistent", "Fixture", "mode1", 1);
    assert!(result.is_err());
    assert!(matches!(
        result.unwrap_err(),
        FixtureLibraryError::NotFound { .. }
    ));
}

/// Verifies the default fixture library can list and create available fixtures.
#[test]
fn test_library_with_real_fixtures() {
    // Use the default library path which should contain fixtures
    let manager = FixtureLibraryManager::new();

    // This might fail if no fixtures are installed, so we handle both cases
    match manager {
        Ok(manager) => {
            println!(
                "Found {} fixtures in default library",
                manager.fixture_count()
            );

            // If we have fixtures, test basic operations
            if manager.fixture_count() > 0 {
                let fixtures = manager.list_fixtures();
                assert!(!fixtures.is_empty());

                // Test the first fixture
                let first = fixtures.first().unwrap();
                println!("Testing fixture: {} {}", first.make, first.model);

                // Should be able to find it
                let found = manager.find_fixture(&first.make, &first.model);
                assert!(found.is_some());

                // Should have at least one mode
                let modes = first.mode_names();
                assert!(!modes.is_empty());

                // Should be able to get default mode
                assert!(first.default_mode().is_some());

                // Try to create a fixture instance
                if let Some(mode) = modes.first() {
                    let result = manager.create_fixture(&first.make, &first.model, mode, 1);
                    if let Ok((fixture, geometry)) = result {
                        assert_eq!(fixture.make, first.make);
                        assert_eq!(fixture.model, first.model);
                        assert_eq!(fixture.identifiers.id, 1);
                        assert!(!fixture.elements.is_empty());
                        println!(
                            "  Created fixture with {} elements, geometry: {}",
                            fixture.elements.len(),
                            geometry.is_some()
                        );
                    }
                }
            }
        }
        Err(e) => {
            // No fixtures directory - this is acceptable for test environment
            println!("No default fixture library found: {}", e);
        }
    }
}

/// Verifies fixture profile mode helpers return stable defaults.
#[test]
fn test_fixture_profile_mode_operations() {
    // This test doesn't require actual fixture files
    // We'll test with real fixtures if they're available
    if let Ok(manager) = FixtureLibraryManager::new() {
        if manager.fixture_count() > 0 {
            let profiles = manager.list_fixtures();
            let profile = profiles.first().unwrap();

            // Test mode_names
            let modes = profile.mode_names();
            assert!(!modes.is_empty(), "Fixture should have at least one mode");

            // Test default_mode
            let default = profile.default_mode();
            assert!(default.is_some(), "Fixture should have a default mode");
            assert_eq!(
                default.unwrap(),
                modes[0],
                "Default mode should be first mode"
            );
        }
    }
}

/// Verifies rescanning keeps built-in fixtures available.
#[test]
fn test_rescan_library() {
    let temp_dir = create_temp_library();
    let mut manager = FixtureLibraryManager::with_path(temp_dir.path().to_path_buf()).unwrap();

    // Initially contains built-ins.
    assert_eq!(manager.fixture_count(), BUILT_IN_FIXTURE_COUNT);

    // Rescan still contains built-ins.
    let result = manager.scan();
    assert!(result.is_ok());
    assert_eq!(manager.fixture_count(), BUILT_IN_FIXTURE_COUNT);
}

/// Verifies invalid make/model keys do not match built-in fixtures.
#[test]
fn test_fixture_key_format() {
    // Test that the make:model key format works correctly
    let temp_dir = create_temp_library();
    let manager = FixtureLibraryManager::with_path(temp_dir.path().to_path_buf()).unwrap();

    // These should all fail (not found) with different make/model combinations
    assert!(manager.find_fixture("Make", "Model").is_none());
    assert!(manager.find_fixture("Make:With:Colons", "Model").is_none());
    assert!(manager.find_fixture("", "").is_none());
}

/// Verifies invalid modes are rejected for available fixture profiles.
#[test]
fn test_create_fixture_invalid_mode() {
    // Test creating a fixture with an invalid mode name
    if let Ok(manager) = FixtureLibraryManager::new() {
        if manager.fixture_count() > 0 {
            let profiles = manager.list_fixtures();
            let profile = profiles.first().unwrap();

            // Try to create with a mode that doesn't exist
            let result = manager.create_fixture(&profile.make, &profile.model, "InvalidMode123", 1);
            assert!(result.is_err());
            assert!(matches!(
                result.unwrap_err(),
                FixtureLibraryError::ModeNotFound { .. }
            ));
        }
    }
}

/// Verifies fixture source variants account for every listed fixture.
#[test]
fn test_fixture_source_types() {
    // Test that we can distinguish between GDTF and OFL fixtures
    if let Ok(manager) = FixtureLibraryManager::new() {
        if manager.fixture_count() > 0 {
            let profiles = manager.list_fixtures();

            let mut gdtf_count = 0;
            let mut ofl_count = 0;
            let mut built_in_count = 0;

            for profile in profiles {
                match &profile.source {
                    FixtureSource::Gdtf(_) => gdtf_count += 1,
                    FixtureSource::Ofl(_) => ofl_count += 1,
                    FixtureSource::BuiltIn { .. } => built_in_count += 1,
                }
            }

            println!(
                "Found {} GDTF, {} OFL, and {} built-in fixtures",
                gdtf_count, ofl_count, built_in_count
            );
            assert!(gdtf_count + ofl_count + built_in_count == manager.fixture_count());
        }
    }
}

/// Ensures all generic demo profiles can be instantiated with an empty library directory.
#[test]
fn generic_sample_profiles_are_self_contained() {
    let directory = create_temp_library();
    let manager = FixtureLibraryManager::with_path(directory.path().to_path_buf()).unwrap();
    for model in [
        "12-segment RGBW Bar",
        "12-segment Rotating Wash Beam",
        "100-segment LED Bar",
        "10-segment Rotating RGBW Bar",
        "Moving Head RGBW",
        "Strobe Matrix 308ch",
    ] {
        let profile = manager.find_fixture("Generic", model).unwrap();
        let mode = &profile.mode_names()[0];
        let (fixture, _) = manager.create_fixture("Generic", model, mode, 1).unwrap();
        assert_eq!(fixture.make, "Generic");
        assert!(fixture.layout.is_some(), "{model} must declare its layout");
        assert!(!fixture.elements.is_empty());
    }
}
