// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_showfile::{current_showfile_metadata, parse_showfile_snapshot_json};

use super::*;

/// Supplies a current-schema snapshot with unsaved state distinct from any stored source.
fn snapshot() -> ShowfileSnapshot {
    let mut snapshot = ShowfileSnapshot {
        metadata: current_showfile_metadata(),
        ..Default::default()
    };
    snapshot.settings.audio_device = Some("unsaved audio selection".to_string());
    snapshot
}

/// Reads an exported snapshot through the same parser used by normal showfile loading.
fn read_export(prepared: &PreparedShowfileExport) -> ShowfileSnapshot {
    parse_showfile_snapshot_json(
        &std::fs::read_to_string(prepared.path().join("showfile.json")).unwrap(),
        "export",
    )
    .unwrap()
}

/// Browser ZIPs contain loadable live state, supporting files, empty directories, and separate warnings.
#[test]
fn zip_exports_preserve_named_show_contents_and_warning_details() {
    let source = tempfile::tempdir().unwrap();
    std::fs::create_dir(source.path().join("empty")).unwrap();
    std::fs::write(source.path().join("asset.bin"), b"asset contents").unwrap();
    write_showfile_snapshot_with_manifest_to_dir(&snapshot(), source.path(), 1, None).unwrap();
    let mut prepared = prepare_showfile_export(
        snapshot(),
        source.path(),
        source.path(),
        ShowfileExportPolicy::ShowfileReferences,
    )
    .unwrap();
    prepared
        .warnings
        .push("Missing referenced audio".to_string());
    assert!(prepared.write_zip("../outside").is_err());
    let zip = prepared.write_zip("Tour.nightfall-show").unwrap();
    drop(prepared);
    let mut zip = zip::ZipArchive::new(zip.reopen().unwrap()).unwrap();
    assert!(zip.by_name("Tour.nightfall-show/showfile.json.gz").is_err());
    assert_eq!(
        zip.by_name("Tour.nightfall-show/showfile.json")
            .unwrap()
            .compression(),
        zip::CompressionMethod::Deflated
    );
    let destination = tempfile::tempdir().unwrap();
    zip.extract(destination.path()).unwrap();
    let show = destination.path().join("Tour.nightfall-show");
    let loaded = super::super::storage::read_showfile_snapshot_from_path(&show).unwrap();
    assert_eq!(
        loaded.settings.audio_device.as_deref(),
        Some("unsaved audio selection")
    );
    assert_eq!(
        std::fs::read(show.join("asset.bin")).unwrap(),
        b"asset contents"
    );
    assert!(show.join("empty").is_dir());
    assert!(show.join("showfile-manifest.json").is_file());
    let warnings: Vec<String> = serde_json::from_slice(
        &std::fs::read(destination.path().join("export-warnings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(warnings, ["Missing referenced audio"]);
    assert!(!show.join("export-warnings.json").exists());
}

/// Published exports retain live state and assets after staging is removed and validate as normal shows.
#[test]
fn published_showfiles_survive_staging_and_have_current_manifests() {
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("extra.bin"), b"show asset").unwrap();
    let destination = tempfile::tempdir().unwrap();
    let prepared = prepare_showfile_export(
        snapshot(),
        source.path(),
        source.path(),
        ShowfileExportPolicy::ShowfileReferences,
    )
    .unwrap();
    let path = prepared
        .write_to(destination.path(), "Tour.nightfall-show")
        .unwrap();
    drop(prepared);
    assert_eq!(path, destination.path().join("Tour.nightfall-show"));
    assert!(path.join("showfile.json.gz").is_file());
    assert!(!path.join("showfile.json").exists());
    let loaded = super::super::storage::read_showfile_snapshot_from_path(&path).unwrap();
    assert_eq!(
        loaded.settings.audio_device.as_deref(),
        Some("unsaved audio selection")
    );
    super::super::manifest::read_current_showfile_manifest_from_dir(&path).unwrap();
    assert_eq!(
        std::fs::read(path.join("extra.bin")).unwrap(),
        b"show asset"
    );
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 1);
}

/// Export failures preserve existing destinations and leave no incomplete show or staging directory.
#[test]
fn publication_rejects_existing_destinations_and_invalid_paths() {
    let root = tempfile::tempdir().unwrap();
    let prepared = prepare_showfile_export(
        snapshot(),
        root.path(),
        root.path(),
        ShowfileExportPolicy::ShowfileOnly,
    )
    .unwrap();
    let existing = root.path().join("existing.nightfall-show");
    std::fs::create_dir(&existing).unwrap();
    std::fs::write(existing.join("keep"), b"original").unwrap();
    let file = root.path().join("file.nightfall-show");
    std::fs::write(&file, b"original file").unwrap();
    for name in [
        "existing",
        "file",
        "../escape",
        "nested/name",
        "nested\\name",
    ] {
        assert!(prepared.write_to(root.path(), name).is_err());
    }
    assert!(
        prepared
            .write_to(&root.path().join("missing"), "show")
            .is_err()
    );
    assert_eq!(std::fs::read(existing.join("keep")).unwrap(), b"original");
    assert_eq!(std::fs::read(file).unwrap(), b"original file");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
}

/// Directory exports preserve unknown and unused assets while replacing only snapshot sidecars.
#[test]
fn policies_preserve_live_state_and_directory_contents_without_saving() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir_all(source.join("unknown/empty")).unwrap();
    std::fs::write(source.join("unknown/extra.bin"), b"unreferenced asset").unwrap();
    std::fs::write(source.join("showfile.json"), b"stored state").unwrap();
    std::fs::write(source.join("showfile-manifest.json"), b"stored manifest").unwrap();
    for policy in [
        ShowfileExportPolicy::ShowfileOnly,
        ShowfileExportPolicy::ShowfileReferences,
        ShowfileExportPolicy::AllReferences,
    ] {
        let prepared =
            prepare_showfile_export(snapshot(), &source, directory.path(), policy).unwrap();
        assert!(prepared.warnings.is_empty());
        assert_eq!(
            read_export(&prepared).settings.audio_device.as_deref(),
            Some("unsaved audio selection")
        );
        super::super::manifest::read_current_showfile_manifest_from_dir(&prepared.path()).unwrap();
        assert_eq!(
            prepared.path().join("unknown/empty").is_dir(),
            policy != ShowfileExportPolicy::ShowfileOnly
        );
        assert_eq!(
            prepared.path().join("unknown/extra.bin").exists(),
            policy != ShowfileExportPolicy::ShowfileOnly
        );
    }
    assert_eq!(
        std::fs::read(source.join("showfile.json")).unwrap(),
        b"stored state"
    );
    assert_eq!(
        std::fs::read(source.join("showfile-manifest.json")).unwrap(),
        b"stored manifest"
    );
    assert!(!directory.path().join("fixtures").exists());
}

/// Unavailable references remain explicit while valid live show state can still be investigated.
#[test]
fn missing_and_unsafe_references_produce_warnings() {
    let directory = tempfile::tempdir().unwrap();
    let mut snapshot = snapshot();
    snapshot
        .timelines
        .push(nightfall_timeline::prelude::Timeline {
            audio_path: "../private.wav".to_string(),
            ..Default::default()
        });
    snapshot
        .fx_module
        .push(nightfall_fx::prelude::StoredFxModule {
            module_name: "missing".to_string(),
            ..Default::default()
        });
    let prepared = prepare_showfile_export(
        snapshot,
        directory.path(),
        directory.path(),
        ShowfileExportPolicy::AllReferences,
    )
    .unwrap();
    assert_eq!(prepared.warnings.len(), 2);
    assert!(
        prepared
            .warnings
            .iter()
            .any(|warning| warning.contains("Unsafe showfile reference"))
    );
    assert!(
        prepared
            .warnings
            .iter()
            .any(|warning| warning.contains("missing.wasm"))
    );
    assert_eq!(
        read_export(&prepared).timelines[0].audio_path,
        "../private.wav"
    );
}

/// Directory copying cannot follow links out of the source or overwrite their targets during staging.
#[cfg(unix)]
#[test]
fn copied_links_are_omitted_before_writing_the_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir(&source).unwrap();
    let private = directory.path().join("private");
    std::fs::write(&private, b"do not modify").unwrap();
    std::os::unix::fs::symlink(&private, source.join("showfile.json")).unwrap();
    std::os::unix::fs::symlink(directory.path(), source.join("escape")).unwrap();
    let prepared = prepare_showfile_export(
        snapshot(),
        &source,
        directory.path(),
        ShowfileExportPolicy::ShowfileReferences,
    )
    .unwrap();
    assert_eq!(prepared.warnings.len(), 2);
    assert!(!prepared.path().join("escape").exists());
    assert_eq!(std::fs::read(private).unwrap(), b"do not modify");
    read_export(&prepared);
}

/// Returns an unversioned reference to the exported test fixture's library definition.
#[cfg(all(feature = "fixture-library", feature = "object-library"))]
fn export_fixture_ref() -> nightfall_fixtures::prelude::Fixture {
    nightfall_fixtures::prelude::Fixture {
        make: "Export Test".to_string(),
        model: "Export Fixture".to_string(),
        mode: "Default".to_string(),
        ..Default::default()
    }
}

/// Writes a small real GDTF archive whose geometry can be materialized after export.
#[cfg(all(feature = "fixture-library", feature = "object-library"))]
fn write_gdtf(path: &Path) {
    use nightfall_fixture_library::testing::{GdtfBuilder, GeometrySpec, ModeSpec};
    GdtfBuilder::new("Export Test", "Export Fixture")
        .geometry(GeometrySpec::generic("Base"))
        .mode(ModeSpec::new("Default", "Base"))
        .write_to(path);
    nightfall_fixture_library::GdtfMetadata::from_file(path).expect("valid test GDTF");
}

/// All references survive loss of the original libraries and reload through normal snapshot and asset APIs.
#[cfg(all(feature = "fixture-library", feature = "object-library"))]
#[test]
fn all_references_reload_without_the_original_libraries() {
    use nightfall_fixture_library::manager::FixtureLibraryManager;
    use nightfall_object_library::manager::{
        ObjectModelPathScope, decode_object_path, encode_object_path,
    };
    use nightfall_scene_objects::prelude::{CustomProperties, SceneObject, SceneObjectProperties};
    let original = tempfile::tempdir().unwrap();
    let source = original.path().join("active");
    for name in ["active", "fixtures", "objects", "fx-modules"] {
        std::fs::create_dir(original.path().join(name)).unwrap();
    }
    write_gdtf(&original.path().join("fixtures/export.gdtf"));
    std::fs::write(original.path().join("track.wav"), b"external audio").unwrap();
    std::fs::write(
        original.path().join("objects/model.robj"),
        b"model and textures",
    )
    .unwrap();
    std::fs::write(
        original.path().join("fx-modules/sparkle.wasm"),
        b"component bytes",
    )
    .unwrap();
    std::fs::write(original.path().join("fx-modules/unused.wasm"), b"unused").unwrap();
    let mut snapshot = snapshot();
    snapshot
        .fixtures
        .push(nightfall_fixtures::prelude::Fixture {
            make: "Export Test".to_string(),
            model: "Export Fixture".to_string(),
            mode: "Default".to_string(),
            ..Default::default()
        });
    snapshot
        .timelines
        .push(nightfall_timeline::prelude::Timeline {
            audio_path: original
                .path()
                .join("track.wav")
                .to_string_lossy()
                .into_owned(),
            ..Default::default()
        });
    snapshot.scene_objects.push(SceneObject::new_custom(
        1,
        "Model",
        CustomProperties {
            model_path: encode_object_path(Path::new("model.robj")),
            ..Default::default()
        },
    ));
    for name in ["sparkle", "sparkle.wasm"] {
        snapshot
            .fx_module
            .push(nightfall_fx::prelude::StoredFxModule {
                module_name: name.to_string(),
                ..Default::default()
            });
    }
    let prepared = prepare_showfile_export(
        snapshot,
        &source,
        original.path(),
        ShowfileExportPolicy::AllReferences,
    )
    .unwrap();
    assert!(prepared.warnings.is_empty(), "{:?}", prepared.warnings);
    original.close().unwrap();
    let loaded = read_export(&prepared);
    let _guard = crate::process_config_lock().lock().unwrap();
    let previous_data = nightfall::nightfall_data_dir();
    let previous_show = nightfall::active_show_data_dir();
    let isolated = tempfile::tempdir().unwrap();
    nightfall::set_nightfall_data_dir(Some(isolated.path().to_owned()));
    use nightfall_desk::resources::log_config::{LogConfig, TracingTarget};
    let config = LogConfig::new(
        |_| Ok(()),
        std::sync::Arc::new(std::sync::RwLock::new(TracingTarget::default())),
    );
    let app = crate::WorldFactory::new(config, false, false, false)
        .build(crate::WorldBootstrap::Showfile {
            name: Some("exported".to_string()),
            source: prepared.path(),
        })
        .unwrap();
    assert_eq!(
        app.world()
            .resource::<nightfall_desk::prelude::DeskSettings>()
            .audio_device,
        loaded.settings.audio_device
    );
    assert!(
        app.world()
            .resource::<FixtureLibraryManager>()
            .geometry_for_fixture(&export_fixture_ref())
            .is_some()
    );
    assert_eq!(
        std::fs::read(nightfall_fx_module::instances::fx_module_path("sparkle").unwrap()).unwrap(),
        b"component bytes"
    );
    drop(app);
    let mounted_root = nightfall::active_show_data_dir().unwrap();
    super::super::manifest::read_current_showfile_manifest_from_dir(&mounted_root).unwrap();
    nightfall::set_nightfall_data_dir(previous_data);
    if let Some(root) = previous_show {
        nightfall::set_active_show_data_dir(root);
    } else {
        nightfall::clear_active_show_data_dir();
    }

    let mut world = bevy::prelude::World::new();
    nightfall_showfile::apply_showfile_snapshot_to_world(&mut world, loaded.clone()).unwrap();
    assert_eq!(
        world
            .resource::<nightfall_desk::prelude::DeskSettings>()
            .audio_device
            .as_deref(),
        Some("unsaved audio selection")
    );
    assert_eq!(
        std::fs::read(prepared.path().join(&loaded.timelines[0].audio_path)).unwrap(),
        b"external audio"
    );
    let SceneObjectProperties::Custom(properties) = &loaded.scene_objects[0].properties else {
        panic!("expected custom model");
    };
    let model = decode_object_path(&properties.model_path).unwrap();
    assert!(matches!(model.scope, ObjectModelPathScope::ShowfileData));
    assert_eq!(
        std::fs::read(
            prepared
                .path()
                .join("scene-objects")
                .join(model.bundle_filename)
        )
        .unwrap(),
        b"model and textures"
    );
    let empty = tempfile::tempdir().unwrap();
    for module in &loaded.fx_module {
        let path = nightfall_fx_module::instances::fx_module_path_in(
            &module.module_name,
            Some(&prepared.path()),
            empty.path(),
        )
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"component bytes");
    }
    assert_eq!(
        std::fs::read_dir(prepared.path().join("fx-modules"))
            .unwrap()
            .count(),
        1
    );
    let mut library = FixtureLibraryManager::read_from_directories(
        empty.path().to_owned(),
        Some(prepared.path()),
    )
    .unwrap();
    let geometry = library
        .geometry_for_fixture(&export_fixture_ref())
        .expect("packaged GDTF geometry");
    assert!(Path::new(geometry.gdtf_path.as_ref().unwrap()).starts_with(prepared.path()));
    library.set_showfile_directory(None).unwrap();
    assert!(
        library
            .geometry_for_fixture(&export_fixture_ref())
            .is_none()
    );
    write_gdtf(&empty.path().join("installed.gdtf"));
    library
        .set_showfile_directory(Some(prepared.path()))
        .unwrap();
    assert!(
        library
            .find_fixture("Export Test", "Export Fixture")
            .unwrap()
            .file_path
            .starts_with(prepared.path())
    );
    library.set_showfile_directory(None).unwrap();
    assert!(
        library
            .find_fixture("Export Test", "Export Fixture")
            .unwrap()
            .file_path
            .starts_with(empty.path())
    );
    let exported_again = prepare_showfile_export(
        loaded,
        &prepared.path(),
        empty.path(),
        ShowfileExportPolicy::AllReferences,
    )
    .unwrap();
    assert!(
        exported_again.warnings.is_empty(),
        "{:?}",
        exported_again.warnings
    );
    assert_eq!(
        std::fs::read_dir(exported_again.path().join("fixtures"))
            .unwrap()
            .count(),
        1
    );
}

/// OFL identities survive colliding filenames, relocation, and a second export without the original library.
#[cfg(feature = "fixture-library")]
#[test]
fn ofl_profiles_preserve_identity_across_exports() {
    use nightfall_fixture_library::manager::FixtureLibraryManager;
    let original = tempfile::tempdir().unwrap();
    let source = original.path().join("active");
    for directory in [original.path().join("fixtures"), source.join("fixtures")] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let mut snapshot = snapshot();
    for (directory, model) in [
        (original.path().join("fixtures"), "Installed Spot"),
        (source.join("fixtures"), "Local Spot"),
    ] {
        let definition = serde_json::json!({
            "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
            "name": model,
            "categories": ["Other"],
            "meta": { "authors": ["Nightfall"], "createDate": "2026-09-06", "lastModifyDate": "2026-09-06" },
            "availableChannels": {},
            "modes": [{ "name": "Default", "channels": [] }]
        });
        std::fs::write(
            directory.join("chauvet@spot.json"),
            serde_json::to_vec(&definition).unwrap(),
        )
        .unwrap();
        snapshot
            .fixtures
            .push(nightfall_fixtures::prelude::Fixture {
                make: "Chauvet".to_string(),
                model: model.to_string(),
                mode: "Default".to_string(),
                ..Default::default()
            });
    }
    let prepared = prepare_showfile_export(
        snapshot,
        &source,
        original.path(),
        ShowfileExportPolicy::AllReferences,
    )
    .unwrap();
    assert!(prepared.warnings.is_empty(), "{:?}", prepared.warnings);
    original.close().unwrap();
    let empty = tempfile::tempdir().unwrap();
    let mut prepared = prepared;
    for _ in 0..2 {
        let library = FixtureLibraryManager::read_from_directories(
            empty.path().to_owned(),
            Some(prepared.path()),
        )
        .unwrap();
        for model in ["Installed Spot", "Local Spot"] {
            let (fixture, _) = library
                .create_fixture("Chauvet", model, "Default", 1)
                .unwrap();
            assert_eq!(fixture.make, "Chauvet");
            assert_eq!(fixture.model, model);
        }
        assert_eq!(
            std::fs::read_dir(prepared.path().join("fixtures"))
                .unwrap()
                .count(),
            2
        );
        let loaded = read_export(&prepared);
        prepared = prepare_showfile_export(
            loaded,
            &prepared.path(),
            empty.path(),
            ShowfileExportPolicy::AllReferences,
        )
        .unwrap();
        assert!(prepared.warnings.is_empty(), "{:?}", prepared.warnings);
    }
}
