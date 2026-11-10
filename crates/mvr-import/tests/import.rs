// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Imports hand-written MVR files with a synthetic GDTF, and the public samples when
//! `NIGHTFALL_MVR_SAMPLES_DIR` is set.

use std::io::{Cursor, Write};
use std::path::Path;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::Group;
use nightfall_engine::prelude::*;
use nightfall_fixture_library::FixtureLibraryManager;
use nightfall_fixture_library::testing::{ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec};
use nightfall_fixtures::fixture_events::crud_events;
use nightfall_fixtures::placement::PlacementPosition;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::websocket::SuppressFixtureChangedSnapshot;
use nightfall_fixtures::{FixtureCommand, RouteEndpoint};
use nightfall_io::prelude::*;
use nightfall_mvr_import::commands::expand_rig_import_commits;
use nightfall_mvr_import::geometry::{Mesh, read_gltf};
use nightfall_mvr_import::plan::{ShowFixture, ShowFixtures, ShowGroup, plan_import};
use nightfall_mvr_import::prelude::*;
use nightfall_mvr_import::rig::{RigPatch, RigTypeSource, read_rig};
use nightfall_programming::prelude::GroupCommand;
use nightfall_scene_objects::prelude::*;
use uuid::Uuid;
use zip::write::SimpleFileOptions;

/// UUID of the hung spot in the test rig.
const SPOT_UUID: &str = "8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6";
/// UUID of the floor spot in the test rig.
const FLOOR_UUID: &str = "4AB19462-A6E3-4C3B-B25A-D8099F78170C";
/// UUID of the fixture whose type the file leaves out.
const MISSING_UUID: &str = "77BCDE16-95A6-4725-9D04-16A0BD67CD1A";

/// Builds a two-channel spot GDTF.
fn spot_gdtf() -> Vec<u8> {
    GdtfBuilder::new("Test", "Spot")
        .geometry(GeometrySpec::generic("Base"))
        .mode(
            ModeSpec::new("Standard", "Base")
                .channel(ChannelSpec::new("Base", "Dimmer", &[1]))
                .channel(ChannelSpec::new("Base", "Pan", &[2])),
        )
        .to_bytes()
}

/// Builds an MVR archive with a hung spot patched at 1.1 with ID 101, a floor spot with no
/// ID patched at 1.11, and a fixture whose GDTF is not in the file.
fn rig_bytes() -> Vec<u8> {
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="Test">
  <Scene>
    <AUXData><Position uuid="0E2DC6B1-7C42-4B3F-9D0B-7D1C8C2F2A11" name="LX 1"/></AUXData>
    <Layers>
      <Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
        <ChildList>
          <Fixture uuid="{SPOT_UUID}" name="Spot">
            <Matrix>{{1,0,0}}{{0,-1,0}}{{0,0,-1}}{{1000,2000,6000}}</Matrix>
            <GDTFSpec>Test@Spot</GDTFSpec>
            <GDTFMode>Standard</GDTFMode>
            <Position>0E2DC6B1-7C42-4B3F-9D0B-7D1C8C2F2A11</Position>
            <FixtureID>101</FixtureID>
            <Addresses><Address break="0">1.1</Address></Addresses>
          </Fixture>
          <Fixture uuid="{FLOOR_UUID}" name="Floor left">
            <Matrix>{{1,0,0}}{{0,1,0}}{{0,0,1}}{{-3000,0,0}}</Matrix>
            <GDTFSpec>Test@Spot.gdtf</GDTFSpec>
            <GDTFMode>Standard</GDTFMode>
            <FixtureID>0</FixtureID>
            <Addresses><Address break="0">11</Address></Addresses>
          </Fixture>
          <Fixture uuid="{MISSING_UUID}" name="Unknown">
            <GDTFSpec>Other@Wash.gdtf</GDTFSpec>
            <GDTFMode>Mode 1</GDTFMode>
            <Addresses><Address break="0">0</Address></Addresses>
          </Fixture>
        </ChildList>
      </Layer>
    </Layers>
  </Scene>
</GeneralSceneDescription>"#
    );
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, contents) in [
        ("GeneralSceneDescription.xml", xml.into_bytes()),
        ("Test@Spot.gdtf", spot_gdtf()),
    ] {
        writer
            .start_file(name, SimpleFileOptions::default())
            .expect("start file");
        writer.write_all(&contents).expect("write file");
    }
    writer.finish().expect("finish archive").into_inner()
}

/// Opens a fixture library on an empty folder with an empty show package folder.
fn empty_library(root: &Path) -> FixtureLibraryManager {
    std::fs::create_dir_all(root.join("show")).unwrap();
    let mut library = FixtureLibraryManager::with_path(root.join("library")).unwrap();
    library
        .set_showfile_directory(Some(root.join("show")))
        .unwrap();
    library
}

/// Parses a UUID constant.
fn uuid(text: &str) -> Uuid {
    Uuid::parse_str(text).unwrap()
}

/// Reading finds both GDTF spellings as one type, converts placement and patch, and notes
/// the type the file leaves out.
#[test]
fn reads_rig_fixtures_and_types() {
    let rig = read_rig(Cursor::new(rig_bytes()), "test.mvr").unwrap();
    assert_eq!(rig.provider.as_deref(), Some("Test"));
    assert_eq!(rig.fixtures.len(), 3);
    let spot = &rig.fixtures[0];
    assert_eq!(spot.uid, uuid(SPOT_UUID));
    assert_eq!(spot.file_id, Some(101));
    assert_eq!(spot.hanging_position.as_deref(), Some("LX 1"));
    assert_eq!(
        spot.placement.position,
        PlacementPosition {
            x: 1.0,
            y: 6.0,
            z: -2.0
        }
    );
    assert_eq!(spot.placement.rotation.x, 180.0);
    assert_eq!(rig.fixtures[1].file_id, None);
    assert_eq!(rig.fixtures[1].patch[0].address, 11);
    assert!(rig.fixtures[2].patch.is_empty());

    let specs: Vec<_> = rig
        .fixture_types
        .iter()
        .map(|ty| ty.spec.as_str())
        .collect();
    assert_eq!(specs, ["Test@Spot", "Test@Spot.gdtf", "Other@Wash.gdtf"]);
    match &rig.fixture_types[0].source {
        RigTypeSource::Embedded(gdtf) => {
            assert_eq!((gdtf.make.as_str(), gdtf.model.as_str()), ("Test", "Spot"));
            assert_eq!(gdtf.modes, ["Standard"]);
        }
        other => panic!("expected an embedded GDTF, got {other:?}"),
    }
    assert!(matches!(
        rig.fixture_types[2].source,
        RigTypeSource::Missing
    ));
}

/// The preview numbers fixtures, takes types from the file and flags the missing one.
#[test]
fn preview_numbers_and_flags_fixtures() {
    let root = tempfile::tempdir().unwrap();
    let library = empty_library(root.path());
    let rig = read_rig(Cursor::new(rig_bytes()), "test.mvr").unwrap();
    let show = ShowFixtures {
        ids: [101].into_iter().collect(),
        ..Default::default()
    };
    let plan = plan_import(
        Uuid::new_v4(),
        &rig,
        &library,
        &show,
        &RigImportOptions::default(),
    );
    let preview = &plan.preview;
    assert_eq!(preview.new_fixtures, 2);
    assert_eq!(preview.fixture_types[0].status, FixtureTypeStatus::Embedded);
    assert_eq!(preview.fixture_types[2].status, FixtureTypeStatus::Missing);
    let statuses: Vec<_> = preview.fixtures.iter().map(|f| f.status).collect();
    assert_eq!(
        statuses,
        [
            FixtureImportStatus::New,
            FixtureImportStatus::New,
            FixtureImportStatus::NeedsFixtureType
        ]
    );
    // 101 is taken, so both fixtures are numbered after it.
    assert_eq!(preview.fixtures[0].fixture_id, Some(102));
    assert_eq!(preview.fixtures[1].fixture_id, Some(103));
    assert_eq!(
        preview.fixtures[0].label, "",
        "the name only repeats the model"
    );
    assert_eq!(preview.fixtures[1].label, "Floor left");
}

/// Builds the show as it is after importing the test rig, with the spot since moved and
/// repatched by hand and a group already named "LX 1".
fn show_after_import(rig: &nightfall_mvr_import::rig::RigFile) -> ShowFixtures {
    let spot = rig
        .fixtures
        .iter()
        .find(|fixture| fixture.uid == uuid(SPOT_UUID))
        .unwrap();
    let floor = rig
        .fixtures
        .iter()
        .find(|fixture| fixture.uid == uuid(FLOOR_UUID))
        .unwrap();
    let mut moved = spot.placement.clone();
    moved.position.y -= 0.5;
    let show_fixture = |id: u32, fixture: &nightfall_mvr_import::rig::RigFixture| ShowFixture {
        id,
        label: String::new(),
        make: "Test".into(),
        model: "Spot".into(),
        mode: "Standard".into(),
        placement: fixture.placement.clone(),
        patch: fixture.patch.clone(),
        shared_patch: false,
    };
    let mut show = ShowFixtures::default();
    show.ids.extend([101, 102]);
    show.fixtures.insert(
        spot.uid,
        ShowFixture {
            placement: moved,
            patch: vec![RigPatch {
                dmx_break: 1,
                universe: 2,
                address: 1,
            }],
            ..show_fixture(101, spot)
        },
    );
    show.fixtures.insert(
        floor.uid,
        ShowFixture {
            label: "Floor left".into(),
            ..show_fixture(102, floor)
        },
    );
    show.groups.push(ShowGroup {
        id: 7,
        uid: Uuid::new_v4(),
        label: "LX 1".into(),
        members: Some(Vec::new()),
    });
    show
}

/// Importing the same file again matches fixtures by UUID: a fixture moved and repatched
/// since is updated back to the file, an untouched one is unchanged, and the group with the
/// hanging position's name is refreshed in place.
#[test]
fn reimport_updates_changed_fixtures() {
    let root = tempfile::tempdir().unwrap();
    let library = empty_library(root.path());
    let rig = read_rig(Cursor::new(rig_bytes()), "test.mvr").unwrap();
    let show = show_after_import(&rig);
    let plan = plan_import(
        Uuid::new_v4(),
        &rig,
        &library,
        &show,
        &RigImportOptions::default(),
    );
    let preview = &plan.preview;
    let statuses: Vec<_> = preview.fixtures.iter().map(|f| f.status).collect();
    assert_eq!(
        statuses,
        [
            FixtureImportStatus::Update,
            FixtureImportStatus::Unchanged,
            FixtureImportStatus::NeedsFixtureType
        ]
    );
    assert_eq!(preview.fixtures[0].changes, ["moved", "repatched"]);
    assert_eq!(preview.fixtures[0].fixture_id, Some(101));
    assert_eq!((preview.new_fixtures, preview.updated_fixtures), (0, 1));
    assert_eq!(plan.updates.len(), 1);
    assert!(plan.updates[0].repatch);
    assert_eq!(preview.group_source, RigGroupSource::HangingPositions);
    assert_eq!(preview.groups.len(), 1);
    assert_eq!(preview.groups[0].group_id, 7);
    assert!(preview.groups[0].existing);

    let options = RigImportOptions {
        update_existing: false,
        groups: RigGroupSource::Layers,
        ..RigImportOptions::default()
    };
    let plan = plan_import(Uuid::new_v4(), &rig, &library, &show, &options);
    assert_eq!(
        plan.preview.fixtures[0].status,
        FixtureImportStatus::AlreadyInShow
    );
    assert!(plan.updates.is_empty());
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups[0].name, "Rig");
    assert_eq!(
        plan.groups[0].id, 8,
        "new groups go after the highest group ID"
    );
    assert_eq!(plan.groups[0].members.len(), 2);
}

/// Builds an app that expands rig import commits and runs fixture commands.
fn import_app(library: FixtureLibraryManager, sessions: RigImportSessions) -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
    app.add_message::<SuppressFixtureChangedSnapshot>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<PendingCommandBuffer>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<nightfall_scene_objects::prelude::SceneObjectDataProvider>();
    app.init_resource::<InputRoutes>();
    app.init_resource::<OutputRoutes>();
    app.init_resource::<DisabledRoutes>();
    app.init_resource::<RouteValidationSettings>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<ConsoleDmxUniverses>();
    let (sender, _receiver) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(sender));
    app.insert_resource(library);
    app.insert_resource(sessions);
    app.add_systems(Update, (expand_rig_import_commits, crud_events).chain());
    app
}

/// A commit installs the file's GDTF into the show package and turns into one fixture
/// command and one group store. The fixture command adds the fixtures with their UUIDs,
/// placements and patch, and the group holds the fixture hung on LX 1.
#[test]
fn commit_adds_fixtures_with_patch_and_placement() {
    let root = tempfile::tempdir().unwrap();
    let sessions = RigImportSessions::default();
    let session = sessions.insert(read_rig(Cursor::new(rig_bytes()), "test.mvr").unwrap());
    let mut app = import_app(empty_library(root.path()), sessions);

    let envelope = CommandEnvelope::new(
        RigImportCommand::Commit {
            session,
            options: RigImportOptions::default(),
        },
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    );
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            envelope.command_id,
            envelope.undo_id,
            Box::new(envelope.command.clone()),
        ));
    app.update();

    let installed: Vec<_> = std::fs::read_dir(root.path().join("show/fixtures"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(installed.len(), 1, "{installed:?}");
    assert!(installed[0].starts_with("Test@Spot-"));

    let mut queued = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    assert_eq!(queued.len(), 2);
    let group = queued
        .pop()
        .unwrap()
        .payload
        .as_any()
        .downcast_ref::<GroupCommand>()
        .cloned()
        .expect("a group command");
    let GroupCommand::StoreGroup(group) = group else {
        panic!("expected a group store, got {group:?}");
    };
    assert_eq!(group.identifiers.label, "LX 1");
    assert_eq!(group.identifiers.id, 1);
    let queued = queued.remove(0);
    assert_eq!(queued.command_id, envelope.command_id);
    assert_eq!(queued.undo_id, envelope.undo_id);
    let command = queued
        .payload
        .as_any()
        .downcast_ref::<FixtureCommand>()
        .expect("a fixture command")
        .clone();
    let FixtureCommand::PatchRig {
        add: fixtures,
        update,
        routes,
    } = &command
    else {
        panic!("expected PatchRig, got {command:?}");
    };
    assert!(update.is_empty());
    assert_eq!(fixtures.len(), 2);
    assert_eq!(fixtures[0].identifiers.uid, uuid(SPOT_UUID));
    assert_eq!(fixtures[0].identifiers.id, 101);
    assert_eq!(fixtures[0].placement.rotation.x, 180.0);
    assert_eq!(fixtures[1].identifiers.id, 102);
    assert_eq!(routes.len(), 2);
    assert_eq!(
        routes[1].target,
        RouteEndpoint::Console {
            universe: Some(DmxRange::single(1)),
            address: Some(11)
        }
    );

    let dispatched = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&dispatched)
        .unwrap();
    app.world_mut().write_message(dispatched);
    app.update();
    let provider = app.world().resource::<FixtureDataProviderExt>();
    let spot = provider.inner.get(uuid(SPOT_UUID)).expect("spot imported");
    assert_eq!(spot.make, "Test");
    assert_eq!(spot.mode, "Standard");
    assert_eq!(app.world().resource::<OutputRoutes>().routes.len(), 2);
}

/// UUID of the truss in the scenery rig.
const TRUSS_UUID: &str = "1F0C7A52-3C9B-4E0D-8B5A-2B1E3D4C5F61";
/// UUID of the venue layer in the scenery rig.
const VENUE_UUID: &str = "6A7B8C9D-0E1F-4A2B-9C3D-4E5F6A7B8C9D";

/// Builds an MVR archive with one unnamed truss, turned a quarter in plan and stretched to
/// twice its model's length, and a venue layer holding a set piece and a video screen that
/// share one model: a single triangle.
fn scenery_rig_bytes() -> Vec<u8> {
    let triangle = Mesh {
        positions: vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0], [0.0, 0.0, 1000.0]],
        indices: vec![0, 1, 2],
    };
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="Test">
  <Scene>
    <Layers>
      <Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rigging">
        <ChildList>
          <Truss uuid="{TRUSS_UUID}" name="">
            <Matrix>{{0,2,0}}{{-1,0,0}}{{0,0,1}}{{1000,2000,6000}}</Matrix>
            <Geometries><Geometry3D fileName="piece.glb"/></Geometries>
          </Truss>
        </ChildList>
      </Layer>
      <Layer uuid="{VENUE_UUID}" name="Venue">
        <ChildList>
          <SceneObject uuid="0B6E2E4A-1C77-4F55-A1F0-0F1E2D3C4B5A" name="Riser">
            <Geometries><Geometry3D fileName="piece.glb"/></Geometries>
          </SceneObject>
          <VideoScreen uuid="5D4C3B2A-1F0E-4D9C-8B7A-6F5E4D3C2B1A" name="Screen">
            <Matrix>{{1,0,0}}{{0,1,0}}{{0,0,1}}{{0,5000,0}}</Matrix>
            <Geometries><Geometry3D fileName="piece.glb"/></Geometries>
          </VideoScreen>
        </ChildList>
      </Layer>
    </Layers>
  </Scene>
</GeneralSceneDescription>"#
    );
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, contents) in [
        ("GeneralSceneDescription.xml", xml.into_bytes()),
        ("piece.glb", triangle.to_glb()),
    ] {
        writer
            .start_file(name, SimpleFileOptions::default())
            .expect("start file");
        writer.write_all(&contents).expect("write file");
    }
    writer.finish().expect("finish archive").into_inner()
}

/// The truss becomes its own scene object, placed by its rotation with its stretch baked
/// into the model, while the venue's two pieces merge into one object drawn in world space.
/// A second import of the same file changes nothing, a moved truss is put back, and turning
/// scenery off skips it all.
#[test]
fn plans_scenery_objects() {
    let rig = read_rig(Cursor::new(scenery_rig_bytes()), "scenery.mvr").unwrap();
    assert_eq!(rig.scenery.len(), 2, "{:#?}", rig.warnings);
    let truss = &rig.scenery[0];
    assert_eq!(truss.uid, uuid(TRUSS_UUID));
    assert_eq!(truss.kind, RigSceneryKind::Truss);
    assert_eq!(
        truss.placement.position,
        PlacementPosition {
            x: 1.0,
            y: 6.0,
            z: -2.0
        }
    );
    assert_eq!(truss.placement.rotation.y, 90.0);
    let local = read_gltf(
        &nightfall_object_library::manager::extract_model_from_bundle(
            &truss.model.as_ref().unwrap().path,
        )
        .unwrap(),
    )
    .unwrap();
    let stretched = local.positions[1];
    assert!(
        (stretched[0] - 2000.0).abs() < 0.5 && stretched[1].abs() < 0.5,
        "{stretched:?}"
    );
    let venue = &rig.scenery[1];
    assert_eq!(venue.uid, uuid(VENUE_UUID));
    assert_eq!(venue.kind, RigSceneryKind::Layer);
    assert_eq!(venue.model.as_ref().unwrap().triangles, 2);

    let root = tempfile::tempdir().unwrap();
    let library = empty_library(root.path());
    let mut show = ShowFixtures::default();
    show.scenery.ids.insert(4);
    let options = RigImportOptions::default();
    let plan = plan_import(Uuid::new_v4(), &rig, &library, &show, &options);
    let rows: Vec<_> = plan
        .preview
        .scenery
        .iter()
        .map(|row| (row.label.as_str(), row.scene_object_id, row.status))
        .collect();
    assert_eq!(
        rows,
        [
            ("Truss 1", Some(5), SceneryImportStatus::New),
            ("Venue", Some(6), SceneryImportStatus::New),
        ]
    );
    assert_eq!(plan.preview.scenery_changes, 2);

    show.apply(&rig, &plan);
    let again = plan_import(Uuid::new_v4(), &rig, &library, &show, &options);
    assert!(again.is_empty());
    assert!(
        again
            .preview
            .scenery
            .iter()
            .all(|row| row.status == SceneryImportStatus::Unchanged)
    );

    show.scenery
        .objects
        .get_mut(&truss.uid)
        .unwrap()
        .placement
        .position
        .x += 1.0;
    let moved = plan_import(Uuid::new_v4(), &rig, &library, &show, &options);
    assert_eq!(moved.scenery.objects.len(), 1);
    assert_eq!(moved.preview.scenery[0].status, SceneryImportStatus::Update);
    assert_eq!(moved.preview.scenery[0].changes, ["moved"]);

    let skipped = plan_import(
        Uuid::new_v4(),
        &rig,
        &library,
        &ShowFixtures::default(),
        &RigImportOptions {
            scenery: false,
            ..RigImportOptions::default()
        },
    );
    assert!(skipped.scenery.objects.is_empty());
    assert!(
        skipped
            .preview
            .scenery
            .iter()
            .all(|row| row.status == SceneryImportStatus::Skipped)
    );
}

/// Opens one of the public samples, or returns `None` when they were not downloaded.
fn sample(name: &str) -> Option<nightfall_mvr_import::rig::RigFile> {
    let dir = std::env::var_os("NIGHTFALL_MVR_SAMPLES_DIR")?;
    let path = Path::new(&dir).join(name);
    Some(nightfall_mvr_import::rig::read_rig_file(&path, name).expect("sample reads"))
}

/// The Capture demo show plans 76 new fixtures from five embedded types, keeping the
/// file's unique IDs and patching every fixture.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn plans_capture_demo_show() {
    let rig = sample("capture_demo_show.mvr").expect("NIGHTFALL_MVR_SAMPLES_DIR is set");
    let root = tempfile::tempdir().unwrap();
    let library = empty_library(root.path());
    let plan = plan_import(
        Uuid::new_v4(),
        &rig,
        &library,
        &ShowFixtures::default(),
        &RigImportOptions::default(),
    );
    let not_new: Vec<_> = plan
        .preview
        .fixtures
        .iter()
        .filter(|fixture| fixture.status != FixtureImportStatus::New)
        .map(|fixture| (&fixture.name, fixture.status, &fixture.warnings))
        .collect();
    assert!(
        not_new.is_empty(),
        "{not_new:#?}\n{:#?}",
        plan.preview.fixture_types
    );
    assert_eq!(plan.preview.new_fixtures, 76);
    assert_eq!(plan.preview.fixture_types.len(), 5);
    assert!(
        plan.preview
            .fixture_types
            .iter()
            .all(|ty| ty.status == FixtureTypeStatus::Embedded)
    );
    // The demo show's GDTFs are cut down to their descriptions, with no model files.
    assert!(
        plan.preview
            .fixture_types
            .iter()
            .all(|ty| ty.missing_3d_model)
    );
    for (planned, fixture) in plan.fixtures.iter().zip(&rig.fixtures) {
        assert_eq!(Some(planned.id), fixture.file_id);
        assert!(!fixture.patch.is_empty());
    }
}

/// The Vectorworks plan imports its 72 unnumbered, unpatched fixtures numbered from 1.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn plans_vectorworks_scene_objects() {
    let rig = sample("scene_objects.mvr").expect("NIGHTFALL_MVR_SAMPLES_DIR is set");
    let root = tempfile::tempdir().unwrap();
    let library = empty_library(root.path());
    let plan = plan_import(
        Uuid::new_v4(),
        &rig,
        &library,
        &ShowFixtures::default(),
        &RigImportOptions::default(),
    );
    assert_eq!(
        plan.preview.new_fixtures, 72,
        "{:#?}",
        plan.preview.warnings
    );
    let ids: Vec<u32> = plan.fixtures.iter().map(|planned| planned.id).collect();
    assert_eq!(ids, (1..=72).collect::<Vec<_>>());
}

/// Both public samples carry trusses or scenery with readable models: Capture's trusses
/// come out as separate objects of truss length, and every model converts without
/// warnings.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn reads_sample_scenery() {
    for name in ["capture_demo_show.mvr", "scene_objects.mvr"] {
        let rig = sample(name).expect("NIGHTFALL_MVR_SAMPLES_DIR is set");
        assert!(!rig.scenery.is_empty(), "{name} has scenery");
        for scenery in &rig.scenery {
            assert!(
                scenery.model.is_some(),
                "{name}: {} has a model",
                scenery.name
            );
            assert!(
                scenery.warnings.is_empty(),
                "{name}: {:?}",
                scenery.warnings
            );
        }
    }
}

/// Submits a commit for `session`, runs its expansion, then dispatches the fixture command
/// it turned into, if any, and runs that too. Returns the fixture command, the number of
/// group stores and the scene objects stored for the scenery.
fn commit_session(
    app: &mut App,
    session: Uuid,
) -> (Option<FixtureCommand>, usize, Vec<SceneObject>) {
    let envelope = CommandEnvelope::new(
        RigImportCommand::Commit {
            session,
            options: RigImportOptions::default(),
        },
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    );
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            envelope.command_id,
            envelope.undo_id,
            Box::new(envelope.command.clone()),
        ));
    app.update();
    let queued = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    let mut command = None;
    let mut groups = 0;
    let mut scenery = Vec::new();
    for envelope in &queued {
        let payload = envelope.payload.as_any();
        if let Some(fixture_command) = payload.downcast_ref::<FixtureCommand>() {
            assert!(
                command.is_none(),
                "the commit expands into one fixture command"
            );
            command = Some(fixture_command.clone());
        } else if let Some(SceneObjectCommand::StoreSceneObject(object)) =
            payload.downcast_ref::<SceneObjectCommand>()
        {
            scenery.push(object.clone());
        } else {
            assert!(payload.is::<GroupCommand>(), "unexpected command");
            groups += 1;
        }
    }
    if let Some(command) = &command {
        let dispatched =
            CommandEnvelope::new(command.clone(), CommandOrigin::Cli, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&dispatched)
            .unwrap();
        app.world_mut().write_message(dispatched);
        app.update();
    }
    (command, groups, scenery)
}

/// The whole Capture demo show imports: its five GDTFs convert, all 76 fixtures are stored
/// with every break patched without route conflicts, and a group is made per layer.
/// Importing it again finds every fixture unchanged and only refreshes the groups.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn imports_capture_demo_show() {
    let rig = sample("capture_demo_show.mvr").expect("NIGHTFALL_MVR_SAMPLES_DIR is set");
    let routes: usize = rig.fixtures.iter().map(|fixture| fixture.patch.len()).sum();
    let root = tempfile::tempdir().unwrap();
    let sessions = RigImportSessions::default();
    let session = sessions.insert(rig);
    let mut app = import_app(empty_library(root.path()), sessions);
    nightfall::set_active_show_data_dir(root.path().join("show"));

    let (command, groups, scenery) = commit_session(&mut app, session);
    assert!(command.is_some());
    assert!(groups > 0, "the layers become groups");
    assert_eq!(scenery.len(), 17, "13 trusses and four layers of scenery");
    let bundles = std::fs::read_dir(root.path().join("show/scene-objects"))
        .unwrap()
        .count();
    assert_eq!(bundles, 17);
    {
        let mut stored = app.world_mut().resource_mut::<SceneObjectDataProvider>();
        for object in scenery {
            stored.add(object).unwrap();
        }
    }

    assert_eq!(
        app.world()
            .resource::<FixtureDataProviderExt>()
            .inner
            .iter()
            .count(),
        76
    );
    assert_eq!(app.world().resource::<OutputRoutes>().routes.len(), routes);

    let (command, regrouped, rescenery) = commit_session(&mut app, session);
    assert!(rescenery.is_empty(), "the scenery is unchanged");
    assert!(
        command.is_none(),
        "nothing changed, so no fixture is touched"
    );
    assert_eq!(regrouped, groups);
}
