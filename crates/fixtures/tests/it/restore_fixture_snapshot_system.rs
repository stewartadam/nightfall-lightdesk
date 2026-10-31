// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::{
    CommandNoticeReply, CommandReply, CommandResult, CommandTracker, EngineOperationEnvelope,
    FinishedCommand,
};
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::events::handle_restore_fixture_snapshot;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::undo::{
    DmxRoutesSnapshot, FixtureSnapshot, ParameterSnapshot, RestoreFixtureSnapshot,
};
use uuid::Uuid;

/// Installs the command lifecycle resources required by action handlers.
fn init_command_lifecycle(app: &mut App) {
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
}

/// Builds an app running only the fixture snapshot restore system and the resources it uses.
fn restore_app() -> App {
    let mut app = App::new();
    init_command_lifecycle(&mut app);
    app.add_message::<EngineOperationEnvelope<RestoreFixtureSnapshot>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputRoutes>();
    app.init_resource::<OutputRoutes>();
    app.init_resource::<DisabledRoutes>();
    app.add_systems(Update, handle_restore_fixture_snapshot);
    app
}

/// Build a single-parameter fixture for restore system tests.
fn make_fixture(uid: Uuid) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id: 505,
            uid,
            label: "restore fixture".to_owned(),
        },
        make: "test".to_owned(),
        model: "test".to_owned(),
        mode: "default".to_owned(),
        elements: vec![FixtureElement {
            label: "main".to_owned(),
            parameters: vec![ParameterMetadata {
                attribute: Attribute::Intensity,
                native_unit: Attribute::Intensity.native_unit(),
                value_polarity: Attribute::Intensity.value_polarity(),
                resolution: DmxValueResolution::Coarse,
                ..Default::default()
            }],
        }],
        ..Default::default()
    }
}

/// RestoreFixtureSnapshot recreates runtime parameter entities for restored fixtures.
#[test]
fn restore_fixture_snapshot_spawns_parameter_entities() {
    let mut app = restore_app();
    let fixture_uid = Uuid::new_v4();
    let fixture = make_fixture(fixture_uid);
    let parameter_values = ParameterValues {
        default_value: 7.0,
        highlight_value: 255.0,
        current_value: 42.0,
    };
    let parameter_metadata = fixture.elements[0].parameters[0].clone();

    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(RestoreFixtureSnapshot(
            FixtureSnapshot {
                fixture,
                parameters: vec![ParameterSnapshot {
                    element_index: 1,
                    metadata: parameter_metadata,
                    values: parameter_values.clone(),
                }],
                color_path_defaults: vec![],
                routes: None,
            },
        )));

    app.update();

    let data_provider = app.world().resource::<FixtureDataProviderExt>();
    assert!(
        data_provider.inner.get(fixture_uid).is_ok(),
        "fixture should be restored to the fixture provider"
    );

    let element_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let parameter_entities = data_provider.parameter_entities_for_element(&element_ref);
    assert_eq!(
        parameter_entities.len(),
        1,
        "restored fixture should have one runtime parameter entity"
    );

    let parameter_entity = parameter_entities[0].entity();
    let parameter = app
        .world()
        .entity(parameter_entity)
        .get::<Parameter>()
        .expect("restored parameter entity should contain a Parameter component");

    assert_eq!(parameter.metadata.attribute, Attribute::Intensity);
    assert_eq!(
        parameter.values.current_value,
        parameter_values.current_value
    );
}

/// RestoreFixtureSnapshot restores fixture color path defaults owned by the fixture.
#[test]
fn restore_fixture_snapshot_restores_color_path_defaults() {
    let mut app = restore_app();
    let fixture_uid = Uuid::new_v4();
    let fixture = make_fixture(fixture_uid);
    let element_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };

    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(RestoreFixtureSnapshot(
            FixtureSnapshot {
                fixture,
                parameters: vec![],
                color_path_defaults: vec![ColorPathDefault {
                    fixture: element_ref.clone(),
                    color_path_id: ColorPathId(2),
                }],
                routes: None,
            },
        )));

    app.update();

    let data_provider = app.world().resource::<FixtureDataProviderExt>();
    assert_eq!(
        data_provider.color_path_default_for_element(&element_ref),
        Some(ColorPathId(2))
    );
}

/// Builds a single-fixture output route to a sACN universe.
fn output_route(uid: Uuid, universe: u16) -> OutputRoute {
    OutputRoute {
        source: OutputSource::Fixture {
            uids: vec![uid],
            element: None,
            param: None,
        },
        target: OutputTarget::Transport {
            target: "sacn".to_owned(),
            universe: Some(DmxRange::single(universe)),
            address: Some(1),
        },
        priority: 0,
        clone: false,
    }
}

/// A snapshot taken before a fixture delete puts the DMX routes back as they were, so an
/// undone delete comes back patched.
#[test]
fn restore_fixture_snapshot_restores_routes_captured_at_delete() {
    let mut app = restore_app();
    let fixture_uid = Uuid::new_v4();
    let other_uid = Uuid::new_v4();
    app.world_mut().resource_mut::<OutputRoutes>().routes = vec![output_route(other_uid, 2)];
    let captured = vec![output_route(fixture_uid, 1), output_route(other_uid, 2)];

    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(RestoreFixtureSnapshot(
            FixtureSnapshot {
                fixture: make_fixture(fixture_uid),
                parameters: vec![],
                color_path_defaults: vec![],
                routes: Some(DmxRoutesSnapshot {
                    input_routes: vec![],
                    output_routes: captured.clone(),
                    disabled_routes: vec![],
                }),
            },
        )));

    app.update();

    assert_eq!(app.world().resource::<OutputRoutes>().routes, captured);
}

/// A snapshot without routes, as taken when undoing a fixture update, leaves the live routes
/// untouched.
#[test]
fn restore_fixture_snapshot_without_routes_keeps_live_routes() {
    let mut app = restore_app();
    let fixture_uid = Uuid::new_v4();
    let live = vec![output_route(fixture_uid, 3)];
    app.world_mut().resource_mut::<OutputRoutes>().routes = live.clone();

    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(RestoreFixtureSnapshot(
            FixtureSnapshot {
                fixture: make_fixture(fixture_uid),
                parameters: vec![],
                color_path_defaults: vec![],
                routes: None,
            },
        )));

    app.update();

    assert_eq!(app.world().resource::<OutputRoutes>().routes, live);
}
