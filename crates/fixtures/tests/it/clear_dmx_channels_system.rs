// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall_engine::prelude::{
    CommandNotice, CommandReply, CommandResult, CommandTracker, EngineActionEnvelope,
    FinishedCommand,
};
use nightfall_fixtures::events::handle_clear_dmx_channels;
use nightfall_fixtures::prelude::{ConsoleChannelOrigin, ConsoleDmxUniverses};
use nightfall_fixtures::undo::{ClearDmxChannels, DmxChannelSnapshot};

/// Installs the command lifecycle resources required by action handlers.
fn init_command_lifecycle(app: &mut App) {
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
}

#[test]
fn test_clear_dmx_channels_resets_manual_channel() {
    let mut app = App::new();
    init_command_lifecycle(&mut app);
    app.add_message::<EngineActionEnvelope<ClearDmxChannels>>();
    app.insert_resource(ConsoleDmxUniverses::default());
    app.add_systems(Update, handle_clear_dmx_channels);

    {
        let mut universes = app.world_mut().resource_mut::<ConsoleDmxUniverses>();
        universes.set_value(5, 13, 255, ConsoleChannelOrigin::ManualCommand);
        assert_eq!(universes.get_value(5, 13), Some(255));
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClearDmxChannels(
            DmxChannelSnapshot {
                channels: DmxChannelExpr::Single(DmxChannelRef {
                    universe: 5,
                    address: 13,
                }),
                value: 0,
            },
        )));
    app.update();

    let universes = app.world().resource::<ConsoleDmxUniverses>();
    assert_eq!(
        universes.get_value(5, 13),
        Some(0),
        "DMX override should be cleared to zero"
    );
}
