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
use nightfall_mvr_import::plan::{ShowFixtures, plan_import};
use nightfall_mvr_import::prelude::*;
use nightfall_mvr_import::rig::{RigTypeSource, read_rig};
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
        uids: Default::default(),
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

/// A commit installs the file's GDTF into the show package, turns into one fixture
/// command, and that command adds the fixtures with their UUIDs, placements and patch.
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
    assert_eq!(queued.len(), 1);
    let queued = queued.remove(0);
    assert_eq!(queued.command_id, envelope.command_id);
    assert_eq!(queued.undo_id, envelope.undo_id);
    let command = queued
        .payload
        .as_any()
        .downcast_ref::<FixtureCommand>()
        .expect("a fixture command")
        .clone();
    let FixtureCommand::AddPatchedFixtures { fixtures, routes } = &command else {
        panic!("expected AddPatchedFixtures, got {command:?}");
    };
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

/// Submits a commit for `session`, runs its expansion, then dispatches the fixture command
/// it turned into and runs that too. Returns the fixture command.
fn commit_session(app: &mut App, session: Uuid) -> FixtureCommand {
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
    assert_eq!(
        queued.len(),
        1,
        "the commit expands into one fixture command"
    );
    let command = queued[0]
        .payload
        .as_any()
        .downcast_ref::<FixtureCommand>()
        .expect("a fixture command")
        .clone();
    let dispatched =
        CommandEnvelope::new(command.clone(), CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&dispatched)
        .unwrap();
    app.world_mut().write_message(dispatched);
    app.update();
    command
}

/// The whole Capture demo show imports: its five GDTFs convert, and all 76 fixtures are
/// stored with every break patched without route conflicts.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn imports_capture_demo_show() {
    let rig = sample("capture_demo_show.mvr").expect("NIGHTFALL_MVR_SAMPLES_DIR is set");
    let routes: usize = rig.fixtures.iter().map(|fixture| fixture.patch.len()).sum();
    let root = tempfile::tempdir().unwrap();
    let sessions = RigImportSessions::default();
    let session = sessions.insert(rig);
    let mut app = import_app(empty_library(root.path()), sessions);

    commit_session(&mut app, session);

    assert_eq!(
        app.world()
            .resource::<FixtureDataProviderExt>()
            .inner
            .iter()
            .count(),
        76
    );
    assert_eq!(app.world().resource::<OutputRoutes>().routes.len(), routes);
}
