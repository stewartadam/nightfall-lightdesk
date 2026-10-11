// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! System tests for releasing manual DMX channel writes and undoing those releases.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use moonshine_kind::Instance;
use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::{
    CommandEnvelope, CommandNoticeReply, CommandOrigin, CommandReply, CommandResult,
    CommandTracker, EngineOperationEnvelope, FinishedCommand, ReplyTarget,
};
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::DmxOperation;
use nightfall_fixtures::prelude::*;
use nightfall_instances::PlaybackOperation;
use nightfall_undo::prelude::{UndoContext, Undoable};

/// Universe holding the patched test parameter.
const PATCHED_UNIVERSE: u16 = 5;
/// Address of the patched test parameter.
const PATCHED_ADDRESS: u16 = 13;
/// Universe that no fixture is patched to.
const UNPATCHED_UNIVERSE: u16 = 9;

/// Builds an app running manual DMX writes, release, composition, and universe output in frame order.
///
/// One coarse parameter defaulting to full is bound to console universe 5 address 13 so tests can
/// observe whether fixture output resumes after a manual override is released.
fn setup_app() -> App {
    let mut app = App::new();
    add_compositor_removal_observers::<Parameter>(&mut app);
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<EngineOperationEnvelope<PlaybackOperation>>();
    app.add_message::<EngineOperationEnvelope<DmxOperation>>();
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(ConsoleDmxUniverses::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        min: 0.0,
        max: 255.0,
        ..Default::default()
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 310,
            uid: uuid::Uuid::new_v4(),
            label: "Fixture 310".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "body".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };
    let parameter_entity = app
        .world_mut()
        .spawn((
            Parameter {
                metadata: metadata.clone(),
                values: ParameterValues {
                    default_value: 255.0,
                    current_value: 255.0,
                    ..Default::default()
                },
            },
            ResolvedConsoleDestination {
                address: Some(ConsoleParameterAddress {
                    universe: PATCHED_UNIVERSE,
                    addresses: vec![PATCHED_ADDRESS],
                }),
            },
        ))
        .id();
    {
        let mut data_provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        data_provider
            .inner
            .add(fixture.clone())
            .expect("test fixture should be added");
        // SAFETY: the entity was spawned with a Parameter component above.
        let parameter: Instance<Parameter> =
            unsafe { Instance::from_entity_unchecked(parameter_entity) };
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            metadata.attribute,
            parameter,
        );
    }
    app.world_mut().spawn((
        Layer::new("test manual".to_string(), MANUAL_ASSERTION_LAYER_PRIORITY),
        ManualAssertionLayer,
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Parameter,
            id: 1,
        }),
    ));

    app.add_systems(
        Update,
        (
            nightfall_fixtures::events::handle_set_dmx_channels,
            nightfall_fixtures::compositor::update_manual_assertion_layer,
            compositor::<Parameter>,
            nightfall_fixtures::universe::dmx_universes,
        )
            .chain(),
    );
    app.update();
    app
}

/// Builds a channel expression addressing one DMX slot.
fn channel(universe: u16, address: u16) -> DmxChannelExpr {
    DmxChannelExpr::Single(DmxChannelRef { universe, address })
}

/// Writes a tracked manual `ch u.a @ value` command and runs one frame.
fn set_channel(app: &mut App, universe: u16, address: u16, value: ChannelDmxValue) {
    let envelope = CommandEnvelope::new(
        FixtureCommand::SetDmxChannels {
            channels: channel(universe, address),
            value,
        },
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    );
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("fixture command should register");
    app.world_mut().write_message(envelope);
    app.update();
}

/// Dispatches one DMX action as the planner or undo replay would, then runs one frame.
fn dispatch_dmx_action(app: &mut App, action: DmxOperation) {
    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(action));
    app.update();
}

/// Captures the undo inverse of a DMX action against the current world, as the undo dispatcher does.
fn capture_inverse(app: &App, action: &DmxOperation) -> DmxOperation {
    let ctx = UndoContext { world: app.world() };
    let inverse = action
        .inverse(&ctx)
        .expect("releasing a manual channel should be undoable");
    inverse
        .as_any()
        .downcast_ref::<DmxOperation>()
        .expect("DMX release inverse should replay as a DMX action")
        .clone()
}

/// Releasing an unpatched manual slot frees it instead of leaving a system-owned zero behind.
#[test]
fn release_channel_frees_unpatched_slot_ownership() {
    let mut app = setup_app();
    set_channel(&mut app, UNPATCHED_UNIVERSE, 1, 50);
    {
        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(universes.get_value(UNPATCHED_UNIVERSE, 1), Some(50));
        assert_eq!(
            universes.get_origin(UNPATCHED_UNIVERSE, 1),
            Some(ConsoleChannelOrigin::ManualCommand)
        );
    }

    dispatch_dmx_action(
        &mut app,
        DmxOperation::ReleaseChannels {
            channels: channel(UNPATCHED_UNIVERSE, 1),
        },
    );

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(
        universes.get_origin(UNPATCHED_UNIVERSE, 1),
        None,
        "released slot must not stay owned by the system"
    );
    assert!(
        !universes.has_universe(UNPATCHED_UNIVERSE),
        "a console universe nothing writes to anymore should stop being output"
    );
}

/// `fix 310 @ 100; ch 5.13 @ 50; release ch 5.13` returns the slot to the fixture's full output.
#[test]
fn release_channel_resumes_patched_fixture_output() {
    let mut app = setup_app();
    {
        let universes = app.world().resource::<ConsoleDmxUniverses>();
        assert_eq!(
            universes.get_value(PATCHED_UNIVERSE, PATCHED_ADDRESS),
            Some(255)
        );
    }

    set_channel(&mut app, PATCHED_UNIVERSE, PATCHED_ADDRESS, 50);
    app.update();
    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .get_value(PATCHED_UNIVERSE, PATCHED_ADDRESS),
        Some(50)
    );

    dispatch_dmx_action(
        &mut app,
        DmxOperation::ReleaseChannels {
            channels: channel(PATCHED_UNIVERSE, PATCHED_ADDRESS),
        },
    );
    app.update();

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(
        universes.get_value(PATCHED_UNIVERSE, PATCHED_ADDRESS),
        Some(255)
    );
    assert_eq!(
        universes.get_origin(PATCHED_UNIVERSE, PATCHED_ADDRESS),
        Some(ConsoleChannelOrigin::OutputBinding)
    );
}

/// `ch 9.1 @ 50; release ch 9.1; undo` restores the manual 50 rather than replaying a zero.
#[test]
fn undo_release_channel_restores_previous_manual_value() {
    let mut app = setup_app();
    set_channel(&mut app, UNPATCHED_UNIVERSE, 1, 50);

    let release = DmxOperation::ReleaseChannels {
        channels: channel(UNPATCHED_UNIVERSE, 1),
    };
    let undo = capture_inverse(&app, &release);
    dispatch_dmx_action(&mut app, release);
    dispatch_dmx_action(&mut app, undo);

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(universes.get_value(UNPATCHED_UNIVERSE, 1), Some(50));
    assert_eq!(
        universes.get_origin(UNPATCHED_UNIVERSE, 1),
        Some(ConsoleChannelOrigin::ManualCommand)
    );
}

/// Undoing a release on a patched slot re-asserts the manual value over the fixture output.
#[test]
fn undo_release_channel_reasserts_manual_value_over_fixture() {
    let mut app = setup_app();
    set_channel(&mut app, PATCHED_UNIVERSE, PATCHED_ADDRESS, 50);
    app.update();

    let release = DmxOperation::ReleaseChannels {
        channels: channel(PATCHED_UNIVERSE, PATCHED_ADDRESS),
    };
    let undo = capture_inverse(&app, &release);
    dispatch_dmx_action(&mut app, release);
    app.update();
    dispatch_dmx_action(&mut app, undo);
    app.update();

    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .get_value(PATCHED_UNIVERSE, PATCHED_ADDRESS),
        Some(50)
    );
}

/// Undoing a manual write on a free slot releases it instead of leaving a system-owned zero.
#[test]
fn undo_set_channel_frees_slot_that_was_unowned() {
    let mut app = setup_app();
    let set = FixtureCommand::SetDmxChannels {
        channels: channel(UNPATCHED_UNIVERSE, 1),
        value: 50,
    };
    let undo = {
        let ctx = UndoContext { world: app.world() };
        set.inverse(&ctx)
            .expect("manual DMX writes should be undoable")
    };
    set_channel(&mut app, UNPATCHED_UNIVERSE, 1, 50);
    let undo = undo
        .as_any()
        .downcast_ref::<DmxOperation>()
        .expect("manual DMX write inverse should replay as a DMX action")
        .clone();
    dispatch_dmx_action(&mut app, undo);

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(universes.get_origin(UNPATCHED_UNIVERSE, 1), None);
    assert!(!universes.has_universe(UNPATCHED_UNIVERSE));
}

/// `ch 9.1 @ 50; ch 9.1 @ 70; undo` restores the earlier manual 50.
#[test]
fn undo_set_channel_restores_previous_manual_value() {
    let mut app = setup_app();
    set_channel(&mut app, UNPATCHED_UNIVERSE, 1, 50);
    let set = FixtureCommand::SetDmxChannels {
        channels: channel(UNPATCHED_UNIVERSE, 1),
        value: 70,
    };
    let undo = {
        let ctx = UndoContext { world: app.world() };
        set.inverse(&ctx)
            .expect("manual DMX writes should be undoable")
    };
    set_channel(&mut app, UNPATCHED_UNIVERSE, 1, 70);
    let undo = undo
        .as_any()
        .downcast_ref::<DmxOperation>()
        .expect("manual DMX write inverse should replay as a DMX action")
        .clone();
    dispatch_dmx_action(&mut app, undo);

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(universes.get_value(UNPATCHED_UNIVERSE, 1), Some(50));
    assert_eq!(
        universes.get_origin(UNPATCHED_UNIVERSE, 1),
        Some(ConsoleChannelOrigin::ManualCommand)
    );
}
