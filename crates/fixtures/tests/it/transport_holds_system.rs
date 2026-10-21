// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! System tests for `ch <transport>:U.A @ V` holds on output wire universes, their release,
//! and undo.

use std::collections::HashMap;

use bevy_app::prelude::*;
use bevy_ecs::message::Messages;
use bevy_ecs::prelude::*;
use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::{
    CommandEnvelope, CommandNoticeReply, CommandOrigin, CommandOutcome, CommandReply,
    CommandResult, CommandTracker, EngineOperationEnvelope, FinishedCommand, ReplyTarget,
};
use nightfall_fixtures::DmxOperation;
use nightfall_fixtures::output_frames::compose_output_frames;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::transport_holds::{
    handle_set_transport_dmx_channels, handle_transport_dmx_operations, resolve_transport_holds,
};
use nightfall_io::{NetworkDmxOutputTargets, OutputTransport, SacnDelivery, UsbDmxOutputTargets};
use nightfall_undo::prelude::{UndoContext, Undoable};

/// Wire universe the tests hold channels on.
const UNIVERSE: u16 = 1;

/// Returns the transport the default `sacn` target resolves to.
fn sacn() -> OutputTransport {
    OutputTransport::Sacn {
        mode: SacnDelivery::Multicast,
    }
}

/// Builds an app that applies transport holds and composes wire frames in frame order, with
/// the default `sacn`, `artnet` and `udmx` outputs configured.
fn setup_app() -> App {
    let mut app = App::new();
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<EngineOperationEnvelope<DmxOperation>>();
    // Undo of fixture commands reads the fixture store even for DMX-only commands.
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<OutputRouting>();
    app.init_resource::<OutputDmxFrames>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.add_systems(
        Update,
        (
            handle_set_transport_dmx_channels,
            handle_transport_dmx_operations,
            resolve_transport_holds,
            compose_output_frames,
        )
            .chain(),
    );
    app.update();
    app
}

/// Builds a channel expression addressing one wire slot.
fn channel(address: u16) -> DmxChannelExpr {
    DmxChannelExpr::Single(DmxChannelRef {
        universe: UNIVERSE,
        address,
    })
}

/// Builds the `ch <target>:1.<address> @ <value>` command.
fn hold_command(target: &str, address: u16, value: ChannelDmxValue) -> FixtureCommand {
    FixtureCommand::SetTransportDmxChannels {
        target: target.to_string(),
        channels: channel(address),
        value,
    }
}

/// Writes a tracked fixture command, runs one frame, and returns its terminal outcome.
fn run_command(app: &mut App, command: FixtureCommand) -> CommandOutcome {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("fixture command should register");
    app.world_mut().write_message(envelope);
    app.update();
    let mut results = app.world_mut().resource_mut::<Messages<CommandResult>>();
    results
        .drain()
        .last()
        .expect("command should finish within the frame")
        .outcome
}

/// Dispatches one DMX action as the planner or undo replay would, then runs one frame.
fn dispatch_dmx_action(app: &mut App, action: DmxOperation) {
    app.world_mut()
        .write_message(EngineOperationEnvelope::detached(action));
    app.update();
}

/// Captures an undo inverse against the current world and returns it as a DMX action.
fn capture_inverse(app: &App, undoable: &dyn Undoable) -> DmxOperation {
    let ctx = UndoContext { world: app.world() };
    undoable
        .inverse(&ctx)
        .expect("transport holds should be undoable")
        .as_any()
        .downcast_ref::<DmxOperation>()
        .expect("transport hold inverse should replay as a DMX action")
        .clone()
}

/// Returns the composed sACN frame for the test universe, if any.
fn sacn_frame(app: &App) -> Option<[ChannelDmxValue; MAX_CHANNELS_PER_UNIVERSE]> {
    app.world()
        .resource::<OutputDmxFrames>()
        .get(&sacn(), UNIVERSE)
        .map(|frame| frame.channels)
}

/// `ch sacn:1.1 @ 255` puts the value on the wire even though nothing is patched there.
#[test]
fn hold_composes_a_frame_for_an_unrouted_universe() {
    let mut app = setup_app();

    let outcome = run_command(&mut app, hold_command("sacn", 1, 255));

    assert!(matches!(outcome, CommandOutcome::Succeeded { .. }));
    let frame = sacn_frame(&app).expect("held universe should be composed");
    assert_eq!(frame[0], 255);
    assert!(frame[1..].iter().all(|value| *value == 0));
}

/// A held channel wins over patched output on that slot and leaves neighbouring slots alone,
/// and keeps winning after bindings are re-resolved.
#[test]
fn hold_overrides_routed_output_and_survives_binding_resolution() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<OutputRouting>()
        .set_output_routes(HashMap::from([(
            (sacn(), UNIVERSE),
            OutputBindingRoute {
                console_windows: Vec::new(),
                direct: true,
            },
        )]));
    app.world_mut()
        .resource_mut::<ConsoleDmxUniverses>()
        .set_output_values(
            &sacn(),
            UNIVERSE,
            1,
            &[10, 20],
            ConsoleChannelOrigin::OutputBinding,
        );

    run_command(&mut app, hold_command("sacn", 2, 99));
    assert_eq!(
        sacn_frame(&app).map(|frame| [frame[0], frame[1]]),
        Some([10, 99])
    );

    {
        let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
        universes.clear_output_binding_values();
        universes.set_output_values(
            &sacn(),
            UNIVERSE,
            1,
            &[11, 21],
            ConsoleChannelOrigin::OutputBinding,
        );
    }
    app.update();
    assert_eq!(
        sacn_frame(&app).map(|frame| [frame[0], frame[1]]),
        Some([11, 99])
    );
}

/// `release ch sacn:1.1` frees the slot, and the frame disappears once nothing feeds it.
#[test]
fn release_frees_held_channel() {
    let mut app = setup_app();
    run_command(&mut app, hold_command("sacn", 1, 255));

    dispatch_dmx_action(
        &mut app,
        DmxOperation::ReleaseTransportChannels {
            target: "sacn".to_string(),
            channels: channel(1),
        },
    );

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(universes.held_wire_value("sacn", UNIVERSE, 1), None);
    assert!(sacn_frame(&app).is_none());
}

/// A target ID that names no configured output fails the command without holding anything.
#[test]
fn unknown_target_fails_without_holding() {
    let mut app = setup_app();

    let outcome = run_command(&mut app, hold_command("scan", 1, 255));

    let CommandOutcome::Failed(error) = outcome else {
        panic!("unknown target should fail, got {outcome:?}");
    };
    assert!(error.message.contains("scan"), "{}", error.message);
    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .held_wire_value("scan", UNIVERSE, 1),
        None
    );
}

/// A slot outside the universe fails the whole command, holding none of its channels.
#[test]
fn out_of_range_address_fails_without_holding() {
    let mut app = setup_app();

    let outcome = run_command(
        &mut app,
        FixtureCommand::SetTransportDmxChannels {
            target: "sacn".to_string(),
            channels: DmxChannelExpr::Range {
                start: DmxChannelRef {
                    universe: UNIVERSE,
                    address: 511,
                },
                end: DmxChannelRef {
                    universe: UNIVERSE,
                    address: 513,
                },
            },
            value: 255,
        },
    );

    assert!(matches!(outcome, CommandOutcome::Failed(_)), "{outcome:?}");
    assert!(sacn_frame(&app).is_none());
}

/// Holds follow their output by name: changing the output's delivery moves the held frame,
/// and the hold can still be released by the name it was set with.
#[test]
fn hold_follows_output_configuration_changes() {
    let mut app = setup_app();
    run_command(&mut app, hold_command("artnet", 1, 42));
    let broadcast = app
        .world()
        .resource::<NetworkDmxOutputTargets>()
        .get("artnet")
        .and_then(|target| target.output_transport())
        .expect("default artnet output should resolve");
    assert!(
        app.world()
            .resource::<OutputDmxFrames>()
            .get(&broadcast, UNIVERSE)
            .is_some()
    );

    app.world_mut()
        .resource_mut::<NetworkDmxOutputTargets>()
        .targets
        .retain(|target| target.id != "artnet");
    app.update();
    assert!(
        app.world()
            .resource::<OutputDmxFrames>()
            .get(&broadcast, UNIVERSE)
            .is_none(),
        "a hold on a removed output must stop being sent"
    );

    dispatch_dmx_action(
        &mut app,
        DmxOperation::ReleaseTransportChannels {
            target: "artnet".to_string(),
            channels: channel(1),
        },
    );
    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .held_wire_value("artnet", UNIVERSE, 1),
        None
    );
}

/// Undoing a hold restores the previous held value, then the unheld state.
#[test]
fn undo_hold_restores_previous_state() {
    let mut app = setup_app();
    let first = hold_command("sacn", 1, 50);
    let undo_first = capture_inverse(&app, &first);
    run_command(&mut app, first);
    let second = hold_command("sacn", 1, 70);
    let undo_second = capture_inverse(&app, &second);
    run_command(&mut app, second);

    dispatch_dmx_action(&mut app, undo_second);
    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .held_wire_value("sacn", UNIVERSE, 1),
        Some(50)
    );

    dispatch_dmx_action(&mut app, undo_first);
    assert_eq!(
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .held_wire_value("sacn", UNIVERSE, 1),
        None
    );
    assert!(sacn_frame(&app).is_none());
}

/// Undoing a release puts the held value back on the wire.
#[test]
fn undo_release_restores_hold() {
    let mut app = setup_app();
    run_command(&mut app, hold_command("sacn", 1, 255));
    let release = DmxOperation::ReleaseTransportChannels {
        target: "sacn".to_string(),
        channels: channel(1),
    };
    let undo = capture_inverse(&app, &release);
    dispatch_dmx_action(&mut app, release);

    dispatch_dmx_action(&mut app, undo);

    assert_eq!(sacn_frame(&app).map(|frame| frame[0]), Some(255));
}
