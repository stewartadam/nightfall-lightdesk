// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy::ecs::system::RunSystemOnce;
use nightfall_clips::Clip;
use nightfall_dmx::prelude::Attribute;
use nightfall_io::BindingTransport;
use nightfall_io::{InputSignalLossPolicy, IoRuntimeSettings, TransportRuntimePolicy};
#[cfg(feature = "object-library")]
use nightfall_object_library::manager::{
    ObjectModelPathScope, decode_object_path, encode_object_path, encode_showfile_object_path,
};
use nightfall_showfile::{CURRENT_SHOWFILE_VERSION, parse_showfile_snapshot_json};
use uuid::Uuid;

use super::*;
use crate::systems::showfile_events::listing::{
    AvailableShowfileValidationStatus, available_showfile_draft_for_name_in_root,
    list_available_showfiles_in_root,
};

fn identifiers(id: u32, label: &str) -> Identifiers {
    Identifiers {
        id,
        uid: Uuid::from_u128(id as u128 + 10_000),
        label: label.to_string(),
    }
}

fn setup_world() -> World {
    let mut world = World::new();
    world.insert_resource(FixtureDataProviderExt::default());
    world.insert_resource(SceneObjectDataProvider::default());
    world.insert_resource(DataProvider::<Cue>::default());
    world.insert_resource(DataProvider::<Sequence>::default());
    world.insert_resource(DataProvider::<Group>::default());
    world.insert_resource(DataProvider::<Master>::default());
    world.insert_resource(DataProvider::<Blueprint>::default());
    let mut color_paths = DataProvider::<ColorPath>::default();
    color_paths.extend(builtin_color_paths());
    world.insert_resource(color_paths);
    world.insert_resource(DataProvider::<Fx>::default());
    world.insert_resource(DataProvider::<StoredFxModule>::default());
    world.insert_resource(DataProvider::<FlowDefinition>::default());
    world.insert_resource(DataProvider::<Timecode>::default());
    world.insert_resource(DataProvider::<Timeline>::default());
    world.insert_resource(InputBindings::default());
    world.insert_resource(OutputBindings::default());
    world.insert_resource(DisabledBindings::default());
    #[cfg(feature = "midi")]
    world.insert_resource(MidiMappings::default());
    #[cfg(feature = "osc")]
    world.insert_resource(OscMappings::default());
    world.insert_resource(DeskSettings::default());
    world.insert_resource(Controls::default());
    world.insert_resource(IoRuntimeSettings::default());
    world.insert_resource(GlobalVariables::default());
    world.insert_resource(PendingCommandBuffer::default());
    world.insert_resource(Messages::<UiNotification>::default());
    world.insert_resource(Messages::<CommandResult>::default());
    world.insert_resource(Messages::<CommandReply>::default());
    world.insert_resource(Messages::<FinishedCommand>::default());
    world.insert_resource(Messages::<CommandNotice>::default());
    world.insert_resource(CommandTracker::default());
    world.insert_resource(CurrentShowfile::default());
    world.insert_resource(ShowfileCleanSnapshotHash::default());
    world
}

/// Write a discovery manifest for snapshot JSON already stored in a test show-data directory.
fn write_test_showfile_manifest(
    show_data_dir: &Path,
    based_on_state_hash: Option<u64>,
    state_hash: u64,
) {
    write_showfile_manifest_to_dir(show_data_dir, state_hash, based_on_state_hash)
        .expect("write test showfile manifest");
}

/// Registers and queues one showfile command for handler tests.
fn submit_showfile_command(world: &mut World, command: DeskCommand) -> CommandId {
    let command_id = CommandId::new();
    world
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("showfile command should register");
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            command,
        ));
    command_id
}

/// Convert a current snapshot into the version-seven fixture master shape that broke loading.
fn legacy_master_snapshot_value(snapshot: &ShowfileSnapshot) -> serde_json::Value {
    let mut value = serde_json::to_value(snapshot).expect("serialize current snapshot");
    value["metadata"]["showfileVersion"] = serde_json::json!(7);
    value["masters"] = serde_json::json!([
        {
            "identifiers": {
                "id": 1,
                "uid": "00000000000000000000000000000001",
                "label": "Legacy global master"
            },
            "kind": "InhibitiveIntensity",
            "target": { "type": "All" },
            "mode": { "type": "AlwaysOn" },
            "level_percent": 85.0
        }
    ]);
    value
}

/// Verifies showfile discovery returns only valid show folders with metadata.
#[test]
fn list_available_showfiles_returns_valid_show_folders() {
    let root = tempfile::tempdir().expect("create showfile root");
    let default_dir = root.path().join("default.nightfall-show");
    let tour_dir = root.path().join("tour.nightfall-show");
    let ignored_dir = root.path().join("ignored.nightfall-show");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    let backup_dir = root
        .path()
        .join("backups")
        .join("default-20260520-010203.nightfall-show");
    std::fs::create_dir_all(&default_dir).expect("create default showfile dir");
    std::fs::create_dir_all(&tour_dir).expect("create tour showfile dir");
    std::fs::create_dir_all(&ignored_dir).expect("create ignored showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create tour draft dir");
    std::fs::create_dir_all(&backup_dir).expect("create default backup dir");

    let mut world = setup_world();
    let saved_snapshot = collect_snapshot(&mut world);
    let mut draft_snapshot = saved_snapshot.clone();
    draft_snapshot.variables.insert(
        "draft-only".to_string(),
        VariableValue::String("unsaved".to_string()),
    );
    let saved_json =
        serialize_showfile_snapshot_json(&saved_snapshot).expect("serialize saved snapshot");
    let draft_json =
        serialize_showfile_snapshot_json(&draft_snapshot).expect("serialize draft snapshot");
    std::fs::write(default_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &saved_json)
        .expect("write default snapshot");
    std::fs::write(tour_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &saved_json)
        .expect("write tour snapshot");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &draft_json)
        .expect("write tour draft snapshot");
    std::fs::write(backup_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &saved_json)
        .expect("write backup snapshot");
    std::fs::write(root.path().join("plain.json"), "{}").expect("write plain file");
    write_test_showfile_manifest(
        &draft_dir,
        Some(
            hash_showfile_snapshot_with_metadata(&saved_snapshot, &saved_snapshot.metadata)
                .expect("hash saved snapshot"),
        ),
        hash_showfile_snapshot_with_metadata(&draft_snapshot, &draft_snapshot.metadata)
            .expect("hash draft snapshot"),
    );

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover available showfiles");

    assert_eq!(
        showfiles
            .iter()
            .map(|showfile| showfile.name.as_str())
            .collect::<Vec<_>>(),
        vec!["default", "tour"]
    );
    assert!(
        showfiles[0]
            .path
            .ends_with(&format!("default.{SHOWFILE_FOLDER_EXTENSION}"))
    );
    assert!(
        showfiles
            .iter()
            .all(|showfile| showfile.modified_ms.is_some())
    );
    assert!(showfiles.iter().all(|showfile| showfile.has_saved_snapshot));
    assert!(
        showfiles
            .iter()
            .all(|showfile| showfile.validation_status
                == AvailableShowfileValidationStatus::Unchecked)
    );
    assert_eq!(showfiles[0].revisions.len(), 1);
    assert_eq!(
        showfiles[0].revisions[0].validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
    assert_eq!(
        showfiles[0].revisions[0].name,
        "default-20260520-010203.nightfall-show"
    );
    let tour_draft = showfiles[1].draft.as_ref().expect("tour draft metadata");
    assert_eq!(tour_draft.showfile_name, "tour");
    assert_eq!(tour_draft.name, "tour.nightfall-show");
    assert!(tour_draft.modified_ms.is_some());
    assert_eq!(
        tour_draft.validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
}

/// Verifies discovery leaves malformed snapshots unchecked without parsing their contents.
#[test]
fn list_available_showfiles_does_not_parse_snapshot_contents() {
    let root = tempfile::tempdir().expect("create showfile root");
    let valid_dir = root.path().join("default.nightfall-show");
    let broken_dir = root.path().join("broken.nightfall-show");
    let broken_draft_dir = root.path().join("drafts").join("broken.nightfall-show");
    let broken_backup_dir = root
        .path()
        .join("backups")
        .join("broken-20260520-010203.nightfall-show");
    std::fs::create_dir_all(&valid_dir).expect("create valid showfile dir");
    std::fs::create_dir_all(&broken_dir).expect("create broken showfile dir");
    std::fs::create_dir_all(&broken_draft_dir).expect("create broken showfile draft dir");
    std::fs::create_dir_all(&broken_backup_dir).expect("create broken showfile backup dir");

    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let valid_json = serialize_showfile_snapshot_json(&snapshot).expect("serialize valid snapshot");
    std::fs::write(valid_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &valid_json)
        .expect("write valid snapshot");
    std::fs::write(broken_dir.join(SHOWFILE_SNAPSHOT_FILENAME), "not json")
        .expect("write malformed snapshot");
    std::fs::write(
        broken_draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        &valid_json,
    )
    .expect("write valid draft snapshot");
    std::fs::write(
        broken_backup_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        "also not json",
    )
    .expect("write malformed backup snapshot");

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover available showfiles");

    assert_eq!(showfiles.len(), 2);
    assert_eq!(showfiles[0].name, "default");
    assert_eq!(
        showfiles[0].validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
    let broken = showfiles
        .iter()
        .find(|showfile| showfile.name == "broken")
        .expect("broken showfile remains listed");
    assert_eq!(
        broken.validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
    assert!(broken.draft.as_ref().is_some_and(
        |draft| draft.validation_status == AvailableShowfileValidationStatus::Unchecked
    ));
    assert_eq!(
        broken.revisions[0].validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
    let serialized = serde_json::to_value(broken).expect("serialize discovery entry");
    assert_eq!(serialized["validationStatus"], "unchecked");
    assert!(serialized.get("loadError").is_none());
}

/// Verifies current showfile schema errors retain locations from the source JSON text.
#[test]
fn parse_current_showfile_errors_include_source_line_and_column() {
    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize current snapshot");
    let fixtures_line = json
        .lines()
        .position(|line| line.contains("\"fixtures\""))
        .map(|index| index + 1)
        .expect("current snapshot should contain fixtures");
    let invalid_json = json.replacen("\"fixtures\": []", "\"fixtures\": {}", 1);

    let error = parse_showfile_snapshot_json(&invalid_json, "invalid-current-showfile")
        .expect_err("object-valued fixtures should fail showfile parsing");

    assert!(
        error.contains(&format!("at line {fixtures_line} column ")),
        "parse error should retain its source location: {error}"
    );
}

/// Verifies clean working drafts are not presented as recoverable load choices.
#[test]
fn list_available_showfiles_hides_clean_working_draft() {
    let root = tempfile::tempdir().expect("create showfile root");
    let show_dir = root.path().join("tour.nightfall-show");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    std::fs::create_dir_all(&show_dir).expect("create showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create draft dir");

    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize snapshot");
    std::fs::write(show_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &json).expect("write saved snapshot");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &json)
        .expect("write draft snapshot");
    let snapshot_hash = hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata)
        .expect("hash clean snapshot");
    write_test_showfile_manifest(&show_dir, None, snapshot_hash);
    write_test_showfile_manifest(&draft_dir, Some(snapshot_hash), snapshot_hash);

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover available showfiles");

    assert_eq!(showfiles.len(), 1);
    assert_eq!(showfiles[0].name, "tour");
    assert_eq!(showfiles[0].draft, None);
}

/// Verifies a draft is recoverable when its clean baseline differs from the current saved show.
#[test]
fn list_available_showfiles_exposes_draft_when_saved_manifest_changed() {
    let root = tempfile::tempdir().expect("create showfile root");
    let show_dir = root.path().join("tour.nightfall-show");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    std::fs::create_dir_all(&show_dir).expect("create saved showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create draft showfile dir");

    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize snapshot");
    std::fs::write(show_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &json).expect("write saved snapshot");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &json)
        .expect("write draft snapshot");
    let old_saved_hash = 1;
    let current_saved_hash = 2;
    write_test_showfile_manifest(&show_dir, None, current_saved_hash);
    write_test_showfile_manifest(&draft_dir, Some(old_saved_hash), old_saved_hash);

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover available showfiles");

    assert!(
        showfiles[0].draft.is_some(),
        "a draft based on an older saved state must remain recoverable"
    );
}

/// Verifies draft-only showfiles are reported as recoverable choices.
#[test]
fn list_available_showfiles_returns_orphaned_working_draft() {
    let root = tempfile::tempdir().expect("create showfile root");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    std::fs::create_dir_all(&draft_dir).expect("create draft dir");

    let mut world = setup_world();
    let mut draft_snapshot = collect_snapshot(&mut world);
    draft_snapshot.variables.insert(
        "draft-only".to_string(),
        VariableValue::String("unsaved".to_string()),
    );
    let draft_json =
        serialize_showfile_snapshot_json(&draft_snapshot).expect("serialize draft snapshot");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &draft_json)
        .expect("write draft snapshot");
    let draft_hash =
        hash_showfile_snapshot_with_metadata(&draft_snapshot, &draft_snapshot.metadata)
            .expect("hash draft snapshot");
    write_test_showfile_manifest(&draft_dir, Some(draft_hash), draft_hash);

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover available showfiles");

    assert_eq!(showfiles.len(), 1);
    assert_eq!(showfiles[0].name, "tour");
    assert_eq!(showfiles[0].modified_ms, None);
    assert!(!showfiles[0].has_saved_snapshot);
    assert_eq!(showfiles[0].revisions, Vec::new());
    let draft = showfiles[0].draft.as_ref().expect("draft metadata");
    assert_eq!(draft.showfile_name, "tour");
    assert_eq!(draft.saved_modified_ms, None);
}

/// Verifies a missing showfile root is treated as an empty list.
#[test]
fn list_available_showfiles_returns_empty_for_missing_root() {
    let root = tempfile::tempdir().expect("create showfile root");
    let missing_root = root.path().join("missing");

    let showfiles =
        list_available_showfiles_in_root(&missing_root).expect("discover available showfiles");

    assert!(showfiles.is_empty());
}

/// Verifies a stale draft manifest causes conservative recovery without parsing the snapshot.
#[test]
fn list_available_showfiles_exposes_draft_when_manifest_is_stale() {
    let root = tempfile::tempdir().expect("create showfile root");
    let show_dir = root.path().join("tour.nightfall-show");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    std::fs::create_dir_all(&show_dir).expect("create saved showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create draft showfile dir");

    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize snapshot");
    std::fs::write(show_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &json).expect("write saved snapshot");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &json)
        .expect("write draft snapshot");
    let snapshot_hash =
        hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata).expect("hash snapshot");
    write_test_showfile_manifest(&show_dir, None, snapshot_hash);
    write_test_showfile_manifest(&draft_dir, Some(snapshot_hash), snapshot_hash);
    std::fs::write(
        draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        "externally modified snapshot",
    )
    .expect("replace draft snapshot after manifest write");

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover available showfiles");

    let draft = showfiles[0]
        .draft
        .as_ref()
        .expect("stale manifest should preserve recovery choice");
    assert_eq!(
        draft.validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
}

/// Verifies targeted draft discovery reads only the requested showfile without parsing JSON.
#[test]
fn targeted_showfile_draft_discovery_returns_requested_unchecked_draft() {
    let root = tempfile::tempdir().expect("create showfile root");
    let saved_dir = root.path().join("tour.nightfall-show");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    std::fs::create_dir_all(&saved_dir).expect("create saved showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create draft showfile dir");
    std::fs::write(saved_dir.join(SHOWFILE_SNAPSHOT_FILENAME), "not json")
        .expect("write unchecked saved snapshot");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), "also not json")
        .expect("write unchecked draft snapshot");

    let draft = available_showfile_draft_for_name_in_root(root.path(), "tour")
        .expect("discover targeted draft")
        .expect("requested draft should exist");

    assert_eq!(draft.showfile_name, "tour");
    assert_eq!(
        draft.validation_status,
        AvailableShowfileValidationStatus::Unchecked
    );
    assert!(
        available_showfile_draft_for_name_in_root(root.path(), "missing")
            .expect("discover missing draft")
            .is_none()
    );
}

/// Verifies a malformed selected draft cannot replace the active show-data directory.
#[test]
fn mount_existing_draft_parses_before_changing_active_directory() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    let active_dir = root.path().join("active.nightfall-show");
    let draft_dir = root.path().join("drafts").join("tour.nightfall-show");
    std::fs::create_dir_all(&active_dir).expect("create active showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create draft dir");
    std::fs::write(draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME), "not json")
        .expect("write malformed draft");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::set_active_show_data_dir(active_dir.clone());

    let error = prepare_showfile_session(
        &showfile_draft_dir_path(Some("tour")).unwrap(),
        Some("tour"),
    )
    .expect_err("malformed draft should fail before mounting");

    assert!(error.contains("failed to parse showfile"));
    assert_eq!(nightfall::active_show_data_dir(), Some(active_dir));
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies a written manifest detects snapshot-size drift without parsing showfile JSON.
#[test]
fn showfile_manifest_rejects_snapshot_size_drift() {
    let root = tempfile::tempdir().expect("create showfile root");
    let show_dir = root.path().join("default.nightfall-show");
    std::fs::create_dir_all(&show_dir).expect("create showfile dir");

    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let snapshot_hash =
        hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata).expect("hash snapshot");
    write_showfile_snapshot_with_manifest_to_dir(&snapshot, &show_dir, snapshot_hash, None)
        .expect("write snapshot and manifest");
    assert!(read_current_showfile_manifest_from_dir(&show_dir).is_ok());

    let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize snapshot");
    std::fs::write(
        showfile_snapshot_path_in_dir(&show_dir),
        format!("{json}\n"),
    )
    .expect("change snapshot size");

    let error = read_current_showfile_manifest_from_dir(&show_dir)
        .expect_err("size drift should stale the manifest");
    assert!(error.contains("stale showfile manifest"));
}

/// Verifies same-size snapshot timestamp changes invalidate discovery metadata.
#[test]
fn showfile_manifest_rejects_snapshot_modification_time_drift() {
    let root = tempfile::tempdir().expect("create showfile root");
    let show_dir = root.path().join("default.nightfall-show");
    std::fs::create_dir_all(&show_dir).expect("create showfile dir");

    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let snapshot_hash =
        hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata).expect("hash snapshot");
    write_showfile_snapshot_with_manifest_to_dir(&snapshot, &show_dir, snapshot_hash, None)
        .expect("write snapshot and manifest");
    assert!(read_current_showfile_manifest_from_dir(&show_dir).is_ok());

    let snapshot_file = std::fs::OpenOptions::new()
        .write(true)
        .open(showfile_snapshot_path_in_dir(&show_dir))
        .expect("open snapshot metadata");
    snapshot_file
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2)),
        )
        .expect("change snapshot modification time");

    let error = read_current_showfile_manifest_from_dir(&show_dir)
        .expect_err("timestamp drift should stale the manifest");
    assert!(error.contains("stale showfile manifest"));
}

/// Verifies the active showfile name treats default as the implicit default path.
#[test]
fn current_showfile_name_normalizes_default_and_named_showfiles() {
    assert_eq!(current_showfile_name(None).expect("default showfile"), None);
    assert_eq!(
        current_showfile_name(Some("default")).expect("default showfile"),
        None
    );
    assert_eq!(
        current_showfile_name(Some("sample.nightfall-show")).expect("named showfile"),
        Some("sample".to_string())
    );
}

/// Verifies plain save targets the currently loaded named showfile.
#[test]
fn effective_save_showfile_name_uses_current_loaded_showfile() {
    let current_showfile = CurrentShowfile {
        name: Some("sample".to_string()),
    };

    assert_eq!(
        effective_save_showfile_name(
            &DeskCommand::SaveShowfile(Default::default()),
            &current_showfile
        )
        .expect("resolve save target"),
        Some("sample".to_string())
    );
    assert_eq!(
        effective_save_showfile_name(
            &DeskCommand::SaveNamedShowfile {
                name: "other.nightfall-show".to_string(),
                options: Default::default(),
            },
            &current_showfile,
        )
        .expect("resolve named save target"),
        Some("other".to_string())
    );
}

/// Verifies save-time layout options become the in-memory saved settings baseline.
#[test]
fn apply_showfile_save_options_updates_active_panel_layout() {
    let active_panel_layout = ActivePanelLayout {
        layout_id: None,
        version: 1,
        layout: serde_json::json!({ "layout": "saved" }),
        panels: Vec::new(),
        updated_at: 42.0,
    };
    let mut desk_settings = DeskSettings::default();
    let save_options = ShowfileSaveOptions {
        active_panel_layout: Some(active_panel_layout.clone()),
    };

    apply_showfile_save_options(&mut desk_settings, &save_options);

    assert_eq!(desk_settings.active_panel_layout, Some(active_panel_layout));
}

/// Verifies any directory can supply a snapshot while saving remains targeted elsewhere.
#[test]
fn prepare_showfile_session_loads_arbitrary_directory_and_resumes_working_storage() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    let source = tempfile::tempdir().expect("create unrelated source directory");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let snapshot = collect_snapshot(&mut setup_world());
    let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize snapshot");
    std::fs::write(source.path().join(SHOWFILE_SNAPSHOT_FILENAME), &json).unwrap();

    prepare_showfile_session(source.path(), Some("destination")).expect("load arbitrary source");
    let draft = showfile_draft_dir_path(Some("destination")).unwrap();
    assert_eq!(nightfall::active_show_data_dir(), Some(draft.clone()));
    assert!(!showfile_dir_path(Some("destination")).unwrap().exists());
    assert_eq!(
        std::fs::read_to_string(source.path().join(SHOWFILE_SNAPSHOT_FILENAME)).unwrap(),
        json
    );

    let marker = draft.join("session-marker");
    std::fs::write(&marker, "keep working assets").unwrap();
    prepare_showfile_session(&draft, Some("destination")).expect("resume working storage");
    assert_eq!(
        std::fs::read_to_string(marker).unwrap(),
        "keep working assets"
    );
    assert!(!showfile_dir_path(Some("destination")).unwrap().exists());
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies loading a revision creates working state without replacing the saved showfile.
#[test]
fn reset_working_draft_from_revision_preserves_saved_showfile() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let show_data_dir = root.path().join("default.nightfall-show");
    let draft_dir = root
        .path()
        .join(SHOWFILE_DRAFTS_DIR)
        .join("default.nightfall-show");
    let current_assets = show_data_dir.join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR);
    let revision_dir = root
        .path()
        .join("backups")
        .join("default-20260520-010203.nightfall-show");
    let revision_assets = revision_dir.join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR);
    std::fs::create_dir_all(&current_assets).expect("create current asset dir");
    std::fs::create_dir_all(&revision_assets).expect("create revision asset dir");
    let mut world = setup_world();
    let current_snapshot = collect_snapshot(&mut world);
    let mut revision_snapshot = current_snapshot.clone();
    revision_snapshot.variables.insert(
        "revision-only".to_string(),
        VariableValue::String("restored".to_string()),
    );
    let current_json =
        serialize_showfile_snapshot_json(&current_snapshot).expect("serialize current snapshot");
    let revision_json =
        serialize_showfile_snapshot_json(&revision_snapshot).expect("serialize revision snapshot");
    std::fs::write(
        show_data_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        &current_json,
    )
    .expect("write current snapshot");
    std::fs::write(current_assets.join("current.robj"), "current").expect("write current asset");
    std::fs::write(
        revision_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        &revision_json,
    )
    .expect("write revision snapshot");
    std::fs::write(revision_assets.join("revision.robj"), "revision")
        .expect("write revision asset");

    let selection =
        ShowfileRevisionSelection::from_revision_name("default-20260520-010203.nightfall-show")
            .expect("parse revision selection");
    let loaded_snapshot = prepare_showfile_session(
        &revision::resolve_showfile_revision_directory(&selection)
            .expect("resolve selected directory"),
        Some(&selection.showfile_name),
    )
    .expect("load revision into working draft");

    assert_eq!(
        std::fs::read_to_string(show_data_dir.join(SHOWFILE_SNAPSHOT_FILENAME))
            .expect("read preserved saved snapshot"),
        current_json
    );
    assert!(
        show_data_dir
            .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
            .join("current.robj")
            .exists(),
        "saved assets should remain unchanged"
    );
    assert!(
        draft_dir
            .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
            .join("revision.robj")
            .exists(),
        "revision assets should be copied into working state"
    );
    assert!(
        matches!(
            loaded_snapshot.variables.get("revision-only"),
            Some(VariableValue::String(value)) if value == "restored"
        ),
        "loaded snapshot should contain the selected backup data"
    );
    assert_eq!(
        nightfall::active_show_data_dir(),
        Some(draft_dir),
        "revision working state should become the active show-data directory"
    );

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies an explicitly selected snapshot loads independently of corrupt canonical storage.
#[test]
fn reset_working_draft_from_revision_ignores_corrupt_saved_baseline() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let saved_dir = root.path().join("default.nightfall-show");
    let revision_dir = root
        .path()
        .join("backups/default-20260520-010203.nightfall-show");
    std::fs::create_dir_all(&saved_dir).expect("create saved directory");
    std::fs::create_dir_all(&revision_dir).expect("create revision directory");
    std::fs::write(
        saved_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        "broken saved snapshot",
    )
    .expect("write corrupt saved snapshot");
    let mut world = setup_world();
    let mut snapshot = collect_snapshot(&mut world);
    snapshot
        .variables
        .insert("selected".into(), VariableValue::String("backup".into()));
    let revision_json = serialize_showfile_snapshot_json(&snapshot).expect("serialize revision");
    std::fs::write(
        revision_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        &revision_json,
    )
    .expect("write revision");
    let selection = ShowfileRevisionSelection::from_revision_name("default-20260520-010203")
        .expect("select revision");

    let loaded = prepare_showfile_session(
        &revision::resolve_showfile_revision_directory(&selection)
            .expect("resolve selected directory"),
        Some(&selection.showfile_name),
    )
    .expect("load selected revision");

    assert!(
        matches!(loaded.variables.get("selected"), Some(VariableValue::String(value)) if value == "backup")
    );
    assert_eq!(
        std::fs::read_to_string(saved_dir.join(SHOWFILE_SNAPSHOT_FILENAME)).unwrap(),
        "broken saved snapshot"
    );
    assert_eq!(
        std::fs::read_to_string(revision_dir.join(SHOWFILE_SNAPSHOT_FILENAME)).unwrap(),
        revision_json
    );
    let draft_dir = root.path().join("drafts/default.nightfall-show");
    assert_eq!(nightfall::active_show_data_dir(), Some(draft_dir.clone()));
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(draft_dir.join(SHOWFILE_MANIFEST_FILENAME)).unwrap(),
    )
    .expect("read working manifest");
    assert!(
        manifest["draft"].is_null(),
        "unreadable saved baseline must remain unknown"
    );
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies an invalid selected revision cannot replace saved or working showfile state.
#[test]
fn reset_working_draft_from_revision_rejects_invalid_snapshot_before_mutation() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    let show_data_dir = root.path().join("default.nightfall-show");
    let draft_dir = root
        .path()
        .join(SHOWFILE_DRAFTS_DIR)
        .join("default.nightfall-show");
    let revision_dir = root
        .path()
        .join("backups")
        .join("default-20260520-010203.nightfall-show");
    std::fs::create_dir_all(&show_data_dir).expect("create current showfile dir");
    std::fs::create_dir_all(&revision_dir).expect("create revision dir");

    let mut world = setup_world();
    let current_snapshot = collect_snapshot(&mut world);
    let current_json =
        serialize_showfile_snapshot_json(&current_snapshot).expect("serialize current snapshot");
    std::fs::write(
        show_data_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        &current_json,
    )
    .expect("write current snapshot");
    std::fs::write(
        revision_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        "truncated revision",
    )
    .expect("write invalid revision");
    nightfall::set_active_show_data_dir(show_data_dir.clone());

    let selection =
        ShowfileRevisionSelection::from_revision_name("default-20260520-010203.nightfall-show")
            .expect("parse revision selection");
    let error = prepare_showfile_session(
        &revision::resolve_showfile_revision_directory(&selection)
            .expect("resolve selected directory"),
        Some(&selection.showfile_name),
    )
    .expect_err("invalid revision should fail before changing working state");

    assert!(error.contains("failed to parse showfile"));
    assert_eq!(
        std::fs::read_to_string(show_data_dir.join(SHOWFILE_SNAPSHOT_FILENAME))
            .expect("read preserved current snapshot"),
        current_json
    );
    assert!(!draft_dir.exists());
    assert_eq!(nightfall::active_show_data_dir(), Some(show_data_dir));

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies showfile load domains are ordered according to declared cross-domain dependencies.
#[test]
fn ordered_showfile_load_domains_respect_dependencies() {
    let domains = ordered_showfile_load_domains().expect("load domain order");
    let cue_structure_pos = domains
        .iter()
        .position(|domain| *domain == ShowfileLoadDomain::CueStructure)
        .expect("cue-structure domain present");
    let fx_pos = domains
        .iter()
        .position(|domain| *domain == ShowfileLoadDomain::Fx)
        .expect("fx domain present");
    let flows_pos = domains
        .iter()
        .position(|domain| *domain == ShowfileLoadDomain::Flows)
        .expect("flows domain present");
    let clips_pos = domains
        .iter()
        .position(|domain| *domain == ShowfileLoadDomain::Clips)
        .expect("clips domain present");
    let timecodes_timelines_pos = domains
        .iter()
        .position(|domain| *domain == ShowfileLoadDomain::TimecodesTimelines)
        .expect("timecodes-timelines domain present");

    assert!(
        cue_structure_pos < clips_pos,
        "cue-structure domain should run before clips"
    );
    assert!(fx_pos < clips_pos, "fx domain should run before clips");
    assert!(
        flows_pos < clips_pos,
        "flows domain should run before clips"
    );
    assert!(
        clips_pos < timecodes_timelines_pos,
        "clips domain should run before timecodes-timelines"
    );
}

#[test]
fn current_showfile_metadata_includes_versions_and_timestamp() {
    let metadata = current_showfile_metadata();

    assert_eq!(metadata.nightfall_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(metadata.showfile_version, CURRENT_SHOWFILE_VERSION);
    assert!(metadata.last_saved_unix_sec > 0);
}

/// Verifies a loaded draft remains dirty against the canonical saved snapshot.
#[test]
fn draft_snapshot_hash_differs_from_saved_clean_baseline() {
    let mut world = setup_world();
    let saved_snapshot = collect_snapshot(&mut world);
    let mut draft_snapshot = saved_snapshot.clone();
    draft_snapshot.variables.insert(
        "draft-only".to_string(),
        VariableValue::String("unsaved".to_string()),
    );
    let mut clean_hash = ShowfileCleanSnapshotHash::default();

    update_clean_snapshot_hash(&mut clean_hash, &saved_snapshot)
        .expect("update clean hash from saved snapshot");
    let draft_hash = hash_showfile_snapshot_with_metadata(&draft_snapshot, &clean_hash.metadata)
        .expect("hash draft snapshot");

    assert_ne!(clean_hash.hash, Some(draft_hash));
}

/// Verifies clean draft rewrites keep the saved metadata hash stable.
#[test]
fn clean_draft_snapshot_hash_matches_saved_clean_baseline() {
    let mut world = setup_world();
    let saved_snapshot = collect_snapshot(&mut world);
    let mut clean_hash = ShowfileCleanSnapshotHash::default();

    update_clean_snapshot_hash(&mut clean_hash, &saved_snapshot)
        .expect("update clean hash from saved snapshot");
    let mut clean_draft_snapshot = saved_snapshot.clone();
    clean_draft_snapshot.metadata = clean_hash.metadata.clone();
    let draft_hash =
        hash_showfile_snapshot_with_metadata(&clean_draft_snapshot, &clean_hash.metadata)
            .expect("hash clean draft snapshot");

    assert_eq!(clean_hash.hash, Some(draft_hash));
}

/// Verifies clean autosave promotes legacy metadata before draft normalization.
#[test]
fn clean_draft_autosave_promotes_legacy_metadata_baseline() {
    let mut world = setup_world();
    let snapshot = collect_snapshot(&mut world);
    let legacy_hash = hash_showfile_snapshot_with_metadata(&snapshot, &ShowfileMetadata::default())
        .expect("hash legacy clean baseline");
    let mut clean_hash = ShowfileCleanSnapshotHash {
        hash: Some(legacy_hash),
        metadata: ShowfileMetadata::default(),
    };

    normalize_clean_snapshot_hash_metadata(&mut clean_hash, &snapshot)
        .expect("promote clean metadata baseline");
    assert_eq!(
        clean_hash.metadata.showfile_version,
        CURRENT_SHOWFILE_VERSION
    );
    assert_ne!(clean_hash.hash, Some(legacy_hash));
    assert_eq!(
        clean_hash.hash,
        Some(
            hash_showfile_snapshot_with_metadata(&snapshot, &clean_hash.metadata)
                .expect("hash promoted clean baseline")
        )
    );
}

/// Verifies an unchecked legacy saved snapshot does not suppress its working draft.
#[test]
fn list_available_showfiles_exposes_draft_beside_legacy_saved_snapshot() {
    let root = tempfile::tempdir().expect("create showfile root");
    let show_dir = root.path().join("default.nightfall-show");
    let draft_dir = root.path().join("drafts").join("default.nightfall-show");
    std::fs::create_dir_all(&show_dir).expect("create showfile dir");
    std::fs::create_dir_all(&draft_dir).expect("create draft dir");

    let mut world = setup_world();
    let saved_snapshot = collect_snapshot(&mut world);
    let legacy_value = legacy_master_snapshot_value(&saved_snapshot);
    let mut draft_snapshot = saved_snapshot;
    draft_snapshot.variables.insert(
        "draft-only".to_string(),
        VariableValue::String("unsaved".to_string()),
    );
    std::fs::write(
        show_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        serde_json::to_string(&legacy_value).expect("serialize legacy snapshot JSON"),
    )
    .expect("write legacy saved snapshot");
    std::fs::write(
        draft_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        serialize_showfile_snapshot_json(&draft_snapshot).expect("serialize draft snapshot"),
    )
    .expect("write current draft snapshot");

    let showfiles =
        list_available_showfiles_in_root(root.path()).expect("discover legacy saved showfile");

    assert_eq!(showfiles.len(), 1);
    assert_eq!(showfiles[0].name, "default");
    assert!(showfiles[0].draft.is_some());
}

/// Verifies named showfile folders use the nightfall-show extension.
#[test]
fn showfile_folder_name_accepts_simple_names() {
    assert_eq!(
        showfile_folder_name(None).expect("canonical folder name"),
        "default.nightfall-show"
    );
    assert_eq!(
        showfile_folder_name(Some("demo")).expect("named folder name"),
        "demo.nightfall-show"
    );
    assert_eq!(
        showfile_folder_name(Some("demo.nightfall-show")).expect("explicit show folder name"),
        "demo.nightfall-show"
    );
}

/// Verifies named showfile folders reject directory traversal.
#[test]
fn showfile_folder_name_rejects_path_segments() {
    assert!(showfile_folder_name(Some("../demo")).is_err());
    assert!(showfile_folder_name(Some("nested/demo")).is_err());
    assert!(showfile_folder_name(Some("nested\\demo")).is_err());
}

/// Verifies import paths from browser file inputs resolve relative to the showfile root.
#[test]
fn resolve_import_showfile_path_uses_showfile_root_for_relative_paths() {
    let showfile_root = std::env::temp_dir().join("nightfall-shows");

    assert_eq!(
        resolve_import_showfile_path(Path::new("sample.nightfall-show"), &showfile_root)
            .expect("relative show folder path should resolve"),
        showfile_root.join("sample.nightfall-show")
    );
    assert_eq!(
        resolve_import_showfile_path(
            Path::new("sample.nightfall-show/showfile.json"),
            &showfile_root
        )
        .expect("relative snapshot path should resolve"),
        showfile_root.join("sample.nightfall-show/showfile.json")
    );
}

/// Verifies explicit absolute import paths are preserved for native file pickers.
#[test]
fn resolve_import_showfile_path_preserves_absolute_paths() {
    let path = std::env::temp_dir().join("sample.nightfall-show");

    assert_eq!(
        resolve_import_showfile_path(&path, &std::env::temp_dir().join("nightfall-shows"))
            .expect("absolute show folder path should pass through"),
        path
    );
}

/// Verifies relative import paths cannot escape the showfile root.
#[test]
fn resolve_import_showfile_path_rejects_parent_segments() {
    let err = resolve_import_showfile_path(
        Path::new("../sample.nightfall-show"),
        &std::env::temp_dir().join("nightfall-shows"),
    )
    .expect_err("parent directory should be rejected");

    assert!(err.contains("invalid relative showfile import path"));
}

/// Verifies selective import can preserve custom timelines while replacing other definitions.
#[test]
fn merge_showfile_snapshots_skips_timelines_while_replacing_cues() {
    let mut world = setup_world();
    seed_world(&mut world);
    let mut current = collect_snapshot(&mut world);
    current.timelines[0].identifiers.label = "Custom timeline".to_string();

    let mut incoming = current.clone();
    incoming.timelines[0].identifiers.label = "Imported timeline".to_string();
    incoming.cues[0].identifiers.label = "Imported cue".to_string();

    let options = ShowfileImportOptions {
        cues: ShowfileImportPolicy::Replace,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged =
        merge_showfile_snapshots(current, incoming, &options).expect("snapshots should merge");

    assert_eq!(merged.timelines[0].identifiers.label, "Custom timeline");
    assert_eq!(merged.cues[0].identifiers.label, "Imported cue");
}

/// Verifies overwrite removes current objects that are absent from the imported collection.
#[test]
fn merge_showfile_snapshots_overwrites_selected_object_type() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let mut incoming = current.clone();
    incoming.groups.clear();

    let options = ShowfileImportOptions {
        groups: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged =
        merge_showfile_snapshots(current, incoming, &options).expect("snapshots should merge");

    assert!(merged.groups.is_empty());
}

/// Verifies master import policy is independent from group import policy.
#[test]
fn merge_showfile_snapshots_uses_separate_master_policy() {
    let mut world = setup_world();
    seed_world(&mut world);
    let mut current = collect_snapshot(&mut world);
    current.masters = vec![Master {
        identifiers: identifiers(701, "Current master"),
        kind: MasterKind::InhibitiveIntensity,
        target: MasterTarget::Fixtures(FixtureMasterTarget::All),
        mode: MasterMode::AlwaysOn,
        level_percent: 100.0,
    }];

    let mut incoming = current.clone();
    incoming.groups.clear();
    incoming.masters = vec![Master {
        identifiers: identifiers(702, "Imported master"),
        kind: MasterKind::InhibitiveIntensity,
        target: MasterTarget::Fixtures(FixtureMasterTarget::All),
        mode: MasterMode::AlwaysOn,
        level_percent: 50.0,
    }];

    let options = ShowfileImportOptions {
        groups: ShowfileImportPolicy::Skip,
        masters: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged =
        merge_showfile_snapshots(current, incoming, &options).expect("snapshots should merge");

    assert_eq!(merged.masters.len(), 1);
    assert_eq!(merged.masters[0].identifiers.label, "Imported master");
    assert!(!merged.groups.is_empty());
}

/// Verifies merge rejects imported objects that collide by numeric ID.
#[test]
fn merge_showfile_snapshots_rejects_duplicate_ids() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let mut incoming = current.clone();
    let mut colliding_cue = incoming.cues[0].clone();
    colliding_cue.identifiers = identifiers(colliding_cue.identifiers.id, "colliding-cue");
    colliding_cue.identifiers.uid = Uuid::new_v4();
    incoming.cues.push(colliding_cue);

    let err = merge_showfile_snapshots(current, incoming, &ShowfileImportOptions::default())
        .expect_err("duplicate cue IDs should be rejected");

    assert!(err.contains("cannot import cues"));
}

/// Verifies skipped object types are not validated during selective import.
#[test]
fn merge_showfile_snapshots_skip_ignores_existing_duplicate_ids() {
    let mut world = setup_world();
    seed_world(&mut world);
    let mut current = collect_snapshot(&mut world);
    let incoming = current.clone();
    let mut colliding_cue = current.cues[0].clone();
    colliding_cue.identifiers = identifiers(colliding_cue.identifiers.id, "existing-collision");
    colliding_cue.identifiers.uid = Uuid::new_v4();
    current.cues.push(colliding_cue);

    let options = ShowfileImportOptions {
        cues: ShowfileImportPolicy::Skip,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged =
        merge_showfile_snapshots(current.clone(), incoming, &options).expect("merge succeeds");

    assert_eq!(merged.cues.len(), current.cues.len());
}

/// Verifies imported resolved FX module selections retarget to current fixture UUIDs.
#[test]
fn merge_showfile_snapshots_skip_fixtures_retargets_fx_module_selection_by_id() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_fixture = current.fixtures[0].clone();
    let incoming_fixture_uid = Uuid::new_v4();

    let mut incoming = current.clone();
    incoming.fixtures = vec![Fixture {
        identifiers: Identifiers {
            id: current_fixture.identifiers.id,
            uid: incoming_fixture_uid,
            label: current_fixture.identifiers.label.clone(),
        },
        ..current_fixture.clone()
    }];
    incoming.fx_module = vec![StoredFxModule {
        identifiers: identifiers(900, "Imported module"),
        module_name: "hook-riser".to_string(),
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: incoming_fixture_uid,
            index: Some(1),
        }])),
        config: HashMap::new(),
    }];

    let options = ShowfileImportOptions {
        fixtures: ShowfileImportPolicy::Skip,
        fx_module: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current, incoming, &options).expect("merge succeeds");

    let SelectionExpr::Resolved(fixtures) = &merged.fx_module[0].selection.source else {
        panic!("selection should remain resolved");
    };
    assert_eq!(fixtures[0].fixture_uid, current_fixture.identifiers.uid);
}

/// Verifies imported resolved FX module selections retarget union branch UUIDs.
#[test]
fn merge_showfile_snapshots_skip_fixtures_retargets_fx_module_union_selection_by_id() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_fixture = current.fixtures[0].clone();
    let incoming_fixture_uid = Uuid::new_v4();

    let mut incoming = current.clone();
    incoming.fixtures = vec![Fixture {
        identifiers: Identifiers {
            id: current_fixture.identifiers.id,
            uid: incoming_fixture_uid,
            label: current_fixture.identifiers.label.clone(),
        },
        ..current_fixture.clone()
    }];
    incoming.fx_module = vec![StoredFxModule {
        identifiers: identifiers(903, "Imported union module"),
        module_name: "hook-riser".to_string(),
        selection: SpatialSelection {
            source: SelectionExpr::Resolved(Vec::new()),
            clauses: Vec::new(),
            union: vec![SpatialSelection::identity(SelectionExpr::Resolved(vec![
                FixtureRef {
                    fixture_uid: incoming_fixture_uid,
                    index: Some(1),
                },
            ]))],
        },
        config: HashMap::new(),
    }];

    let options = ShowfileImportOptions {
        fixtures: ShowfileImportPolicy::Skip,
        fx_module: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current, incoming, &options).expect("merge succeeds");

    let SelectionExpr::Resolved(fixtures) = &merged.fx_module[0].selection.union[0].source else {
        panic!("union branch selection should remain resolved");
    };
    assert_eq!(fixtures[0].fixture_uid, current_fixture.identifiers.uid);
}

/// Verifies imported resolved FX selections retarget to current fixture UUIDs.
#[test]
fn merge_showfile_snapshots_skip_fixtures_retargets_fx_selection_by_id() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_fixture = current.fixtures[0].clone();
    let incoming_fixture_uid = Uuid::new_v4();

    let mut incoming = current.clone();
    incoming.fixtures = vec![Fixture {
        identifiers: Identifiers {
            id: current_fixture.identifiers.id,
            uid: incoming_fixture_uid,
            label: current_fixture.identifiers.label.clone(),
        },
        ..current_fixture.clone()
    }];
    incoming.fx = vec![Fx {
        identifiers: identifiers(901, "Imported fx"),
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: incoming_fixture_uid,
            index: Some(1),
        }])),
        attributes: HashMap::new(),
    }];

    let options = ShowfileImportOptions {
        fixtures: ShowfileImportPolicy::Skip,
        fx: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current, incoming, &options).expect("merge succeeds");

    let SelectionExpr::Resolved(fixtures) = &merged.fx[0].selection.source else {
        panic!("selection should remain resolved");
    };
    assert_eq!(fixtures[0].fixture_uid, current_fixture.identifiers.uid);
}

/// Verifies imported stable group refs retarget to current group UUIDs.
#[test]
fn merge_showfile_snapshots_skip_groups_retargets_fx_selection_by_id() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_group = current.groups[0].clone();
    let incoming_group_uid = Uuid::new_v4();

    let mut incoming = current.clone();
    incoming.groups = vec![Group {
        identifiers: Identifiers {
            id: current_group.identifiers.id,
            uid: incoming_group_uid,
            label: current_group.identifiers.label.clone(),
        },
        ..current_group.clone()
    }];
    incoming.fx = vec![Fx {
        identifiers: identifiers(904, "Imported group fx"),
        selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ByUid {
            uid: incoming_group_uid,
        })),
        attributes: HashMap::new(),
    }];
    incoming.sequences[0].setup_cue.instructions = vec![BoundCueInstruction {
        selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ByUid {
            uid: incoming_group_uid,
        })),
        cue_instruction: CueInstruction::default(),
    }];

    let options = ShowfileImportOptions {
        groups: ShowfileImportPolicy::Skip,
        fx: ShowfileImportPolicy::Overwrite,
        sequences: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current, incoming, &options).expect("merge succeeds");

    let SelectionExpr::Group(GroupRefExpr::ByUid { uid }) = &merged.fx[0].selection.source else {
        panic!("selection should remain a stable group UID ref");
    };
    assert_eq!(*uid, current_group.identifiers.uid);
    assert_eq!(
        merged.sequences[0].setup_cue.instructions[0]
            .selection
            .source,
        SelectionExpr::Group(GroupRefExpr::ByUid {
            uid: current_group.identifiers.uid,
        })
    );
}

/// Verifies imported Blueprint applications retarget when definitions resolve by current ID.
#[test]
fn merge_showfile_snapshots_skip_blueprints_retargets_cue_references_by_id() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_blueprint = current.blueprints[0].clone();
    let incoming_blueprint_uid = Uuid::new_v4();

    let mut incoming = current.clone();
    incoming.blueprints = vec![Blueprint {
        identifiers: Identifiers {
            id: current_blueprint.identifiers.id,
            uid: incoming_blueprint_uid,
            label: current_blueprint.identifiers.label.clone(),
        },
        ..current_blueprint
    }];
    incoming.cues[0].instructions = vec![BoundCueInstruction {
        selection: SpatialSelection::default(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid: incoming_blueprint_uid,
                selector: BlueprintSelector::Category(Attribute::Red.category()),
            }),
            ..Default::default()
        },
    }];

    let options = ShowfileImportOptions {
        blueprints: ShowfileImportPolicy::Skip,
        cues: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current.clone(), incoming, &options)
        .expect("Blueprint reference import should succeed");

    assert_eq!(
        merged.cues[0].instructions[0]
            .cue_instruction
            .blueprint_application
            .as_ref()
            .map(|application| application.blueprint_uid),
        Some(current.blueprints[0].identifiers.uid),
    );
}

/// Verifies imported authored group IDs normalize against the merged group definitions.
#[test]
fn merge_showfile_snapshots_stabilizes_authored_group_ids() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_group = current.groups[0].clone();

    let mut incoming = current.clone();
    incoming.fx = vec![Fx {
        identifiers: identifiers(905, "Imported authored group fx"),
        selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(
            current_group.identifiers.id,
        ))),
        attributes: HashMap::new(),
    }];

    let options = ShowfileImportOptions {
        groups: ShowfileImportPolicy::Skip,
        fx: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current, incoming, &options).expect("merge succeeds");

    assert_eq!(
        merged.fx[0].selection.source,
        SelectionExpr::Group(GroupRefExpr::ByUid {
            uid: current_group.identifiers.uid,
        })
    );
}

/// Verifies imported resolved flow selections retarget to current fixture UUIDs.
#[test]
fn merge_showfile_snapshots_skip_fixtures_retargets_flow_selection_by_id() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let current_fixture = current.fixtures[0].clone();
    let incoming_fixture_uid = Uuid::new_v4();

    let mut incoming = current.clone();
    incoming.fixtures = vec![Fixture {
        identifiers: Identifiers {
            id: current_fixture.identifiers.id,
            uid: incoming_fixture_uid,
            label: current_fixture.identifiers.label.clone(),
        },
        ..current_fixture.clone()
    }];
    incoming.flows = vec![FlowDefinition {
        identifiers: identifiers(902, "Imported flow"),
        nodes: vec![FlowNodeDefinition {
            node_id: 1,
            kind: "constant_selection".to_string(),
            label: "Imported selection".to_string(),
            ports: vec![FlowPortDefinition {
                port_id: 1,
                name: "Selection".to_string(),
                direction: FlowPortDirection::Input,
                port_type: FlowPortType::Selection,
                is_optional: false,
                default_value: Some(FlowValue::Selection(SpatialSelection::identity(
                    SelectionExpr::Resolved(vec![FixtureRef {
                        fixture_uid: incoming_fixture_uid,
                        index: Some(1),
                    }]),
                ))),
                enum_options: None,
            }],
            position: None,
        }],
        ..Default::default()
    }];

    let options = ShowfileImportOptions {
        fixtures: ShowfileImportPolicy::Skip,
        flows: ShowfileImportPolicy::Overwrite,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current, incoming, &options).expect("merge succeeds");

    let Some(FlowValue::Selection(selection)) = &merged.flows[0].nodes[0].ports[0].default_value
    else {
        panic!("flow port should keep selection default");
    };
    let SelectionExpr::Resolved(fixtures) = &selection.source else {
        panic!("selection should remain resolved");
    };
    assert_eq!(fixtures[0].fixture_uid, current_fixture.identifiers.uid);
}

/// Verifies merge keeps current UUID matches while replace updates those objects.
#[test]
fn merge_showfile_snapshots_replace_updates_uuid_matches() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let mut incoming = current.clone();
    incoming.cues[0].identifiers.label = "Imported cue".to_string();

    let merge_options = ShowfileImportOptions {
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged = merge_showfile_snapshots(current.clone(), incoming.clone(), &merge_options)
        .expect("snapshots should merge");
    assert_ne!(merged.cues[0].identifiers.label, "Imported cue");

    let replace_options = ShowfileImportOptions {
        cues: ShowfileImportPolicy::Replace,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let replaced = merge_showfile_snapshots(current, incoming, &replace_options)
        .expect("snapshots should replace matching cues");
    assert_eq!(replaced.cues[0].identifiers.label, "Imported cue");
}

/// Verifies unsupported policies are rejected for file-backed FX modules.
#[test]
fn merge_showfile_snapshots_rejects_fx_module_merge_policy() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let incoming = current.clone();

    let options = ShowfileImportOptions {
        fx_module: ShowfileImportPolicy::Merge,
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let err = merge_showfile_snapshots(current, incoming, &options)
        .expect_err("fx modules should reject merge");

    assert!(err.contains("fx modules import policy Merge is not supported"));
}

/// Verifies importing the same plain binding lists does not duplicate entries.
#[test]
fn merge_showfile_snapshots_deduplicates_plain_binding_lists() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let incoming = current.clone();

    let options = ShowfileImportOptions {
        timelines: ShowfileImportPolicy::Skip,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    let merged =
        merge_showfile_snapshots(current.clone(), incoming, &options).expect("merge succeeds");

    assert_eq!(merged.bindings.input.len(), current.bindings.input.len());
    assert_eq!(merged.bindings.output.len(), current.bindings.output.len());
    assert_eq!(
        merged.bindings.disabled.len(),
        current.bindings.disabled.len()
    );
}

/// Verifies imported timeline audio is copied from the source show-data directory.
#[test]
fn prepare_imported_showfile_assets_copies_selected_timeline_audio() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let mut incoming = current.clone();
    let timeline_uid = incoming.timelines[0].identifiers().uid;
    let relative_audio_path = format!(
        "{}/{}/track.wav",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        timeline_uid.simple()
    );
    incoming.timelines[0].audio_path = relative_audio_path.clone();

    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-import-audio-{}",
        Uuid::new_v4().simple()
    ));
    let source_show_data_dir = temp_root.join("source-show-data");
    let current_show_data_dir = temp_root.join("current-show-data");
    let source_audio_path = source_show_data_dir.join(&relative_audio_path);
    std::fs::create_dir_all(source_audio_path.parent().expect("audio parent"))
        .expect("create source audio directory");
    std::fs::write(&source_audio_path, b"audio").expect("write source audio");

    let options = ShowfileImportOptions {
        timelines: ShowfileImportPolicy::Overwrite,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    prepare_imported_showfile_assets(
        &mut incoming,
        &current,
        &options,
        &source_show_data_dir.join("showfile.json"),
        &current_show_data_dir,
    )
    .expect("audio assets should copy");

    assert_eq!(
        std::fs::read(current_show_data_dir.join(relative_audio_path)).expect("read copied audio"),
        b"audio"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies imported assets resolve relative to a dropped show folder.
#[test]
fn prepare_imported_showfile_assets_accepts_show_folder_import_path() {
    let mut world = setup_world();
    seed_world(&mut world);
    let current = collect_snapshot(&mut world);
    let mut incoming = current.clone();
    let timeline_uid = incoming.timelines[0].identifiers().uid;
    let relative_audio_path = format!(
        "{}/{}/folder-track.wav",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        timeline_uid.simple()
    );
    incoming.timelines[0].audio_path = relative_audio_path.clone();

    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-import-folder-audio-{}",
        Uuid::new_v4().simple()
    ));
    let source_show_data_dir = temp_root.join("sample.nightfall-show");
    let current_show_data_dir = temp_root.join("default.nightfall-show");
    let source_audio_path = source_show_data_dir.join(&relative_audio_path);
    std::fs::create_dir_all(source_audio_path.parent().expect("audio parent"))
        .expect("create source audio directory");
    std::fs::write(&source_audio_path, b"folder-audio").expect("write source audio");

    let options = ShowfileImportOptions {
        timelines: ShowfileImportPolicy::Overwrite,
        timecodes: ShowfileImportPolicy::Skip,
        ..Default::default()
    };
    prepare_imported_showfile_assets(
        &mut incoming,
        &current,
        &options,
        &source_show_data_dir,
        &current_show_data_dir,
    )
    .expect("audio assets should copy from folder import");

    assert_eq!(
        std::fs::read(current_show_data_dir.join(relative_audio_path)).expect("read copied audio"),
        b"folder-audio"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies showfile snapshots retain tracks even when they have no items yet.
#[test]
fn collect_snapshot_preserves_empty_timeline_tracks() {
    let mut world = setup_world();
    seed_world(&mut world);
    {
        let mut timeline_provider = world.resource_mut::<DataProvider<Timeline>>();
        let mut timeline = (*timeline_provider
            .from_id(10)
            .expect("timeline should exist"))
        .clone();
        timeline.tracks = vec![
            Track {
                id: "empty-track-a".to_string(),
                label: "Empty Track A".to_string(),
                muted: false,
                solo: false,
                expanded: false,
                actions: Vec::new(),
                automation_lanes: Vec::new(),
            },
            Track {
                id: "empty-track-b".to_string(),
                label: "Empty Track B".to_string(),
                muted: true,
                solo: false,
                expanded: true,
                actions: Vec::new(),
                automation_lanes: Vec::new(),
            },
        ];
        timeline_provider
            .add(timeline)
            .expect("timeline should be updated");
    }

    let snapshot = collect_snapshot(&mut world);
    let timeline = snapshot
        .timelines
        .iter()
        .find(|timeline| timeline.identifiers.id == 10)
        .expect("timeline should be snapshotted");

    assert_eq!(timeline.tracks.len(), 2);
    assert_eq!(timeline.tracks[0].id, "empty-track-a");
    assert_eq!(timeline.tracks[1].id, "empty-track-b");
    assert!(timeline.tracks.iter().all(|track| track.actions.is_empty()));
}

#[test]
fn save_showfile_event_emits_success_result_and_toast() {
    let mut app = App::new();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.add_message::<UiNotification>();
    let correlation_id = Uuid::new_v4();
    let event = CommandEnvelope::with_context(
        correlation_id.into(),
        correlation_id.into(),
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
        DeskCommand::SaveShowfile(Default::default()),
    );
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("save command should register");

    app.world_mut()
        .run_system_once(
            move |mut responder: CommandResponder,
                  mut ui_notifications: MessageWriter<UiNotification>| {
                write_showfile_saved_feedback(&event, &mut responder, &mut ui_notifications);
            },
        )
        .expect("run save feedback system");

    let results: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(
        results.iter().any(|result| {
            result.command_id == correlation_id.into()
                && matches!(result.outcome, CommandOutcome::Succeeded { .. })
        }),
        "expected save showfile success command result"
    );

    let ui_notifications: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<UiNotification>>()
        .drain()
        .collect();
    assert!(
        ui_notifications.iter().any(|notification| {
            matches!(
                notification,
                UiNotification::ShowToast {
                    level: ToastLevel::Success,
                    message,
                } if message == "Showfile saved"
            )
        }),
        "expected save showfile success toast"
    );
}

#[test]
fn new_showfile_event_is_deferred_when_swap_request_resource_exists() {
    let mut world = setup_world();
    world.insert_resource(crate::PendingWorldSwapRequest::default());
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());

    let correlation_id = Uuid::new_v4();
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            DeskCommand::NewShowfile,
        ));

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let queued = world
        .resource_mut::<crate::PendingWorldSwapRequest>()
        .take_requests();
    assert_eq!(
        queued,
        vec![crate::PendingWorldSwap::NewShowfile {
            correlation_id,
            showfile_name: None,
            include_sample_data: false,
        }]
    );
}

/// Verifies named new-show commands defer through the world swap queue with their name.
#[test]
fn named_new_showfile_event_is_deferred_when_swap_request_resource_exists() {
    let mut world = setup_world();
    world.insert_resource(crate::PendingWorldSwapRequest::default());
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());

    let correlation_id = Uuid::new_v4();
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            DeskCommand::NewNamedShowfile(nightfall_desk::desk_command::NewShowfileOptions {
                name: "demo".to_string(),
                include_sample_data: true,
            }),
        ));

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let queued = world
        .resource_mut::<crate::PendingWorldSwapRequest>()
        .take_requests();
    assert_eq!(
        queued,
        vec![crate::PendingWorldSwap::NewShowfile {
            correlation_id,
            showfile_name: Some("demo".to_string()),
            include_sample_data: true,
        }]
    );
}

/// Verifies load commands defer through the world swap queue with their optional name.
#[test]
fn load_showfile_event_is_deferred_when_swap_request_resource_exists() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let mut world = setup_world();
    world.insert_resource(crate::PendingWorldSwapRequest::default());
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());

    let correlation_id = Uuid::new_v4();
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            DeskCommand::LoadNamedShowfile("demo".to_string()),
        ));

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let queued = world
        .resource_mut::<crate::PendingWorldSwapRequest>()
        .take_requests();
    assert_eq!(
        queued,
        vec![crate::PendingWorldSwap::LoadShowfile {
            correlation_id,
            showfile_name: Some("demo".to_string()),
            source: showfile_dir_path(Some("demo")).unwrap(),
        }]
    );
}

/// Verifies draft load commands defer through the same world swap queue as saved loads.
#[test]
fn load_draft_showfile_event_is_deferred_when_swap_request_resource_exists() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let mut world = setup_world();
    world.insert_resource(crate::PendingWorldSwapRequest::default());
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());

    let correlation_id = Uuid::new_v4();
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            DeskCommand::LoadDraftShowfile("demo".to_string()),
        ));

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let queued = world
        .resource_mut::<crate::PendingWorldSwapRequest>()
        .take_requests();
    assert_eq!(
        queued,
        vec![crate::PendingWorldSwap::LoadShowfile {
            correlation_id,
            showfile_name: Some("demo".to_string()),
            source: showfile_draft_dir_path(Some("demo")).unwrap(),
        }]
    );
}

/// Verifies direct saved loads succeed even when rebuildable manifest repair fails.
#[test]
fn load_showfile_event_emits_success_result_after_direct_load() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();

    let tour_dir = root.path().join("tour.nightfall-show");
    std::fs::create_dir_all(&tour_dir).expect("create saved showfile dir");
    let mut snapshot_world = setup_world();
    let snapshot = collect_snapshot(&mut snapshot_world);
    let snapshot_json =
        serialize_showfile_snapshot_json(&snapshot).expect("serialize saved snapshot");
    std::fs::write(tour_dir.join(SHOWFILE_SNAPSHOT_FILENAME), snapshot_json)
        .expect("write saved snapshot");
    std::fs::create_dir(tour_dir.join(SHOWFILE_MANIFEST_FILENAME))
        .expect("block saved manifest repair with a directory");

    let mut world = setup_world();
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());
    let command_id = submit_showfile_command(
        &mut world,
        DeskCommand::LoadNamedShowfile("tour".to_string()),
    );

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let results: Vec<_> = world
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(
        results.iter().any(|result| {
            result.command_id == command_id
                && matches!(result.outcome, CommandOutcome::Succeeded { .. })
        }),
        "expected load showfile success command result"
    );
    assert!(
        tour_dir.join(SHOWFILE_MANIFEST_FILENAME).is_dir(),
        "failed best-effort repair should leave the readable saved show untouched"
    );
    assert!(
        root.path()
            .join(SHOWFILE_DRAFTS_DIR)
            .join("tour.nightfall-show")
            .join(SHOWFILE_MANIFEST_FILENAME)
            .is_file(),
        "saved load should still create a valid working draft manifest"
    );

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verifies a loaded backup stays in working state until an explicit save replaces canonical data.
#[test]
fn load_showfile_revision_event_preserves_saved_showfile_until_save() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("create showfile root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();

    let default_dir = root.path().join("default.nightfall-show");
    let revision_dir = root
        .path()
        .join("backups")
        .join("default-20260707-151450.nightfall-show");
    std::fs::create_dir_all(&default_dir).expect("create saved showfile dir");
    std::fs::create_dir_all(&revision_dir).expect("create backup revision dir");

    let mut saved_world = setup_world();
    let saved_snapshot = collect_snapshot(&mut saved_world);
    let mut revision_snapshot = saved_snapshot.clone();
    revision_snapshot.variables.insert(
        "revision-only".to_string(),
        VariableValue::String("restored".to_string()),
    );
    let saved_json =
        serialize_showfile_snapshot_json(&saved_snapshot).expect("serialize saved snapshot");
    let revision_json =
        serialize_showfile_snapshot_json(&revision_snapshot).expect("serialize revision snapshot");
    std::fs::write(default_dir.join(SHOWFILE_SNAPSHOT_FILENAME), &saved_json)
        .expect("write saved snapshot");
    std::fs::write(
        revision_dir.join(SHOWFILE_SNAPSHOT_FILENAME),
        &revision_json,
    )
    .expect("write revision snapshot");

    let mut world = setup_world();
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());
    let command_id = submit_showfile_command(
        &mut world,
        DeskCommand::LoadShowfileRevision(
            ShowfileRevisionSelection::from_revision_name("default-20260707-151450")
                .expect("parse revision selection"),
        ),
    );

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let results: Vec<_> = world
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(
        results.iter().any(|result| {
            result.command_id == command_id
                && matches!(result.outcome, CommandOutcome::Succeeded { .. })
        }),
        "expected backup revision load success command result"
    );
    assert_eq!(
        std::fs::read_to_string(default_dir.join(SHOWFILE_SNAPSHOT_FILENAME))
            .expect("read preserved saved snapshot"),
        saved_json
    );
    let working_snapshot = read_showfile_snapshot_from_path(
        &root
            .path()
            .join(SHOWFILE_DRAFTS_DIR)
            .join("default.nightfall-show"),
    )
    .expect("read revision working snapshot");
    assert!(
        matches!(
            working_snapshot.variables.get("revision-only"),
            Some(VariableValue::String(value)) if value == "restored"
        ),
        "revision working draft should contain the selected backup data"
    );
    let loaded_variable = world
        .resource::<GlobalVariables>()
        .get("revision-only")
        .expect("revision variable should be loaded");
    assert!(
        matches!(loaded_variable, VariableValue::String(value) if value == "restored"),
        "revision variable should retain its loaded string value"
    );

    let save_command_id = submit_showfile_command(
        &mut world,
        DeskCommand::SaveShowfile(ShowfileSaveOptions::default()),
    );
    world
        .run_system_once(handle_events)
        .expect("run explicit save handler");
    let save_results: Vec<_> = world
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(
        save_results.iter().any(|result| {
            result.command_id == save_command_id
                && matches!(result.outcome, CommandOutcome::Succeeded { .. })
        }),
        "expected explicit save success command result"
    );
    let saved_after_explicit_save = read_showfile_snapshot_from_path(&default_dir)
        .expect("read canonical snapshot after explicit save");
    assert!(
        matches!(
            saved_after_explicit_save.variables.get("revision-only"),
            Some(VariableValue::String(value)) if value == "restored"
        ),
        "explicit save should replace canonical data with the loaded revision"
    );

    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

#[test]
fn mixed_world_swap_events_preserve_original_order() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let mut world = setup_world();
    world.insert_resource(crate::PendingWorldSwapRequest::default());
    world.insert_resource(Messages::<CommandEnvelope<DeskCommand>>::default());

    let load_correlation_id = Uuid::new_v4();
    let new_correlation_id = Uuid::new_v4();
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            load_correlation_id.into(),
            load_correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            DeskCommand::LoadShowfile,
        ));
    world
        .resource_mut::<Messages<CommandEnvelope<DeskCommand>>>()
        .write(CommandEnvelope::with_context(
            new_correlation_id.into(),
            new_correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            DeskCommand::NewShowfile,
        ));

    world
        .run_system_once(handle_events)
        .expect("run showfile handler");

    let queued = world
        .resource_mut::<crate::PendingWorldSwapRequest>()
        .take_requests();
    assert_eq!(
        queued,
        vec![
            crate::PendingWorldSwap::LoadShowfile {
                correlation_id: load_correlation_id,
                showfile_name: None,
                source: showfile_dir_path(None).unwrap(),
            },
            crate::PendingWorldSwap::NewShowfile {
                correlation_id: new_correlation_id,
                showfile_name: None,
                include_sample_data: false,
            },
        ]
    );
}

/// Populate a test world with representative showfile definitions and runtime settings.
fn seed_world(world: &mut World) {
    let fixture = Fixture {
        identifiers: identifiers(1, "fixture-1"),
        elements: vec![FixtureElement::default()],
        ..Default::default()
    };
    let fixture_uid = fixture.identifiers.uid;
    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    let scene_object = SceneObject::new_truss(2, "scene-truss", TrussProperties::default());
    world
        .resource_mut::<SceneObjectDataProvider>()
        .add(scene_object)
        .expect("scene object should be added");

    let cue = Cue {
        identifiers: identifiers(3, "cue-1"),
        ..Default::default()
    };
    let cue_uid = cue.identifiers.uid;
    world
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("cue should be added");

    let sequence = Sequence {
        identifiers: identifiers(4, "sequence-1"),
        steps: vec![SimpleUuid::from(cue_uid)],
        ..Default::default()
    };
    world
        .resource_mut::<DataProvider<Sequence>>()
        .add(sequence)
        .expect("sequence should be added");

    let group = Group {
        identifiers: identifiers(5, "group-1"),
        ..Default::default()
    };
    world
        .resource_mut::<DataProvider<Group>>()
        .add(group)
        .expect("group should be added");

    let blueprint = Blueprint {
        identifiers: identifiers(6, "blueprint-1"),
        ..Default::default()
    };
    world
        .resource_mut::<DataProvider<Blueprint>>()
        .add(blueprint)
        .expect("blueprint should be added");

    let fx = Fx {
        identifiers: identifiers(7, "fx-1"),
        ..Default::default()
    };
    world
        .resource_mut::<DataProvider<Fx>>()
        .add(fx)
        .expect("fx should be added");

    world.spawn(StepFx {
        identifiers: identifiers(12, "step-fx-1"),
        selection: SelectionExpr::default().into(),
        ..Default::default()
    });

    let flow = FlowDefinition {
        identifiers: identifiers(8, "flow-1"),
        ..Default::default()
    };
    world
        .resource_mut::<DataProvider<FlowDefinition>>()
        .add(flow)
        .expect("flow should be added");

    let timecode = Timecode {
        identifiers: identifiers(9, "timecode-1"),
        ..Default::default()
    };
    let timecode_uid = timecode.identifiers.uid;
    world
        .resource_mut::<DataProvider<Timecode>>()
        .add(timecode)
        .expect("timecode should be added");

    let timeline = Timeline {
        identifiers: identifiers(10, "timeline-1"),
        timecode_uid,
        ..Default::default()
    };
    world
        .resource_mut::<DataProvider<Timeline>>()
        .add(timeline)
        .expect("timeline should be added");

    world
        .resource::<GlobalVariables>()
        .set("global-rate", VariableValue::Float(1.25));

    world
        .resource_mut::<InputBindings>()
        .bindings
        .push(InputBinding {
            source: InputSource::Transport {
                transport: BindingTransport::Sacn,
                universe: Some(DmxRange::single(1)),
                address: Some(10),
            },
            target: InputTarget::Fixture {
                uids: vec![fixture_uid],
                element: None,
                param: None,
            },
            priority: 0,
            clone: false,
        });

    world
        .resource_mut::<OutputBindings>()
        .bindings
        .push(OutputBinding {
            source: OutputSource::Fixture {
                uids: vec![fixture_uid],
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "artnet".to_string(),
                universe: Some(DmxRange::single(2)),
                address: Some(50),
            },
            priority: 1,
            clone: false,
        });

    world
        .resource_mut::<DisabledBindings>()
        .bindings
        .push(DisabledBinding::Output {
            source: OutputSource::Fixture {
                uids: vec![fixture_uid],
                element: None,
                param: None,
            },
            priority: 2,
            clone: false,
        });

    let clip = Clip {
        identifiers: identifiers(11, "clip-1"),
        ..Default::default()
    };
    world.spawn(clip);

    #[cfg(feature = "midi")]
    world
        .resource_mut::<MidiMappings>()
        .set_mappings(vec![MidiMapping {
            device_name: "Grid".to_string(),
            id: uuid::Uuid::from_u128(1),
            input: nightfall_input_midi::command::MidiBindingInput::Continuous,
            channel: 176,
            note: 36,
            velocity: None,
            action: set_control_action(1),
        }]);
    #[cfg(feature = "osc")]
    world
        .resource_mut::<OscMappings>()
        .set_mappings(vec![OscMapping {
            source: Some("127.0.0.1:9000".to_string()),
            address: "/grid/fader".to_string(),
            id: uuid::Uuid::new_v4(),
            input: nightfall_input_osc::command::OscBindingInput::Continuous {
                minimum: 0.0,
                maximum: 1.0,
            },
            arg_index: Some(1),
            arg_value: Some("0.5".to_string()),
            action: set_control_action(2),
        }]);

    {
        let mut desk_settings = world.resource_mut::<DeskSettings>();
        desk_settings.programmer_auto_select = true;
        desk_settings.audio_device = Some("Built-in Output".to_string());
        desk_settings.selection_flatten_policy = SelectionFlattenPolicy::Prompt;
        desk_settings.active_panel_layout = Some(ActivePanelLayout {
            layout_id: None,
            version: 2,
            layout: serde_json::json!({
                "grid": "active",
                "activeGroup": "main",
            }),
            panels: vec![StoredPanelLayoutPanel {
                id: "panel-Visualizer".to_string(),
                title: "Visualizer".to_string(),
                params: serde_json::json!({
                    "mode": "operator",
                }),
            }],
            updated_at: 1_700_000_002_000.0,
        });
        desk_settings.panel_layouts = vec![StoredPanelLayout {
            shown_in_switcher: true,
            id: "operator-layout".to_string(),
            name: "Operator".to_string(),
            version: 2,
            layout: serde_json::json!({
                "grid": "operator",
                "activeGroup": "main",
            }),
            panels: vec![StoredPanelLayoutPanel {
                id: "panel-Cues".to_string(),
                title: "Cues".to_string(),
                params: serde_json::json!({
                    "selectedSequence": "main",
                }),
            }],
            created_at: 1_700_000_000_000.0,
            updated_at: 1_700_000_001_000.0,
        }];
    }

    let mut io_settings = world.resource_mut::<IoRuntimeSettings>();
    io_settings.network_interface = Some("en0".to_string());
    io_settings.input_signal_loss_policy = InputSignalLossPolicy::ClearAfterTimeout {};
    io_settings.input_signal_loss_timeout = std::time::Duration::from_millis(777);
}

fn collect_snapshot(world: &mut World) -> ShowfileSnapshot {
    world
        .run_system_once(|showfile_save_state: ShowfileSaveState| {
            snapshot_from_save_state(&showfile_save_state)
        })
        .expect("collect snapshot system should run")
}

fn apply_snapshot(world: &mut World, snapshot: ShowfileSnapshot) {
    let mut snapshot = Some(snapshot);
    world
        .run_system_once(
            move |mut showfile_load_state: ShowfileLoadState, mut commands: Commands| {
                let snapshot = snapshot.take().expect("snapshot should be available");
                let ShowfileLoadState {
                    fixture_data_provider,
                    scene_object_provider,
                    cue_data_provider,
                    seq_data_provider,
                    group_data_provider,
                    master_data_provider,
                    blueprint_data_provider,
                    color_path_data_provider,
                    fx_data_provider,
                    fx_module_data_provider,
                    flow_data_provider,
                    timecode_data_provider,
                    timeline_data_provider,
                    active_fx_module_ids: _,
                    input_bindings,
                    output_bindings,
                    disabled_bindings,
                    #[cfg(feature = "midi")]
                    midi_mappings,
                    #[cfg(feature = "osc")]
                    osc_mappings,
                    global_variables,
                    desk_settings,
                    io_settings,
                    ..
                } = &mut showfile_load_state;
                apply_showfile_snapshot(
                    snapshot,
                    fixture_data_provider.as_mut(),
                    scene_object_provider.as_mut(),
                    cue_data_provider.as_mut(),
                    seq_data_provider.as_mut(),
                    group_data_provider.as_mut(),
                    master_data_provider.as_mut(),
                    blueprint_data_provider.as_mut(),
                    color_path_data_provider.as_mut(),
                    fx_data_provider.as_mut(),
                    fx_module_data_provider.as_mut(),
                    flow_data_provider.as_mut(),
                    timecode_data_provider.as_mut(),
                    timeline_data_provider.as_mut(),
                    input_bindings.as_mut(),
                    output_bindings.as_mut(),
                    disabled_bindings.as_mut(),
                    #[cfg(feature = "midi")]
                    midi_mappings.as_mut(),
                    #[cfg(feature = "osc")]
                    osc_mappings.as_mut(),
                    desk_settings.as_mut(),
                    io_settings.as_mut(),
                    &mut commands,
                    global_variables.as_ref(),
                )
            },
        )
        .expect("apply snapshot system should run")
        .expect("snapshot application should succeed");
}

fn try_apply_snapshot(world: &mut World, snapshot: ShowfileSnapshot) -> Result<(), String> {
    let mut snapshot = Some(snapshot);
    world
        .run_system_once(
            move |mut showfile_load_state: ShowfileLoadState, mut commands: Commands| {
                let snapshot = snapshot.take().expect("snapshot should be available");
                let ShowfileLoadState {
                    fixture_data_provider,
                    scene_object_provider,
                    cue_data_provider,
                    seq_data_provider,
                    group_data_provider,
                    master_data_provider,
                    blueprint_data_provider,
                    color_path_data_provider,
                    fx_data_provider,
                    fx_module_data_provider,
                    flow_data_provider,
                    timecode_data_provider,
                    timeline_data_provider,
                    active_fx_module_ids: _,
                    input_bindings,
                    output_bindings,
                    disabled_bindings,
                    #[cfg(feature = "midi")]
                    midi_mappings,
                    #[cfg(feature = "osc")]
                    osc_mappings,
                    global_variables,
                    desk_settings,
                    io_settings,
                    ..
                } = &mut showfile_load_state;
                apply_showfile_snapshot(
                    snapshot,
                    fixture_data_provider.as_mut(),
                    scene_object_provider.as_mut(),
                    cue_data_provider.as_mut(),
                    seq_data_provider.as_mut(),
                    group_data_provider.as_mut(),
                    master_data_provider.as_mut(),
                    blueprint_data_provider.as_mut(),
                    color_path_data_provider.as_mut(),
                    fx_data_provider.as_mut(),
                    fx_module_data_provider.as_mut(),
                    flow_data_provider.as_mut(),
                    timecode_data_provider.as_mut(),
                    timeline_data_provider.as_mut(),
                    input_bindings.as_mut(),
                    output_bindings.as_mut(),
                    disabled_bindings.as_mut(),
                    #[cfg(feature = "midi")]
                    midi_mappings.as_mut(),
                    #[cfg(feature = "osc")]
                    osc_mappings.as_mut(),
                    desk_settings.as_mut(),
                    io_settings.as_mut(),
                    &mut commands,
                    global_variables.as_ref(),
                )
            },
        )
        .expect("apply snapshot system should run")
}

/// Resolves FX identity using the same provider helper used by the domain's registration.
fn lookup_test_fx_identity(
    In(reference): In<ObjectRef>,
    provider: Res<DataProvider<Fx>>,
) -> nightfall_engine::object_registry::ObjectLookupResult {
    nightfall_engine::object_registry::lookup_provider_object(&reference, &provider)
}

/// Showfile replacement preserves registered lookup systems and points them at replacement data.
#[test]
fn in_place_load_preserves_object_registry_and_replaces_lookup_data() {
    use nightfall_engine::object_registry::{register_object_lookup, resolve_object};
    let mut world = setup_world();
    register_object_lookup(&mut world, ObjectType::Fx, lookup_test_fx_identity);
    let original = Fx {
        identifiers: identifiers(7, "Original FX"),
        ..Default::default()
    };
    let original_uid = original.identifiers.uid;
    world
        .resource_mut::<DataProvider<Fx>>()
        .add(original)
        .unwrap();
    let reference = ObjectRef::ById {
        object_type: ObjectType::Fx,
        id: 7,
    };
    assert_eq!(
        resolve_object(&mut world, &reference).unwrap().uid,
        original_uid
    );
    let show_owned_entity = world.spawn_empty().id();

    let mut replacement_world = setup_world();
    let replacement = Fx {
        identifiers: Identifiers {
            uid: Uuid::from_u128(20_007),
            ..identifiers(7, "Replacement FX")
        },
        ..Default::default()
    };
    let replacement_uid = replacement.identifiers.uid;
    replacement_world
        .resource_mut::<DataProvider<Fx>>()
        .add(replacement)
        .unwrap();
    let snapshot = collect_snapshot(&mut replacement_world);
    load_snapshot_in_place(&mut world, snapshot);

    assert!(world.get_entity(show_owned_entity).is_err());
    assert_eq!(
        resolve_object(&mut world, &reference).unwrap().uid,
        replacement_uid
    );
    assert!(
        resolve_object(
            &mut world,
            &ObjectRef::ByUid {
                object_type: ObjectType::Fx,
                uid: original_uid
            }
        )
        .is_err()
    );
}

/// Applies a replacement snapshot through the actual in-place load and reset pipeline.
fn try_load_snapshot_in_place(world: &mut World, snapshot: ShowfileSnapshot) -> Result<(), String> {
    let mut snapshot = Some(snapshot);
    world
        .run_system_once(
            move |mut showfile_load_state: ShowfileLoadState, mut commands: Commands| {
                let snapshot = snapshot.take().expect("snapshot should be available");
                let ShowfileLoadState {
                    fixture_data_provider,
                    scene_object_provider,
                    cue_data_provider,
                    seq_data_provider,
                    group_data_provider,
                    master_data_provider,
                    blueprint_data_provider,
                    color_path_data_provider,
                    fx_data_provider,
                    fx_module_data_provider,
                    flow_data_provider,
                    timecode_data_provider,
                    timeline_data_provider,
                    active_fx_module_ids,
                    input_bindings,
                    output_bindings,
                    disabled_bindings,
                    #[cfg(feature = "midi")]
                    midi_mappings,
                    #[cfg(feature = "osc")]
                    osc_mappings,
                    all_entities,
                    resolved_input_bindings,
                    console_dmx_addresses,
                    console_dmx_universes,
                    input_dmx_universes,
                    universe_transport_map,
                    instance_index,
                    final_layer_attributed_assertions,
                    pending_commands,
                    scheduled_commands,
                    undo_manager,
                    controller_learning,
                    programmer,
                    global_variables,
                    desk_settings,
                    io_settings,
                } = &mut showfile_load_state;

                load_showfile_in_place(
                    snapshot,
                    fixture_data_provider.as_mut(),
                    scene_object_provider.as_mut(),
                    cue_data_provider.as_mut(),
                    seq_data_provider.as_mut(),
                    group_data_provider.as_mut(),
                    master_data_provider.as_mut(),
                    blueprint_data_provider.as_mut(),
                    color_path_data_provider.as_mut(),
                    fx_data_provider.as_mut(),
                    fx_module_data_provider.as_mut(),
                    flow_data_provider.as_mut(),
                    timecode_data_provider.as_mut(),
                    timeline_data_provider.as_mut(),
                    active_fx_module_ids.as_deref_mut(),
                    input_bindings.as_mut(),
                    output_bindings.as_mut(),
                    disabled_bindings.as_mut(),
                    #[cfg(feature = "midi")]
                    midi_mappings.as_mut(),
                    #[cfg(feature = "osc")]
                    osc_mappings.as_mut(),
                    &*all_entities,
                    resolved_input_bindings.as_deref_mut(),
                    console_dmx_addresses.as_deref_mut(),
                    console_dmx_universes.as_deref_mut(),
                    input_dmx_universes.as_deref_mut(),
                    universe_transport_map.as_deref_mut(),
                    instance_index.as_deref_mut(),
                    final_layer_attributed_assertions.as_deref_mut(),
                    pending_commands.as_mut(),
                    scheduled_commands.as_deref_mut(),
                    undo_manager.as_deref_mut(),
                    controller_learning.as_deref_mut(),
                    programmer.as_deref_mut(),
                    global_variables.as_ref(),
                    desk_settings.as_mut(),
                    io_settings.as_mut(),
                    &mut commands,
                )
            },
        )
        .expect("in-place load system should run")
}

fn load_snapshot_in_place(world: &mut World, snapshot: ShowfileSnapshot) {
    try_load_snapshot_in_place(world, snapshot).expect("in-place load should succeed");
}

#[test]
fn save_load_save_roundtrip_produces_equivalent_snapshot_json() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let json = serde_json::to_string_pretty(&source_snapshot).expect("serialize snapshot");
    let parsed_snapshot: ShowfileSnapshot =
        serde_json::from_str(&json).expect("deserialize snapshot");

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, parsed_snapshot);
    let restored_snapshot = collect_snapshot(&mut restored_world);

    let source_value = serde_json::to_value(source_snapshot).expect("snapshot to value");
    let restored_value = serde_json::to_value(restored_snapshot).expect("snapshot to value");
    assert_eq!(source_value, restored_value);
}

#[test]
fn load_into_fresh_world_is_idempotent_across_restarts() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut first_restart_world = setup_world();
    apply_snapshot(&mut first_restart_world, source_snapshot.clone());
    let first_snapshot = collect_snapshot(&mut first_restart_world);

    let mut second_restart_world = setup_world();
    apply_snapshot(&mut second_restart_world, first_snapshot.clone());
    let second_snapshot = collect_snapshot(&mut second_restart_world);

    let first_value = serde_json::to_value(first_snapshot).expect("snapshot to value");
    let second_value = serde_json::to_value(second_snapshot).expect("snapshot to value");
    assert_eq!(first_value, second_value);
}

/// Verifies direct showfile restore normalizes authored group IDs before runtime storage.
#[test]
fn load_into_fresh_world_stabilizes_authored_group_ids() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let mut source_snapshot = collect_snapshot(&mut source_world);
    let group_uid = source_snapshot.groups[0].identifiers.uid;
    let group_id = source_snapshot.groups[0].identifiers.id;
    source_snapshot.fx[0].selection =
        SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(group_id)));
    source_snapshot.sequences[0].release_cue.instructions = vec![BoundCueInstruction {
        selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(group_id))),
        cue_instruction: CueInstruction::default(),
    }];

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, source_snapshot);
    let restored_snapshot = collect_snapshot(&mut restored_world);

    assert_eq!(
        restored_snapshot.fx[0].selection.source,
        SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
    );
    assert_eq!(
        restored_snapshot.sequences[0].release_cue.instructions[0]
            .selection
            .source,
        SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
    );
}

#[test]
fn roundtrip_preserves_patch_bindings_and_domain_counts() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, source_snapshot);
    let restored_snapshot = collect_snapshot(&mut restored_world);

    assert_eq!(restored_snapshot.fixtures.len(), 1);
    assert_eq!(restored_snapshot.scene_objects.len(), 1);
    assert_eq!(restored_snapshot.cues.len(), 1);
    assert_eq!(restored_snapshot.sequences.len(), 1);
    assert_eq!(restored_snapshot.groups.len(), 1);
    assert_eq!(restored_snapshot.blueprints.len(), 1);
    assert_eq!(restored_snapshot.fx.len(), 1);
    assert_eq!(restored_snapshot.step_fx.len(), 1);
    assert_eq!(restored_snapshot.flows.len(), 1);
    assert_eq!(restored_snapshot.timecodes.len(), 1);
    assert_eq!(restored_snapshot.timelines.len(), 1);
    assert_eq!(restored_snapshot.clips.len(), 1);
    assert_eq!(restored_snapshot.bindings.input.len(), 1);
    assert_eq!(restored_snapshot.bindings.output.len(), 1);
    assert_eq!(restored_snapshot.bindings.disabled.len(), 1);

    let fixture_uid = restored_snapshot.fixtures[0].identifiers.uid;
    match &restored_snapshot.bindings.output[0].source {
        OutputSource::Fixture { uids, .. } => assert_eq!(uids, &vec![fixture_uid]),
        _ => panic!("expected fixture source in output binding"),
    }
}

/// Verifies Blueprint definitions and stable cue applications survive serialization and load.
#[test]
fn roundtrip_preserves_blueprint_applications() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let mut source_snapshot = collect_snapshot(&mut source_world);
    let blueprint_uid = source_snapshot.blueprints[0].identifiers.uid;
    source_snapshot.cues[0].instructions = vec![BoundCueInstruction {
        selection: SpatialSelection::default(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid,
                selector: BlueprintSelector::Category(Attribute::Red.category()),
            }),
            ..Default::default()
        },
    }];
    let json = serialize_showfile_snapshot_json(&source_snapshot)
        .expect("Blueprint reference snapshot should serialize");
    let parsed = parse_showfile_snapshot_json(&json, "Blueprint reference test")
        .expect("Blueprint reference snapshot should parse");

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, parsed);
    let restored = collect_snapshot(&mut restored_world);

    assert_eq!(
        serde_json::to_value(&restored.blueprints).expect("restored Blueprints should serialize"),
        serde_json::to_value(&source_snapshot.blueprints)
            .expect("source Blueprints should serialize"),
    );
    assert_eq!(
        restored.cues[0].instructions[0]
            .cue_instruction
            .blueprint_application,
        source_snapshot.cues[0].instructions[0]
            .cue_instruction
            .blueprint_application,
    );
}

#[test]
fn roundtrip_preserves_desk_settings() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, source_snapshot.clone());
    let restored_snapshot = collect_snapshot(&mut restored_world);

    assert_eq!(
        restored_snapshot.settings.programmer_auto_select,
        source_snapshot.settings.programmer_auto_select
    );
    assert_eq!(
        restored_snapshot.io_settings.network_interface,
        source_snapshot.io_settings.network_interface
    );
    assert_eq!(
        restored_snapshot.settings.audio_device,
        source_snapshot.settings.audio_device
    );
    assert_eq!(
        restored_snapshot.io_settings.input_signal_loss_policy,
        source_snapshot.io_settings.input_signal_loss_policy
    );
    assert_eq!(
        restored_snapshot.settings.selection_flatten_policy,
        source_snapshot.settings.selection_flatten_policy
    );
    assert_eq!(
        restored_snapshot.settings.showfile_backup_retention,
        source_snapshot.settings.showfile_backup_retention
    );
    assert_eq!(
        restored_snapshot.settings.panel_layouts,
        source_snapshot.settings.panel_layouts
    );
    assert_eq!(
        restored_snapshot.settings.active_panel_layout,
        source_snapshot.settings.active_panel_layout
    );
}

/// Verifies the desk-state contributor preserves variables and settings through snapshot load.
#[test]
fn roundtrip_preserves_desk_state_contributor_slice() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    {
        let mut stale_settings = restored_world.resource_mut::<DeskSettings>();
        stale_settings.programmer_auto_select = false;
    }
    {
        let mut stale_settings = restored_world.resource_mut::<IoRuntimeSettings>();
        stale_settings.network_interface = Some("stale0".to_string());
    }
    restored_world
        .resource::<GlobalVariables>()
        .set("stale-only", VariableValue::Float(99.0));

    load_snapshot_in_place(&mut restored_world, source_snapshot.clone());
    let restored_snapshot = collect_snapshot(&mut restored_world);

    assert_eq!(
        serde_json::to_value(&restored_snapshot.variables).expect("variables to value"),
        serde_json::to_value(&source_snapshot.variables).expect("variables to value")
    );
    assert_eq!(
        serde_json::to_value(&restored_snapshot.settings).expect("settings to value"),
        serde_json::to_value(&source_snapshot.settings).expect("settings to value")
    );
    assert!(!restored_snapshot.variables.contains_key("stale-only"));
}

/// Verifies showfile preferences cannot replace process-scoped transport permissions.
#[test]
fn showfile_load_preserves_transport_runtime_policy() {
    let mut source_world = setup_world();
    {
        let mut settings = source_world.resource_mut::<IoRuntimeSettings>();
        settings.network_output_enabled = true;
        settings.network_input_enabled = true;
        settings.usb_output_enabled = true;
    }
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    restored_world.insert_resource(TransportRuntimePolicy::new(false, false, false));
    apply_snapshot(&mut restored_world, source_snapshot);

    let settings = restored_world.resource::<IoRuntimeSettings>();
    let policy = restored_world.resource::<TransportRuntimePolicy>();
    assert!(settings.network_output_enabled);
    assert!(settings.network_input_enabled);
    assert!(settings.usb_output_enabled);
    assert!(!policy.network_output_enabled(settings));
    assert!(!policy.network_input_enabled(settings));
    assert!(!policy.usb_output_enabled(settings));
}

#[cfg(feature = "midi")]
#[test]
fn roundtrip_preserves_midi_mappings() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, source_snapshot.clone());
    let restored_snapshot = collect_snapshot(&mut restored_world);

    assert_eq!(
        restored_snapshot.midi_mappings,
        source_snapshot.midi_mappings
    );
    assert_eq!(restored_snapshot.midi_mappings.len(), 1);
    let mapping = &restored_snapshot.midi_mappings[0];
    assert_eq!(mapping.device_name, "Grid");
    assert_eq!(mapping.channel, 176);
    assert_eq!(mapping.note, 36);
    assert_eq!(mapping.velocity, None);
    assert_eq!(mapping.action, set_control_action(1));
}

/// Verifies OSC input mappings survive showfile save/load snapshot application.
#[cfg(feature = "osc")]
#[test]
fn roundtrip_preserves_osc_mappings() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, source_snapshot.clone());
    let restored_snapshot = collect_snapshot(&mut restored_world);

    assert_eq!(restored_snapshot.osc_mappings, source_snapshot.osc_mappings);
    assert_eq!(restored_snapshot.osc_mappings.len(), 1);
    let mapping = &restored_snapshot.osc_mappings[0];
    assert_eq!(mapping.source.as_deref(), Some("127.0.0.1:9000"));
    assert_eq!(mapping.address, "/grid/fader");
    assert_eq!(mapping.arg_index, Some(1));
    assert_eq!(mapping.arg_value.as_deref(), Some("0.5"));
    assert_eq!(mapping.action, set_control_action(2));
}

#[test]
fn roundtrip_preserves_custom_scene_object_model_properties() {
    let mut source_world = setup_world();
    source_world
        .resource_mut::<SceneObjectDataProvider>()
        .add(SceneObject::new_custom(
            42,
            "custom-prop-test",
            CustomProperties {
                model_path: "show-token.robj".to_string(),
                scale: 1.75,
                color_override: Some("#336699".to_string()),
                library_object_name: None,
                library_object_version: None,
            },
        ))
        .expect("custom scene object should be added");

    let source_snapshot = collect_snapshot(&mut source_world);

    let mut restored_world = setup_world();
    apply_snapshot(&mut restored_world, source_snapshot);
    let restored_snapshot = collect_snapshot(&mut restored_world);

    let restored_object = restored_snapshot
        .scene_objects
        .iter()
        .find(|scene_object| scene_object.identifiers.id == 42)
        .expect("restored custom scene object");

    match &restored_object.properties {
        SceneObjectProperties::Custom(props) => {
            assert_eq!(props.model_path, "show-token.robj");
            assert_eq!(props.scale, 1.75);
            assert_eq!(props.color_override.as_deref(), Some("#336699"));
            assert!(props.library_object_name.is_none());
            assert!(props.library_object_version.is_none());
        }
        _ => panic!("expected custom scene object properties"),
    }
}

#[test]
fn showfile_import_rejects_multiple_fixture_versions_for_same_asset_key() {
    let mut world = setup_world();

    let fixture_a = Fixture {
        identifiers: identifiers(1, "fixture-a"),
        make: "Acme".to_string(),
        model: "Beam 200".to_string(),
        mode: "16ch".to_string(),
        elements: vec![FixtureElement {
            label: "Element A".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Red,
                native_unit: Attribute::Red.native_unit(),
                value_polarity: Attribute::Red.value_polarity(),
                ..Default::default()
            }],
        }],
        layout: None,
        library_asset_etag: Some("v1".to_string()),
        ..Default::default()
    };

    let fixture_b = Fixture {
        identifiers: identifiers(2, "fixture-b"),
        make: "Acme".to_string(),
        model: "Beam 200".to_string(),
        mode: "16ch".to_string(),
        elements: vec![FixtureElement {
            label: "Element B".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Blue,
                native_unit: Attribute::Blue.native_unit(),
                value_polarity: Attribute::Blue.value_polarity(),
                ..Default::default()
            }],
        }],
        layout: None,
        library_asset_etag: Some("v2".to_string()),
        ..Default::default()
    };

    let result = try_apply_snapshot(
        &mut world,
        ShowfileSnapshot {
            control_assignments: Vec::new(),
            metadata: ShowfileMetadata::default(),
            fixtures: vec![fixture_a, fixture_b],
            variables: HashMap::new(),
            bindings: BindingsSnapshot {
                input: vec![],
                output: vec![],
                disabled: vec![],
            },
            #[cfg(feature = "midi")]
            midi_mappings: vec![],
            #[cfg(feature = "osc")]
            osc_mappings: vec![],
            scene_objects: vec![],
            cues: vec![],
            sequences: vec![],
            groups: vec![],
            masters: vec![],
            blueprints: vec![],
            color_paths: vec![],
            color_path_defaults: vec![],
            fx: vec![],
            fx_module: vec![],
            step_fx: vec![],
            flows: vec![],
            timecodes: vec![],
            timelines: vec![],
            clips: vec![],
            settings: DeskSettings::default(),
            io_settings: IoRuntimeSettings::default(),
        },
    );

    assert!(result.is_err());
    let error = result.expect_err("expected fixture version validation error");
    assert!(error.contains("multiple versions of fixture asset"));
}

#[test]
fn showfile_import_allows_non_library_fixtures_without_asset_version_metadata() {
    let mut world = setup_world();

    let fixture_a = Fixture {
        identifiers: identifiers(1, "fixture-a"),
        make: "Generic".to_string(),
        model: "RGBPixelTape 180ch".to_string(),
        mode: String::new(),
        elements: vec![FixtureElement {
            label: "Element A".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Red,
                native_unit: Attribute::Red.native_unit(),
                value_polarity: Attribute::Red.value_polarity(),
                ..Default::default()
            }],
        }],
        ..Default::default()
    };
    let fixture_b = Fixture {
        identifiers: identifiers(2, "fixture-b"),
        make: "Generic".to_string(),
        model: "RGBPixelTape 180ch".to_string(),
        mode: String::new(),
        elements: vec![FixtureElement {
            label: "Element B".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Blue,
                native_unit: Attribute::Blue.native_unit(),
                value_polarity: Attribute::Blue.value_polarity(),
                ..Default::default()
            }],
        }],
        ..Default::default()
    };

    let result = try_apply_snapshot(
        &mut world,
        ShowfileSnapshot {
            control_assignments: Vec::new(),
            metadata: ShowfileMetadata::default(),
            fixtures: vec![fixture_a, fixture_b],
            variables: HashMap::new(),
            bindings: BindingsSnapshot {
                input: vec![],
                output: vec![],
                disabled: vec![],
            },
            #[cfg(feature = "midi")]
            midi_mappings: vec![],
            #[cfg(feature = "osc")]
            osc_mappings: vec![],
            scene_objects: vec![],
            cues: vec![],
            sequences: vec![],
            groups: vec![],
            masters: vec![],
            blueprints: vec![],
            color_paths: vec![],
            color_path_defaults: vec![],
            fx: vec![],
            fx_module: vec![],
            step_fx: vec![],
            flows: vec![],
            timecodes: vec![],
            timelines: vec![],
            clips: vec![],
            settings: DeskSettings::default(),
            io_settings: IoRuntimeSettings::default(),
        },
    );

    assert!(result.is_ok());
}

#[test]
fn showfile_import_rejects_multiple_scene_object_versions_for_same_asset_name() {
    let mut world = setup_world();

    let scene_object_a = SceneObject::new_custom(
        1,
        "Road Case A",
        CustomProperties {
            model_path: "show-a".to_string(),
            scale: 1.0,
            color_override: None,
            library_object_name: Some("Road Case".to_string()),
            library_object_version: Some("v1".to_string()),
        },
    );
    let scene_object_b = SceneObject::new_custom(
        2,
        "Road Case B",
        CustomProperties {
            model_path: "show-b".to_string(),
            scale: 1.0,
            color_override: None,
            library_object_name: Some("Road Case".to_string()),
            library_object_version: Some("v2".to_string()),
        },
    );

    let result = try_apply_snapshot(
        &mut world,
        ShowfileSnapshot {
            control_assignments: Vec::new(),
            metadata: ShowfileMetadata::default(),
            fixtures: vec![],
            variables: HashMap::new(),
            bindings: BindingsSnapshot {
                input: vec![],
                output: vec![],
                disabled: vec![],
            },
            #[cfg(feature = "midi")]
            midi_mappings: vec![],
            #[cfg(feature = "osc")]
            osc_mappings: vec![],
            scene_objects: vec![scene_object_a, scene_object_b],
            cues: vec![],
            sequences: vec![],
            groups: vec![],
            masters: vec![],
            blueprints: vec![],
            color_paths: vec![],
            color_path_defaults: vec![],
            fx: vec![],
            fx_module: vec![],
            step_fx: vec![],
            flows: vec![],
            timecodes: vec![],
            timelines: vec![],
            clips: vec![],
            settings: DeskSettings::default(),
            io_settings: IoRuntimeSettings::default(),
        },
    );

    assert!(result.is_err());
    let error = result.expect_err("expected scene object version validation error");
    assert!(error.contains("multiple versions of scene object asset"));
}

#[cfg(feature = "object-library")]
#[test]
fn snapshot_library_model_path_for_showfile_rewrites_scope_and_copies_bundle() {
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-events-{}",
        Uuid::new_v4().simple()
    ));
    let library_path = temp_root.join("objects");
    let show_data_dir = temp_root.join("default.nightfall-show");

    std::fs::create_dir_all(&library_path).expect("create temp library directory");
    std::fs::create_dir_all(&show_data_dir).expect("create temp show-data directory");

    let library_bundle_path = library_path.join("object-a.robj");
    std::fs::write(&library_bundle_path, b"bundle").expect("write temp object bundle");
    let encoded_library_path = encode_object_path(&library_bundle_path);

    let snapshot_model_path = snapshot_library_model_path_for_showfile(
        &encoded_library_path,
        &library_path,
        &show_data_dir,
    )
    .expect("snapshot should succeed")
    .expect("library path should be converted to showfile path");

    let decoded_snapshot_path =
        decode_object_path(&snapshot_model_path).expect("snapshot path should decode");
    assert_eq!(
        decoded_snapshot_path.scope,
        ObjectModelPathScope::ShowfileData
    );
    assert!(
        decoded_snapshot_path
            .bundle_filename
            .ends_with("object-a.robj")
    );

    let copied_bundle_path = show_data_dir
        .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
        .join(decoded_snapshot_path.bundle_filename);
    assert!(
        copied_bundle_path.exists(),
        "expected copied bundle at {}",
        copied_bundle_path.display()
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies imported showfile scene object bundles are copied into current show-data.
#[cfg(feature = "object-library")]
#[test]
fn copy_imported_scene_object_assets_copies_showfile_bundle() {
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-events-import-object-{}",
        Uuid::new_v4().simple()
    ));
    let source_show_data_dir = temp_root.join("source-show-data");
    let current_show_data_dir = temp_root.join("current-show-data");
    let source_bundle_path = source_show_data_dir
        .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
        .join("case.robj");
    std::fs::create_dir_all(source_bundle_path.parent().expect("bundle parent"))
        .expect("create source bundle directory");
    std::fs::write(&source_bundle_path, b"bundle").expect("write source bundle");

    let current = vec![];
    let mut incoming = vec![SceneObject::new_custom(
        1,
        "Road Case",
        CustomProperties {
            model_path: encode_showfile_object_path(&source_bundle_path),
            scale: 1.0,
            color_override: None,
            library_object_name: None,
            library_object_version: None,
        },
    )];

    copy_imported_scene_object_assets(
        &current,
        &mut incoming,
        ShowfileImportPolicy::Overwrite,
        &source_show_data_dir,
        &current_show_data_dir,
    )
    .expect("scene object bundle should copy");

    let decoded_path =
        decode_object_path(scene_object_model_path(&incoming[0]).expect("model path"))
            .expect("model path should decode");
    let copied_bundle_path = current_show_data_dir
        .join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR)
        .join(decoded_path.bundle_filename);
    assert_eq!(
        std::fs::read(copied_bundle_path).expect("read copied object bundle"),
        b"bundle"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

#[cfg(feature = "object-library")]
#[test]
fn remove_orphaned_showfile_object_snapshots_keeps_only_referenced_showfile_assets() {
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-events-cleanup-{}",
        Uuid::new_v4().simple()
    ));
    let show_data_dir = temp_root.join("default.nightfall-show");
    let snapshots_dir = show_data_dir.join(SHOWFILE_SCENE_OBJECT_SNAPSHOTS_DIR);
    std::fs::create_dir_all(&snapshots_dir).expect("create snapshot directory");

    let retained_snapshot_path = snapshots_dir.join("keep.robj");
    let orphaned_snapshot_path = snapshots_dir.join("orphan.robj");
    let unrelated_file_path = snapshots_dir.join("notes.txt");
    std::fs::write(&retained_snapshot_path, b"keep").expect("write retained snapshot");
    std::fs::write(&orphaned_snapshot_path, b"orphan").expect("write orphaned snapshot");
    std::fs::write(&unrelated_file_path, b"note").expect("write unrelated file");

    let scene_objects = vec![SceneObject::new_custom(
        1,
        "Road Case",
        CustomProperties {
            model_path: encode_showfile_object_path(&retained_snapshot_path),
            scale: 1.0,
            color_override: None,
            library_object_name: None,
            library_object_version: None,
        },
    )];

    remove_orphaned_showfile_object_snapshots(&scene_objects, &show_data_dir)
        .expect("cleanup should succeed");

    assert!(
        retained_snapshot_path.exists(),
        "referenced snapshot should be kept"
    );
    assert!(
        !orphaned_snapshot_path.exists(),
        "unreferenced snapshot should be removed"
    );
    assert!(
        unrelated_file_path.exists(),
        "non-asset files should not be removed"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies timeline audio cleanup keeps referenced files and removes stale upload assets.
#[test]
fn remove_orphaned_timeline_audio_assets_keeps_only_referenced_audio() {
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-events-timeline-audio-cleanup-{}",
        Uuid::new_v4().simple()
    ));
    let show_data_dir = temp_root.join("default.nightfall-show");
    let audio_root = show_data_dir.join(SHOWFILE_TIMELINE_AUDIO_DIR);
    std::fs::create_dir_all(&audio_root).expect("create timeline audio directory");

    let retained_timeline_uid = Uuid::new_v4();
    let deleted_timeline_uid = Uuid::new_v4();
    let retained_relative_path = format!(
        "{}/{}/keep.wav",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        retained_timeline_uid.simple()
    );
    let retained_audio_path = show_data_dir.join(&retained_relative_path);
    let replaced_audio_path = show_data_dir.join(format!(
        "{}/{}/old.mp3",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        retained_timeline_uid.simple()
    ));
    let deleted_timeline_audio_dir = audio_root.join(deleted_timeline_uid.simple().to_string());
    let deleted_timeline_audio_path = deleted_timeline_audio_dir.join("deleted.m4a");
    let unrelated_file_path = audio_root.join("notes.txt");

    std::fs::create_dir_all(retained_audio_path.parent().expect("retained parent"))
        .expect("create retained timeline audio directory");
    std::fs::create_dir_all(&deleted_timeline_audio_dir)
        .expect("create deleted timeline audio directory");
    std::fs::write(&retained_audio_path, b"keep").expect("write retained audio");
    std::fs::write(&replaced_audio_path, b"old").expect("write replaced audio");
    std::fs::write(&deleted_timeline_audio_path, b"deleted").expect("write deleted audio");
    std::fs::write(&unrelated_file_path, b"note").expect("write unrelated file");

    let mut timeline = Timeline {
        identifiers: identifiers(1, "Timeline"),
        ..Timeline::default()
    };
    timeline.audio_path = retained_relative_path;

    remove_orphaned_timeline_audio_assets(&[timeline], &show_data_dir)
        .expect("cleanup should succeed");

    assert!(
        retained_audio_path.exists(),
        "referenced timeline audio should be kept"
    );
    assert!(
        !replaced_audio_path.exists(),
        "unreferenced audio in a retained timeline directory should be removed"
    );
    assert!(
        !deleted_timeline_audio_path.exists(),
        "audio for deleted timelines should be removed"
    );
    assert!(
        !deleted_timeline_audio_dir.exists(),
        "empty timeline audio directories should be removed"
    );
    assert!(
        unrelated_file_path.exists(),
        "non-audio files should not be removed"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies save cleanup covers runtime audio and a distinct saved show copy.
#[test]
fn remove_orphaned_timeline_audio_assets_in_save_dirs_cleans_runtime_and_saved_copy() {
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-events-timeline-audio-save-cleanup-{}",
        Uuid::new_v4().simple()
    ));
    let runtime_show_data_dir = temp_root.join("show-data");
    let saved_show_data_dir = temp_root.join("sample.nightfall-show");
    let timeline_uid = Uuid::new_v4();
    let retained_relative_path = format!(
        "{}/{}/keep.wav",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        timeline_uid.simple()
    );

    let runtime_retained_path = runtime_show_data_dir.join(&retained_relative_path);
    let runtime_orphaned_path = runtime_show_data_dir.join(format!(
        "{}/{}/runtime-old.mp3",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        timeline_uid.simple()
    ));
    let saved_retained_path = saved_show_data_dir.join(&retained_relative_path);
    let saved_orphaned_path = saved_show_data_dir.join(format!(
        "{}/{}/saved-old.m4a",
        SHOWFILE_TIMELINE_AUDIO_DIR,
        timeline_uid.simple()
    ));

    for audio_path in [
        &runtime_retained_path,
        &runtime_orphaned_path,
        &saved_retained_path,
        &saved_orphaned_path,
    ] {
        std::fs::create_dir_all(audio_path.parent().expect("audio parent"))
            .expect("create timeline audio directory");
        std::fs::write(audio_path, b"audio").expect("write timeline audio");
    }

    let mut timeline = Timeline {
        identifiers: identifiers(1, "Timeline"),
        ..Timeline::default()
    };
    timeline.audio_path = retained_relative_path;

    remove_orphaned_timeline_audio_assets_in_save_dirs(
        &[timeline],
        &runtime_show_data_dir,
        &saved_show_data_dir,
    )
    .expect("cleanup should succeed");

    assert!(
        runtime_retained_path.exists(),
        "referenced runtime audio should be kept"
    );
    assert!(
        saved_retained_path.exists(),
        "referenced saved-copy audio should be kept"
    );
    assert!(
        !runtime_orphaned_path.exists(),
        "runtime orphan audio should be removed"
    );
    assert!(
        !saved_orphaned_path.exists(),
        "saved-copy orphan audio should be removed"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies each save keeps a distinct timestamped backup snapshot.
#[test]
fn backup_show_data_directory_copies_full_directory_to_versioned_backups() {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-backup-{}-{}",
        std::process::id(),
        timestamp
    ));
    let show_data_dir = temp_root.join("default.nightfall-show");
    let scene_objects_dir = show_data_dir.join("scene-objects");

    std::fs::create_dir_all(&scene_objects_dir).expect("create show-data scene-objects dir");
    std::fs::write(show_data_dir.join("showfile.json"), b"v1").expect("write showfile");
    std::fs::write(scene_objects_dir.join("object-a.robj"), b"a1").expect("write bundle a");

    backup_show_data_directory(&show_data_dir, 2).expect("backup should succeed");
    let backup_root = temp_root.join("backups");
    let mut backup_dirs: Vec<_> = std::fs::read_dir(&backup_root)
        .expect("read backup root")
        .map(|entry| entry.expect("read backup dir entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("default-") && name.ends_with(".nightfall-show")
                })
        })
        .collect();
    backup_dirs.sort();
    assert_eq!(backup_dirs.len(), 1);
    let first_backup_dir = backup_dirs[0].clone();
    let first_backup_name = first_backup_dir
        .file_name()
        .and_then(|name| name.to_str())
        .expect("backup directory name should be utf-8");
    assert_eq!(
        first_backup_name.len(),
        "default-YYYYMMDD-HHMMSS.nightfall-show".len()
    );
    assert_eq!(&first_backup_name[16..17], "-");
    assert!(
        first_backup_name[8..16]
            .chars()
            .all(|ch| ch.is_ascii_digit())
            && first_backup_name[17..23]
                .chars()
                .all(|ch| ch.is_ascii_digit()),
        "backup name should use default-YYYYMMDD-HHMMSS.nightfall-show format"
    );

    assert_eq!(
        std::fs::read_to_string(first_backup_dir.join("showfile.json"))
            .expect("read backup showfile"),
        "v1"
    );
    assert_eq!(
        std::fs::read(first_backup_dir.join("scene-objects").join("object-a.robj"))
            .expect("read backup bundle a"),
        b"a1"
    );

    std::fs::write(show_data_dir.join("showfile.json"), b"v2").expect("rewrite showfile");
    std::fs::remove_file(scene_objects_dir.join("object-a.robj")).expect("remove bundle a");
    std::fs::write(scene_objects_dir.join("object-b.robj"), b"b2").expect("write bundle b");

    backup_show_data_directory(&show_data_dir, 2).expect("second backup should succeed");
    let mut backup_dirs: Vec<_> = std::fs::read_dir(&backup_root)
        .expect("read backup root after second backup")
        .map(|entry| entry.expect("read backup dir entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("default-") && name.ends_with(".nightfall-show")
                })
        })
        .collect();
    backup_dirs.sort();
    assert_eq!(backup_dirs.len(), 2);
    let second_backup_dir = backup_dirs
        .into_iter()
        .find(|path| path != &first_backup_dir)
        .expect("second backup directory should exist");

    assert_eq!(
        std::fs::read_to_string(first_backup_dir.join("showfile.json"))
            .expect("read original backup showfile"),
        "v1"
    );
    assert_eq!(
        std::fs::read_to_string(second_backup_dir.join("showfile.json"))
            .expect("read updated backup showfile"),
        "v2"
    );
    assert!(
        first_backup_dir
            .join("scene-objects")
            .join("object-a.robj")
            .exists(),
        "original backup should retain files from its snapshot"
    );
    assert_eq!(
        std::fs::read(
            second_backup_dir
                .join("scene-objects")
                .join("object-b.robj")
        )
        .expect("read backup bundle b"),
        b"b2"
    );
    assert!(
        !second_backup_dir
            .join("scene-objects")
            .join("object-a.robj")
            .exists(),
        "new backup should reflect files removed from source"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies show-data copy helpers skip manifests while preserving other files.
#[test]
fn copy_directory_recursive_excluding_names_omits_matching_entries() {
    let temp_root = tempfile::tempdir().expect("create temp directory");
    let source_dir = temp_root.path().join("source.nightfall-show");
    let nested_dir = source_dir.join("nested");
    let destination_dir = temp_root.path().join("destination.nightfall-show");

    std::fs::create_dir_all(&nested_dir).expect("create nested source directory");
    std::fs::write(source_dir.join("showfile.json"), b"snapshot").expect("write showfile");
    std::fs::write(
        source_dir.join(SHOWFILE_MANIFEST_FILENAME),
        b"root metadata",
    )
    .expect("write root metadata");
    std::fs::write(
        nested_dir.join(SHOWFILE_MANIFEST_FILENAME),
        b"nested metadata",
    )
    .expect("write nested metadata");
    std::fs::write(nested_dir.join("asset.bin"), b"asset").expect("write asset");

    copy_directory_recursive_excluding_names(
        &source_dir,
        &destination_dir,
        &[SHOWFILE_MANIFEST_FILENAME],
    )
    .expect("copy with excluded metadata");

    assert_eq!(
        std::fs::read(destination_dir.join("showfile.json")).expect("read copied showfile"),
        b"snapshot"
    );
    assert_eq!(
        std::fs::read(destination_dir.join("nested").join("asset.bin")).expect("read copied asset"),
        b"asset"
    );
    assert!(
        !destination_dir.join(SHOWFILE_MANIFEST_FILENAME).exists(),
        "root manifest should be skipped"
    );
    assert!(
        !destination_dir
            .join("nested")
            .join(SHOWFILE_MANIFEST_FILENAME)
            .exists(),
        "nested manifest should be skipped"
    );
}

/// Verifies show-data copies fail instead of merging into an existing destination.
#[test]
fn copy_directory_recursive_rejects_existing_destination() {
    let temp_root = tempfile::tempdir().expect("create temp directory");
    let source_dir = temp_root.path().join("source.nightfall-show");
    let destination_dir = temp_root.path().join("destination.nightfall-show");

    std::fs::create_dir_all(&source_dir).expect("create source directory");
    std::fs::write(source_dir.join("showfile.json"), b"snapshot").expect("write showfile");
    std::fs::create_dir_all(&destination_dir).expect("create destination directory");

    let error =
        copy_directory_recursive(&source_dir, &destination_dir).expect_err("copy should fail");

    assert!(
        error.contains("already exists"),
        "error should mention the existing destination: {error}"
    );
}

/// Verifies backup revision selections retain their revision and owning showfile names.
#[test]
fn showfile_revision_selection_accepts_timestamped_backup_names() {
    assert_eq!(
        ShowfileRevisionSelection::from_revision_name("default-20260707-151450")
            .expect("default revision should parse")
            .showfile_name,
        "default",
    );
    assert_eq!(
        ShowfileRevisionSelection::from_revision_name(
            "sample-show-20260707-151450-2.nightfall-show",
        )
        .expect("collision-suffixed named revision should parse")
        .showfile_name,
        "sample-show",
    );
    assert!(
        ShowfileRevisionSelection::from_revision_name("default-not-a-timestamp").is_err(),
        "invalid revision names should be rejected"
    );
}

/// Verifies named show folders back up under their own timestamped names.
#[test]
fn backup_show_data_directory_names_named_show_backups() {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-named-showfile-backup-{}-{}",
        std::process::id(),
        timestamp
    ));
    let show_data_dir = temp_root.join("sample.nightfall-show");

    std::fs::create_dir_all(&show_data_dir).expect("create named show dir");
    std::fs::write(show_data_dir.join("showfile.json"), b"named-v1").expect("write named showfile");

    backup_show_data_directory(&show_data_dir, 2).expect("backup should succeed");

    let backup_dirs =
        list_show_data_backup_directories(&show_data_dir).expect("backup directories should list");
    assert_eq!(backup_dirs.len(), 1);
    let backup_name = backup_dirs[0]
        .file_name()
        .and_then(|name| name.to_str())
        .expect("backup directory name should be utf-8");
    assert!(
        backup_name.starts_with("sample-") && backup_name.ends_with(".nightfall-show"),
        "named show backup should use sample-YYYYMMDD-HHMMSS.nightfall-show format"
    );
    assert_eq!(
        std::fs::read_to_string(backup_dirs[0].join("showfile.json"))
            .expect("read named backup showfile"),
        "named-v1"
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies backup retention removes the oldest timestamped backup snapshots.
#[test]
fn backup_show_data_directory_prunes_old_backups_to_retention_limit() {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-backup-retention-{}-{}",
        std::process::id(),
        timestamp
    ));
    let show_data_dir = temp_root.join("default.nightfall-show");

    std::fs::create_dir_all(&show_data_dir).expect("create show-data dir");
    for version in 1..=3 {
        std::fs::write(show_data_dir.join("showfile.json"), format!("v{version}"))
            .expect("write showfile version");
        backup_show_data_directory(&show_data_dir, 2).expect("backup should succeed");
    }

    let backup_dirs =
        list_show_data_backup_directories(&show_data_dir).expect("backup directories should list");
    assert_eq!(backup_dirs.len(), 2);
    let backup_versions: Vec<_> = backup_dirs
        .iter()
        .map(|backup_dir| {
            std::fs::read_to_string(backup_dir.join("showfile.json"))
                .expect("read retained backup showfile")
        })
        .collect();
    assert_eq!(backup_versions, vec!["v2", "v3"]);

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies zero backup retention means unlimited retained timestamped backups.
#[test]
fn backup_show_data_directory_retention_zero_keeps_all_backups() {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-backup-unlimited-{}-{}",
        std::process::id(),
        timestamp
    ));
    let show_data_dir = temp_root.join("default.nightfall-show");

    std::fs::create_dir_all(&show_data_dir).expect("create show-data dir");
    for version in 1..=3 {
        std::fs::write(show_data_dir.join("showfile.json"), format!("v{version}"))
            .expect("write showfile version");
        backup_show_data_directory(&show_data_dir, 0).expect("backup should succeed");
    }

    let backup_dirs =
        list_show_data_backup_directories(&show_data_dir).expect("backup directories should list");
    assert_eq!(backup_dirs.len(), 3);
    let backup_versions: Vec<_> = backup_dirs
        .iter()
        .map(|backup_dir| {
            std::fs::read_to_string(backup_dir.join("showfile.json"))
                .expect("read retained backup showfile")
        })
        .collect();
    assert_eq!(backup_versions, vec!["v1", "v2", "v3"]);

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// Verifies backup-like directories with invalid timestamp shapes are ignored safely.
#[test]
fn backup_show_data_directory_ignores_invalid_unicode_backup_names() {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    let temp_root = std::env::temp_dir().join(format!(
        "nightfall-showfile-backup-invalid-name-{}-{}",
        std::process::id(),
        timestamp
    ));
    let show_data_dir = temp_root.join("default.nightfall-show");
    let invalid_backup_dir = temp_root
        .join("backups")
        .join("default-\u{e9}234567-123456.nightfall-show");

    std::fs::create_dir_all(&show_data_dir).expect("create show-data dir");
    std::fs::create_dir_all(&invalid_backup_dir).expect("create invalid backup-like dir");
    std::fs::write(show_data_dir.join("showfile.json"), "v1").expect("write showfile version");

    backup_show_data_directory(&show_data_dir, 1).expect("backup should succeed");

    assert!(
        invalid_backup_dir.exists(),
        "invalid backup-like directory should be ignored"
    );
    assert_eq!(
        list_show_data_backup_directories(&show_data_dir)
            .expect("backup directories should list")
            .len(),
        1
    );

    std::fs::remove_dir_all(temp_root).expect("remove temp test directory");
}

/// File loading retains unavailable bindings for repair and ends the previous learning interaction.
#[cfg(all(feature = "midi", feature = "osc"))]
#[test]
fn file_load_retains_mapping_diagnostics_and_ends_learning() {
    use nightfall_actions::{ActionReference, ActionRegistry, ActionSurface};
    use nightfall_engine::controller_learning::{
        ControllerLearning, ControllerLearningCommand, LearnedControllerSource, LearnedGesture,
    };
    let _guard = crate::process_config_lock().lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let mut midi = source_world.resource::<MidiMappings>().mappings().to_vec();
    midi[0].action = ActionReference::new("missing.midi", serde_json::json!({}));
    let missing_master_uid = Uuid::new_v4();
    let master_action = ActionReference::new(
        nightfall_desk::automation_actions::MASTER_SET_ACTION_ID,
        serde_json::json!({"master_uid": missing_master_uid}),
    );
    let mut master_midi = midi[0].clone();
    master_midi.id = Uuid::new_v4();
    master_midi.channel = 0xb0;
    master_midi.note = 7;
    master_midi.velocity = None;
    master_midi.input = nightfall_input_midi::command::MidiBindingInput::Continuous;
    master_midi.action = master_action.clone();
    midi.push(master_midi);
    source_world
        .resource_mut::<MidiMappings>()
        .set_mappings(midi.clone());
    let mut osc = source_world.resource::<OscMappings>().mappings().to_vec();
    osc[0].action = ActionReference::new("missing.osc", serde_json::json!({}));
    let mut master_osc = osc[0].clone();
    master_osc.id = Uuid::new_v4();
    master_osc.address = "/missing-master".into();
    master_osc.arg_index = Some(0);
    master_osc.arg_value = None;
    master_osc.input = nightfall_input_osc::command::OscBindingInput::Continuous {
        minimum: 0.0,
        maximum: 1.0,
    };
    master_osc.action = master_action;
    osc.push(master_osc);
    source_world
        .resource_mut::<OscMappings>()
        .set_mappings(osc.clone());
    let snapshot = collect_snapshot(&mut source_world);
    std::fs::write(
        source.path().join(SHOWFILE_SNAPSHOT_FILENAME),
        serialize_showfile_snapshot_json(&snapshot).unwrap(),
    )
    .unwrap();

    let mut learning_app = App::new();
    learning_app.add_plugins(nightfall_engine::EnginePlugin);
    learning_app.init_resource::<PendingCommandBuffer>();
    learning_app.add_plugins(ClientBridgePlugin);
    let session_id = Uuid::new_v4();
    let command = CommandEnvelope::new(
        ControllerLearningCommand::Begin {
            session_id,
            surface: ActionSurface::Midi,
        },
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    );
    learning_app
        .world_mut()
        .resource_mut::<CommandTracker>()
        .register(&command)
        .unwrap();
    learning_app.world_mut().write_message(command);
    learning_app.update();
    let held = LearnedControllerSource {
        surface: ActionSurface::Midi,
        selector: serde_json::json!({"note":42}),
        label: "Held button".into(),
        gesture: LearnedGesture::Press,
    };
    assert!(
        learning_app
            .world_mut()
            .resource_mut::<ControllerLearning>()
            .capture(held.clone())
    );
    let mut world = setup_world();
    world.insert_resource(
        learning_app
            .world_mut()
            .remove_resource::<ControllerLearning>()
            .unwrap(),
    );
    load::load_showfile_into_world(
        &mut world,
        Some("Mapping restore"),
        source.path().to_path_buf(),
    )
    .unwrap();
    assert_eq!(world.resource::<MidiMappings>().mappings(), midi);
    assert_eq!(world.resource::<OscMappings>().mappings(), osc);
    let mut registration_app = App::new();
    registration_app.init_resource::<ActionRegistry>();
    nightfall_desk::automation_actions::register_desk_actions(&mut registration_app);
    let registry = registration_app
        .world_mut()
        .remove_resource::<ActionRegistry>()
        .unwrap();
    assert_eq!(
        world
            .resource::<MidiMappings>()
            .validation_errors(&registry)[0]
            .as_ref()
            .unwrap()
            .code,
        "action.not_registered"
    );
    assert_eq!(
        world.resource::<OscMappings>().validation_errors(&registry)[0]
            .as_ref()
            .unwrap()
            .code,
        "action.not_registered"
    );
    for restored in [false, true] {
        if restored {
            let mut master = Master::default();
            master.identifiers.uid = missing_master_uid;
            master.identifiers.id = 99;
            world
                .resource_mut::<DataProvider<Master>>()
                .add(master)
                .unwrap();
        }
        let midi_mappings = world.resource::<MidiMappings>();
        let osc_mappings = world.resource::<OscMappings>();
        let errors = [
            midi_mappings.target_validation_errors(
                &world,
                &registry,
                &midi_mappings.validation_errors(&registry),
            ),
            osc_mappings.target_validation_errors(
                &world,
                &registry,
                &osc_mappings.validation_errors(&registry),
            ),
        ];
        for errors in errors {
            assert_eq!(errors[0].as_ref().unwrap().code, "action.not_registered");
            if restored {
                assert!(errors[1].is_none());
            } else {
                assert_eq!(errors[1].as_ref().unwrap().code, "master.not_found");
            }
        }
        assert_eq!(midi_mappings.mappings(), midi);
        assert_eq!(osc_mappings.mappings(), osc);
    }
    let mut learning = world.resource_mut::<ControllerLearning>();
    assert_eq!(
        learning
            .captured(session_id, ActionSurface::Midi)
            .unwrap_err()
            .code,
        "mapping.learning_expired"
    );
    assert!(learning.capture(LearnedControllerSource {
        gesture: LearnedGesture::Release,
        ..held
    }));
    nightfall::clear_active_show_data_dir();
    nightfall::set_nightfall_data_dir(None);
}

/// Verify loading a snapshot replaces stale definitions and settings in an existing world.
#[test]
fn load_in_place_replaces_stale_world_state() {
    let mut source_world = setup_world();
    seed_world(&mut source_world);
    let source_snapshot = collect_snapshot(&mut source_world);

    let mut target_world = setup_world();
    seed_world(&mut target_world);

    let stale_fixture = Fixture {
        identifiers: identifiers(99, "stale-fixture"),
        elements: vec![FixtureElement::default()],
        ..Default::default()
    };
    target_world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(stale_fixture)
        .expect("stale fixture should be added");

    target_world
        .resource::<GlobalVariables>()
        .set("stale-only", VariableValue::Float(7.0));

    let stale_clip = Clip {
        identifiers: identifiers(199, "stale-clip"),
        ..Default::default()
    };
    target_world.spawn(stale_clip);

    let stale_blueprint = Blueprint {
        identifiers: identifiers(299, "stale-blueprint"),
        ..Default::default()
    };
    target_world
        .resource_mut::<DataProvider<Blueprint>>()
        .add(stale_blueprint)
        .expect("stale blueprint should be added");
    {
        let mut stale_settings = target_world.resource_mut::<DeskSettings>();
        stale_settings.programmer_auto_select = false;
        stale_settings.audio_device = Some("stale-speaker".to_string());
        stale_settings.selection_flatten_policy = SelectionFlattenPolicy::Silent;
    }
    {
        let mut stale_settings = target_world.resource_mut::<IoRuntimeSettings>();
        stale_settings.network_interface = Some("stale0".to_string());
        stale_settings.input_signal_loss_policy = InputSignalLossPolicy::Hold;
    }

    load_snapshot_in_place(&mut target_world, source_snapshot);
    let restored_snapshot = collect_snapshot(&mut target_world);

    assert_eq!(restored_snapshot.fixtures.len(), 1);
    assert_eq!(restored_snapshot.clips.len(), 1);
    assert_eq!(restored_snapshot.blueprints.len(), 1);
    assert_eq!(restored_snapshot.fixtures[0].identifiers.id, 1);
    assert_eq!(restored_snapshot.clips[0].identifiers.id, 11);
    assert_eq!(restored_snapshot.blueprints[0].identifiers.id, 6);
    assert!(!restored_snapshot.variables.contains_key("stale-only"));
    assert!(restored_snapshot.settings.programmer_auto_select);
    assert_eq!(
        restored_snapshot.io_settings.network_interface.as_deref(),
        Some("en0")
    );
    assert_eq!(
        restored_snapshot.settings.audio_device.as_deref(),
        Some("Built-in Output")
    );
    assert_eq!(
        restored_snapshot.io_settings.input_signal_loss_policy,
        InputSignalLossPolicy::ClearAfterTimeout {}
    );
    assert_eq!(
        restored_snapshot.io_settings.input_signal_loss_timeout,
        std::time::Duration::from_millis(777)
    );
    assert_eq!(
        restored_snapshot.settings.selection_flatten_policy,
        SelectionFlattenPolicy::Prompt
    );

    let mut transport_layer_query = target_world.query_filtered::<(), With<TransportInputLayer>>();
    assert_eq!(transport_layer_query.iter(&target_world).count(), 1);
    let mut manual_layer_query = target_world.query_filtered::<(), With<ManualAssertionLayer>>();
    assert_eq!(manual_layer_query.iter(&target_world).count(), 1);
}

#[test]
fn load_in_place_validation_failure_preserves_existing_world_state() {
    let mut target_world = setup_world();
    seed_world(&mut target_world);
    let baseline_snapshot = collect_snapshot(&mut target_world);

    let fixture_a = Fixture {
        identifiers: identifiers(401, "fixture-a"),
        make: "Acme".to_string(),
        model: "Beam 200".to_string(),
        mode: "16ch".to_string(),
        elements: vec![FixtureElement {
            label: "Element A".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Red,
                native_unit: Attribute::Red.native_unit(),
                value_polarity: Attribute::Red.value_polarity(),
                ..Default::default()
            }],
        }],
        layout: None,
        library_asset_etag: Some("v1".to_string()),
        ..Default::default()
    };
    let fixture_b = Fixture {
        identifiers: identifiers(402, "fixture-b"),
        make: "Acme".to_string(),
        model: "Beam 200".to_string(),
        mode: "16ch".to_string(),
        elements: vec![FixtureElement {
            label: "Element B".to_string(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Blue,
                native_unit: Attribute::Blue.native_unit(),
                value_polarity: Attribute::Blue.value_polarity(),
                ..Default::default()
            }],
        }],
        layout: None,
        library_asset_etag: Some("v2".to_string()),
        ..Default::default()
    };

    let invalid_snapshot = ShowfileSnapshot {
        control_assignments: Vec::new(),
        metadata: ShowfileMetadata::default(),
        fixtures: vec![fixture_a, fixture_b],
        variables: HashMap::new(),
        bindings: BindingsSnapshot {
            input: vec![],
            output: vec![],
            disabled: vec![],
        },
        #[cfg(feature = "midi")]
        midi_mappings: vec![],
        #[cfg(feature = "osc")]
        osc_mappings: vec![],
        scene_objects: vec![],
        cues: vec![],
        sequences: vec![],
        groups: vec![],
        masters: vec![],
        blueprints: vec![],
        color_paths: vec![],
        color_path_defaults: vec![],
        fx: vec![],
        fx_module: vec![],
        step_fx: vec![],
        flows: vec![],
        timecodes: vec![],
        timelines: vec![],
        clips: vec![],
        settings: DeskSettings::default(),
        io_settings: IoRuntimeSettings::default(),
    };

    let result = try_load_snapshot_in_place(&mut target_world, invalid_snapshot);
    assert!(result.is_err(), "invalid snapshot should fail validation");
    let error = result.expect_err("expected fixture version validation error");
    assert!(error.contains("multiple versions of fixture asset"));

    let after_snapshot = collect_snapshot(&mut target_world);
    let baseline_value = serde_json::to_value(baseline_snapshot).expect("snapshot to value");
    let after_value = serde_json::to_value(after_snapshot).expect("snapshot to value");
    assert_eq!(after_value, baseline_value);
}

/// Verify restored fixtures initialize their virtual intensity parameter to full output.
#[test]
fn load_initializes_virtual_intensity_to_full_scale() {
    let mut world = setup_world();
    let fixture_uid = Uuid::from_u128(42);

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: fixture_uid,
            label: "fixture-vdim".to_string(),
        },
        elements: vec![FixtureElement {
            label: "Element 1".to_string(),
            parameters: vec![
                ParameterMetadata {
                    attribute: Attribute::VirtualIntensity,
                    native_unit: Attribute::VirtualIntensity.native_unit(),
                    value_polarity: Attribute::VirtualIntensity.value_polarity(),
                    max: 255.0,
                    ..Default::default()
                },
                ParameterMetadata {
                    attribute: Attribute::Red,
                    native_unit: Attribute::Red.native_unit(),
                    value_polarity: Attribute::Red.value_polarity(),
                    ..Default::default()
                },
            ],
        }],
        ..Default::default()
    };

    apply_snapshot(
        &mut world,
        ShowfileSnapshot {
            control_assignments: Vec::new(),
            metadata: ShowfileMetadata::default(),
            fixtures: vec![fixture],
            variables: HashMap::new(),
            settings: DeskSettings::default(),
            io_settings: IoRuntimeSettings::default(),
            bindings: BindingsSnapshot {
                input: vec![],
                output: vec![],
                disabled: vec![],
            },
            #[cfg(feature = "midi")]
            midi_mappings: vec![],
            #[cfg(feature = "osc")]
            osc_mappings: vec![],
            scene_objects: vec![],
            cues: vec![],
            sequences: vec![],
            groups: vec![],
            masters: vec![],
            blueprints: vec![],
            color_paths: vec![],
            color_path_defaults: vec![],
            fx: vec![],
            fx_module: vec![],
            step_fx: vec![],
            flows: vec![],
            timecodes: vec![],
            timelines: vec![],
            clips: vec![],
        },
    );

    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };

    let vdim_entity = {
        let fixture_data_provider = world.resource::<FixtureDataProviderExt>();
        fixture_data_provider
            .try_parameter_for_element_attribute(&fixture_ref, &Attribute::VirtualIntensity)
            .expect("virtual intensity parameter should exist")
            .entity()
    };

    let red_entity = {
        let fixture_data_provider = world.resource::<FixtureDataProviderExt>();
        fixture_data_provider
            .try_parameter_for_element_attribute(&fixture_ref, &Attribute::Red)
            .expect("red parameter should exist")
            .entity()
    };

    let vdim = world
        .get::<Parameter>(vdim_entity)
        .expect("virtual intensity component should exist");
    assert_eq!(vdim.values.default_value, 255.0);
    assert_eq!(vdim.values.current_value, 255.0);

    let red = world
        .get::<Parameter>(red_entity)
        .expect("red component should exist");
    assert_eq!(red.values.default_value, 0.0);
    assert_eq!(red.values.current_value, 0.0);
}

#[test]
fn load_materializes_timecodes_and_timelines() {
    let mut world = setup_world();
    let timecode_uid = Uuid::new_v4();
    let timeline_uid = Uuid::new_v4();

    let timecode = Timecode {
        identifiers: Identifiers {
            id: 11,
            uid: timecode_uid,
            label: "tc-11".to_string(),
        },
        ..Default::default()
    };

    let timeline = Timeline {
        identifiers: Identifiers {
            id: 22,
            uid: timeline_uid,
            label: "tl-22".to_string(),
        },
        timecode_uid,
        ..Default::default()
    };

    apply_snapshot(
        &mut world,
        ShowfileSnapshot {
            control_assignments: Vec::new(),
            metadata: ShowfileMetadata::default(),
            fixtures: vec![],
            variables: HashMap::new(),
            settings: DeskSettings::default(),
            io_settings: IoRuntimeSettings::default(),
            bindings: BindingsSnapshot {
                input: vec![],
                output: vec![],
                disabled: vec![],
            },
            #[cfg(feature = "midi")]
            midi_mappings: vec![],
            #[cfg(feature = "osc")]
            osc_mappings: vec![],
            scene_objects: vec![],
            cues: vec![],
            sequences: vec![],
            groups: vec![],
            masters: vec![],
            blueprints: vec![],
            color_paths: vec![],
            color_path_defaults: vec![],
            fx: vec![],
            fx_module: vec![],
            step_fx: vec![],
            flows: vec![],
            timecodes: vec![timecode],
            timelines: vec![timeline],
            clips: vec![],
        },
    );

    let timecode_generators = world.query::<&TimecodeGenerator>().iter(&world).count();
    let materialized_timelines = world.query::<&MaterializedTimeline>().iter(&world).count();

    assert_eq!(timecode_generators, 1);
    assert_eq!(materialized_timelines, 1);
}
