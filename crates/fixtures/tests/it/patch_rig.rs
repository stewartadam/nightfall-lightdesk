// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command-level checks that `PatchRig` keeps a whole rig change or none of it, and that its
//! undo operation puts the fixtures and routes back.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::FixtureCommand;
use nightfall_fixtures::events::handle_restore_patched_fixtures;
use nightfall_fixtures::fixture_events::crud_events;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::undo::{
    DmxRoutesSnapshot, PatchedFixturesSnapshot, RestorePatchedFixtures,
};
use nightfall_fixtures::websocket::SuppressFixtureChangedSnapshot;
use nightfall_fixtures::{PatchRoute, RigFixtureUpdate, RouteEndpoint};
use nightfall_io::prelude::*;
use uuid::Uuid;

/// Creates an app that runs fixture commands and the batch restore operation with strict
/// route validation.
fn app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<EngineOperationEnvelope<RestorePatchedFixtures>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
    app.add_message::<SuppressFixtureChangedSnapshot>();
    app.init_resource::<CommandTracker>();
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
    app.add_systems(
        Update,
        (crud_events, handle_restore_patched_fixtures).chain(),
    );
    app
}

/// Builds a fixture with one dimmer channel.
fn dimmer(id: u32) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            label: format!("Dimmer {id}"),
        },
        make: "test".to_owned(),
        model: "dimmer".to_owned(),
        mode: "1ch".to_owned(),
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

/// Builds the route patching fixture `id` to a console universe and address.
fn patch(id: u32, universe: u16, address: u16) -> PatchRoute {
    PatchRoute {
        source: RouteEndpoint::Fixture {
            ids: vec![id],
            element: None,
            param: None,
        },
        target: RouteEndpoint::Console {
            universe: Some(DmxRange::single(universe)),
            address: Some(address),
        },
    }
}

/// Registers and sends a fixture command, then runs one update.
fn send(app: &mut App, command: FixtureCommand) {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("command registers");
    app.world_mut().write_message(envelope);
    app.update();
}

/// Returns the IDs of every stored fixture, sorted.
fn fixture_ids(app: &App) -> Vec<u32> {
    let mut ids: Vec<u32> = app
        .world()
        .resource::<FixtureDataProviderExt>()
        .inner
        .iter()
        .map(|entry| entry.value().identifiers.id)
        .collect();
    ids.sort_unstable();
    ids
}

/// A batch stores every fixture with its parameters and adds each route.
#[test]
fn adds_fixtures_and_routes_together() {
    let mut app = app();
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![dimmer(1), dimmer(2), dimmer(3)],
            update: vec![],
            routes: vec![patch(1, 1, 1), patch(2, 1, 2)],
        },
    );

    assert_eq!(fixture_ids(&app), [1, 2, 3]);
    assert_eq!(app.world().resource::<OutputRoutes>().routes.len(), 2);
    let parameters = app
        .world_mut()
        .query::<&Parameter>()
        .iter(app.world())
        .count();
    assert_eq!(parameters, 3);
}

/// An ID already in the show rejects the whole batch before anything is stored.
#[test]
fn rejects_a_batch_reusing_an_id() {
    let mut app = app();
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![dimmer(1)],
            update: vec![],
            routes: vec![],
        },
    );
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![dimmer(2), dimmer(1)],
            update: vec![],
            routes: vec![],
        },
    );

    assert_eq!(fixture_ids(&app), [1]);
}

/// A route that overlaps another removes the batch's fixtures again and leaves the routes as
/// they were.
#[test]
fn rolls_back_when_a_route_overlaps() {
    let mut app = app();
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![dimmer(1), dimmer(2)],
            update: vec![],
            routes: vec![patch(1, 1, 1), patch(2, 1, 1)],
        },
    );
    app.update();

    assert!(fixture_ids(&app).is_empty());
    assert!(app.world().resource::<OutputRoutes>().routes.is_empty());
    let parameters = app
        .world_mut()
        .query::<&Parameter>()
        .iter(app.world())
        .count();
    assert_eq!(parameters, 0, "rolled back parameters are despawned");
}

/// The undo operation removes the batch and restores the routes from before it.
#[test]
fn restore_removes_the_batch_and_its_routes() {
    let mut app = app();
    let fixtures = vec![dimmer(1), dimmer(2)];
    let uids: Vec<Uuid> = fixtures
        .iter()
        .map(|fixture| fixture.identifiers.uid)
        .collect();
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: fixtures,
            update: vec![],
            routes: vec![patch(1, 1, 1)],
        },
    );
    assert_eq!(fixture_ids(&app), [1, 2]);

    let envelope =
        EngineOperationEnvelope::detached(RestorePatchedFixtures(PatchedFixturesSnapshot {
            remove: uids,
            restore: vec![],
            revert: vec![],
            routes: DmxRoutesSnapshot {
                input_routes: vec![],
                output_routes: vec![],
                disabled_routes: vec![],
            },
        }));
    app.world_mut().write_message(envelope);
    app.update();

    assert!(fixture_ids(&app).is_empty());
    assert!(app.world().resource::<OutputRoutes>().routes.is_empty());
}

/// Returns the stored fixture with `id`.
fn stored(app: &App, id: u32) -> Fixture {
    (*app
        .world()
        .resource::<FixtureDataProviderExt>()
        .inner
        .from_id(id)
        .expect("fixture is stored"))
    .clone()
}

/// Returns the console addresses of every output route, sorted.
fn console_addresses(app: &App) -> Vec<(Option<DmxRange>, Option<u16>)> {
    let mut addresses: Vec<_> = app
        .world()
        .resource::<OutputRoutes>()
        .routes
        .iter()
        .filter_map(|route| match &route.target {
            OutputTarget::Console { universe, address } => Some((*universe, *address)),
            _ => None,
        })
        .collect();
    addresses.sort_by_key(|(_, address)| *address);
    addresses
}

/// Updating a fixture changes its label and placement and moves its patch, while a new
/// fixture is added in the same change.
#[test]
fn updates_and_repatches_existing_fixtures() {
    let mut app = app();
    let existing = dimmer(1);
    let uid = existing.identifiers.uid;
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![existing],
            update: vec![],
            routes: vec![patch(1, 1, 1)],
        },
    );

    let mut placement = FixturePlacement::default();
    placement.position.y = 6.0;
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![dimmer(2)],
            update: vec![RigFixtureUpdate {
                uid,
                label: Some("FOH 1".to_owned()),
                placement: Some(placement.clone()),
                repatch: true,
            }],
            routes: vec![patch(1, 1, 10), patch(2, 1, 1)],
        },
    );

    assert_eq!(fixture_ids(&app), [1, 2]);
    let fixture = stored(&app, 1);
    assert_eq!(fixture.identifiers.label, "FOH 1");
    assert_eq!(fixture.placement, placement);
    assert_eq!(
        console_addresses(&app),
        [
            (Some(DmxRange::single(1)), Some(1)),
            (Some(DmxRange::single(1)), Some(10))
        ]
    );
}

/// A failed repatch puts the changed fixture back as it was and keeps its old patch.
#[test]
fn failed_update_restores_the_fixture() {
    let mut app = app();
    let existing = dimmer(1);
    let uid = existing.identifiers.uid;
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![existing, dimmer(2)],
            update: vec![],
            routes: vec![patch(1, 1, 1), patch(2, 1, 2)],
        },
    );
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![],
            update: vec![RigFixtureUpdate {
                uid,
                label: Some("Moved".to_owned()),
                placement: None,
                repatch: true,
            }],
            routes: vec![patch(1, 1, 2)],
        },
    );

    assert_eq!(stored(&app, 1).identifiers.label, "Dimmer 1");
    assert_eq!(
        console_addresses(&app),
        [
            (Some(DmxRange::single(1)), Some(1)),
            (Some(DmxRange::single(1)), Some(2))
        ]
    );
}

/// The undo operation puts a changed fixture's definition back and keeps its parameters.
#[test]
fn restore_brings_back_changed_fixtures() {
    let mut app = app();
    let existing = dimmer(1);
    let original = existing.clone();
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![existing],
            update: vec![],
            routes: vec![],
        },
    );
    send(
        &mut app,
        FixtureCommand::PatchRig {
            add: vec![],
            update: vec![RigFixtureUpdate {
                uid: original.identifiers.uid,
                label: Some("Changed".to_owned()),
                placement: None,
                repatch: false,
            }],
            routes: vec![],
        },
    );
    assert_eq!(stored(&app, 1).identifiers.label, "Changed");

    let envelope =
        EngineOperationEnvelope::detached(RestorePatchedFixtures(PatchedFixturesSnapshot {
            remove: vec![],
            restore: vec![],
            revert: vec![original],
            routes: DmxRoutesSnapshot {
                input_routes: vec![],
                output_routes: vec![],
                disabled_routes: vec![],
            },
        }));
    app.world_mut().write_message(envelope);
    app.update();

    assert_eq!(fixture_ids(&app), [1]);
    assert_eq!(stored(&app, 1).identifiers.label, "Dimmer 1");
    let parameters = app
        .world_mut()
        .query::<&Parameter>()
        .iter(app.world())
        .count();
    assert_eq!(parameters, 1, "the fixture keeps its one parameter entity");
}
