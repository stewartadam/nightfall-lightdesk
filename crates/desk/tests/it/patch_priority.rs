// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command-level checks that `patch` priorities decide which passthrough source reaches the wire.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_cmd_parse::generate_ast;
use nightfall_desk::systems::event_handlers::fixture_events::crud_events;
use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nightfall_engine::prelude::*;
use nightfall_fixtures::FixtureCommand;
use nightfall_fixtures::ast_conv::FixtureAstConverter;
use nightfall_fixtures::binding_resolution::resolve_input_bindings;
use nightfall_fixtures::output_frames::{
    OutputDmxFrames, OutputRouting, compose_output_frames, update_input_routing,
};
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::websocket::SuppressFixtureChangedSnapshot;
use nightfall_io::prelude::*;
use web_time::Instant;

/// Creates an app that runs fixture commands, resolves input bindings, and composes wire frames.
///
/// Binding validation is permissive because strict validation rejects overlapping targets, and
/// priority only arbitrates between bindings that are allowed to overlap.
fn patch_pipeline_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
    app.add_message::<SuppressFixtureChangedSnapshot>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<InputBindings>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<DisabledBindings>();
    app.insert_resource(BindingValidationSettings {
        mode: BindingValidationMode::Permissive,
    });
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
    app.init_resource::<ConsoleDmxAddresses>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.init_resource::<InputDmxUniverses>();
    app.init_resource::<ResolvedInputBindings>();
    app.init_resource::<OutputRouting>();
    app.init_resource::<OutputDmxFrames>();
    let (sender, _receiver) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(sender));
    app.add_systems(
        Update,
        (
            crud_events,
            resolve_input_bindings,
            update_input_routing,
            compose_output_frames,
        )
            .chain(),
    );
    app
}

/// Parses each `patch` command and submits the resulting fixture commands for the next update.
fn submit_patch_commands(app: &mut App, patch_commands: &[&str]) {
    for input in patch_commands {
        let ast = generate_ast(input).expect("patch command should parse");
        for payload in FixtureAstConverter::convert(&ast).expect("patch should convert") {
            let command = payload
                .as_any()
                .downcast_ref::<FixtureCommand>()
                .expect("patch should convert to a fixture command")
                .clone();
            let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
            app.world_mut()
                .resource_mut::<CommandTracker>()
                .register(&envelope)
                .expect("patch command should register");
            app.world_mut().write_message(envelope);
        }
    }
}

/// Runs `patch_commands` through the pipeline with sACN universe 1 carrying 11 and sACN universe
/// 2 carrying 22, and returns the first channel composed for Art-Net universe 5.
fn artnet_value_after_patch_commands(patch_commands: &[&str]) -> u8 {
    let mut app = patch_pipeline_app();
    submit_patch_commands(&mut app, patch_commands);
    for (universe, value) in [(1, 11), (2, 22)] {
        let mut data = [0; MAX_CHANNELS_PER_UNIVERSE];
        data[0] = value;
        app.world_mut()
            .resource_mut::<InputDmxUniverses>()
            .set_universe(BindingTransport::Sacn, universe, data, Instant::now());
    }
    app.update();

    assert_eq!(
        app.world().resource::<InputBindings>().bindings.len(),
        patch_commands.len(),
        "every patch command should add an input binding"
    );
    let artnet = OutputTransport::ArtNet {
        mode: ArtNetDelivery::Broadcast,
    };
    app.world()
        .resource::<OutputDmxFrames>()
        .get(&artnet, 5)
        .expect("Art-Net universe 5 should be composed")
        .channels[0]
}

/// Verifies the higher `prio` patch reaches the wire regardless of the order patches are entered.
#[test]
fn patch_commands_send_highest_priority_source_to_shared_target() {
    assert_eq!(
        artnet_value_after_patch_commands(&[
            "patch sacn:1 @ artnet:5 prio 10",
            "patch sacn:2 @ artnet:5 prio 1",
        ]),
        11
    );
    assert_eq!(
        artnet_value_after_patch_commands(&[
            "patch sacn:2 @ artnet:5 prio 1",
            "patch sacn:1 @ artnet:5 prio 10",
        ]),
        11
    );
}

/// Verifies equal-priority patches to one target deterministically favor the first one entered.
#[test]
fn patch_commands_with_equal_priority_favor_first_patch() {
    assert_eq!(
        artnet_value_after_patch_commands(&[
            "patch sacn:1 @ artnet:5 prio 3",
            "patch sacn:2 @ artnet:5 prio 3",
        ]),
        11
    );
    assert_eq!(
        artnet_value_after_patch_commands(&[
            "patch sacn:2 @ artnet:5 prio 3",
            "patch sacn:1 @ artnet:5 prio 3",
        ]),
        22
    );
}
