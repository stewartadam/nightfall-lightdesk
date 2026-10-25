// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Event handlers for fixture commands.

use std::collections::{HashMap, HashSet, hash_map::Entry};

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use moonshine_kind::prelude::*;
use nightfall::prelude::{ColorPath, ColorPathId, FixtureRef};
use nightfall_engine::prelude::*;
use nightfall_fixtures::FixturePlacementUpdateEntry;
use nightfall_fixtures::parameter::Parameter;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::route_validation::validate_routes;
use nightfall_fixtures::websocket::{
    SuppressFixtureChangedSnapshot, broadcast_fixture_command, send_color_path_defaults,
};
use nightfall_io::RouteTransport;
use nightfall_io::prelude::*;
use uuid::Uuid;

mod color_path_defaults;
mod definitions;
mod patch;

#[cfg(test)]
use color_path_defaults::resolve_color_path_default_fixture_ref;
#[cfg(test)]
use definitions::collect_fixture_placement_batch_updates;
#[cfg(test)]
use patch::{OUTPUT_DISABLE_ERROR, apply_dmx_route_add, apply_dmx_route_remove};

/// Cohesive dependencies shared by fixture definition, patch, and color path default handlers.
#[derive(SystemParam)]
pub struct FixtureCrudContext<'w, 's> {
    /// Deferred ECS mutations, used to despawn deleted fixtures' parameters.
    commands: Commands<'w, 's>,
    /// Persisted fixtures and their parameter entities.
    fixture_data_provider: ResMut<'w, FixtureDataProviderExt>,
    /// Websocket broadcaster for placement and color path default updates.
    broadcaster: Res<'w, ClientEventSink>,
    /// Suppresses the fixture snapshot made redundant by a placement broadcast.
    suppress_fixture_changed_snapshot: MessageWriter<'w, SuppressFixtureChangedSnapshot>,
    /// Exact-once command lifecycle responder.
    responder: CommandResponder<'w>,
    /// Live fixture parameters updated by parameter offset changes.
    param_query: Query<'w, 's, InstanceMut<'static, Parameter>>,
    /// Live input routes.
    input_routes: ResMut<'w, InputRoutes>,
    /// Live output routes.
    output_routes: ResMut<'w, OutputRoutes>,
    /// Live disabled input routes.
    disabled_routes: ResMut<'w, DisabledRoutes>,
    /// Policy used when validating route changes.
    route_settings: Res<'w, RouteValidationSettings>,
    /// Configured network DMX output targets.
    network_outputs: Res<'w, NetworkDmxOutputTargets>,
    /// Configured USB DMX output targets.
    usb_outputs: Res<'w, UsbDmxOutputTargets>,
    /// Optional color path library referenced by color path defaults.
    color_paths: Option<Res<'w, DataProvider<ColorPath>>>,
}

/// Finishes a fixture command with a structured domain failure.
fn fail_fixture_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    code: &'static str,
    message: String,
) {
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%command_id, %error, "fixture_command_failure_failed");
    }
}

/// Finishes a fixture command after its requested mutation has completed.
fn succeed_fixture_command(responder: &mut CommandResponder, command_id: CommandId) {
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%command_id, %error, "fixture_command_success_failed");
    }
}

/// Handles CRUD events for fixtures.
///
/// Fixture definition, patch, and color path default commands go to their family handler,
/// which reports the command's outcome. DMX channel commands belong to the fixtures crate.
pub fn crud_events(
    mut context: FixtureCrudContext,
    mut events: MessageReader<CommandEnvelope<FixtureCommand>>,
) {
    for event in events.read() {
        match &event.command {
            FixtureCommand::StoreFixture(_)
            | FixtureCommand::RenameFixture { .. }
            | FixtureCommand::DeleteFixture(_)
            | FixtureCommand::UpdateFixturePlacements { .. }
            | FixtureCommand::UpdateFixtureParameterOffset { .. } => {
                definitions::handle_command(&mut context, event);
            }
            FixtureCommand::UpdateFixturePatch { .. }
            | FixtureCommand::AddDmxRoute { .. }
            | FixtureCommand::RemoveDmxRoutes { .. } => patch::handle_command(&mut context, event),
            FixtureCommand::SetColorPathDefault { .. }
            | FixtureCommand::SetColorPathDefaultById { .. } => {
                color_path_defaults::handle_command(&mut context, event);
            }
            FixtureCommand::SetDmxChannels { .. }
            | FixtureCommand::SetTransportDmxChannels { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall::prelude::Identifiers;
    use uuid::Uuid;

    use super::*;

    fn create_test_fixture(id: u32) -> Fixture {
        Fixture {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: format!("fixture-{id}"),
            },
            make: "Test".to_string(),
            model: "Fixture".to_string(),
            mode: "Default".to_string(),
            elements: Vec::new(),
            physical: None,
            placement: FixturePlacement::default(),
            layout: None,
            library_asset_etag: None,
        }
    }

    /// Creates a minimal app that executes fixture CRUD commands with lifecycle tracking.
    fn fixture_command_app() -> App {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<FixtureCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_message::<SuppressFixtureChangedSnapshot>();
        app.init_resource::<CommandTracker>();
        app.insert_resource(FixtureDataProviderExt::default());
        app.insert_resource(InputRoutes::default());
        app.insert_resource(OutputRoutes::default());
        app.insert_resource(DisabledRoutes::default());
        app.insert_resource(RouteValidationSettings::default());
        app.insert_resource(NetworkDmxOutputTargets::default());
        app.insert_resource(UsbDmxOutputTargets::default());
        let (sender, _receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(Update, crud_events);
        app
    }

    /// Submits one tracked fixture command to the test app.
    fn submit_fixture_command(app: &mut App, command: FixtureCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("fixture command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Verifies fixture storage mutates the provider before reporting semantic success.
    #[test]
    fn store_fixture_mutates_before_success() {
        let mut app = fixture_command_app();
        let fixture = create_test_fixture(42);
        let command_id =
            submit_fixture_command(&mut app, FixtureCommand::StoreFixture(fixture.clone()));

        app.update();

        assert!(
            app.world()
                .resource::<FixtureDataProviderExt>()
                .inner
                .from_id(42)
                .is_ok()
        );
        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(matches!(
            results.as_slice(),
            [CommandResult {
                command_id: result_command_id,
                outcome: CommandOutcome::Succeeded { output: None },
            }] if *result_command_id == command_id
        ));
    }

    /// Verifies a missing fixture rename returns one structured failure.
    #[test]
    fn rename_missing_fixture_returns_failure() {
        let mut app = fixture_command_app();
        let command_id =
            submit_fixture_command(&mut app, FixtureCommand::RenameFixture { id: 7, new_id: 8 });

        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(matches!(
            results.as_slice(),
            [CommandResult {
                command_id: result_command_id,
                outcome: CommandOutcome::Failed(error),
            }] if *result_command_id == command_id && error.code == "fixture.not_found"
        ));
    }

    /// Builds a fixture output route patching `uids` to universe 1 of the sACN output.
    fn sacn_output_route(uids: Vec<Uuid>) -> OutputRoute {
        OutputRoute {
            source: OutputSource::Fixture {
                uids,
                element: None,
                param: None,
            },
            target: OutputTarget::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            priority: 0,
            clone: false,
        }
    }

    /// Verifies deleting a fixture drops it from every DMX route: routes naming only that
    /// fixture disappear, shared routes keep their other fixtures, and unrelated routes stay.
    #[test]
    fn delete_fixture_removes_it_from_dmx_routes() {
        let mut app = fixture_command_app();
        let deleted = create_test_fixture(1);
        let kept = create_test_fixture(2);
        let (deleted_uid, kept_uid) = (deleted.identifiers.uid, kept.identifiers.uid);
        {
            let mut provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
            provider.inner.add(deleted).expect("fixture should insert");
            provider.inner.add(kept).expect("fixture should insert");
        }
        let console_input = InputRoute {
            source: InputSource::Transport {
                transport: RouteTransport::Sacn,
                universe: Some(DmxRange::single(1)),
                address: None,
            },
            target: InputTarget::Console {
                universe: Some(DmxRange::single(1)),
                address: None,
            },
            priority: 0,
            clone: false,
        };
        app.world_mut().resource_mut::<InputRoutes>().routes = vec![
            InputRoute {
                source: InputSource::Fixture {
                    uids: vec![kept_uid],
                    element: None,
                    param: None,
                },
                target: InputTarget::Fixture {
                    uids: vec![deleted_uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            },
            console_input.clone(),
        ];
        app.world_mut().resource_mut::<OutputRoutes>().routes = vec![
            sacn_output_route(vec![deleted_uid]),
            sacn_output_route(vec![deleted_uid, kept_uid]),
        ];
        app.world_mut().resource_mut::<DisabledRoutes>().routes = vec![DisabledRoute::Input {
            source: InputSource::Fixture {
                uids: vec![deleted_uid],
                element: None,
                param: None,
            },
            priority: 0,
            clone: false,
        }];

        submit_fixture_command(&mut app, FixtureCommand::DeleteFixture(1));
        app.update();

        assert_eq!(
            app.world().resource::<InputRoutes>().routes,
            vec![console_input]
        );
        assert_eq!(
            app.world().resource::<OutputRoutes>().routes,
            vec![sacn_output_route(vec![kept_uid])]
        );
        assert!(app.world().resource::<DisabledRoutes>().routes.is_empty());
    }

    /// Builds a fixture with a fixed number of empty elements for target resolution tests.
    fn create_test_fixture_with_elements(id: u32, element_count: u32) -> Fixture {
        let mut fixture = create_test_fixture(id);
        fixture.elements = (1..=element_count)
            .map(|index| FixtureElement {
                label: format!("element-{index}"),
                parameters: Vec::new(),
            })
            .collect();
        fixture
    }

    /// Verifies whole-fixture color path targets resolve to fixture refs without an element index.
    #[test]
    fn resolve_color_path_default_fixture_ref_resolves_whole_fixture() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let fixture = create_test_fixture_with_elements(301, 2);
        let fixture_uid = fixture.identifiers.uid;
        fixture_data_provider
            .inner
            .add(fixture)
            .expect("fixture should insert");

        let resolved = resolve_color_path_default_fixture_ref(&fixture_data_provider, 301, None)
            .expect("whole fixture target should resolve");

        assert_eq!(
            resolved,
            FixtureRef {
                fixture_uid,
                index: None
            }
        );
    }

    /// Verifies element color path targets resolve to fixture refs with a 1-based index.
    #[test]
    fn resolve_color_path_default_fixture_ref_resolves_fixture_element() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        let fixture = create_test_fixture_with_elements(301, 2);
        let fixture_uid = fixture.identifiers.uid;
        fixture_data_provider
            .inner
            .add(fixture)
            .expect("fixture should insert");

        let resolved = resolve_color_path_default_fixture_ref(&fixture_data_provider, 301, Some(2))
            .expect("fixture element target should resolve");

        assert_eq!(
            resolved,
            FixtureRef {
                fixture_uid,
                index: Some(2)
            }
        );
    }

    /// Verifies invalid element color path targets fail before writing defaults.
    #[test]
    fn resolve_color_path_default_fixture_ref_rejects_missing_element() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        fixture_data_provider
            .inner
            .add(create_test_fixture_with_elements(301, 1))
            .expect("fixture should insert");

        let error = resolve_color_path_default_fixture_ref(&fixture_data_provider, 301, Some(2))
            .expect_err("missing fixture element should fail");

        assert_eq!(
            error,
            "Failed to set fixture color path default: fixture 301 element 2 not found"
        );
    }

    #[test]
    fn collect_fixture_placement_batch_updates_composes_repeated_fixture_updates() {
        let mut fixture_data_provider = FixtureDataProviderExt::default();
        fixture_data_provider
            .inner
            .add(create_test_fixture(1))
            .expect("fixture should be inserted");

        let updates = vec![
            FixturePlacementUpdateEntry {
                id: 1,
                position: Some(FixturePlacementPositionUpdate::X(1.0)),
                rotation: None,
            },
            FixturePlacementUpdateEntry {
                id: 1,
                position: Some(FixturePlacementPositionUpdate::Y(2.0)),
                rotation: None,
            },
        ];

        let (fixtures_to_store, changed_updates) =
            collect_fixture_placement_batch_updates(&fixture_data_provider, &updates)
                .expect("batch update should succeed");

        assert_eq!(changed_updates.len(), 2);
        assert_eq!(fixtures_to_store.len(), 1);
        let updated_fixture = &fixtures_to_store[0];
        assert_eq!(updated_fixture.identifiers.id, 1);
        assert_eq!(updated_fixture.placement.position.x, 1.0);
        assert_eq!(updated_fixture.placement.position.y, 2.0);
        assert_eq!(updated_fixture.placement.position.z, 0.0);
    }

    #[test]
    fn collect_fixture_placement_batch_updates_errors_on_missing_fixture() {
        let fixture_data_provider = FixtureDataProviderExt::default();

        let updates = vec![FixturePlacementUpdateEntry {
            id: 42,
            position: Some(FixturePlacementPositionUpdate::X(1.0)),
            rotation: None,
        }];

        let result = collect_fixture_placement_batch_updates(&fixture_data_provider, &updates);

        match result {
            Ok(_) => panic!("expected missing fixture error"),
            Err(message) => {
                assert_eq!(
                    message,
                    "Failed to update placement for fixture 42: not found"
                );
            }
        }
    }

    #[test]
    fn apply_dmx_route_add_supports_transport_to_transport() {
        let source = RouteEndpoint::Transport {
            target: "sacn".to_string(),
            universe: Some(DmxRange::single(1)),
            address: Some(10),
        };
        let target = RouteEndpoint::Transport {
            target: "artnet".to_string(),
            universe: Some(DmxRange::single(2)),
            address: Some(20),
        };

        let mut input_routes = InputRoutes::default();
        let mut output_routes = OutputRoutes::default();
        let mut disabled_routes = DisabledRoutes::default();
        let data_provider = FixtureDataProviderExt::default();
        let network_outputs = NetworkDmxOutputTargets::default();
        let usb_outputs = UsbDmxOutputTargets::default();

        apply_dmx_route_add(
            &source,
            &target,
            3,
            true,
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
            &network_outputs,
            &usb_outputs,
        )
        .expect("transport-to-transport add should succeed");

        assert_eq!(input_routes.routes.len(), 1);
        assert!(output_routes.routes.is_empty());
        assert!(disabled_routes.routes.is_empty());

        assert_eq!(
            input_routes.routes[0],
            InputRoute {
                source: InputSource::Transport {
                    transport: RouteTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                target: InputTarget::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange::single(2)),
                    address: Some(20),
                },
                priority: 3,
                clone: true,
            }
        );
    }

    /// Verifies outputs cannot be patched to `disabled`, while transport inputs still can.
    #[test]
    fn apply_dmx_route_disables_only_inputs() {
        let fixture = create_test_fixture(12);
        let mut data_provider = FixtureDataProviderExt::default();
        let _ = data_provider.inner.add(fixture);
        let mut input_routes = InputRoutes::default();
        let mut output_routes = OutputRoutes::default();
        let mut disabled_routes = DisabledRoutes::default();
        let network_outputs = NetworkDmxOutputTargets::default();
        let usb_outputs = UsbDmxOutputTargets::default();

        let output_sources = [
            RouteEndpoint::Fixture {
                ids: vec![12],
                element: None,
                param: None,
            },
            RouteEndpoint::FixtureBreak {
                ids: vec![12],
                dmx_break: 2,
            },
            RouteEndpoint::Console {
                universe: Some(DmxRange::single(1)),
                address: None,
            },
        ];
        for source in &output_sources {
            let error = apply_dmx_route_add(
                source,
                &RouteEndpoint::Disabled,
                0,
                false,
                &mut input_routes,
                &mut output_routes,
                &mut disabled_routes,
                &data_provider,
                &network_outputs,
                &usb_outputs,
            )
            .expect_err("outputs cannot be disabled");
            assert_eq!(error, OUTPUT_DISABLE_ERROR);
        }
        assert!(output_routes.routes.is_empty());
        assert!(disabled_routes.routes.is_empty());

        let transport = RouteEndpoint::Transport {
            target: "sacn".to_string(),
            universe: Some(DmxRange::single(1)),
            address: None,
        };
        apply_dmx_route_add(
            &transport,
            &RouteEndpoint::Disabled,
            0,
            false,
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
            &network_outputs,
            &usb_outputs,
        )
        .expect("transport inputs can be disabled");
        assert_eq!(disabled_routes.routes.len(), 1);

        apply_dmx_route_remove(
            None,
            Some(&RouteEndpoint::Disabled),
            None,
            None,
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
        )
        .expect("removing disabled rules should succeed");
        assert!(disabled_routes.routes.is_empty());
    }

    /// Verifies `rm patch` rejects output sources filtered by `disabled`, which can never match.
    #[test]
    fn apply_dmx_route_remove_rejects_disabled_output_sources() {
        let fixture = create_test_fixture(12);
        let mut data_provider = FixtureDataProviderExt::default();
        let _ = data_provider.inner.add(fixture);
        let mut input_routes = InputRoutes::default();
        let mut output_routes = OutputRoutes::default();
        let mut disabled_routes = DisabledRoutes::default();

        for source in [
            RouteEndpoint::Fixture {
                ids: vec![12],
                element: None,
                param: None,
            },
            RouteEndpoint::FixtureBreak {
                ids: vec![12],
                dmx_break: 2,
            },
            RouteEndpoint::Console {
                universe: Some(DmxRange::single(1)),
                address: None,
            },
        ] {
            let error = apply_dmx_route_remove(
                Some(&source),
                Some(&RouteEndpoint::Disabled),
                None,
                None,
                &mut input_routes,
                &mut output_routes,
                &mut disabled_routes,
                &data_provider,
            )
            .expect_err("output sources cannot have disabled rules");
            assert_eq!(error, OUTPUT_DISABLE_ERROR);
        }
    }

    /// Verifies a fixture break patches only to transports and is removed by a whole-fixture unpatch.
    #[test]
    fn apply_dmx_route_fixture_break_round_trip() {
        let fixture = create_test_fixture(12);
        let fixture_uid = fixture.identifiers.uid;
        let mut data_provider = FixtureDataProviderExt::default();
        let _ = data_provider.inner.add(fixture);
        let source = RouteEndpoint::FixtureBreak {
            ids: vec![12],
            dmx_break: 2,
        };
        let transport = RouteEndpoint::Transport {
            target: "sacn".to_string(),
            universe: Some(DmxRange::single(1)),
            address: Some(200),
        };
        let mut input_routes = InputRoutes::default();
        let mut output_routes = OutputRoutes::default();
        let mut disabled_routes = DisabledRoutes::default();
        let network_outputs = NetworkDmxOutputTargets::default();
        let usb_outputs = UsbDmxOutputTargets::default();

        let console = RouteEndpoint::Console {
            universe: None,
            address: None,
        };
        assert!(
            apply_dmx_route_add(
                &source,
                &console,
                0,
                false,
                &mut input_routes,
                &mut output_routes,
                &mut disabled_routes,
                &data_provider,
                &network_outputs,
                &usb_outputs,
            )
            .is_err()
        );

        apply_dmx_route_add(
            &source,
            &transport,
            0,
            false,
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
            &network_outputs,
            &usb_outputs,
        )
        .expect("fixture break patch should succeed");
        assert_eq!(
            output_routes.routes[0].source,
            OutputSource::FixtureBreak {
                uids: vec![fixture_uid],
                dmx_break: 2,
            }
        );

        apply_dmx_route_remove(
            Some(&RouteEndpoint::Fixture {
                ids: vec![12],
                element: None,
                param: None,
            }),
            None,
            None,
            None,
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
        )
        .expect("whole-fixture unpatch should succeed");
        assert!(output_routes.routes.is_empty());
    }

    #[test]
    fn apply_dmx_route_remove_supports_transport_to_transport() {
        let mut input_routes = InputRoutes {
            routes: vec![InputRoute {
                source: InputSource::Transport {
                    transport: RouteTransport::Sacn,
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                target: InputTarget::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange::single(9)),
                    address: Some(42),
                },
                priority: 4,
                clone: false,
            }],
        };
        let mut output_routes = OutputRoutes::default();
        let mut disabled_routes = DisabledRoutes::default();
        let data_provider = FixtureDataProviderExt::default();

        apply_dmx_route_remove(
            Some(&RouteEndpoint::Transport {
                target: "sacn".to_string(),
                universe: Some(DmxRange::single(1)),
                address: Some(10),
            }),
            Some(&RouteEndpoint::Transport {
                target: "artnet".to_string(),
                universe: Some(DmxRange::single(9)),
                address: Some(42),
            }),
            Some(4),
            Some(false),
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
        )
        .expect("transport-to-transport remove should succeed");

        assert!(input_routes.routes.is_empty());
        assert!(output_routes.routes.is_empty());
        assert!(disabled_routes.routes.is_empty());
    }

    #[test]
    fn apply_dmx_route_remove_target_transport_without_source_removes_input_and_output() {
        let mut input_routes = InputRoutes {
            routes: vec![
                InputRoute {
                    source: InputSource::Transport {
                        transport: RouteTransport::Sacn,
                        universe: Some(DmxRange::single(1)),
                        address: Some(1),
                    },
                    target: InputTarget::Transport {
                        target: "artnet".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
                InputRoute {
                    source: InputSource::Transport {
                        transport: RouteTransport::ArtNet,
                        universe: Some(DmxRange::single(2)),
                        address: Some(1),
                    },
                    target: InputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let fixture_uid = Uuid::new_v4();
        let mut output_routes = OutputRoutes {
            routes: vec![
                OutputRoute {
                    source: OutputSource::Fixture {
                        uids: vec![fixture_uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "artnet".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
                OutputRoute {
                    source: OutputSource::Fixture {
                        uids: vec![fixture_uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: None,
                        address: None,
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        };

        let mut disabled_routes = DisabledRoutes::default();
        let data_provider = FixtureDataProviderExt::default();

        apply_dmx_route_remove(
            None,
            Some(&RouteEndpoint::Transport {
                target: "artnet".to_string(),
                universe: None,
                address: None,
            }),
            None,
            None,
            &mut input_routes,
            &mut output_routes,
            &mut disabled_routes,
            &data_provider,
        )
        .expect("remove with target transport filter should succeed");

        assert_eq!(input_routes.routes.len(), 1);
        assert!(matches!(
            input_routes.routes[0].target,
            InputTarget::Transport {
                ref target,
                ..
            } if target == "sacn"
        ));

        assert_eq!(output_routes.routes.len(), 1);
        assert!(matches!(
            output_routes.routes[0].target,
            OutputTarget::Transport {
                ref target,
                ..
            } if target == "sacn"
        ));
    }
}
